#!/usr/bin/env node
/**
 * tools/build-static-pages.js
 * ------------------------------------------------------------------
 * 施設個別ページ（SEO用の"本物の"静的HTML）を生成するツール。
 *
 * 【これまでの経緯・このツールの位置づけ】
 * index.html には、施設ごとに独立したURL（例: /tokyo/taito/ueno/）で
 * 開けるクライアントサイドのルーティングが既に実装済み（SLUG_OVERRIDES /
 * spotSlug() / updateSeoTagsForSpot() など）。ただしこれはあくまで
 * 「index.html をブラウザが読み込んでJSが実行された後に」タイトルや
 * meta・構造化データを書き換える仕組みであり、GitHub Pages上に
 * その施設のURLに対応する“実ファイル”が存在するわけではない
 * （存在しないパスへの直接アクセスは 404.html → リダイレクト復元で
 * index.html に戻ってきてから上記の仕組みが動く）。
 *
 * このツールは、選ばれた施設について「実ファイルとして存在する」
 * 軽量な静的HTMLページを {slug}/index.html として書き出す。
 * クローラーやJS非実行環境でも初回レスポンスの時点で内容が読める
 * ようにするのが目的。index.html 側の挙動・既存機能は一切変更しない
 * （このツールは新しいファイルを増やすだけで、index.html は読み取り専用
 * として扱う）。
 *
 * 【データの正としての扱い】
 * 施設情報は data/spots.json のみを正とする。ここで値を推測・生成する
 * ことは一切しない。存在しない項目はページ上でも構造化データ上でも
 * 省略する（index.html の buildSpotJsonLd と同じ方針）。
 *
 * 【現在のフェーズ：100施設（フェーズ2）】
 * 600施設への一括展開はまだ実施しない。tools/facility-rollout-list.json に
 * 列挙した施設名だけを対象にする。将来の展開時は、このファイルの中身を
 * SLUG_OVERRIDES の全キー（＝現在668施設）に差し替えれば、
 * そのまま同じロジックで全施設分を生成できる設計にしている。
 *
 * 【実行方法】
 *   node tools/build-static-pages.js
 * リポジトリのルート（index.html と同じ階層）から実行する想定。
 * ------------------------------------------------------------------
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SITE_ORIGIN = "https://odekakenavi.github.io";
const APP_BASE_PATH = "/odekake-navi/"; // GitHub Pagesのプロジェクトサイトのベースパス
const HOME_URL = SITE_ORIGIN + APP_BASE_PATH;
const GA_MEASUREMENT_ID = "G-HMLTN7373E"; // index.htmlと同一のGA4測定ID（analyticsのdata sourceを分けないため）

// ▼▼▼ 今回のパイロット対象。tools/facility-rollout-list.json（施設名の配列）から読み込む。
// このファイルを差し替えるだけで対象施設を増減できる（600施設展開時も同じ仕組みを使う）。
// ファイルが無い場合は、最初の10施設（フェーズ1）にフォールバックする。 ▼▼▼
const ROLLOUT_LIST_PATH = path.join(__dirname, "facility-rollout-list.json");
const FALLBACK_10 = [
  "上野動物園", "すみだ水族館", "よみうりランド", "国営昭和記念公園",
  "はまぎん こども宇宙科学館", "鉄道博物館", "キッザニア東京",
  "アンパンマンこどもミュージアム＆モール横浜", "東京都水の科学館", "国営ひたち海浜公園",
];
function loadRolloutList() {
  try {
    return JSON.parse(fs.readFileSync(ROLLOUT_LIST_PATH, "utf-8"));
  } catch (e) {
    console.warn("⚠ facility-rollout-list.json が読めないため、フェーズ1の10施設にフォールバックします。");
    return FALLBACK_10;
  }
}
const PILOT_FACILITY_NAMES = loadRolloutList();

// ------------------------------------------------------------------
// index.html から SLUG_OVERRIDES（施設名→確定slug）を抽出する。
// index.html を二重管理しないための措置（このツールの中に同じデータを
// 手で書き写さない。常に index.html 側を正とする）。
// ------------------------------------------------------------------
function extractSlugOverrides(html) {
  const m = html.match(/const SLUG_OVERRIDES = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error("SLUG_OVERRIDES block not found in index.html");
  const body = m[1];
  const re = /"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/g;
  const map = {};
  let mm;
  while ((mm = re.exec(body))) {
    map[JSON.parse('"' + mm[1] + '"')] = JSON.parse('"' + mm[2] + '"');
  }
  return map;
}

// index.html の DESIGNATED_CITIES / baseMunicipality / fullPrefectureName と同じロジック
const DESIGNATED_CITIES = ["横浜市", "川崎市", "さいたま市", "千葉市", "相模原市"];
function baseMunicipality(area) {
  if (!area) return area;
  for (const dc of DESIGNATED_CITIES) {
    if (area.indexOf(dc) === 0) {
      const m = area.match(new RegExp("^" + dc + ".+?区"));
      return m ? m[0] : dc;
    }
  }
  if (area.indexOf("郡") !== -1) {
    const m = area.match(/^.+?郡.+?(?:町|村)/);
    if (m) return m[0];
  }
  const m = area.match(/^.+?(?:市|区|町|村)/);
  return m ? m[0] : area;
}
function cleanCityDisplayName(jpName) {
  const m = jpName.match(/^.+郡(.+)$/);
  return m ? m[1] : jpName;
}
function fullPrefectureName(region) {
  if (!region) return "";
  if (region === "東京") return "東京都";
  return region + "県";
}
function fullAreaLabel(spot) {
  return fullPrefectureName(spot.region) + (spot.area || "");
}
function deriveCategory(spot) {
  if (spot.genre) return spot.genre;
  const text = (spot.name || "") + (spot.desc || "");
  if (text.includes("水族館")) return "水族館";
  if (text.includes("動物園")) return "動物園";
  if (text.includes("博物館") || text.includes("科学館") || text.includes("技術館") || text.includes("ミュージアム")) return "博物館・科学館";
  if (text.includes("牧場")) return "牧場";
  if (text.includes("遊園地") || text.includes("テーマパーク")) return "遊園地・テーマパーク";
  if (text.includes("公園")) return "公園";
  return "おでかけスポット";
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
// data/spots.json の parkingDetail は施設によって「文字列」または
// 「{note, priceLabel, ratingLabel, ...} のオブジェクト」の2パターンがある。
// String(object) は "[object Object]" になってしまうため、両方を正しく処理する。
function formatParkingDetail(pd) {
  if (!pd) return "";
  if (typeof pd === "string") return "（" + esc(pd) + "）";
  if (typeof pd === "object") {
    const text = pd.note || pd.ratingLabel || pd.priceLabel || "";
    return text ? "（" + esc(text) + "）" : "";
  }
  return "";
}
// 季節（春/夏/秋/冬）→ 既存の /season/xxx/ ページのslug
const SEASON_SLUG = { "春": "spring", "夏": "summer", "秋": "autumn", "冬": "winter" };

// ------------------------------------------------------------------
// メイン処理
// ------------------------------------------------------------------
function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf-8");
  const slugOverrides = extractSlugOverrides(html);
  const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "spots.json"), "utf-8"));
  const hotelsData = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "hotels.json"), "utf-8"));

  const byName = new Map(spots.map((s) => [s.name, s]));

  // ホテルをフラットな配列にしておく（index.html の hotelFlatList() と同じ考え方）
  const hotelFlat = [];
  Object.keys(hotelsData.familyHotels || {}).forEach((areaKey) => {
    (hotelsData.familyHotels[areaKey] || []).forEach((h) => hotelFlat.push({ hotel: h, areaKey }));
  });

  // 全施設のうち、slug確定済み（SLUG_OVERRIDES登録済み）のものだけを
  // 「周辺のお出かけスポット」の候補にする＝リンク先が必ず実在するURLになる
  const slugSpots = spots
    .filter((s) => slugOverrides[s.name])
    .map((s) => ({ spot: s, slug: slugOverrides[s.name] }));

  const results = [];

  PILOT_FACILITY_NAMES.forEach((name) => {
    const spot = byName.get(name);
    if (!spot) {
      console.error("⚠ spots.json に見つかりません:", name);
      return;
    }
    const slug = slugOverrides[name];
    if (!slug) {
      console.error("⚠ SLUG_OVERRIDES に見つかりません:", name);
      return;
    }
    const page = buildPage(spot, slug, { slugSpots, hotelFlat });
    const outDir = path.join(ROOT, slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.html"), page.html, "utf-8");
    results.push(page.meta);
    console.log("✓ generated:", slug + "/index.html");
  });

  fs.writeFileSync(
    path.join(ROOT, "tools", "pilot-report.json"),
    JSON.stringify(results, null, 2),
    "utf-8"
  );
  console.log("\n生成件数:", results.length, "/ 対象:", PILOT_FACILITY_NAMES.length);
  console.log("レポート: tools/pilot-report.json に出力しました。");
}

// ------------------------------------------------------------------
// 1施設分のページを組み立てる
// ------------------------------------------------------------------
function buildPage(spot, slug, ctx) {
  const canonicalHref = HOME_URL + slug + "/";
  const title = `${spot.name}｜子連れお出かけ情報｜おでかけナビ`;
  // index.html buildSpotMetaDescription() と同一の組み立てロジック
  let description = `${spot.name}（${fullAreaLabel(spot)}）の子連れお出かけ情報。`;
  if (spot.desc) description += spot.desc;
  if (description.length > 120) description = description.slice(0, 120) + "…";

  const category = deriveCategory(spot);
  const [prefSlug, citySlug] = slug.split("/");
  const rawCityLabel = (spot.area || "").split("・")[0] || spot.area || "";
  const cityLabel = cleanCityDisplayName(baseMunicipality(rawCityLabel));
  const prefLabel = fullPrefectureName(spot.region);
  const prefHref = HOME_URL + prefSlug + "/";
  const cityHref = HOME_URL + prefSlug + "/" + citySlug + "/";

  // ---- 構造化データ：BreadcrumbList（index.html setBreadcrumbJsonLdForSpot と同一方針）----
  const breadcrumbItems = [
    { name: "おでかけナビ", url: HOME_URL },
    { name: prefLabel, url: prefHref },
    { name: cityLabel, url: cityHref },
    { name: spot.name, url: canonicalHref },
  ];
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbItems.map((it, i) => ({
      "@type": "ListItem", position: i + 1, name: it.name, item: it.url,
    })),
  };

  // ---- 構造化データ：TouristAttraction（index.html buildSpotJsonLd と同一方針。無い項目は省略）----
  const spotLd = { "@context": "https://schema.org", "@type": "TouristAttraction", name: spot.name, url: canonicalHref };
  if (spot.desc) spotLd.description = spot.desc;
  if (spot.region || cityLabel) {
    spotLd.address = { "@type": "PostalAddress" };
    if (spot.region) spotLd.address.addressRegion = prefLabel;
    if (cityLabel) spotLd.address.addressLocality = cityLabel;
    spotLd.address.addressCountry = "JP";
  }
  if (typeof spot.lat === "number" && typeof spot.lng === "number") {
    spotLd.geo = { "@type": "GeoCoordinates", latitude: spot.lat, longitude: spot.lng };
  }
  if (spot.officialUrl) spotLd.sameAs = spot.officialUrl;

  // ---- 年齢層の表示 ----
  const AGE_LABELS = { "0-1歳": "0〜1歳", "2-3歳": "2〜3歳", "4-6歳": "4〜6歳（未就学児）", "低学年": "小学校低学年", "高学年": "小学校高学年" };
  const ageLabels = (spot.ages || []).map((a) => AGE_LABELS[a] || a);

  // ---- 所要時間 ----
  let stayTimeText = "";
  if (spot.stayTime) {
    const toH = (m) => (m % 60 === 0 ? m / 60 + "時間" : Math.floor(m / 60) + "時間" + (m % 60) + "分");
    stayTimeText = `目安 ${toH(spot.stayTime.minMinutes)}〜${toH(spot.stayTime.maxMinutes)}`;
  } else if (spot.duration && spot.duration.length) {
    stayTimeText = spot.duration.join("・") + "が目安";
  }

  // ---- 雨の日との相性 ----
  let rainText = "";
  if (spot.weather && spot.weather.length) {
    rainText = spot.weather.includes("雨")
      ? "雨の日でも楽しみやすい（屋内中心、または屋根のあるエリアが多い）"
      : "晴れの日向き（屋外中心の施設）";
  }

  // ---- 営業時間 ----
  const DAY_LABELS = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日", holiday: "祝" };
  let businessHoursRows = "";
  if (spot.businessHours) {
    businessHoursRows = Object.keys(DAY_LABELS)
      .filter((k) => spot.businessHours[k])
      .map((k) => `<tr><th>${DAY_LABELS[k]}</th><td>${esc(spot.businessHours[k])}</td></tr>`)
      .join("");
  }

  // ---- 混雑の目安 ----
  let congestionRows = "";
  if (spot.congestion) {
    const CONG_LABELS = { weekdayAM: "平日午前", weekdayPM: "平日午後", holidayAM: "土日祝午前", holidayPM: "土日祝午後" };
    congestionRows = Object.keys(CONG_LABELS)
      .filter((k) => spot.congestion[k])
      .map((k) => `<tr><th>${CONG_LABELS[k]}</th><td>${esc(spot.congestion[k])}</td></tr>`)
      .join("");
  }

  // ---- 周辺のお出かけスポット（実在するURLだけ。半径15km以内・近い順に最大4件）----
  const nearbySpots = ctx.slugSpots
    .filter((x) => x.spot.name !== spot.name && typeof x.spot.lat === "number" && typeof spot.lat === "number")
    .map((x) => ({ ...x, km: haversineKm(spot.lat, spot.lng, x.spot.lat, x.spot.lng) }))
    .filter((x) => x.km <= 15)
    .sort((a, b) => a.km - b.km)
    .slice(0, 4);

  // ---- 周辺ホテル（半径10km以内・近い順に最大3件。個別URLが無いためリンクはせずテキスト情報として掲載）----
  const nearbyHotels = ctx.hotelFlat
    .filter((x) => typeof x.hotel.lat === "number" && typeof spot.lat === "number")
    .map((x) => ({ ...x, km: haversineKm(spot.lat, spot.lng, x.hotel.lat, x.hotel.lng) }))
    .filter((x) => x.km <= 10)
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);

  // ---- 季節ページへのリンク（seasonsフィールドがある場合のみ）----
  const seasonLinks = (spot.seasons || [])
    .map((s) => SEASON_SLUG[s])
    .filter(Boolean)
    .map((s) => ({ label: { spring: "春のおでかけ", summer: "夏のおでかけ", autumn: "秋のおでかけ", winter: "冬のおでかけ" }[s], href: HOME_URL + "season/" + s + "/" }));

  const appOpenHref = HOME_URL + "?spot=" + encodeURIComponent(spot.name);

  const html = renderHtml({
    spot, slug, canonicalHref, title, description, category,
    prefLabel, prefHref, cityLabel, cityHref, appOpenHref,
    breadcrumbLd, spotLd, ageLabels, stayTimeText, rainText,
    businessHoursRows, congestionRows, nearbySpots, nearbyHotels, seasonLinks,
  });

  return {
    html,
    meta: {
      name: spot.name, slug, url: canonicalHref, title, description,
      category, region: spot.region, area: spot.area,
      nearbySpotCount: nearbySpots.length, nearbyHotelCount: nearbyHotels.length,
      fieldsShown: Object.keys(spot),
    },
  };
}

function renderHtml(d) {
  const s = d.spot;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(d.title)}</title>
<meta name="description" content="${esc(d.description)}">
<link rel="canonical" href="${esc(d.canonicalHref)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="おでかけナビ">
<meta property="og:title" content="${esc(d.title)}">
<meta property="og:description" content="${esc(d.description)}">
<meta property="og:url" content="${esc(d.canonicalHref)}">
<meta property="og:image" content="${HOME_URL}og-image.png">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(d.title)}">
<meta name="twitter:description" content="${esc(d.description)}">
<meta name="twitter:image" content="${HOME_URL}og-image.png">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 192 192%27%3E%3Crect width=%27192%27 height=%27192%27 rx=%2740%27 fill=%27%233E8FB0%27/%3E%3Ccircle cx=%2760%27 cy=%2750%27 r=%2222%27 fill=%27%23F4B740%27/%3E%3Cpath d=%27M20 140 Q40 100 96 100 Q152 100 172 140 Z%27 fill=%27%23FFFDF8%27/%3E%3Ccircle cx=%2760%27 cy=%27150%27 r=%2214%27 fill=%27%232B2620%27/%3E%3Ccircle cx=%27132%27 cy=%27150%27 r=%2214%27 fill=%27%232B2620%27/%3E%3Crect x=%2740%27 y=%27112%27 width=%27112%27 height=%2732%27 rx=%2710%27 fill=%27%23E2603A%27/%3E%3C/svg%3E">
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(d.breadcrumbLd)}</script>
<script type="application/ld+json">${JSON.stringify(d.spotLd)}</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_MEASUREMENT_ID}', { 'anonymize_ip': true, 'allow_google_signals': false });
</script>
<style>
  :root{ --cream:#FBF7EF; --paper:#FFFDF8; --ink:#2B2620; --ink-soft:#6b6259; --sun:#3E8FB0; --coral:#E2603A; --line:#E7DFCF; --yellow:#F4B740; --green:#4F7942; }
  *{box-sizing:border-box;}
  body{margin:0; background:var(--cream); color:var(--ink); font-family:'Noto Sans JP',sans-serif; line-height:1.7; -webkit-font-smoothing:antialiased;}
  h1,h2,.mark{font-family:'Zen Maru Gothic',sans-serif;}
  a{color:var(--sun);}
  .wrap{max-width:720px; margin:0 auto; padding:0 16px 48px;}
  header.site-header{background:var(--paper); border-bottom:1px solid var(--line); padding:10px 16px;}
  header.site-header a{color:var(--ink); text-decoration:none; font-family:'Zen Maru Gothic',sans-serif; font-weight:900; font-size:15px;}
  nav.breadcrumb{font-size:12px; color:var(--ink-soft); padding:12px 0 4px; overflow-x:auto; white-space:nowrap;}
  nav.breadcrumb a{color:var(--ink-soft); text-decoration:none;}
  nav.breadcrumb a:hover{text-decoration:underline;}
  .badge-row{display:flex; gap:6px; flex-wrap:wrap; margin:6px 0 14px;}
  .badge{display:inline-block; background:#fff; border:1px solid var(--line); border-radius:999px; padding:4px 12px; font-size:12px; color:var(--ink-soft);}
  h1{font-size:24px; margin:4px 0 2px; line-height:1.35;}
  .lead{color:var(--ink-soft); font-size:14px; margin-bottom:18px;}
  .card{background:var(--paper); border:1px solid var(--line); border-radius:16px; padding:16px 18px; margin-bottom:14px;}
  .card h2{font-size:16px; margin:0 0 8px; display:flex; align-items:center; gap:6px;}
  .card p{margin:0 0 8px; font-size:14px;}
  .card p:last-child{margin-bottom:0;}
  .age-list{display:flex; flex-wrap:wrap; gap:6px; margin:0;}
  .age-chip{background:#FFF4E6; border:1px solid #F0DDB8; color:#8a5a17; border-radius:8px; padding:4px 10px; font-size:12.5px;}
  table.info-table{width:100%; border-collapse:collapse; font-size:13px;}
  table.info-table th{text-align:left; color:var(--ink-soft); font-weight:500; width:4.2em; padding:4px 8px 4px 0; vertical-align:top;}
  table.info-table td{padding:4px 0; vertical-align:top;}
  .cta-btn{display:block; text-align:center; background:var(--coral); color:#fff; text-decoration:none; font-weight:700; padding:14px; border-radius:14px; font-size:15px; margin:20px 0;}
  .cta-btn:hover{opacity:.92;}
  .cta-sub{text-align:center; font-size:12px; color:var(--ink-soft); margin-top:-14px; margin-bottom:20px;}
  .nearby-item{display:block; padding:10px 0; border-bottom:1px solid var(--line); text-decoration:none; color:var(--ink);}
  .nearby-item:last-child{border-bottom:none;}
  .nearby-item .nm{font-weight:700; font-size:14px;}
  .nearby-item .meta{font-size:12px; color:var(--ink-soft);}
  .hotel-item{padding:10px 0; border-bottom:1px solid var(--line);}
  .hotel-item:last-child{border-bottom:none;}
  .hotel-item .nm{font-weight:700; font-size:14px;}
  .hotel-item .meta{font-size:12px; color:var(--ink-soft);}
  .link-list{display:flex; flex-wrap:wrap; gap:8px; font-size:13px;}
  .link-list a{background:#fff; border:1px solid var(--line); border-radius:999px; padding:6px 12px; text-decoration:none;}
  #geoBtn{background:#fff; border:1px solid var(--line); border-radius:10px; padding:8px 14px; font-size:13px; color:var(--ink); cursor:pointer;}
  #geoResult{font-size:13px; margin-top:8px; color:var(--ink-soft);}
  footer.site-footer{text-align:center; font-size:12px; color:var(--ink-soft); padding:24px 16px 40px;}
  footer.site-footer a{color:var(--ink-soft);}
  .verified{font-size:11.5px; color:var(--ink-soft); margin-top:2px;}
</style>
</head>
<body>
<header class="site-header"><a href="${HOME_URL}">🧭 おでかけナビ</a></header>
<div class="wrap">
  <nav class="breadcrumb" aria-label="パンくずリスト">
    <a href="${HOME_URL}">おでかけナビ</a> &rsaquo;
    <a href="${d.prefHref}">${esc(d.prefLabel)}</a> &rsaquo;
    <a href="${d.cityHref}">${esc(d.cityLabel)}</a> &rsaquo;
    ${esc(s.name)}
  </nav>

  <div class="badge-row">
    <span class="badge">${esc(d.category)}</span>
    <span class="badge">📍 ${esc(d.prefLabel)}${esc(s.area || "")}</span>
  </div>
  <h1>${esc(s.name)}</h1>
  <p class="lead">${esc(d.prefLabel)}${esc(s.area || "")}にある${esc(d.category)}。子連れでのお出かけ情報をまとめました。</p>

  ${s.desc || s.tip ? `<div class="card">
    <h2>📝 おすすめポイント</h2>
    ${s.desc ? `<p>${esc(s.desc)}</p>` : ""}
    ${s.tip ? `<p>💡 ${esc(s.tip)}</p>` : ""}
  </div>` : ""}

  ${d.ageLabels.length ? `<div class="card">
    <h2>👶 対象年齢の目安</h2>
    <div class="age-list">${d.ageLabels.map((a) => `<span class="age-chip">${esc(a)}</span>`).join("")}</div>
  </div>` : ""}

  <div class="card">
    <h2>ℹ️ 基本情報</h2>
    <table class="info-table">
      ${d.stayTimeText ? `<tr><th>所要時間</th><td>${esc(d.stayTimeText)}</td></tr>` : ""}
      ${d.rainText ? `<tr><th>天候</th><td>${esc(d.rainText)}</td></tr>` : ""}
      ${s.price ? `<tr><th>料金</th><td>${esc(s.price)}</td></tr>` : ""}
      ${s.parking ? `<tr><th>駐車場</th><td>${s.parking === "yes" ? "あり" : s.parking === "no" ? "なし（周辺のコインパーキング等をご確認ください）" : esc(s.parking)}${formatParkingDetail(s.parkingDetail)}</td></tr>` : ""}
      ${s.baby ? `<tr><th>赤ちゃん・ベビーカー</th><td>${esc(s.baby)}</td></tr>` : ""}
      ${s.access ? `<tr><th>アクセス</th><td>${esc(s.access)}</td></tr>` : ""}
      ${s.lunch ? `<tr><th>食事</th><td>${esc(s.lunch)}</td></tr>` : ""}
    </table>
  </div>

  ${d.businessHoursRows ? `<div class="card">
    <h2>🕘 営業時間</h2>
    <table class="info-table">${d.businessHoursRows}</table>
    ${s.closedDays && s.closedDays.length ? `<p style="margin-top:8px;">定休日：${s.closedDays.map(esc).join("／")}</p>` : ""}
    ${s.businessHoursNote ? `<p>${esc(s.businessHoursNote)}</p>` : ""}
  </div>` : (s.closedDays && s.closedDays.length ? `<div class="card"><h2>🕘 定休日</h2><p>${s.closedDays.map(esc).join("／")}</p></div>` : "")}

  ${d.congestionRows ? `<div class="card">
    <h2>👥 混雑の目安</h2>
    <table class="info-table">${d.congestionRows}</table>
  </div>` : ""}

  <div class="card">
    <h2>📍 現在地からの距離</h2>
    <button id="geoBtn" type="button">現在地からの距離を計算する</button>
    <div id="geoResult"></div>
  </div>

  ${s.officialUrl ? `<div class="card">
    <h2>🔗 公式サイト</h2>
    <p><a href="${esc(s.officialUrl)}" target="_blank" rel="noopener">${esc(s.officialUrl)}</a></p>
    ${s.verifiedAt ? `<p class="verified">最終確認：${esc(s.verifiedAt)}</p>` : ""}
  </div>` : (s.verifiedAt ? `<p class="verified" style="margin:-6px 0 14px;">情報の最終確認：${esc(s.verifiedAt)}</p>` : "")}

  ${(s.bookingLinks && Object.keys(s.bookingLinks).length) ? `<div class="card">
    <h2>🎫 チケット・予約情報</h2>
    <div class="link-list">
      ${Object.entries(s.bookingLinks).map(([site, url]) => {
        const label = site === "asoview" ? "アソビュー" : site === "jalan" ? "じゃらん" : site;
        return `<a href="${esc(url)}" target="_blank" rel="nofollow noopener">${esc(label)}で見る</a>`;
      }).join("")}
    </div>
  </div>` : ""}

  <a class="cta-btn" href="${d.appOpenHref}">🧭 アプリ版で開く（お気に入り・行った記録・プランに追加できます）</a>
  <p class="cta-sub">アプリ版では天気・年齢・エリアなど他の条件からも探せます</p>

  ${d.nearbySpots.length ? `<div class="card">
    <h2>🚗 周辺のお出かけスポット</h2>
    ${d.nearbySpots.map((n) => `<a class="nearby-item" href="${HOME_URL}${n.slug}/">
      <div class="nm">${esc(n.spot.name)}</div>
      <div class="meta">${esc(n.spot.area || "")} ・ 約${Math.round(n.km)}km</div>
    </a>`).join("")}
  </div>` : ""}

  ${d.nearbyHotels.length ? `<div class="card">
    <h2>🏨 周辺のファミリー向けホテル</h2>
    ${d.nearbyHotels.map((n) => `<div class="hotel-item">
      <div class="nm">${esc(n.hotel.name)}</div>
      <div class="meta">${esc(n.hotel.area || "")} ・ 約${Math.round(n.km)}km${n.hotel.priceRange && n.hotel.priceRange.indexOf("要確認") < 0 ? " ・ " + esc(n.hotel.priceRange) : ""}</div>
    </div>`).join("")}
    <p style="font-size:12px; color:var(--ink-soft); margin-top:6px;">ホテルの詳細・空室検索は<a href="${HOME_URL}">トップページ</a>のホテル検索からご覧いただけます。</p>
  </div>` : ""}

  <div class="card">
    <h2>🗺 関連ページ</h2>
    <div class="link-list">
      <a href="${HOME_URL}">トップページ</a>
      <a href="${d.prefHref}">${esc(d.prefLabel)}のおでかけスポット</a>
      <a href="${d.cityHref}">${esc(d.cityLabel)}のおでかけスポット</a>
      ${d.seasonLinks.map((l) => `<a href="${l.href}">${esc(l.label)}</a>`).join("")}
    </div>
  </div>
</div>
<footer class="site-footer">
  <p>© おでかけナビ ｜ <a href="${HOME_URL}">トップページへ戻る</a></p>
</footer>
<script>
(function(){
  var btn = document.getElementById('geoBtn');
  var out = document.getElementById('geoResult');
  var lat = ${JSON.stringify(typeof s.lat === "number" ? s.lat : null)};
  var lng = ${JSON.stringify(typeof s.lng === "number" ? s.lng : null)};
  if(!btn) return;
  btn.addEventListener('click', function(){
    if(lat === null || lng === null){ out.textContent = 'この施設の位置情報が未登録のため計算できません。'; return; }
    if(!navigator.geolocation){ out.textContent = 'お使いの環境では現在地を取得できません。'; return; }
    out.textContent = '取得中…';
    navigator.geolocation.getCurrentPosition(function(pos){
      var R = 6371;
      var dLat = (lat - pos.coords.latitude) * Math.PI/180;
      var dLng = (lng - pos.coords.longitude) * Math.PI/180;
      var a = Math.sin(dLat/2)**2 + Math.cos(pos.coords.latitude*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.sin(dLng/2)**2;
      var km = R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      out.textContent = '現在地から約 ' + km.toFixed(1) + ' km です。';
    }, function(){
      out.textContent = '現在地を取得できませんでした（位置情報の利用を許可してください）。';
    });
  });
})();
</script>
</body>
</html>
`;
}

main();

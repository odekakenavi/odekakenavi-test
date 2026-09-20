#!/usr/bin/env node
// おでかけナビ 静的ページ生成ツール
// index.html の施設データ(SPOTS)から、検索エンジン向けの静的ページ一式を作る。
//   ・施設ページ  /{都道府県}/{市区町村}/{施設}/index.html
//   ・地域ページ  /{都道府県}/index.html ・ /{都道府県}/{市区町村}/index.html
//   ・季節ページ  /season/{spring|summer|autumn|winter}/index.html
//   ・sitemap.xml ・_slug_manifest.json
//
// 使い方（リポジトリ直下で実行）:
//   node tools/build-static-pages.js --out _build            … _build/ に生成（既存ファイルは触らない）
//   node tools/build-static-pages.js --compare .              … 何も書き込まず、公開中のファイル(.)との違いだけ報告
//   node tools/build-static-pages.js --index index.html --out _build --include-unpinned
//
// 方針:
//   ・既定では SLUG_OVERRIDES に登録済み（＝URL確定済み）の施設だけを対象にする。
//     未登録の施設は URL が確定していないため、--include-unpinned を付けた時だけ含める。
//   ・データは index.html の次の部分を取り出して読む（この名前・並びを変える時は、このツールも直すこと）:
//       'const SPOTS = [' から 'function spotBySlug' まで（施設・URL用の表・slug生成）／GENRES／deriveCategory
//     施設データを別ファイルへ移した時は、読み込み元をその .js に変える。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = 'https://odekakenavi.github.io/odekake-navi/';
const BASE = '/odekake-navi/';

// ------------------------------------------------------------------ 引数
const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; }
const INDEX_PATH = opt('index', 'index.html');
const OUT_DIR = opt('out', '_build');
const COMPARE_DIR = opt('compare', null);
const INCLUDE_UNPINNED = !!opt('include-unpinned', false);

// ------------------------------------------------------------------ index.html からデータ部分を取り出す
function extractMainScript(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, best = '';
  while ((m = re.exec(html))) if (m[1].length > best.length) best = m[1];
  return best;
}
function findLine(lines, prefix, from = 0) {
  for (let i = from; i < lines.length; i++) if (lines[i].startsWith(prefix)) return i;
  throw new Error('index.html に見つかりません: ' + prefix);
}
// 「const X = ...;」「function X(){...}」を、行頭の閉じ括弧までで切り出す
function extractDecl(lines, name) {
  let i = -1;
  for (let k = 0; k < lines.length; k++) if (new RegExp('^(const|function)\\s+' + name + '\\b').test(lines[k])) { i = k; break; }
  if (i < 0) throw new Error('宣言が見つかりません: ' + name);
  if (/;\s*(\/\/.*)?$/.test(lines[i]) && !/[\[{(]\s*$/.test(lines[i])) return lines[i];
  let j = i + 1;
  while (j < lines.length && !/^[}\]]\)?;?\s*$/.test(lines[j])) j++;
  return lines.slice(i, j + 1).join('\n');
}
function loadApp(indexPath) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const lines = extractMainScript(html).split('\n');
  const sp = findLine(lines, 'const SPOTS = [');
  const end = findLine(lines, 'function spotBySlug');
  let code = lines.slice(sp, end + 1).join('\n');
  code += '\n' + extractDecl(lines, 'GENRES');
  code += '\n' + extractDecl(lines, 'deriveCategory');
  code += '\nthis.__app = { SPOTS, SLUG_OVERRIDES, PREF_SLUG, DESIGNATED_CITIES, GENRES, spotSlug, baseMunicipality, deriveCategory };';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'index.html(data)' });
  return sandbox.__app;
}

// ------------------------------------------------------------------ 共通ヘルパー
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Python の json.dumps(ensure_ascii=False) と同じ書式（区切りは ", " と ": "）
function pyJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ': ' + pyJson(v[k])).join(', ') + '}';
  return JSON.stringify(v);
}
const PREF_FULL = { '東京': '東京都', '神奈川': '神奈川県', '埼玉': '埼玉県', '千葉': '千葉県', '茨城': '茨城県', '栃木': '栃木県', '群馬': '群馬県', '山梨': '山梨県', '静岡': '静岡県', '福島': '福島県', '長野': '長野県' };
const SEASONS = [
  { key: '春', slug: 'spring', emoji: '🌸', period: '2/21〜5/20' },
  { key: '夏', slug: 'summer', emoji: '☀️', period: '5/21〜8/20' },
  { key: '秋', slug: 'autumn', emoji: '🍁', period: '8/21〜11/20' },
  { key: '冬', slug: 'winter', emoji: '❄️', period: '11/21〜2/20' },
];
// メタ説明は120文字を超えたら120文字で切って「…」を付ける（コードポイント数で数える）
function clip(t, n) { const a = Array.from(t); return a.length > n ? a.slice(0, n).join('') + '…' : t; }
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // コードポイント順（JSの既定ソートと同じ）

const CSS_FAC = String.raw`
  body{font-family:"Noto Sans JP",sans-serif; background:#FBF7EF; color:#2B2620; margin:0; padding:0; line-height:1.7;}
  .wrap{max-width:640px; margin:0 auto; padding:20px 18px 60px;}
  header.site{padding:14px 18px; background:#3E8FB0;}
  header.site a{color:#fff; text-decoration:none; font-weight:700;}
  nav.breadcrumb{font-size:13px; color:#6b6258; margin:16px 0 10px;}
  nav.breadcrumb a{color:#3E8FB0; text-decoration:none;}
  h1{font-size:22px; margin:6px 0 4px;}
  .genre-badge{display:inline-block; background:#E2603A; color:#fff; border-radius:20px; padding:3px 12px; font-size:13px; margin-bottom:10px;}
  .area-line{color:#6b6258; font-size:14px; margin-bottom:14px;}
  .desc{margin:14px 0;}
  .tip{background:#FFFDF8; border:1px solid #eadfca; border-radius:10px; padding:12px 14px; font-size:14px; margin:14px 0;}
  .detail-block{margin:22px 0;}
  .detail-block h2{font-size:16px; border-left:4px solid #F4B740; padding-left:8px; margin-bottom:8px;}
  table.hours-table{border-collapse:collapse; width:100%; font-size:14px;}
  table.hours-table th, table.hours-table td{border:1px solid #eadfca; padding:4px 8px; text-align:left;}
  ul{margin:6px 0; padding-left:20px;}
  .cta{display:block; text-align:center; background:#3E8FB0; color:#fff !important; text-decoration:none; font-weight:700; padding:14px; border-radius:12px; margin:26px 0 10px;}
  .cta:hover{opacity:.9;}
  .maps-link{display:inline-block; margin-top:6px; color:#3E8FB0;}
  footer{font-size:12px; color:#928a7c; text-align:center; padding:24px 18px 40px;}
  footer a{color:#3E8FB0;}
  .verified{font-size:12px; color:#928a7c; margin-top:24px;}
`;
const CSS_REGION = String.raw`
  body{font-family:"Noto Sans JP",sans-serif; background:#FBF7EF; color:#2B2620; margin:0; padding:0; line-height:1.7;}
  .wrap{max-width:640px; margin:0 auto; padding:20px 18px 60px;}
  header.site{padding:14px 18px; background:#3E8FB0;}
  header.site a{color:#fff; text-decoration:none; font-weight:700;}
  nav.breadcrumb{font-size:13px; color:#6b6258; margin:16px 0 10px;}
  nav.breadcrumb a{color:#3E8FB0; text-decoration:none;}
  h1{font-size:21px; margin:6px 0 4px;}
  .count-badge{display:inline-block; background:#E2603A; color:#fff; border-radius:20px; padding:3px 12px; font-size:13px; margin-bottom:14px;}
  .intro{margin:10px 0 20px; font-size:14px; color:#4a443c;}
  .section-title{font-size:16px; border-left:4px solid #F4B740; padding-left:8px; margin:26px 0 10px;}
  .genre-badge-row{display:flex; flex-wrap:wrap; gap:8px;}
  .genre-badge-item{background:#fff; border:1px solid #eadfca; border-radius:999px; padding:7px 14px; font-size:13px; font-weight:600;}
  .link-grid{display:grid; grid-template-columns:1fr 1fr; gap:10px;}
  .link-card{display:block; background:#fff; border:1px solid #eadfca; border-radius:10px; padding:12px 14px; text-decoration:none; color:#2B2620;}
  .link-card .lc-name{font-weight:700; font-size:14px;}
  .link-card .lc-count{font-size:12px; color:#928a7c; margin-top:2px;}
  .facility-list{list-style:none; margin:0; padding:0;}
  .facility-list li{margin-bottom:10px;}
  .facility-list a{display:block; background:#fff; border:1px solid #eadfca; border-radius:10px; padding:12px 14px; text-decoration:none; color:#2B2620; font-size:14px; font-weight:600;}
  .facility-list a .fa-area{display:block; font-weight:400; font-size:12px; color:#928a7c; margin-top:2px;}
  .cta{display:block; text-align:center; background:#3E8FB0; color:#fff !important; text-decoration:none; font-weight:700; padding:14px; border-radius:12px; margin:26px 0 10px;}
  footer{font-size:12px; color:#928a7c; text-align:center; padding:24px 18px 40px;}
  footer a{color:#3E8FB0;}
`;
const CSS_SEASON = String.raw`
  body{font-family:"Noto Sans JP",sans-serif; background:#FBF7EF; color:#2B2620; margin:0; padding:0; line-height:1.7;}
  .wrap{max-width:640px; margin:0 auto; padding:20px 18px 60px;}
  header.site{padding:14px 18px; background:#3E8FB0;}
  header.site a{color:#fff; text-decoration:none; font-weight:700;}
  nav.breadcrumb{font-size:13px; color:#6b6258; margin:16px 0 10px;}
  nav.breadcrumb a{color:#3E8FB0; text-decoration:none;}
  h1{font-size:22px; margin:6px 0 4px;}
  .period-badge{display:inline-block; background:#F4B740; color:#2B2620; border-radius:20px; padding:3px 14px; font-size:13px; margin-bottom:6px; font-weight:700;}
  .count-badge{display:inline-block; background:#E2603A; color:#fff; border-radius:20px; padding:3px 12px; font-size:13px; margin-bottom:14px; margin-left:6px;}
  .intro{margin:10px 0 20px; font-size:14px; color:#4a443c;}
  .season-nav{display:flex; gap:8px; margin:10px 0 22px; flex-wrap:wrap;}
  .season-nav a{flex:1; min-width:70px; text-align:center; background:#fff; border:1px solid #eadfca; border-radius:10px; padding:8px 4px; text-decoration:none; color:#2B2620; font-size:13px; font-weight:700;}
  .season-nav a.current{border-color:#E2603A; background:#FFF1E6;}
  .region-block{margin:26px 0;}
  .region-title{font-size:16px; border-left:4px solid #F4B740; padding-left:8px; margin-bottom:2px;}
  .region-title a{color:#2B2620; text-decoration:none;}
  .region-sub{font-size:12px; color:#928a7c; margin:0 0 10px 12px;}
  .facility-list{list-style:none; margin:0; padding:0;}
  .facility-list li{margin-bottom:10px;}
  .facility-list a{display:block; background:#fff; border:1px solid #eadfca; border-radius:10px; padding:12px 14px; text-decoration:none; color:#2B2620; font-size:14px; font-weight:600;}
  .facility-list a .fa-area{display:block; font-weight:400; font-size:12px; color:#928a7c; margin-top:2px;}
  .cta{display:block; text-align:center; background:#3E8FB0; color:#fff !important; text-decoration:none; font-weight:700; padding:14px; border-radius:12px; margin:26px 0 10px;}
  footer{font-size:12px; color:#928a7c; text-align:center; padding:24px 18px 40px;}
  footer a{color:#3E8FB0;}
`;

const FOOTER = `<footer>
  データ出典・運営者情報・免責事項は<a href="${BASE}">おでかけナビ トップページ</a>の「よくある質問」「運営者について」でご確認いただけます。<br>
  © おでかけナビ
</footer>
</body>
</html>
`;
function head(title, description, canonical, jsonlds, css, blankBeforeStyle = false) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="おでかけナビ">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${jsonlds.map(j => `<script type="application/ld+json">${pyJson(j)}</script>`).join('\n')}
${blankBeforeStyle ? '\n' : ''}<style>${css}</style>
</head>
<body>
<header class="site"><a href="${BASE}">🧭 おでかけナビ</a></header>
<div class="wrap">
`;
}
const breadcrumbLd = items => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => Object.assign({ '@type': 'ListItem', position: i + 1, name: it[0] }, it[1] ? { item: it[1] } : {})) });
const itemListLd = (name, items) => ({ '@context': 'https://schema.org', '@type': 'ItemList', name, numberOfItems: items.length, itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it[0], url: it[1] })) });

// 表示用の市区町村名：郡は省く（「足柄下郡箱根町」→「箱根町」）
function cityDisplay(base) { return base.indexOf('郡') !== -1 ? base.replace(/^.+?郡/, '') : base; }
// ------------------------------------------------------------------ 施設データの整理
function prepare(app) {
  const rows = [];
  app.SPOTS.forEach(spot => {
    const pinned = Object.prototype.hasOwnProperty.call(app.SLUG_OVERRIDES, spot.name);
    if (!pinned && !INCLUDE_UNPINNED) return;
    const slug = app.spotSlug(spot);
    const [prefSlug, citySlug] = slug.split('/');
    rows.push({
      spot, slug, prefSlug, citySlug,
      prefFull: PREF_FULL[spot.region] || spot.region,
      city: cityDisplay(app.baseMunicipality(spot.area)),
      genre: app.deriveCategory(spot),
      explicitGenre: spot.genre || null,
    });
  });
  return rows;
}

// ------------------------------------------------------------------ 施設ページ
const WD = [['mon', '月'], ['tue', '火'], ['wed', '水'], ['thu', '木'], ['fri', '金'], ['sat', '土'], ['sun', '日'], ['holiday', '祝']];
function minutesLabel(m) { const h = Math.floor(m / 60), r = m % 60; return h && r ? `${h}時間${r}分` : h ? `${h}時間` : `${r}分`; }
function facilityPage(row) {
  const s = row.spot;
  const url = SITE + row.slug + '/';
  const title = `${s.name}｜子連れお出かけ情報｜おでかけナビ`;
  const description = clip(`${s.name}（${row.prefFull}${s.area}）の子連れお出かけ情報。${s.desc}`, 120);
  const ld1 = breadcrumbLd([['おでかけナビ', SITE], [row.prefFull, `${SITE}${row.prefSlug}/`], [row.city, `${SITE}${row.prefSlug}/${row.citySlug}/`], [s.name, url]]);
  const ld2 = { '@context': 'https://schema.org', '@type': 'TouristAttraction', name: s.name, description, url,
    address: { '@type': 'PostalAddress', addressRegion: row.prefFull, addressLocality: s.area },
    geo: { '@type': 'GeoCoordinates', latitude: s.lat, longitude: s.lng },
    sameAs: s.officialUrl || undefined };
  let h = head(title, description, url, [ld1, ld2], CSS_FAC);
  h += `<nav class="breadcrumb">
  <a href="${BASE}">おでかけナビ</a> ／ <a href="${BASE}${row.prefSlug}/">${esc(row.prefFull)}</a> ／ <a href="${BASE}${row.prefSlug}/${row.citySlug}/">${esc(row.city)}</a> ／ ${esc(s.name)}
</nav>
<h1>${esc(s.name)}</h1>
<div class="genre-badge">${esc(row.genre)}</div>
<div class="area-line">📍 ${esc(row.prefFull)}${esc(s.area)}</div>
<div class="desc">${esc(s.desc)}</div>
`;
  if (s.tip) h += `<div class="tip">💡 ${esc(s.tip)}</div>\n`;
  const block = (title, inner) => `\n<div class="detail-block">\n  <h2>${title}</h2>\n  ${inner}\n</div>`;
  const parts = [];
  parts.push(block('💰 料金', `<p>${esc(s.price)}</p>`));
  parts.push(block('🅿️ 駐車場', `<p>${s.parking === 'yes' ? 'あり' : 'なし（周辺のコインパーキング等をご検討ください）'}</p>`));
  const q = encodeURIComponent(`${s.name} ${s.area}`);
  parts.push(block('🚃 アクセス', `<p>${esc(s.access)}</p>\n  <a class="maps-link" href="https://www.google.com/maps/search/?api=1&amp;query=${q}" target="_blank" rel="noopener nofollow">📍 Googleマップで見る</a>`));
  parts.push(block('👶 対象年齢の目安', `<p>${esc((s.ages || []).join('、'))}</p>`));
  parts.push(block('⏱️ おすすめ滞在時間', `<p>${s.stayTime ? `目安 ${minutesLabel(s.stayTime.minMinutes)}〜${minutesLabel(s.stayTime.maxMinutes)}` : '情報なし'}</p>`));
  parts.push(block('☔ 天気との相性', `<p>${esc((s.weather || []).join('、'))}</p>`));
  parts.push(block('👨‍👩‍👧 子連れ向け情報', `<p>${esc(s.baby)}</p>`));
  let hours;
  if (s.businessHours) hours = `<table class="hours-table">${WD.map(([k, l]) => `<tr><th>${l}</th><td>${esc(s.businessHours[k] || '')}</td></tr>`).join('')}</table>`;
  else if (s.businessHoursNote && s.__noteOK) hours = `<p>${esc(s.businessHoursNote)}</p>`;
  else hours = '<p>情報なし（公式サイト等でご確認ください）</p>';
  parts.push(block('🕐 営業時間', hours));
  parts.push(block('🚫 定休日', s.closedDays && s.closedDays.length ? `<ul>${s.closedDays.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '<p>情報なし</p>'));
  parts.push(block('🔗 公式サイト', s.officialUrl ? `<p><a href="${esc(s.officialUrl)}" target="_blank" rel="noopener nofollow">公式サイトを見る</a></p>` : '<p>公式サイト情報なし（施設名で検索してご確認ください）</p>'));
  h += parts.join('');
  const BK = { asoview: 'あそびゅー！', jalan: 'じゃらん' };
  const bl = s.bookingLinks ? Object.keys(s.bookingLinks).filter(k => BK[k] && s.bookingLinks[k]) : [];
  const booking = bl.length ? `<div class="detail-block"><h2>🎟️ 予約情報</h2><ul>${bl.map(k => `<li><a href="${esc(s.bookingLinks[k])}" target="_blank" rel="noopener nofollow">${BK[k]}で見る</a></li>`).join('')}</ul></div>` : '';
  h += '\n' + booking;
  const verified = s.verifiedAt ? `<div class="verified">✅ 情報確認日：${esc(s.verifiedAt)}</div>` : '';
  h += `\n\n<a class="cta" href="${BASE}?spot=${encodeURIComponent(s.name)}">🧭 天気・行き方・混雑状況をおでかけナビアプリで見る</a>\n\n${verified}\n</div>\n` + FOOTER;
  return h;
}

// ------------------------------------------------------------------ 地域ページ・季節ページ
const A = (href, inner) => `<a href="${href}">${inner}</a>`;
const li = r => `<li><a href="${BASE}${r.slug}/">${esc(r.spot.name)}<span class="fa-area">${esc(r.spot.area)}</span></a></li>`;
const card = (href, name, count) => `<a class="link-card" href="${href}"><span class="lc-name">${esc(name)}</span><span class="lc-count">${count}件</span></a>`;
const byCountDesc = (arr, first) => arr.map((x, i) => [x, i]).sort((a, b) => (b[0].count - a[0].count) || (first ? first(a[0], b[0]) : 0) || (a[1] - b[1])).map(x => x[0]);

function buildRegions(app, rows) {
  const designated = app.DESIGNATED_CITIES;
  const prefs = new Map();   // prefSlug -> {short, full, rows, cities:Map, parents:Map, seasons}
  rows.forEach(r => {
    const base = app.baseMunicipality(r.spot.area);
    const D = designated.find(d => base === d || base.indexOf(d) === 0);
    let p = prefs.get(r.prefSlug);
    if (!p) { p = { slug: r.prefSlug, short: r.spot.region, full: r.prefFull, rows: [], cities: new Map(), parents: new Map(), rawCities: new Map() }; prefs.set(r.prefSlug, p); }
    p.rows.push(r);
    // 施設ページの上位リンク先＝slugの2番目
    const raw = p.rawCities.get(r.citySlug) || { slug: r.citySlug, name: r.city, count: 0 };
    raw.count++; p.rawCities.set(r.citySlug, raw);
    if (D) {
      const parentSlug = r.citySlug.replace(/-city$/, '').split('-')[0];
      let par = p.parents.get(parentSlug);
      if (!par) { par = { slug: parentSlug, name: D, count: 0, wards: new Map(), direct: [] }; p.parents.set(parentSlug, par); }
      par.count++;
      if (base === D) { par.direct.push(r); par.directSlug = r.citySlug; }
      else {
        let w = par.wards.get(r.citySlug);
        if (!w) { w = { slug: r.citySlug, name: base, count: 0, rows: [], parent: par }; par.wards.set(r.citySlug, w); p.cities.set(r.citySlug, w); }
        w.count++; w.rows.push(r);
      }
    } else {
      let c = p.cities.get(r.citySlug);
      if (!c) { c = { slug: r.citySlug, name: r.city, count: 0, rows: [], parent: null }; p.cities.set(r.citySlug, c); }
      c.count++; c.rows.push(r);
    }
  });
  return prefs;
}

function prefPage(p) {
  const url = `${SITE}${p.slug}/`;
  const rawList = byCountDesc([...p.rawCities.values()]);
  const top = rawList.slice(0, 4).map(c => c.name).join('・');
  // 一覧に出すのは、政令指定都市を親（市）にまとめた単位
  const parents = byCountDesc([...p.parents.values()]);
  const normals = byCountDesc([...p.cities.values()].filter(c => !c.parent));
  const cards = parents.concat(normals);
  const title = `${p.full}の子連れお出かけスポット｜おでかけナビ`;
  const description = `${p.full}内の子連れお出かけスポットを市区町村ごとにまとめています。現在${p.rows.length}件のスポットを掲載。${top}など。`;
  const ld1 = breadcrumbLd([['おでかけナビ', SITE], [p.full]]);
  const ld2 = itemListLd(`${p.full}の市区町村一覧`, cards.map(c => [c.name, `${SITE}${p.slug}/${c.slug}/`]));
  let h = head(title, description, url, [ld1, ld2], CSS_REGION, true);
  h += `<nav class="breadcrumb"><a href="${SITE}">おでかけナビ</a> ／ ${esc(p.full)}</nav>
<h1>📍${esc(p.full)}のお出かけ特集</h1>
<div class="count-badge">登録スポット数：${p.rows.length}件</div>
<p class="intro">${esc(p.full.replace(/[都道府県]$/, ''))}${p.full.endsWith('都') ? '都' : '県'}内の子連れお出かけスポットを市区町村ごとにまとめています。現在${p.rows.length}件を掲載。エリアは${top}など${p.rawCities.size}市区町村に分かれています。</p>
`;
  // 人気カテゴリ（施設データに genre が明示されているものだけ数える）
  const gc = new Map();
  p.rows.forEach(r => { if (r.explicitGenre) gc.set(r.explicitGenre, (gc.get(r.explicitGenre) || 0) + 1); });
  const gorder = p.genres;
  // 同数の時は、データに最初に現れた順（gc は最初に現れた順に並ぶ）
  const gl = [...gc.entries()].map(([k, n], i) => ({ key: k, count: n, first: i, idx: gorder.findIndex(g => g.key === k) })).sort((a, b) => (b.count - a.count) || (a.first - b.first)).slice(0, 3);
  if (gl.length) h += `<div class="section-title">🏷️ 人気カテゴリ</div><div class="genre-badge-row">${gl.map(g => `<span class="genre-badge-item">${gorder[g.idx].label.split(' ')[0]}${esc(g.key)}（${g.count}件）</span>`).join('')}</div>`;
  h += `<div class="section-title">📍 市区町村から探す</div><div class="link-grid">${cards.map(c => card(`${BASE}${p.slug}/${c.slug}/`, c.name, c.count)).join('')}</div>\n`;
  const sl = SEASONS.map(se => ({ se, n: p.rows.filter(r => (r.spot.seasons || []).includes(se.key)).length })).filter(x => x.n > 0);
  if (sl.length) h += `<div class="section-title">季節から探す</div><div class="link-grid">${sl.map(x => card(`${BASE}season/${x.se.slug}/#region-${p.slug}`, `${x.se.emoji} ${x.se.key}のお出かけ`, x.n)).join('')}</div>`;
  h += `\n<a class="cta" href="${BASE}?region=${p.short}">🧭 おでかけナビで検索・絞り込みして探す</a>\n</div>\n` + FOOTER;
  return h;
}

// 市区町村ページ（ふつうの市・政令市の区）と、政令市の親ページ
function cityPage(p, c) {
  const url = `${SITE}${p.slug}/${c.slug}/`;
  const list = c.rows.slice().sort((a, b) => cmp(a.spot.name, b.spot.name));
  const title = `${c.name}の子連れお出かけスポット｜おでかけナビ`;
  const description = `${c.name}内の子連れお出かけスポット一覧。現在${list.length}件を掲載。施設ごとの詳しい情報（料金・駐車場・アクセス等）も見られます。`;
  const crumbs = [['おでかけナビ', SITE], [p.full, `${SITE}${p.slug}/`]];
  if (c.parent) crumbs.push([c.parent.name, `${SITE}${p.slug}/${c.parent.slug}/`]);
  crumbs.push([c.name]);
  const ld1 = breadcrumbLd(crumbs);
  const ld2 = itemListLd(`${c.name}の子連れお出かけスポット一覧`, list.map(r => [r.spot.name, `${SITE}${r.slug}/`]));
  let h = head(title, description, url, [ld1, ld2], CSS_REGION, true);
  h += `<nav class="breadcrumb">${crumbs.map((x, i) => i === crumbs.length - 1 ? esc(x[0]) : A(x[1], esc(x[0]))).join(' ／ ')}</nav>
<h1>${esc(c.name)}の子連れお出かけスポット</h1>
<div class="count-badge">登録スポット数：${list.length}件</div>
<p class="intro">${esc(c.name)}で「おでかけナビ」に登録されている子連れお出かけスポット一覧です。</p>

<div class="section-title">🏞️ 施設一覧</div><ul class="facility-list">${list.map(li).join('')}</ul>
<a class="cta" href="${BASE}">🧭 おでかけナビで検索・絞り込みして探す</a>
</div>
` + FOOTER;
  return h;
}
function parentPage(p, par) {
  const url = `${SITE}${p.slug}/${par.slug}/`;
  const direct = par.direct.slice().sort((a, b) => cmp(a.spot.name, b.spot.name));
  const wards = [...par.wards.values()].sort((a, b) => cmp(a.slug, b.slug));
  const all = wards.flatMap(w => w.rows).concat(direct).sort((a, b) => cmp(a.spot.name, b.spot.name));
  const title = `${par.name}の子連れお出かけスポット｜おでかけナビ`;
  const description = `${par.name}内の子連れお出かけスポットを区ごとにまとめています。現在${par.count}件のスポットを掲載。`;
  const crumbs = [['おでかけナビ', SITE], [p.full, `${SITE}${p.slug}/`], [par.name]];
  const ld1 = breadcrumbLd(crumbs);
  const ld2 = itemListLd(`${par.name}の区・施設一覧`, wards.map(w => [w.name, `${SITE}${p.slug}/${w.slug}/`]).concat(direct.map(r => [r.spot.name, `${SITE}${r.slug}/`])));
  let h = head(title, description, url, [ld1, ld2], CSS_REGION, true);
  h += `<nav class="breadcrumb">${A(SITE, 'おでかけナビ')} ／ ${A(`${SITE}${p.slug}/`, esc(p.full))} ／ ${esc(par.name)}</nav>
<h1>${esc(par.name)}の子連れお出かけスポット</h1>
<div class="count-badge">登録スポット数：${par.count}件</div>
<p class="intro">${esc(par.name)}内で「おでかけナビ」に登録されている子連れお出かけスポットです。</p>
<div class="section-title">📍 区から探す</div><div class="link-grid">${wards.map(w => card(`${BASE}${p.slug}/${w.slug}/`, w.name, w.count)).join('')}</div>
`;
  h += (direct.length ? `<div class="section-title">🏞️ 施設一覧</div><ul class="facility-list">${direct.map(li).join('')}</ul>` : '');
  h += `\n<a class="cta" href="${BASE}">🧭 おでかけナビで検索・絞り込みして探す</a>\n</div>\n` + FOOTER;
  return h;
}

function seasonPage(se, rows, prefs) {
  const url = `${SITE}season/${se.slug}/`;
  const inSeason = rows.filter(r => (r.spot.seasons || []).includes(se.key));
  const blocks = [...prefs.values()].map(p => ({ p, list: inSeason.filter(r => r.prefSlug === p.slug).sort((a, b) => cmp(a.spot.name, b.spot.name)) }))
    .filter(b => b.list.length)
    // 同数の時は、その季節の施設がデータに最初に現れた都県の順
    .map(b => Object.assign(b, { count: b.list.length, ord: inSeason.findIndex(r => r.prefSlug === b.p.slug) }))
    .sort((a, b) => (b.count - a.count) || (a.ord - b.ord));
  const flat = blocks.flatMap(b => b.list);
  const title = `${se.key}のおすすめ子連れお出かけスポット｜おでかけナビ`;
  const description = `${se.key}（${se.period}）におすすめの子連れお出かけスポットを${flat.length}件掲載。施設データに登録されている季節情報をもとに選んでいます。`;
  const ld1 = breadcrumbLd([['おでかけナビ', SITE], [`${se.key}のお出かけ`]]);
  const ld2 = itemListLd(`${se.key}のおすすめ子連れお出かけスポット一覧`, flat.map(r => [r.spot.name, `${SITE}${r.slug}/`]));
  let h = head(title, description, url, [ld1, ld2], CSS_SEASON, true);
  h += `<nav class="breadcrumb"><a href="${SITE}">おでかけナビ</a> ／ ${se.key}のお出かけ</nav>
<div class="period-badge">${se.period}</div>
<div class="count-badge">${flat.length}件掲載</div>
<h1>${se.emoji} ${se.key}のおすすめ子連れお出かけスポット</h1>
<p class="intro">「おでかけナビ」に登録されているスポットの中から、${se.key}（${se.period}）におすすめの子連れお出かけスポットをまとめました。都道府県ごとに探せます。</p>
<div class="season-nav">${SEASONS.map(x => `<a class="season-nav-item${x === se ? ' current' : ''}" href="${BASE}season/${x.slug}/">${x.emoji} ${x.key}</a>`).join('')}</div>
${blocks.map(b => `<div class="region-block" id="region-${b.p.slug}"><div class="region-title"><a href="${BASE}${b.p.slug}/">${esc(b.p.full)}</a>（${b.count}件）</div><div class="region-sub">この地域のスポット一覧は<a href="${BASE}${b.p.slug}/">${esc(b.p.full)}のページ</a>でも見られます</div><ul class="facility-list">${b.list.map(li).join('')}</ul></div>`).join('')}
<a class="cta" href="${BASE}">🧭 おでかけナビで検索・絞り込みして探す</a>
</div>
` + FOOTER;
  return h;
}

function sitemapXml(prefs, rows) {
  const ent = (rel, cf, pr) => `<url>\n<loc>${SITE}${rel}</loc>\n<changefreq>${cf}</changefreq>\n<priority>${pr}</priority>\n</url>\n`;
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  x += ent('', 'daily', '1.0');
  SEASONS.slice().sort((a, b) => cmp(a.slug, b.slug)).forEach(se => { x += ent(`season/${se.slug}/`, 'weekly', '0.9'); });
  [...prefs.values()].sort((a, b) => cmp(a.slug, b.slug)).forEach(p => {
    x += ent(`${p.slug}/`, 'weekly', '0.9');
    const slugs = new Set([...p.cities.keys(), ...p.parents.keys(), ...[...p.parents.values()].filter(x => x.direct.length).map(x => x.directSlug)]);
    [...slugs].sort(cmp).forEach(s => { x += ent(`${p.slug}/${s}/`, 'weekly', '0.8'); });
  });
  rows.forEach(r => { x += ent(`${r.slug}/`, 'monthly', '0.7'); });
  return x + '</urlset>\n';
}

// ------------------------------------------------------------------ 生成の本体
function main() {
  const app = loadApp(INDEX_PATH);
  const rows = prepare(app);
  const files = new Map(); // 相対パス -> 内容
  rows.forEach(r => files.set(`${r.slug}/index.html`, facilityPage(r)));
  const prefs = buildRegions(app, rows);
  prefs.forEach(p => {
    p.genres = app.GENRES;
    files.set(`${p.slug}/index.html`, prefPage(p));
    p.cities.forEach(c => files.set(`${p.slug}/${c.slug}/index.html`, cityPage(p, c)));
    p.parents.forEach(par => {
      files.set(`${p.slug}/${par.slug}/index.html`, parentPage(p, par));
      // 区の指定がない施設（例：横浜市みなとみらい）は、専用の一覧ページを別に持つ
      if (par.direct.length) files.set(`${p.slug}/${par.directSlug}/index.html`, cityPage(p, { slug: par.directSlug, name: `${par.name}（区指定なしのスポット）`, rows: par.direct, parent: null }));
    });
  });
  SEASONS.forEach(se => files.set(`season/${se.slug}/index.html`, seasonPage(se, rows, prefs)));
  files.set('sitemap.xml', sitemapXml(prefs, rows));
  files.set('_slug_manifest.json', JSON.stringify(rows.map(r => ({ name: r.spot.name, slug: r.slug })), null, 1));
  return { app, rows, files };
}
module.exports = { main };
function walkIndexPages(root) {
  const out = [];
  (function rec(dir, rel) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) { if (d.name === '.git' || d.name === 'node_modules' || d.name === 'experiences' || d.name === 'tools') continue; rec(path.join(dir, d.name), rel ? rel + '/' + d.name : d.name); }
      else if (d.name === 'index.html' && rel) out.push(rel + '/index.html');
    }
  })(root, '');
  return out;
}
if (require.main === module) {
  const { app, rows, files } = main();
  // 念のための点検：slugの重複・固定表にあるのにデータに無い施設
  const seen = new Set();
  rows.forEach(r => { if (seen.has(r.slug)) console.error('警告: slug重複 ' + r.slug); seen.add(r.slug); });
  const names = new Set(app.SPOTS.map(s => s.name));
  Object.keys(app.SLUG_OVERRIDES).forEach(n => { if (!names.has(n)) console.error('警告: SLUG_OVERRIDES にあるが SPOTS に無い施設: ' + n); });
  const unpinned = app.SPOTS.filter(s => !Object.prototype.hasOwnProperty.call(app.SLUG_OVERRIDES, s.name));
  if (unpinned.length && !INCLUDE_UNPINNED) console.log(`注意: URL未確定（SLUG_OVERRIDES に未登録）の ${unpinned.length} 施設は生成対象から外しています。`);

  if (COMPARE_DIR) {
    // 公開中のファイルと比較するだけ（何も書き込まない）
    let same = 0; const diff = [], missing = [];
    for (const [rel, body] of files) {
      const p = path.join(COMPARE_DIR, rel);
      if (!fs.existsSync(p)) { missing.push(rel); continue; }
      (fs.readFileSync(p, 'utf8') === body ? (same++, null) : diff.push(rel));
    }
    const gen = new Set([...files.keys()]);
    const onlyPublished = walkIndexPages(COMPARE_DIR).filter(r => !gen.has(r));
    console.log(`生成 ${files.size} ファイル: 公開中と同一 ${same}／内容が違う ${diff.length}／公開中に無い ${missing.length}／生成されなかった公開中ページ ${onlyPublished.length}`);
    diff.slice(0, 20).forEach(r => console.log('  違い: ' + r));
    if (diff.length > 20) console.log(`  …ほか ${diff.length - 20} 件`);
    missing.slice(0, 20).forEach(r => console.log('  新規: ' + r));
    onlyPublished.forEach(r => console.log('  生成されず: ' + r));
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [rel, body] of files) { const p = path.join(OUT_DIR, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
    console.log(`${files.size} ファイルを ${OUT_DIR}/ に生成しました`);
  }
}

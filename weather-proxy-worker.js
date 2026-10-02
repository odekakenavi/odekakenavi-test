// Cloudflare Workers: WeatherAPI.com 中継（APIキーをブラウザに出さないため）
//
// 設定（Workers の Settings > Variables and Secrets）
//   WEATHERAPI_KEY  : Secret。WeatherAPI.com のAPIキー
//   ALLOWED_ORIGINS : Text。許可するサイトのオリジン（カンマ区切り）
//                     例: https://youraccount.github.io
//
// 呼び出し: GET https://<worker>.workers.dev/?lat=35.68&lng=139.76

const JAPAN_BOUNDS = { latMin: 24, latMax: 46, lngMin: 122, lngMax: 146 };
const EDGE_CACHE_SECONDS = 3 * 60 * 60;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";

    if (!allowed.includes(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, origin);
    }

    const url = new URL(request.url);
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < JAPAN_BOUNDS.latMin || lat > JAPAN_BOUNDS.latMax ||
      lng < JAPAN_BOUNDS.lngMin || lng > JAPAN_BOUNDS.lngMax
    ) {
      return json({ error: "bad_coordinates" }, 400, origin);
    }

    // 小数第2位に丸めて、キャッシュ効率を上げる
    const rLat = Math.round(lat * 100) / 100;
    const rLng = Math.round(lng * 100) / 100;

    const cacheKey = new Request(`https://weather-cache.invalid/${rLat},${rLng}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(hit.body, { status: 200, headers: { ...Object.fromEntries(hit.headers), ...corsHeaders(origin) } });
    }

    const upstream =
      "https://api.weatherapi.com/v1/forecast.json" +
      `?key=${encodeURIComponent(env.WEATHERAPI_KEY)}` +
      `&q=${rLat},${rLng}&days=3&aqi=no&alerts=no`;

    let res;
    try {
      res = await fetch(upstream);
    } catch (e) {
      return json({ error: "upstream_unreachable" }, 502, origin);
    }
    if (!res.ok) {
      // 上流のエラー内容（キーを含みうる）はそのまま返さない
      return json({ error: "upstream_error", status: res.status }, 502, origin);
    }

    const src = await res.json();
    const days = (src && src.forecast && src.forecast.forecastday) || [];
    const slim = {
      forecast: {
        forecastday: days.map((f) => ({
          date: f.date,
          // 午前（6〜12時）・午後（12〜18時）の計算用に、日中の時間ごとのデータだけを渡す
          hour: (f.hour || [])
            .map((x) => ({
              h: parseInt(String(x.time || "").slice(11, 13), 10),
              c: x.condition && x.condition.code,
              r: x.chance_of_rain,
              s: x.chance_of_snow,
            }))
            .filter((x) => x.h >= 6 && x.h < 18),
          day: {
            maxtemp_c: f.day && f.day.maxtemp_c,
            mintemp_c: f.day && f.day.mintemp_c,
            daily_chance_of_rain: f.day && f.day.daily_chance_of_rain,
            daily_chance_of_snow: f.day && f.day.daily_chance_of_snow,
            condition: { code: f.day && f.day.condition && f.day.condition.code },
          },
        })),
      },
    };

    const body = JSON.stringify(slim);
    const out = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${EDGE_CACHE_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${EDGE_CACHE_SECONDS}`,
        ...corsHeaders(origin),
      },
    });
  },
};

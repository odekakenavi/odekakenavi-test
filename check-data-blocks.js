#!/usr/bin/env node
// 施設（data/spots.json があればそれ、無ければ index.html 内の DATA-BLOCK）とホテル（index.html 内の DATA-BLOCK）の整合を確認するだけのツール。
// ファイルは一切書き換えない。使い方:  node tools/check-data-blocks.js [index.html]
//   確認すること: ①データだけで単独評価できる（他の変数・関数に依存しない） ②JSONにできない値が無い
//                 ③JSON往復で内容が同一 ④施設名の重複が無い ⑤hotelArea の参照先が FAMILY_HOTELS に在る ⑥ホテルの地域メタが揃っている
const fs = require('fs'), vm = require('vm');
const file = process.argv[2] || 'index.html';
const lines = fs.readFileSync(file, 'utf8').split('\n');
let failed = 0;
const fail = (msg) => { failed++; console.log('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);

function block(begin, end) {
  const b = lines.findIndex(l => l.includes('DATA-BLOCK BEGIN: ' + begin));
  const e = lines.findIndex((l, i) => i > b && l.includes('DATA-BLOCK END: ' + end));
  if (b < 0 || e < 0) { fail(begin + ' の DATA-BLOCK BEGIN/END が見つからない'); return null; }
  return lines.slice(b + 1, e).join('\n');
}
function evalPure(text, names) {
  try { return vm.runInContext(text + '\n;({' + names.join(',') + '})', vm.createContext({}), { timeout: 30000 }); }
  catch (err) { fail('単独評価に失敗（外部の変数・関数を参照している可能性）: ' + err.message); return null; }
}
function unsafe(v, path, out) {
  if (v === undefined) out.push(path + ' = undefined');
  else if (typeof v === 'function') out.push(path + ' = function');
  else if (typeof v === 'number' && !isFinite(v)) out.push(path + ' = NaN/Infinity');
  else if (v instanceof Date || v instanceof RegExp || v instanceof Map || v instanceof Set) out.push(path + ' = ' + v.constructor.name);
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) unsafe(v[k], path + '.' + k, out);
}
function roundTrip(label, obj) {
  const bad = []; unsafe(obj, label, bad);
  bad.length ? fail(label + ' にJSONにできない値: ' + bad.slice(0, 3).join(', ')) : pass(label + ' にJSONにできない値は無い');
  const s = JSON.stringify(obj);
  s === JSON.stringify(JSON.parse(s)) ? pass(label + ' はJSON往復で同一（' + Math.round(s.length / 1024) + ' KB）') : fail(label + ' がJSON往復で変わる');
}

console.log('施設データ（SPOTS）');
let SPOTS = [];
const jsonPath = require('path').join(require('path').dirname(file), 'data', 'spots.json');
if (fs.existsSync(jsonPath)) {
  // 外部化済み：data/spots.json を検証する
  try { SPOTS = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); pass('data/spots.json を読み込めた：' + SPOTS.length + '件'); }
  catch (err) { fail('data/spots.json がJSONとして不正: ' + err.message); }
  if (!Array.isArray(SPOTS) || !SPOTS.length) { fail('data/spots.json が空、または配列ではない'); SPOTS = []; }
  const need = ['region', 'name', 'area', 'lat', 'lng', 'ages', 'weather', 'duration', 'price', 'parking', 'access', 'desc'];
  const lacking = SPOTS.filter(s => need.some(k => s[k] === undefined)).map(s => s.name || '(名前なし)');
  lacking.length ? fail('必須項目が欠けている施設: ' + lacking.slice(0, 5).join(' / ')) : pass('全施設に必須項目（' + need.join('/') + '）がある');
  const badGeo = SPOTS.filter(s => !(typeof s.lat === 'number' && typeof s.lng === 'number' && isFinite(s.lat) && isFinite(s.lng))).map(s => s.name);
  badGeo.length ? fail('緯度経度が数値でない: ' + badGeo.slice(0, 5).join(' / ')) : pass('緯度経度はすべて数値');
} else {
  const spText = block('SPOTS', 'SPOTS');
  const sp = spText && evalPure(spText, ['SPOTS']);
  if (sp) { SPOTS = sp.SPOTS; pass('単独評価OK：' + SPOTS.length + '件'); }
}
if (SPOTS.length) {
  roundTrip('SPOTS', SPOTS);
  const seen = new Set(), dup = [];
  SPOTS.forEach(s => { seen.has(s.name) ? dup.push(s.name) : seen.add(s.name); });
  dup.length ? fail('施設名の重複: ' + dup.slice(0, 5).join(' / ')) : pass('施設名（＝主キー）の重複なし');
}
console.log('ホテルデータ');
const hoText = block('FAMILY_HOTELS', 'FAMILY_HOTELS');
const ho = hoText && evalPure(hoText, ['FAMILY_HOTELS', 'HOTEL_AREA_META', 'HOTEL_PREF_ORDER']);
if (ho) {
  const areas = Object.keys(ho.FAMILY_HOTELS), meta = Object.keys(ho.HOTEL_AREA_META);
  pass('単独評価OK：' + areas.length + 'エリア／' + areas.reduce((n, a) => n + ho.FAMILY_HOTELS[a].length, 0) + '件');
  roundTrip('HOTELS', ho);
  const noMeta = areas.filter(a => !meta.includes(a)), noHotel = meta.filter(a => !areas.includes(a));
  noMeta.length || noHotel.length ? fail('地域メタの不整合 メタ無し:[' + noMeta + '] ホテル無し:[' + noHotel + ']') : pass('FAMILY_HOTELS と HOTEL_AREA_META のエリアが一致');
  const bad = SPOTS.filter(s => s.hotelArea && !areas.includes(s.hotelArea)).map(s => s.name + '→' + s.hotelArea);
  bad.length ? fail('存在しない hotelArea: ' + bad.join(', ')) : pass('SPOTS の hotelArea はすべて FAMILY_HOTELS に存在');
}
console.log(failed ? '\n❌ ' + failed + ' 件の問題あり' : '\n✅ すべてOK（そのままJSONへ切り出せる状態）');
process.exit(failed ? 1 : 0);

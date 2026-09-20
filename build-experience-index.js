#!/usr/bin/env node
// experiences/ 以下を検証し、experiences/index.json（目次）を再生成する。
// 使い方: node tools/build-experience-index.js   （リポジトリ直下で実行）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(process.cwd(), 'experiences');
const STATUS = ['published', 'pending', 'hidden'];
const TRANSPORT = ['car', 'train', 'bus', 'bicycle', 'walk', 'other'];
const LEVELS = ['easy', 'partial', 'hard'];
const PHOTO_CATS = ['entrance', 'parking', 'play', 'meal_rest', 'other'];
const KIDS = ['stroller', 'toddlerFun', 'elementaryFun', 'meals', 'diaperChange', 'nursing', 'restBreak'];
const FORBIDDEN = ['rating', 'stars', 'score', 'rank', 'ranking', 'recommend', 'recommendLevel'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'photos' ? [] : walk(p);
    return d.name.endsWith('.json') && d.name !== 'index.json' && !d.name.startsWith('_') ? [p] : [];
  });
}
const errors = [];
const facilities = {};
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/').replace(/\.json$/, '');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push(`${rel}: JSONとして読めません`); continue; }
  if (data.facilityId !== rel) errors.push(`${rel}: facilityId(${data.facilityId})がファイルパスと一致しません`);
  if (!Array.isArray(data.experiences)) { errors.push(`${rel}: experiences が配列ではありません`); continue; }
  const ids = new Set();
  let count = 0, latest = '';
  data.experiences.forEach((e, i) => {
    const at = `${rel}[${i}]`;
    if (!e.id || ids.has(e.id)) errors.push(`${at}: idが未設定または重複`); ids.add(e.id);
    if (e.facilityId !== rel) errors.push(`${at}: facilityIdが一致しません`);
    if (!STATUS.includes(e.status)) errors.push(`${at}: statusが不正`);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(e.visitDate || '')) errors.push(`${at}: visitDateの形式が不正`);
    if (e.transport !== undefined && !TRANSPORT.includes(e.transport)) errors.push(`${at}: transportが不正`);
    FORBIDDEN.forEach(k => { if (k in e) errors.push(`${at}: ${k} は仕様外（評価・ランキング系の項目は持てません）`); });
    Object.entries(e.kids || {}).forEach(([k, v]) => {
      if (!KIDS.includes(k)) errors.push(`${at}: kids.${k} は仕様外`);
      else if (v && v.level !== undefined && !LEVELS.includes(v.level)) errors.push(`${at}: kids.${k}.levelが不正`);
    });
    (e.photos || []).forEach((p, j) => {
      if (!p.url) errors.push(`${at}: photos[${j}].urlが空`);
      if (!PHOTO_CATS.includes(p.category)) errors.push(`${at}: photos[${j}].categoryが不正`);
    });
    if (e.status === 'published') { count++; if (e.visitDate > latest) latest = e.visitDate; }
  });
  if (count > 0) facilities[rel] = { count, latest };
}
if (errors.length) { console.error('検証エラー:\n' + errors.map(s => ' - ' + s).join('\n')); process.exit(1); }
const sorted = Object.fromEntries(Object.entries(facilities).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(ROOT, 'index.json'), JSON.stringify({ version: 1, facilities: sorted }, null, 2) + '\n');
console.log(`index.json を更新しました（掲載中の施設: ${Object.keys(sorted).length}件）`);

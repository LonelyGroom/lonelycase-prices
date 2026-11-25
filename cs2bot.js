// LonelyCase — цены CS2 для раздела «Предметы».
// Каждый запуск (≈ раз в 30 минут) берёт все цены CS2 со Skinport одним запросом (в рублях: 1 ₽ = 1 G = 1 LC)
// и кладёт рядом с ценами Standoff 2:
//   cs2market.json      — список предметов: цена, изменение за день/неделю, редкость, картинка, категория
//   cs2hist/<xx>.json   — история цен для графиков (256 файлов, xx — первые 2 символа хэша названия)
//   cs2meta.json        — справочник картинок/редкостей из CSGO-API (обновляется раз в сутки)
// Запуск: node cs2bot.js (Node 20+). Ошибки не ломают сбор цен Standoff 2 — шаг в workflow необязательный.
const fs = require('fs');

const SKINPORT = 'https://api.skinport.com/v1/items?app_id=730&currency=RUB&tradable=0';
const API = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
const META_TTL = 24 * 3600; // справочник картинок — раз в сутки
const now = Math.floor(Date.now() / 1000);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// тот же хэш, что в приложении (FNV-1a)
const histKey = (name) => {
  let h = 0x811c9dc5;
  for (const ch of String(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

async function getJson(url, opt = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opt);
      if (r.status === 429) { last = new Error('HTTP 429'); await sleep(30000); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; await sleep(5000); }
  }
  throw last;
}

// ---------- справочник: картинка, редкость, категория, коллекция ----------
const RAR_BY_NAME = {
  'consumer grade': 'cs_consumer', 'industrial grade': 'cs_industrial', 'mil-spec grade': 'cs_milspec', 'mil-spec': 'cs_milspec',
  restricted: 'cs_restricted', classified: 'cs_classified', covert: 'cs_covert', contraband: 'cs_contraband',
  'base grade': 'cs_base', 'high grade': 'cs_high', remarkable: 'cs_remarkable', exotic: 'cs_exotic', extraordinary: 'cs_extraordinary',
  distinguished: 'cs_milspec', exceptional: 'cs_restricted', superior: 'cs_classified', master: 'cs_covert',
};
function rarOf(r) {
  if (!r) return '';
  const byName = RAR_BY_NAME[String(r.name || '').toLowerCase()];
  if (byName) return byName;
  const id = String(r.id || '');
  if (/contraband/.test(id)) return 'cs_contraband';
  if (/ancient/.test(id)) return 'cs_covert';
  if (/legendary/.test(id)) return 'cs_classified';
  if (/mythical/.test(id)) return 'cs_restricted';
  if (/uncommon/.test(id)) return 'cs_industrial';
  if (/rare/.test(id)) return 'cs_milspec';
  if (/common/.test(id)) return 'cs_consumer';
  return '';
}
function skinCat(x) {
  const c = String((x.category && x.category.name) || '');
  if (c === 'Knives') return 'knife';
  if (c === 'Gloves') return 'gloves';
  if (c === 'Pistols') return 'pistol';
  if (c === 'Rifles') return 'rifle';
  if (c === 'SMGs') return 'smg';
  if (c === 'Heavy') return 'heavy';
  return 'other';
}
async function buildMeta() {
  const meta = {}; // market_hash_name → [картинка, редкость, категория, коллекция]
  const add = (arr, fn) => {
    for (const x of arr || []) {
      const n = x && x.market_hash_name;
      if (!n || meta[n]) continue;
      const v = fn(x);
      if (v) meta[n] = v;
    }
  };
  const col = (x) => (Array.isArray(x.collections) && x.collections[0] && x.collections[0].name) || '';
  // в каких кейсах/капсулах выпадает в игре: [[название, картинка], ...]
  const crt = (x) => (Array.isArray(x.crates) ? x.crates.filter((c) => c && c.name).slice(0, 12).map((c) => [c.name, c.image || '']) : []);
  const files = [
    ['skins_not_grouped.json', (x) => [x.image || '', rarOf(x.rarity), skinCat(x), col(x), crt(x)]],
    ['stickers.json', (x) => [x.image || '', rarOf(x.rarity), 'sticker', col(x), crt(x)]],
    ['sticker_slabs.json', (x) => [x.image || '', rarOf(x.rarity), 'charm', col(x)]],
    ['keychains.json', (x) => [x.image || '', rarOf(x.rarity), 'charm', col(x), crt(x)]],
    ['crates.json', (x) => [x.image || '', '', 'container', '']],
    ['agents.json', (x) => [x.image || '', rarOf(x.rarity), /counter/i.test(String((x.team && (x.team.id || x.team.name)) || '')) ? 'agent_ct' : 'agent_t', col(x)]],
    ['graffiti.json', (x) => [x.image || '', rarOf(x.rarity), 'graffiti', col(x), crt(x)]],
    ['patches.json', (x) => [x.image || '', rarOf(x.rarity), 'patch', '', crt(x)]],
    ['music_kits.json', (x) => [x.image || '', rarOf(x.rarity), 'music', '', crt(x)]],
    ['collectibles.json', (x) => [x.image || '', rarOf(x.rarity), 'other', '']],
    ['keys.json', (x) => [x.image || '', '', 'container', '']],
  ];
  for (const [f, fn] of files) {
    try { add(await getJson(API + f, {}, 2), fn); log(`  ✓ ${f}`); } catch (e) { log(`  • ${f}: ${e.message}`); }
  }
  return meta;
}

// ---------- история цен ----------
// последние 24 ч — каждая точка; до 7 дней — точка раз в 6 часов; до 90 дней — раз в сутки; старше — удаляется
function thin(pts) {
  const out = [], seen = new Set();
  for (const p of pts) {
    const age = now - p[0];
    if (age > 90 * 86400) continue;
    if (age <= 86400) { out.push(p); continue; }
    const step = age <= 7 * 86400 ? 6 * 3600 : 86400;
    const b = Math.floor(p[0] / step) + ':' + step;
    if (seen.has(b)) continue; // в каждом отрезке — первая точка
    seen.add(b); out.push(p);
  }
  return out;
}
const priceAt = (pts, ts) => { // цена ближе всего к моменту ts (не позже)
  let best = null;
  for (const p of pts) { if (p[0] <= ts) best = p; else break; }
  return best ? best[1] : 0;
};

(async () => {
  // 1) справочник картинок (кэш на сутки)
  let metaFile = null;
  try { metaFile = JSON.parse(fs.readFileSync('cs2meta.json', 'utf8')); } catch (e) { /* нет */ }
  if (!metaFile || !metaFile.meta || metaFile.v !== 2 || now - (metaFile.updated || 0) > META_TTL) {
    log('• обновляю справочник картинок CS2 (CSGO-API)…');
    const meta = await buildMeta();
    if (Object.keys(meta).length > 1000) { metaFile = { v: 2, updated: now, meta }; fs.writeFileSync('cs2meta.json', JSON.stringify(metaFile)); }
    else if (!metaFile) metaFile = { updated: 0, meta };
    log(`✓ справочник: ${Object.keys(metaFile.meta).length} предметов`);
  }
  const META = metaFile.meta || {};

  // 2) цены Skinport (один запрос на все предметы)
  const arr = await getJson(SKINPORT, { headers: { 'Accept-Encoding': 'br' } }, 3);
  if (!Array.isArray(arr) || arr.length < 1000) throw new Error('Skinport вернул мало предметов: ' + (arr && arr.length));
  const price = {};
  for (const x of arr) {
    const n = x && x.market_hash_name; if (!n) continue;
    const p = r2(x.min_price != null ? x.min_price : x.suggested_price);
    if (!(p > 0)) continue;
    if (!price[n] || p < price[n]) price[n] = p; // у Doppler и т.п. несколько фаз — берём самую дешёвую
  }
  const names = Object.keys(price);
  log(`✓ Skinport: ${names.length} предметов с ценой`);

  // 3) история: читаем шарды, дописываем точку, прореживаем
  fs.mkdirSync('cs2hist', { recursive: true });
  const shards = {};
  const shard = (k) => {
    if (!shards[k]) { try { shards[k] = JSON.parse(fs.readFileSync(`cs2hist/${k}.json`, 'utf8')); } catch (e) { shards[k] = {}; } }
    return shards[k];
  };
  const ch = {};
  for (const n of names) {
    const sh = shard(histKey(n).slice(0, 2));
    let pts = sh[n] || [];
    const last = pts[pts.length - 1];
    if (!last || now - last[0] >= 20 * 60) pts.push([now, price[n]]);
    else last[1] = price[n];
    pts = thin(pts);
    sh[n] = pts;
    const d = priceAt(pts, now - 86400), w = priceAt(pts, now - 7 * 86400) || (pts[0] && pts[0][1]) || 0;
    const pct = (old) => (old > 0 ? Math.round(((price[n] - old) / old) * 10000) / 100 : 0);
    if (d || w) ch[n] = [d ? pct(d) : 0, w ? pct(w) : 0];
  }
  // предметы, которых больше нет на Skinport, — история хранится, пока не устареет
  for (const k of Object.keys(shards)) {
    for (const n of Object.keys(shards[k])) { if (!price[n]) { const t = thin(shards[k][n]); if (t.length) shards[k][n] = t; else delete shards[k][n]; } }
    fs.writeFileSync(`cs2hist/${k}.json`, JSON.stringify(shards[k]));
  }

  // 4) список для приложения: строки [название, цена, Δдень, Δнеделя, редкость, картинка, категория, коллекция]
  // картинки сжимаем: общая папка → номер в списке pre
  const pre = [], preIdx = new Map();
  const pack = (url) => {
    if (!url) return '';
    const i = url.lastIndexOf('/');
    const dir = url.slice(0, i + 1), file = url.slice(i + 1);
    if (!preIdx.has(dir)) { preIdx.set(dir, pre.length); pre.push(dir); }
    return preIdx.get(dir) + '|' + file;
  };
  const cols = [], colIdx = new Map();
  const colId = (c) => { if (!c) return -1; if (!colIdx.has(c)) { colIdx.set(c, cols.length); cols.push(c); } return colIdx.get(c); };
  const crs = [], crIdx = new Map(); // кейсы игры: [название, картинка]
  const crId = (c) => { if (!crIdx.has(c[0])) { crIdx.set(c[0], crs.length); crs.push([c[0], pack(c[1])]); } return crIdx.get(c[0]); };
  const plain = (n) => n.replace(/^★\s*/, '').replace(/^StatTrak™\s*/, '').replace(/^Souvenir\s+/, '').replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '');
  const metaOf = (n) => META[n] || META[n.replace('StatTrak™ ', '')] || META[n.replace(/^Souvenir /, '')] || null;
  let noMeta = 0;
  const rows = names.sort().map((n) => {
    const m = metaOf(n) || [];
    if (!m.length) noMeta++;
    let cat = m[2] || '';
    if (!cat) { // запасная категория по названию
      if (/^Sticker \|/.test(n)) cat = 'sticker';
      else if (/^(Charm|Sticker Slab) \|/.test(n)) cat = 'charm';
      else if (/^(Sealed Graffiti|Graffiti) \|/.test(n)) cat = 'graffiti';
      else if (/^Patch \|/.test(n)) cat = 'patch';
      else if (/^Music Kit \|/.test(n)) cat = 'music';
      else if (/(Case|Capsule|Package|Key|Pass)$/.test(plain(n))) cat = 'container';
      else if (/^★/.test(n)) cat = /Gloves|Wraps/.test(n) ? 'gloves' : 'knife';
      else cat = 'other';
    }
    const c = ch[n] || [0, 0];
    const cr = Array.isArray(m[4]) ? m[4].map(crId) : [];
    return cr.length ? [n, price[n], c[0], c[1], m[1] || '', pack(m[0] || ''), cat, colId(m[3] || ''), cr] : [n, price[n], c[0], c[1], m[1] || '', pack(m[0] || ''), cat, colId(m[3] || '')];
  });
  fs.writeFileSync('cs2market.json', JSON.stringify({ updated: now, cur: 'RUB', pre, cols, crs, rows }));
  log(`✓ cs2market.json: ${rows.length} предметов (без картинки: ${noMeta}), графиков: ${Object.keys(shards).length} файлов`);
})().catch((e) => { console.log('• цены CS2 не обновились: ' + e.message); process.exitCode = 0; });

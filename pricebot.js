// LonelyCase — сборщик рыночных цен Standoff 2 (публичный репозиторий lonelycase-prices).
// Запускается GitHub Actions каждые 30 минут. Сайт standoff-2.com пропускает ~20 запросов в минуту,
// поэтому за один запуск обновляются предметы, которые дольше всех не обновлялись, а между запусками
// всё хранится в state.json. Полный круг по ~2400 предметам — примерно за 2 часа.
// Графики: hist/<FNV-1a от названия>.json = { n: название, p: [[время, цена], ...] }
// Результат: so2prices.json = { updated, cur:"G", src, items:{название: цена}, ch:{название:[Δдень %, Δнеделя %]}, rar:{название: редкость} }
const fs = require('fs');

const BASES = ['https://standoff-2.com/skins-new.php', 'https://standoff-2.com/skins.php'];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HDR = { 'User-Agent': UA, Accept: 'application/json, text/javascript, */*', Referer: 'https://standoff-2.com/shop/', 'X-Requested-With': 'XMLHttpRequest' };
const BUDGET = 22 * 60000;   // минут на один запуск (запуск раз в 30 мин)
const GAP = 2200;            // пауза между запросами, мс (~27 в минуту; при 429 скрипт сам ждёт)
const NAMES_EVERY = 12 * 3600; // список предметов и редкость — раз в 12 часов

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;
const now = () => Math.floor(Date.now() / 1000);
const tsOf = (d) => { const x = Date.parse(String(d || '').replace(' ', 'T')); return Number.isFinite(x) ? x : 0; };

async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: HDR, signal: ctl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return JSON.parse(await r.text());
  } finally { clearTimeout(t); }
}

function rareId(v) {
  const t = String(v || '').toLowerCase().trim();
  if (!t) return '';
  if (/uncommon|необыч/.test(t)) return 'uncommon';
  if (/common|обыч/.test(t)) return 'common';
  if (/rare|редк/.test(t)) return 'rare';
  if (/epic|эпич/.test(t)) return 'epic';
  if (/legend|легенд/.test(t)) return 'legendary';
  if (/arcane|аркан|тайн/.test(t)) return 'arcane';
  if (/nameless|безым/.test(t)) return 'nameless';
  return '';
}
// имя файла истории: FNV-1a (32 бита) от названия — так же считает приложение
function histKey(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
// история для графика: последние 2 суток — точка в час, до 30 дней — раз в 6 часов, до года — раз в сутки
function compact(rows) {
  const nowMs = Date.now(), H = 3600000, out = new Map();
  for (const r of rows) {
    const age = nowMs - r.t;
    if (age > 366 * 24 * H) continue;
    const step = age <= 48 * H ? H : age <= 30 * 24 * H ? 6 * H : 24 * H;
    out.set(step + ':' + Math.floor(r.t / step), [Math.floor(r.t / 1000), r.p]); // последняя цена в интервале
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}
function priceAt(rows, at) { let p = 0; for (const r of rows) { if (r.t <= at) p = r.p; else break; } return p; }

(async () => {
  const t0 = Date.now();
  let st = { base: '', names: [], namesAt: 0, rar: {}, items: {} };
  try { st = Object.assign(st, JSON.parse(fs.readFileSync('state.json', 'utf8'))); } catch (e) { console.log('state.json нет — начинаю с нуля'); }

  // 1) список предметов и редкость (раз в 12 часов)
  if (!st.names.length || now() - st.namesAt > NAMES_EVERY) {
    for (const b of BASES) {
      try {
        const j = await getJson(b + '?command=getNames');
        const names = [...new Set((Array.isArray(j) ? j : []).map((x) => String((Array.isArray(x) ? x[0] : x && x.name) || '')).filter(Boolean))];
        if (names.length) { st.base = b; st.names = names; st.namesAt = now(); break; }
      } catch (e) { console.log(`getNames ${b}: ${e.message}`); }
      await sleep(GAP);
    }
    try {
      await sleep(GAP);
      const info = await getJson(st.base + '?command=getModelInfo', 40000);
      const rar = {}; const seen = {};
      for (const m of Array.isArray(info) ? info : []) {
        const raw = m && (m.rare || m.Rare || m.rarity);
        const id = rareId(raw);
        if (m && m.name && id) rar[m.name] = id;
        seen[raw || '—'] = (seen[raw || '—'] || 0) + 1;
      }
      if (Object.keys(rar).length) st.rar = rar;
      console.log(`редкость у ${Object.keys(rar).length}; значения: ${Object.entries(seen).slice(0, 10).map(([k, v]) => k + '×' + v).join(', ')}`);
    } catch (e) { console.log('редкость не получена: ' + e.message); }
  }
  if (!st.names.length) { console.log('• список предметов не получен — цены не обновлены'); return; }
  const alive = new Set(st.names);
  for (const k of Object.keys(st.items)) if (!alive.has(k)) delete st.items[k];

  // 2) очередь: сначала никогда не скачанные, потом самые старые
  const queue = st.names.slice().sort((a, b) => ((st.items[a] && st.items[a].t) || 0) - ((st.items[b] && st.items[b].t) || 0));
  let ok = 0, fail = 0, s429 = 0, i = 0;
  const day = 86400000;
  while (i < queue.length && Date.now() - t0 < BUDGET) {
    const name = queue[i];
    try {
      const j = await getJson(`${st.base}?command=getStat&name=${encodeURIComponent(name)}`);
      const rows = (Array.isArray(j) ? j : [])
        .map((r) => ({ t: tsOf(r.Date || r.date), p: Number(String(r.purchase_price != null ? r.purchase_price : r.sale_price).replace(',', '.')) }))
        .filter((r) => r.t && r.p > 0).sort((a, b) => a.t - b.t);
      if (rows.length) {
        const cur = rows[rows.length - 1].p, n = Date.now();
        const d1 = priceAt(rows, n - day), w1 = priceAt(rows, n - 7 * day);
        st.items[name] = { p: r2(cur), d: d1 ? r2(((cur - d1) / d1) * 100) : 0, w: w1 ? r2(((cur - w1) / w1) * 100) : 0, t: now() };
        try { fs.mkdirSync('hist', { recursive: true }); fs.writeFileSync(`hist/${histKey(name)}.json`, JSON.stringify({ n: name, p: compact(rows) })); } catch (e) { /* без графика */ }
      } else {
        st.items[name] = Object.assign({}, st.items[name], { t: now() }); // нет истории — отложить
      }
      ok++; i++;
      await sleep(GAP);
    } catch (e) {
      if (e.status === 429) { s429++; await sleep(30000); continue; } // сайт просит подождать — ждём и повторяем тот же предмет
      fail++; i++;
      await sleep(GAP);
    }
  }

  // 3) итоговый файл для приложения
  const items = {}, ch = {}, rar = {};
  for (const [k, v] of Object.entries(st.items)) {
    if (!(v && v.p > 0)) continue;
    items[k] = v.p; ch[k] = [v.d || 0, v.w || 0];
    if (st.rar[k]) rar[k] = st.rar[k];
  }
  fs.writeFileSync('state.json', JSON.stringify(st));
  fs.writeFileSync('so2prices.json', JSON.stringify({ updated: now(), cur: 'G', src: 'standoff-2.com', items, ch, rar }));
  const ages = Object.values(st.items).map((v) => now() - (v.t || 0));
  const oldest = ages.length ? Math.round(Math.max(...ages) / 3600) : 0;
  console.log(`✓ обновлено ${ok}, ошибок ${fail}, пауз из-за 429: ${s429}; всего с ценой ${Object.keys(items).length} из ${st.names.length}; самая старая цена — ${oldest} ч назад (${Math.round((Date.now() - t0) / 1000)} с)`);
})().catch((e) => { console.log('• ошибка: ' + e.message); process.exitCode = 0; });

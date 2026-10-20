// 시험용 가짜 구글 환경: 시트·캐시·잠금·해시·지도를 흉내 내고 apps-script/Code.gs를 그대로 실행한다.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

// ── 아주 작은 가짜 구글 환경 ──
const display = (v) => (v == null ? '' : typeof v === 'string' ? v.replace(/^'/, '') : String(v));
function makeSheet(name, rows = []) {
  const data = rows.map((r) => [...r]);
  const width = () => Math.max(1, ...data.map((r) => r.length));
  const range = (r, c, nr = 1, nc = 1) => ({
    getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => display((data[r - 1 + i] || [])[c - 1 + j]))),
    setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => { while (data.length < r + i) data.push([]); data[r - 1 + i][c - 1 + j] = v; })),
    setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; },
  });
  return {
    data, getName: () => name,
    getDataRange: () => range(1, 1, data.length, width()),
    getRange: range,
    getLastColumn: () => width(),
    appendRow: (row) => data.push([...row]),
    setFrozenRows() {},
  };
}
function makeSpreadsheet(id, sheets) {
  return {
    getId: () => id, getSheets: () => sheets,
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.push(s); return s; },
  };
}
// 주간세미나 시트: 실제 내려받은 CSV
function parseCsv(t) { const rows=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++}else q=false}else f+=c}else if(c==='"')q=true;else if(c===','){r.push(f);f=''}else if(c==='\n'){r.push(f);rows.push(r);r=[];f=''}else if(c!=='\r')f+=c}if(f||r.length){r.push(f);rows.push(r)}return rows; }
export function makeEnv({ seminarCsv, now }) {
  const ops = makeSpreadsheet('OPS', []);
  const seminar = makeSpreadsheet('SEM', [makeSheet('시트1', parseCsv(seminarCsv))]);
  const props = {}; let cache = {}; const alerts = [];
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ops,
      openById: (id) => (id === 'OPS' ? ops : id === 'SEM' ? seminar : (() => { throw new Error('없는 시트'); })()),
      flush() {},
      getUi: () => ({ alert: (m) => alerts.push(m) }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => (cache[k] = v), removeAll: (ks) => ks.forEach((k) => delete cache[k]) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => [...createHash('sha256').update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('yy', p.year.slice(2)).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    Maps: { newGeocoder: () => ({ setRegion() { return this; }, setLanguage() { return this; }, geocode: (a) => ({ results: a.includes('없는') ? [] : [{ geometry: { location: { lat: 37.5972, lng: 127.0587 } } }] }) }) },
  };
  // 현재 시각 고정
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return new RealDate(now).getTime(); } }
  ctx.Date = FixedDate;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(process.env.CODE || "apps-script/Code.gs", 'utf8'), ctx);
  const get = (action) => JSON.parse(ctx.doGet({ parameter: { action } }).getContent());
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { ctx, ops, props, alerts, get, post, clearCache: () => (cache = {}) };
}

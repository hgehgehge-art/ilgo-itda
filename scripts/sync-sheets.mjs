// 시트 동기화: Google Sheets → data/seminars.json, data/books.json, Supabase seminars 표
// 설치할 패키지 없음(Node.js 20 이상). GitHub Actions에서 30분마다 실행한다.
//
// 필요한 환경 변수(GitHub Secrets)
//   GOOGLE_SERVICE_ACCOUNT_KEY  서비스 계정 키 JSON 전체
//   SEMINAR_SHEET_ID            세미나 일정 시트 ID
//   LOAN_SHEET_ID               대출 시트 ID(도서 목록·대출 기록 탭)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 선택: SEMINAR_TAB, BOOK_TAB, LOAN_TAB (탭 이름이 기본값과 다를 때)
//
// 점검용: SHEETS_FIXTURE=파일.json 이면 시트 대신 그 파일의 값을 읽는다.
//   { "seminars": [[머리행], [행]...], "books": [...], "loans": [...] }
//   이때 SUPABASE_URL이 없으면 Supabase 반영은 건너뛴다.
//
// 종료 코드: 0 성공 / 1 실패(파일 변경 없음) / 3 일부 실패(바뀐 파일은 저장됨, 실행은 실패로 표시)
//
// 개인정보: 대출 기록의 '빌린 회원 이름' 열은 어디에도 쓰지 않는다. 오류 기록에는 행 번호와 관리번호만 남긴다.

import { createSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// ── 시트 열 이름 ─────────────────────────────────────
// README의 계획을 기준으로 한 기본값이다. 실제 시트의 머리행과 다르면 여기만 고친다.
const COLUMNS = {
  seminars: {
    id: '세미나 ID', // 필수
    title: '작가 및 작품명', // 필수
    startsAt: '개최 일시', // 필수. 연도 포함. 시간이 없으면 오후 6시
    presenter: '발제자',
    place: '장소', // 없으면 동아리방
    capacity: '정원', // 없으면 11
    status: '게시 상태', // 초안 / 게시 / 취소. 비어 있으면 초안
    docUrl: '발제문 URL',
    note: '공개 안내', // 사이트에 그대로 보이는 안내. 기존 '비고' 열은 내보내지 않는다
  },
  books: {
    copyId: '관리번호', // 필수
    seriesNo: '전집 권번호', // 필수
    title: '제목', // 필수
    author: '작가',
    translator: '번역자',
    isbn: 'ISBN',
  },
  loans: {
    copyId: '관리번호', // 필수
    dueDate: '반납 예정일',
    returnedAt: '실제 반납일', // 비어 있으면 아직 반납하지 않은 대출
    // '빌린 회원 이름' 열은 일부러 적지 않는다. 읽지도 내보내지도 않는다.
  },
};
const REQUIRED = {
  seminars: ['id', 'title', 'startsAt'],
  books: ['copyId', 'seriesNo', 'title'],
  loans: ['copyId', 'returnedAt'],
};

const TABS = {
  seminars: process.env.SEMINAR_TAB || '시트1',
  books: process.env.BOOK_TAB || '도서 목록',
  loans: process.env.LOAN_TAB || '대출 기록',
};
const DEFAULT_TIME = '18:00';
const DEFAULT_PLACE = '동아리방';
const DEFAULT_CAPACITY = 11;
const STATUS = { 게시: 'published', 취소: 'cancelled', 초안: 'draft' };

const OUT = { seminars: 'data/seminars.json', books: 'data/books.json' };

const env = process.env;
const fixturePath = env.SHEETS_FIXTURE;

// ── 기록 ──
const log = (...a) => console.log(...a);
const warn = (msg) => console.log(`::warning::${msg}`);
const fail = (msg) => console.log(`::error::${msg}`);

// ── Google 인증과 시트 읽기 ──────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function googleToken() {
  const key = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claim}`);
  const jwt = `${head}.${claim}.${b64url(signer.sign(key.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google 인증 실패 (${res.status})`);
  return (await res.json()).access_token;
}

let tokenPromise;
let fixture;
async function readTab(sheetId, tab, kind) {
  if (fixturePath) {
    fixture ??= JSON.parse(await readFile(fixturePath, 'utf8'));
    if (!fixture[kind]) throw new Error(`점검 파일에 ${kind}가 없음`);
    return fixture[kind];
  }
  tokenPromise ??= googleToken();
  const token = await tokenPromise;
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  );
  // 응답 본문에는 시트 내용이 있을 수 있으므로 기록하지 않는다
  if (!res.ok) throw new Error(`'${tab}' 탭을 읽지 못함 (${res.status})`);
  return (await res.json()).values ?? [];
}

// 머리행으로 열 위치를 찾아 { 키: 값 } 행 목록으로 바꾼다. 필요한 열만 꺼낸다.
function toRecords(values, kind) {
  const [header = [], ...rows] = values;
  const names = header.map((h) => String(h ?? '').trim());
  const index = {};
  for (const [key, name] of Object.entries(COLUMNS[kind])) index[key] = names.indexOf(name);
  const missing = REQUIRED[kind].filter((k) => index[k] === -1).map((k) => COLUMNS[kind][k]);
  if (missing.length) throw new Error(`${TABS[kind]} 탭에 필요한 열이 없음: ${missing.join(', ')}`);

  return rows
    .map((row, i) => {
      const rec = { row: i + 2 };
      for (const [key, at] of Object.entries(index)) rec[key] = at === -1 ? '' : String(row[at] ?? '').trim();
      return rec;
    })
    .filter((r) => Object.entries(r).some(([k, v]) => k !== 'row' && v !== ''));
}

// ── 날짜 해석 (한국시간) ─────────────────────────────
// '2026-10-08', '2026. 10. 8', '2026/10/8' (+ '18:00' 또는 '오후 6:00')
function parseDateTime(text, defaultTime) {
  const m = String(text).match(
    /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?(?:\s*\([^)]*\))?(?:\s+(오전|오후)?\s*(\d{1,2}):(\d{2}))?\s*$/,
  );
  if (!m) return null;
  const [, y, mo, d, ampm, hh, mm] = m;
  let h;
  let min;
  if (hh != null) {
    h = Number(hh);
    min = Number(mm);
    if (ampm === '오후' && h < 12) h += 12;
    if (ampm === '오전' && h === 12) h = 0;
  } else if (defaultTime) {
    [h, min] = defaultTime.split(':').map(Number);
  }
  const date = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  // 실제로 있는 날짜인지 확인
  const check = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) return null;
  if (h == null) return { date };
  if (h > 23 || min > 59) return null;
  return { date, iso: `${date}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+09:00` };
}

// ── 파일 쓰기: syncedAt만 다르면 쓰지 않는다 ──────────
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeIfChanged(path, key, items) {
  const prev = await readJson(path);
  const same =
    prev && prev.example !== true && JSON.stringify(prev[key]) === JSON.stringify(items);
  if (same) {
    log(`${path}: 내용 변화 없음`);
    return false;
  }
  const data = { syncedAt: new Date().toISOString(), [key]: items };
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  log(`${path}: ${items.length}건 저장`);
  return true;
}

// ── 세미나 ───────────────────────────────────────────
async function syncSeminars() {
  const records = toRecords(await readTab(env.SEMINAR_SHEET_ID, TABS.seminars, 'seminars'), 'seminars');

  const all = [];
  const seen = new Set();
  for (const r of records) {
    if (!r.id || !r.title || !r.startsAt) {
      warn(`세미나 ${r.row}행: 세미나 ID·제목·개최 일시 중 빈 값이 있어 건너뜀`);
      continue;
    }
    if (seen.has(r.id)) {
      warn(`세미나 ${r.row}행: 세미나 ID '${r.id}'가 중복되어 건너뜀`);
      continue;
    }
    const when = parseDateTime(r.startsAt, DEFAULT_TIME);
    if (!when?.iso) {
      warn(`세미나 ${r.row}행: 개최 일시를 해석하지 못해 건너뜀 (예: 2026-10-08 또는 2026-10-08 18:00)`);
      continue;
    }
    const status = r.status === '' ? 'draft' : STATUS[r.status];
    if (!status) {
      warn(`세미나 ${r.row}행: 게시 상태 '${r.status}'를 알 수 없어 건너뜀 (초안·게시·취소)`);
      continue;
    }
    const cap = r.capacity === '' ? DEFAULT_CAPACITY : Number(r.capacity);
    if (!Number.isInteger(cap) || cap < 2 || cap > 100) {
      warn(`세미나 ${r.row}행: 정원 '${r.capacity}'가 올바르지 않아 건너뜀`);
      continue;
    }
    seen.add(r.id);
    all.push({
      id: r.id,
      title: r.title,
      presenter: r.presenter,
      startsAt: when.iso,
      place: r.place || DEFAULT_PLACE,
      capacity: cap,
      status,
      docUrl: /^https:\/\/\S+$/.test(r.docUrl) ? r.docUrl : null,
      note: r.note,
    });
  }

  // 1) Supabase에 먼저 반영한다. 실패하면 사이트에 새 일정을 내보내지 않는다
  //    (서버가 모르는 세미나에 신청 버튼이 생기지 않도록).
  //    초안도 반영한다: 게시했다가 초안으로 되돌린 세미나의 신청을 서버에서 막기 위해서.
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    await upsertSupabase(all);
  } else if (fixturePath) {
    log('Supabase 반영 건너뜀(점검 모드)');
  } else {
    throw new Error('SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없음');
  }

  // 2) 사이트에는 게시·취소만 내보낸다
  const visible = all
    .filter((s) => s.status !== 'draft')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  log(`세미나: 시트 ${records.length}행 → 유효 ${all.length}건, 공개 ${visible.length}건`);
  return writeIfChanged(OUT.seminars, 'seminars', visible);
}

async function upsertSupabase(seminars) {
  if (seminars.length === 0) return;
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/seminars?on_conflict=id`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(
      seminars.map((s) => ({
        id: s.id,
        title: s.title,
        starts_at: s.startsAt,
        capacity: s.capacity,
        status: s.status,
        updated_at: new Date().toISOString(),
      })),
    ),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Supabase 세미나 반영 실패 (${res.status})`);
  log(`Supabase: 세미나 ${seminars.length}건 반영(같은 ID는 수정, 예약은 그대로)`);
}

// ── 대출 ─────────────────────────────────────────────
async function syncBooks() {
  const [bookValues, loanValues] = await Promise.all([
    readTab(env.LOAN_SHEET_ID, TABS.books, 'books'),
    readTab(env.LOAN_SHEET_ID, TABS.loans, 'loans'),
  ]);
  const bookRows = toRecords(bookValues, 'books');
  const loanRows = toRecords(loanValues, 'loans');

  const prev = await readJson(OUT.books);
  const prevById = new Map(
    prev && prev.example !== true && Array.isArray(prev.books) ? prev.books.map((b) => [b.copyId, b]) : [],
  );

  // 반납되지 않은 대출을 소장본별로 모은다
  const open = new Map();
  for (const l of loanRows) {
    if (!l.copyId) {
      warn(`대출 기록 ${l.row}행: 관리번호가 비어 있어 건너뜀`);
      continue;
    }
    if (l.returnedAt !== '') continue;
    if (!open.has(l.copyId)) open.set(l.copyId, []);
    open.get(l.copyId).push(l);
  }

  let conflicts = 0;
  const books = [];
  const seen = new Set();
  for (const b of bookRows) {
    const seriesNo = Number(b.seriesNo);
    if (!b.copyId || !b.title || !Number.isInteger(seriesNo) || seriesNo < 1) {
      warn(`도서 목록 ${b.row}행: 관리번호·권번호·제목 중 빈 값이나 잘못된 값이 있어 건너뜀`);
      continue;
    }
    if (seen.has(b.copyId)) {
      warn(`도서 목록 ${b.row}행: 관리번호 '${b.copyId}'가 중복되어 건너뜀`);
      continue;
    }
    seen.add(b.copyId);

    const loans = open.get(b.copyId) ?? [];
    let status = 'available';
    let dueDate = null;
    if (loans.length === 1) {
      status = 'on_loan';
      dueDate = parseDateTime(loans[0].dueDate)?.date ?? null;
      if (loans[0].dueDate && !dueDate) warn(`대출 기록 ${loans[0].row}행: 반납 예정일을 해석하지 못함`);
    } else if (loans.length > 1) {
      conflicts += 1;
      fail(
        `관리번호 '${b.copyId}'에 반납되지 않은 대출이 ${loans.length}건 (대출 기록 ${loans.map((l) => l.row).join(', ')}행). 이 책은 이전 상태를 유지함`,
      );
      // 이전 값을 유지한다. 이전 값이 없으면 '대출 가능'으로 잘못 알리지 않도록 대출 중으로 둔다.
      const before = prevById.get(b.copyId);
      status = before?.status ?? 'on_loan';
      dueDate = before?.dueDate ?? null;
    }

    books.push({
      copyId: b.copyId,
      seriesNo,
      title: b.title,
      author: b.author,
      translator: b.translator,
      isbn: b.isbn,
      status,
      dueDate,
    });
  }

  for (const id of open.keys()) {
    if (!seen.has(id)) warn(`대출 기록에 도서 목록에 없는 관리번호 '${id}'가 있음`);
  }

  books.sort((a, b) => a.seriesNo - b.seriesNo || a.copyId.localeCompare(b.copyId));
  const onLoan = books.filter((b) => b.status === 'on_loan').length;
  log(`도서: 소장본 ${books.length}권, 대출 중 ${onLoan}권`);
  const wrote = await writeIfChanged(OUT.books, 'books', books);
  return { wrote, conflicts };
}

// ── 실행 ─────────────────────────────────────────────
if (!fixturePath) {
  const need = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'SEMINAR_SHEET_ID', 'LOAN_SHEET_ID'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    fail(`환경 변수가 없음: ${missing.join(', ')}`);
    process.exit(1);
  }
}

let failed = false;
let wroteAny = false;

try {
  wroteAny = (await syncSeminars()) || wroteAny;
} catch (e) {
  failed = true;
  fail(`세미나 동기화 실패, ${OUT.seminars}는 그대로 둠: ${e.message}`);
}

try {
  const { wrote, conflicts } = await syncBooks();
  wroteAny = wrote || wroteAny;
  if (conflicts) failed = true;
} catch (e) {
  failed = true;
  fail(`도서 동기화 실패, ${OUT.books}는 그대로 둠: ${e.message}`);
}

process.exit(failed ? (wroteAny ? 3 : 1) : 0);

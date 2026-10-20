/**
 * 읽고, 잇다 — 구글 시트 백엔드 (Google Apps Script)
 *
 * 비공개 운영 스프레드시트의 '확장 프로그램 → Apps Script'에 붙여 넣고, 웹 앱으로 배포한다.
 * 사이트(GitHub Pages)는 이 웹 앱 주소 하나로 모든 데이터를 읽고 쓴다. 다른 서버는 없다.
 *
 *  · 세미나: 동아리 주간세미나 시트를 그대로 읽는다(원본 수정 없음). 신청은 '세미나 신청' 탭에 쌓인다.
 *  · 책장: '도서 목록'·'대출 기록' 탭으로 대출 상태를 계산한다. 빌린 사람 이름은 내보내지 않는다.
 *  · 그날의 토론: '토론 기록' 탭. 운영진 코드로 저장·게시한다. AI 정리는 GitHub Actions가 맡는다.
 *  · 독서 지도: '독서 지도' 탭. 주소로 좌표를 채우고, 회원 추천은 '검토 대기'로 받는다.
 *
 * 개인정보: 신청자 이름·확인번호, 빌린 사람 이름, 토론 원문은 응답에 넣지 않는다.
 * 발제자 이름은 첫 글자만 보이게 가려서 내보낸다.
 *
 * 처음 설정은 스프레드시트 위쪽 메뉴 '읽고, 잇다'에서 한다(코드에 비밀값을 적지 않는다).
 */

// ── 탭과 열 ─────────────────────────────────────────
const TAB = {
  books: '도서 목록',
  loans: '대출 기록',
  reservations: '세미나 신청',
  discussions: '토론 기록',
  places: '독서 지도',
};

const HEADERS = {
  books: ['관리번호', '전집 권번호', '제목', '작가', '번역자', 'ISBN'],
  loans: ['관리번호', '빌린 회원 이름', '대출일', '반납 예정일', '실제 반납일'],
  reservations: ['세미나 ID', '이름', '확인번호(해시)', '신청 시각', '취소 시각'],
  discussions: ['세미나 ID', '상태', 'AI 상태', '키워드', '요약', '질문', '남기고 싶은 말', '원문', '수정 시각', '게시 시각', 'AI 메모'],
  places: ['장소 ID', '장소 이름', '분류', '주소', '위도', '경도', '관련 책', '한 줄 메모', '네이버 지도 링크', '출처', '추천한 사람', '게시', '추천 시각'],
};

const PLACE_CATEGORIES = ['서점', '북카페', '도서관', '작품 속 장소', '모임 장소'];
const DEFAULT_TIME = '18:00';
const DEFAULT_PLACE = '동아리방';
const DEFAULT_CAPACITY = 11;
const CACHE_SECONDS = 60;
const LIMITS = { discussionSavesPerDay: 50, placeSuggestionsPerDay: 30, textMin: 200, textMax: 45000 };

// ── 웹 앱 진입점 ────────────────────────────────────

/** 읽기: ?action=seminars | books | discussions | places */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'seminars') return json_(getSeminars_());
    if (action === 'books') return json_(getBooks_());
    if (action === 'discussions') return json_(getDiscussions_());
    if (action === 'places') return json_(getPlaces_());
    if (action === 'ping') return json_({ status: 'ok' });
    return json_({ status: 'error', error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ status: 'error' });
  }
}

/** 쓰기: 본문 JSON { action, … }. 사이트는 text/plain으로 보낸다(브라우저 사전 요청을 피하려고). */
function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ result: 'invalid' });
  }
  try {
    switch (body.action) {
      case 'reserve':
        return json_({ result: reserve_(body.seminarId, body.name, body.pin) });
      case 'cancel':
        return json_({ result: cancel_(body.seminarId, body.name, body.pin) });
      case 'saveDiscussion':
        return json_({ result: saveDiscussion_(body) });
      case 'loadDiscussion':
        return json_(loadDiscussion_(body.code, body.seminarId));
      case 'suggestPlace':
        return json_({ result: suggestPlace_(body) });
      case 'aiPending':
        return json_(aiPending_(body.token));
      case 'aiSave':
        return json_({ result: aiSave_(body) });
      default:
        return json_({ result: 'invalid' });
    }
  } catch (err) {
    console.error(err);
    return json_({ result: 'error' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── 공통 도우미 ─────────────────────────────────────

function props_() {
  return PropertiesService.getScriptProperties();
}

function ops_() {
  const id = props_().getProperty('OPS_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function tab_(key) {
  const ss = ops_();
  let sheet = ss.getSheetByName(TAB[key]);
  if (!sheet) {
    sheet = ss.insertSheet(TAB[key]);
    sheet.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 머리행 이름으로 열을 찾아 [{열 이름: 값, _row: 시트 행 번호}] 로 읽는다
function records_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length === 0) return [];
  const header = values[0].map((h) => String(h).trim());
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const rec = { _row: r + 1 };
    let any = false;
    header.forEach((h, c) => {
      const v = String(values[r][c] == null ? '' : values[r][c]).trim();
      if (h) rec[h] = v;
      if (v) any = true;
    });
    if (any) out.push(rec);
  }
  return out;
}

function colIndex_(sheet, name) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map((h) => String(h).trim());
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`'${sheet.getName()}' 탭에 '${name}' 열이 없음`);
  return i + 1;
}

function sha256_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// 솔트를 넣은 해시: '솔트$해시'
function hashSecret_(secret) {
  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return `${salt}$${sha256_(salt + secret)}`;
}

function checkSecret_(secret, stored) {
  if (!stored || stored.indexOf('$') === -1) {
    sha256_('timing' + secret); // 없을 때도 같은 일을 해 응답 시간을 맞춘다
    return false;
  }
  const [salt, hash] = stored.split('$');
  return sha256_(salt + secret) === hash;
}

// 시트가 '2026-10-07' 같은 글자를 날짜로 바꾸지 않도록 글자로 적는다
function asText_(v) {
  return typeof v === 'string' && v !== '' ? "'" + v : v;
}

function nowIso_() {
  return new Date().toISOString();
}

function kstDate_(d) {
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
}

// 발제자 이름 가리기: 홍길동 → 홍○○
function maskName_(name) {
  const t = String(name || '').trim();
  if (t.length <= 1) return t;
  return t.charAt(0) + '○'.repeat(Math.min(t.length - 1, 3));
}

// 하루 횟수 제한(스크립트 속성에 날짜별로 센다)
function underDailyLimit_(key, limit) {
  const p = props_();
  const k = `COUNT_${key}_${kstDate_(new Date())}`;
  const n = Number(p.getProperty(k) || 0);
  if (n >= limit) return false;
  p.setProperty(k, String(n + 1));
  return true;
}

function cached_(key, seconds, build) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const value = build();
  try {
    cache.put(key, JSON.stringify(value), seconds);
  } catch (err) {
    // 너무 크면 캐시하지 않는다
  }
  return value;
}

function clearCache_() {
  CacheService.getScriptCache().removeAll(['seminars', 'books', 'discussions', 'places']);
}

// ── 날짜 해석(한국시간) ─────────────────────────────
// '2026-10-08', '2026. 10. 8', '9/7 (월)', '10/8 19:00', '오후 6:00:00' 등
function kstTime_(text, defaultTime) {
  const t = String(text || '').trim();
  let m = t.match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?(?:\s*\([^)]*\))?(?:\s+(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  let y, mo, d, ampm, hh, mm;
  if (m) {
    [, y, mo, d, ampm, hh, mm] = m;
    y = Number(y);
  } else {
    m = t.match(/^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\([^)]*\))?(?:\s+(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?)?$/);
    if (!m) return null;
    [, mo, d, ampm, hh, mm] = m;
    // 연도가 없으면 오늘 기준 앞뒤 6개월 안의 연도로 본다
    const today = new Date(kstDate_(new Date()) + 'T00:00:00Z');
    y = today.getUTCFullYear();
    const guess = Date.UTC(y, Number(mo) - 1, Number(d));
    const half = 183 * 86400000;
    if (guess < today.getTime() - half) y += 1;
    else if (guess > today.getTime() + half) y -= 1;
  }
  mo = Number(mo);
  d = Number(d);
  let h;
  let min;
  if (hh != null) {
    h = Number(hh);
    min = Number(mm);
    if (ampm === '오후' && h < 12) h += 12;
    if (ampm === '오전' && h === 12) h = 0;
  } else {
    [h, min] = defaultTime.split(':').map(Number);
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || min > 59) return null;
  const pad = (n) => ('0' + n).slice(-2);
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(min)}:00+09:00`;
  return { iso, date: `${y}-${pad(mo)}-${pad(d)}`, time: new Date(iso).getTime() };
}

// ── 세미나 ───────────────────────────────────────────

function readSeminarRows_() {
  const id = props_().getProperty('SEMINAR_SHEET_ID');
  if (!id) throw new Error('세미나 시트가 연결되지 않음');
  const ss = SpreadsheetApp.openById(id);
  const tabName = props_().getProperty('SEMINAR_TAB');
  const sheet = (tabName && ss.getSheetByName(tabName)) || ss.getSheets()[0];
  return sheet.getDataRange().getDisplayValues();
}

// 주간세미나 시트(기존 형식) 또는 정리된 형식을 사이트용 세미나 목록으로 바꾼다
function parseSeminars_(values) {
  const hrow = values.findIndex((row) => row.some((c) => String(c).trim() === '작가 및 작품명'));
  if (hrow === -1) throw new Error("'작가 및 작품명' 머리행이 없음");
  const header = values[hrow].map((h) => String(h).trim().replace(/\s*\(.*$/, ''));
  const col = (name) => header.indexOf(name);
  const get = (row, name) => (col(name) === -1 ? '' : String(row[col(name)] == null ? '' : row[col(name)]).trim());
  const structured = col('세미나 ID') !== -1;

  const out = [];
  const seen = {};
  for (let r = hrow + 1; r < values.length; r++) {
    const row = values[r];
    let title = get(row, '작가 및 작품명');
    const when = get(row, '개최 일시') || get(row, '발제 날짜');
    if (!title || !when) continue;
    const start = kstTime_(when, DEFAULT_TIME);
    if (!start) continue; // 휴회 기간처럼 하루가 아닌 행

    let id;
    let status;
    if (structured) {
      id = get(row, '세미나 ID');
      status = { 게시: 'published', 취소: 'cancelled', 초안: 'draft', '': 'draft' }[get(row, '게시 상태')];
    } else {
      id = start.date; // 기존 형식: 날짜가 ID
      status = 'published';
      const m = title.match(/^(.+?)\s+-\s+(.+)$/);
      if (m) title = `${m[1]} 『${m[2]}』`;
    }
    const capText = get(row, '정원');
    const capacity = capText === '' ? DEFAULT_CAPACITY : /^\d{1,3}$/.test(capText) ? Number(capText) : null;
    if (!id || !status || status === 'draft' || !capacity || capacity < 2 || capacity > 100 || seen[id]) continue;
    seen[id] = true;
    const docUrl = get(row, '발제문 URL');
    out.push({
      id,
      title,
      presenter: maskName_(get(row, '발제자')),
      startsAt: start.iso,
      place: get(row, '장소') || DEFAULT_PLACE,
      capacity,
      status,
      docUrl: /^https:\/\/\S+$/.test(docUrl) ? docUrl : null,
      note: get(row, '공개 안내') || get(row, '비고'),
    });
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function seminarList_() {
  return cached_('seminars', CACHE_SECONDS, () => parseSeminars_(readSeminarRows_()));
}

// 취소되지 않은 신청 수(발제자 제외)
function reservationCounts_() {
  const counts = {};
  for (const r of records_(tab_('reservations'))) {
    if (!r['취소 시각']) counts[r['세미나 ID']] = (counts[r['세미나 ID']] || 0) + 1;
  }
  return counts;
}

function getSeminars_() {
  return { status: 'ok', fetchedAt: nowIso_(), seminars: seminarList_(), counts: reservationCounts_() };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  // 같은 순간의 신청을 한 줄로 세운다. 마지막 자리에 여럿이 동시에 신청해도 한 명만 성공한다
  if (!lock.tryLock(15000)) return 'busy';
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// 결과: ok | duplicate | full | closed | invalid | busy
function reserve_(seminarId, name, pin) {
  const n = String(name || '').trim();
  const p = String(pin || '');
  if (!n || n.length > 30 || !/^\d{4}$/.test(p)) return 'invalid';
  return withLock_(() => {
    const s = seminarList_().find((x) => x.id === seminarId);
    if (!s) return 'invalid';
    if (s.status !== 'published' || new Date(s.startsAt).getTime() <= Date.now()) return 'closed';
    const sheet = tab_('reservations');
    const active = records_(sheet).filter((r) => r['세미나 ID'] === seminarId && !r['취소 시각']);
    if (active.some((r) => r['이름'] === n)) return 'duplicate';
    if (active.length >= s.capacity - 1) return 'full';
    sheet.appendRow([seminarId, n, hashSecret_(p), nowIso_(), ''].map(asText_));
    SpreadsheetApp.flush();
    return 'ok';
  });
}

// 결과: ok | not_found | closed | busy   (이름이 없을 때와 확인번호가 틀릴 때 똑같이 not_found)
function cancel_(seminarId, name, pin) {
  const n = String(name || '').trim();
  const p = String(pin || '');
  return withLock_(() => {
    const s = seminarList_().find((x) => x.id === seminarId);
    if (!s) {
      checkSecret_(p, '');
      return 'not_found';
    }
    if (new Date(s.startsAt).getTime() <= Date.now()) return 'closed';
    const sheet = tab_('reservations');
    const row = records_(sheet).find((r) => r['세미나 ID'] === seminarId && r['이름'] === n && !r['취소 시각']);
    if (!row || !checkSecret_(p, row['확인번호(해시)'])) {
      if (!row) checkSecret_(p, '');
      return 'not_found';
    }
    sheet.getRange(row._row, colIndex_(sheet, '취소 시각')).setValue(asText_(nowIso_()));
    SpreadsheetApp.flush();
    return 'ok';
  });
}

// ── 책장 ─────────────────────────────────────────────

function isoDate_(text) {
  const m = String(text || '').trim().match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  return m ? `${m[1]}-${('0' + m[2]).slice(-2)}-${('0' + m[3]).slice(-2)}` : null;
}

function getBooks_() {
  const books = cached_('books', CACHE_SECONDS, () => {
    const open = {};
    for (const l of records_(tab_('loans'))) {
      // '빌린 회원 이름' 열은 읽지 않는다
      if (!l['관리번호'] || l['실제 반납일']) continue;
      (open[l['관리번호']] = open[l['관리번호']] || []).push(l);
    }
    const seen = {};
    const out = [];
    for (const b of records_(tab_('books'))) {
      const seriesNo = Number(b['전집 권번호']);
      if (!b['관리번호'] || !b['제목'] || !Number.isInteger(seriesNo) || seriesNo < 1 || seen[b['관리번호']]) continue;
      seen[b['관리번호']] = true;
      const loans = open[b['관리번호']] || [];
      out.push({
        copyId: b['관리번호'],
        seriesNo,
        title: b['제목'],
        author: b['작가'] || '',
        translator: b['번역자'] || '',
        isbn: b['ISBN'] || '',
        status: loans.length ? 'on_loan' : 'available',
        // 미반납이 두 건 이상이면 기록 확인이 필요하므로 날짜를 보여 주지 않는다
        dueDate: loans.length === 1 ? isoDate_(loans[0]['반납 예정일']) : null,
      });
    }
    return out.sort((a, b) => a.seriesNo - b.seriesNo || (a.copyId < b.copyId ? -1 : 1));
  });
  return { status: 'ok', fetchedAt: nowIso_(), books };
}

// ── 그날의 토론 ──────────────────────────────────────

function parseJson_(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (err) {
    return fallback;
  }
}

function getDiscussions_() {
  const list = cached_('discussions', CACHE_SECONDS, () => {
    const seminars = {};
    seminarList_().forEach((s) => (seminars[s.id] = s));
    return records_(tab_('discussions'))
      .filter((d) => d['상태'] === '게시' && seminars[d['세미나 ID']])
      .map((d) => ({
        seminarId: d['세미나 ID'],
        title: seminars[d['세미나 ID']].title,
        startsAt: seminars[d['세미나 ID']].startsAt,
        keywords: parseJson_(d['키워드'], []),
        summary: d['요약'],
        questions: parseJson_(d['질문'], []),
        quotes: parseJson_(d['남기고 싶은 말'], []),
        publishedAt: d['게시 시각'],
      }))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  });
  return { status: 'ok', discussions: list };
}

function staffOk_(code) {
  return checkSecret_(String(code || '').trim(), props_().getProperty('STAFF_CODE_HASH'));
}

function cleanList_(v, max, mapFn) {
  if (!Array.isArray(v) || v.length > max) return null;
  return v.map(mapFn).filter(Boolean);
}

// 결과: ok | bad_code | not_found | too_short | too_long | invalid | limit
function saveDiscussion_(b) {
  if (!staffOk_(b.code)) return 'bad_code';
  const text = String(b.text || '').trim();
  if (!seminarList_().some((s) => s.id === b.seminarId)) return 'not_found';
  if (text.length < LIMITS.textMin) return 'too_short';
  if (text.length > LIMITS.textMax) return 'too_long';
  const keywords = cleanList_(b.keywords, 40, (k) =>
    k && String(k.word || '').trim() ? { word: String(k.word).trim().slice(0, 20), count: Math.max(1, Number(k.count) || 1) } : null,
  );
  const questions = cleanList_(b.questions, 10, (q) => String(q || '').trim().slice(0, 300) || null);
  const quotes = cleanList_(b.quotes, 10, (q) =>
    q && String(q.text || '').trim() ? { speaker: String(q.speaker || '참석자').trim().slice(0, 20), text: String(q.text).trim().slice(0, 500) } : null,
  );
  const summary = String(b.summary || '').trim();
  if (!keywords || !questions || !quotes || summary.length > 2000) return 'invalid';
  if (!underDailyLimit_('DISCUSSION', LIMITS.discussionSavesPerDay)) return 'limit';

  // AI 정리를 요청하면 운영진이 결과를 확인할 때까지 초안으로 둔다
  const publish = !!b.publish && !b.requestAi;
  return withLock_(() => {
    const sheet = tab_('discussions');
    const existing = records_(sheet).find((d) => d['세미나 ID'] === b.seminarId);
    const now = nowIso_();
    const row = [
      b.seminarId,
      publish ? '게시' : '초안',
      b.requestAi ? '요청' : existing ? existing['AI 상태'] || '' : '',
      JSON.stringify(keywords),
      summary,
      JSON.stringify(questions),
      JSON.stringify(quotes),
      text,
      now,
      publish ? (existing && existing['게시 시각']) || now : '',
      b.requestAi ? '' : existing ? existing['AI 메모'] || '' : '',
    ];
    const cells = row.map(asText_);
    if (existing) sheet.getRange(existing._row, 1, 1, cells.length).setValues([cells]);
    else sheet.appendRow(cells);
    SpreadsheetApp.flush();
    clearCache_();
    return 'ok';
  });
}

function loadDiscussion_(code, seminarId) {
  if (!staffOk_(code)) return { status: 'bad_code' };
  const d = records_(tab_('discussions')).find((x) => x['세미나 ID'] === seminarId);
  if (!d) return { status: 'empty' };
  const ai = { 요청: 'requested', 완료: 'done', 실패: 'failed' }[d['AI 상태']] || 'none';
  return {
    status: 'ok',
    seminarId,
    text: d['원문'],
    keywords: parseJson_(d['키워드'], []),
    summary: d['요약'],
    questions: parseJson_(d['질문'], []),
    quotes: parseJson_(d['남기고 싶은 말'], []),
    state: d['상태'] === '게시' ? 'published' : 'draft',
    aiStatus: ai,
    aiNote: d['AI 메모'],
    updatedAt: d['수정 시각'],
  };
}

// GitHub Actions의 AI 정리용. 토큰은 메뉴에서 만들고 해시만 저장한다
function aiOk_(token) {
  return checkSecret_(String(token || ''), props_().getProperty('AI_TOKEN_HASH'));
}

function aiPending_(token) {
  if (!aiOk_(token)) return { status: 'bad_token' };
  const seminars = {};
  seminarList_().forEach((s) => (seminars[s.id] = s));
  const items = records_(tab_('discussions'))
    .filter((d) => d['AI 상태'] === '요청')
    .slice(0, 5)
    .map((d) => ({
      seminarId: d['세미나 ID'],
      title: seminars[d['세미나 ID']] ? seminars[d['세미나 ID']].title : '',
      text: d['원문'],
      keywords: parseJson_(d['키워드'], []),
    }));
  return { status: 'ok', items };
}

// 결과: ok | bad_token | not_found | invalid
function aiSave_(b) {
  if (!aiOk_(b.token)) return 'bad_token';
  return withLock_(() => {
    const sheet = tab_('discussions');
    const d = records_(sheet).find((x) => x['세미나 ID'] === b.seminarId);
    if (!d) return 'not_found';
    const set = (name, value) => sheet.getRange(d._row, colIndex_(sheet, name)).setValue(asText_(value));
    if (b.error) {
      set('AI 상태', '실패');
      set('AI 메모', String(b.error).slice(0, 200));
    } else {
      const r = b.result || {};
      if (!Array.isArray(r.keywords) || !Array.isArray(r.questions) || !Array.isArray(r.quotes)) return 'invalid';
      set('키워드', JSON.stringify(r.keywords.slice(0, 40)));
      set('요약', String(r.summary || '').slice(0, 2000));
      set('질문', JSON.stringify(r.questions.slice(0, 10)));
      set('남기고 싶은 말', JSON.stringify(r.quotes.slice(0, 10)));
      set('AI 상태', '완료');
      set('AI 메모', '');
      set('상태', '초안');
    }
    set('수정 시각', nowIso_());
    SpreadsheetApp.flush();
    clearCache_();
    return 'ok';
  });
}

// ── 독서 지도 ────────────────────────────────────────

// 게시된 장소 중 좌표가 빈 곳은 주소로 찾아 시트에 적어 둔다(한 번 찾으면 다시 찾지 않음)
function fillCoordinates_(sheet, rows) {
  const latCol = colIndex_(sheet, '위도');
  const lngCol = colIndex_(sheet, '경도');
  let tries = 0;
  for (const r of rows) {
    if (r['게시'] !== '게시' || (r['위도'] && r['경도']) || !r['주소'] || tries >= 10) continue;
    tries++;
    try {
      const res = Maps.newGeocoder().setRegion('kr').setLanguage('ko').geocode(r['주소']);
      const loc = res && res.results && res.results[0] && res.results[0].geometry.location;
      if (loc) {
        sheet.getRange(r._row, latCol).setValue(loc.lat);
        sheet.getRange(r._row, lngCol).setValue(loc.lng);
        r['위도'] = String(loc.lat);
        r['경도'] = String(loc.lng);
      }
    } catch (err) {
      console.error('좌표 찾기 실패', r['장소 ID']);
    }
  }
}

function getPlaces_() {
  const places = cached_('places', CACHE_SECONDS, () => {
    const sheet = tab_('places');
    const rows = records_(sheet);
    fillCoordinates_(sheet, rows);
    return rows
      .filter((r) => r['게시'] === '게시' && r['장소 이름'] && r['주소'])
      .map((r) => {
        const lat = Number(r['위도']);
        const lng = Number(r['경도']);
        const link = r['네이버 지도 링크'];
        return {
          id: r['장소 ID'] || `P-${r._row}`,
          name: r['장소 이름'],
          category: PLACE_CATEGORIES.indexOf(r['분류']) !== -1 ? r['분류'] : '모임 장소',
          address: r['주소'],
          lat: Number.isFinite(lat) && r['위도'] ? lat : null,
          lng: Number.isFinite(lng) && r['경도'] ? lng : null,
          book: /^\d{1,3}$/.test(r['관련 책']) ? Number(r['관련 책']) : null,
          memo: r['한 줄 메모'],
          naverUrl: /^https:\/\/(naver\.me|map\.naver\.com|m\.place\.naver\.com|place\.map\.naver\.com)\/\S*$/.test(link) ? link : null,
          source: r['출처'] === '회원 추천' ? '회원 추천' : '운영진',
          recommender: r['출처'] === '회원 추천' ? r['추천한 사람'] || '해문 회원' : '',
        };
      });
  });
  return { status: 'ok', categories: PLACE_CATEGORIES, places };
}

// 결과: ok | missing | invalid_category | too_long | duplicate | limit
function suggestPlace_(b) {
  const name = String(b.name || '').trim();
  const address = String(b.address || '').trim();
  const reason = String(b.reason || '').trim();
  const nickname = String(b.nickname || '').trim();
  const book = String(b.book || '').trim();
  const link = String(b.naverUrl || '').trim();
  if (!name || !address || !reason) return 'missing';
  if (PLACE_CATEGORIES.indexOf(b.category) === -1) return 'invalid_category';
  if (name.length > 50 || address.length > 120 || reason.length > 100 || nickname.length > 20) return 'too_long';
  if (book && !/^\d{1,3}$/.test(book)) return 'invalid_book';
  return withLock_(() => {
    const sheet = tab_('places');
    const norm = (s) => String(s).replace(/\s+/g, '');
    if (records_(sheet).some((r) => norm(r['장소 이름']) === norm(name) && norm(r['주소']) === norm(address))) return 'duplicate';
    if (!underDailyLimit_('PLACE', LIMITS.placeSuggestionsPerDay)) return 'limit';
    sheet.appendRow([
      `S-${Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMddHHmmss')}`,
      name,
      b.category,
      address,
      '',
      '',
      book,
      reason,
      link,
      '회원 추천',
      nickname || '해문 회원',
      '검토 대기',
      nowIso_(),
    ].map(asText_));
    SpreadsheetApp.flush();
    return 'ok';
  });
}

// ── 운영진 메뉴 ──────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('읽고, 잇다')
    .addItem('1. 처음 설정(탭 만들기)', 'setupSheets')
    .addItem('2. 세미나 시트 연결', 'connectSeminarSheet')
    .addItem('3. 운영진 코드 정하기', 'setStaffCode')
    .addItem('AI 작업 토큰 만들기(선택)', 'makeAiToken')
    .addItem('저장된 값 새로 고치기', 'refreshCache')
    .addToUi();
}

function setupSheets() {
  props_().setProperty('OPS_SHEET_ID', SpreadsheetApp.getActiveSpreadsheet().getId());
  Object.keys(TAB).forEach((k) => tab_(k));
  SpreadsheetApp.getUi().alert('탭을 만들었습니다. 다음으로 "2. 세미나 시트 연결"을 실행하세요.');
}

function connectSeminarSheet() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('세미나 시트 연결', '주간세미나 스프레드시트 주소(또는 ID)를 붙여 넣으세요.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const text = res.getResponseText().trim();
  const m = text.match(/\/d\/([A-Za-z0-9_-]{20,})/);
  const id = m ? m[1] : text;
  try {
    const rows = parseSeminars_(SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getDisplayValues());
    props_().setProperty('SEMINAR_SHEET_ID', id);
    clearCache_();
    ui.alert(`연결했습니다. 세미나 ${rows.length}건을 읽었습니다.`);
  } catch (err) {
    ui.alert(`연결하지 못했습니다: ${err.message}`);
  }
}

function setStaffCode() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('운영진 코드 정하기', '토론 기록을 올릴 때 쓸 코드(6자 이상)를 입력하세요. 원문은 저장되지 않습니다.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const code = res.getResponseText().trim();
  if (code.length < 6) return ui.alert('6자 이상이어야 합니다.');
  props_().setProperty('STAFF_CODE_HASH', hashSecret_(code));
  ui.alert('운영진 코드를 정했습니다.');
}

function makeAiToken() {
  const token = Utilities.getUuid() + Utilities.getUuid();
  props_().setProperty('AI_TOKEN_HASH', hashSecret_(token));
  SpreadsheetApp.getUi().alert(
    `아래 토큰을 GitHub Secrets의 AI_WORKER_TOKEN에 등록하세요. 이 창을 닫으면 다시 볼 수 없습니다.\n\n${token}`,
  );
}

function refreshCache() {
  clearCache_();
  SpreadsheetApp.getUi().alert('저장된 값을 비웠습니다. 사이트가 다음 요청 때 시트를 다시 읽습니다.');
}

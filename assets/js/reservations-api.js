// 서버 호출을 한곳에 모은 모듈. 서버는 구글 시트에 붙은 Apps Script 웹 앱 하나뿐이다(apps-script/Code.gs).
//  - 읽기: GET ?action=seminars | books | discussions | places
//  - 쓰기: POST(text/plain, JSON) { action: reserve | cancel | saveDiscussion | loadDiscussion | suggestPlace }
//
// config.js의 APPS_SCRIPT_URL이 비어 있을 때:
//  - 내 컴퓨터(localhost)에서는 가짜 응답으로 동작한다. 주소 뒤에 ?mock=결과 를 붙이면 신청·취소가 그 결과를 돌려준다.
//    예: ?mock=full, ?mock=closed, ?mock=not_found, ?mock=error
//  - 배포된 사이트에서는 mode가 'off'가 되어, 화면은 시트를 직접 읽어 일정만 보여 주고 신청은 막는다.

import { APPS_SCRIPT_URL } from './config.js';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const mode = APPS_SCRIPT_URL ? 'live' : isLocal ? 'mock' : 'off';

// ── 실제 서버(Apps Script) ──
async function getJson(action) {
  const res = await fetch(`${APPS_SCRIPT_URL}?action=${encodeURIComponent(action)}`, {
    signal: AbortSignal.timeout(20_000),
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
  const data = await res.json();
  if (data.status && data.status !== 'ok') throw new Error('서버 오류');
  return data;
}

// Apps Script는 사전 요청(OPTIONS)을 받지 못하므로 text/plain으로 보낸다
async function postJson(body) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
  return res.json();
}

// 결과 문자열. 'busy'(동시 요청이 몰림)와 'error'는 화면에서 일시적 오류로 보인다
const result = (r) => (r && typeof r.result === 'string' ? r.result : 'error');

// ── 가짜 응답 (localhost 전용) ──
const forced = new URLSearchParams(location.search).get('mock');
const mockSeminars = new Map(); // id → { startsAt, capacity, status, title }
const mockReservations = new Map(); // id → [{ name, pin }]
const mockDiscussions = new Map(); // seminarId → 기록
const mockPlaces = [];

export function setMockSeminars(list, initialCounts = {}) {
  for (const s of list) {
    mockSeminars.set(s.id, s);
    const n = initialCounts[s.id] ?? 0;
    mockReservations.set(
      s.id,
      Array.from({ length: n }, (_, i) => ({ name: `가짜 신청자 ${i + 1}`, pin: '0000' })),
    );
  }
}

const delay = () => new Promise((r) => setTimeout(r, 400));

async function mockReserve(fn, id, name, pin) {
  await delay();
  if (forced === 'error') throw new Error('가짜 오류');
  if (forced) return forced;
  const s = mockSeminars.get(id);
  const n = String(name ?? '').trim();
  const list = mockReservations.get(id);
  const started = s && new Date(s.startsAt) <= new Date();
  if (fn === 'reserve') {
    if (!s || !n || !/^\d{4}$/.test(pin)) return 'invalid';
    if (s.status !== 'published' || started) return 'closed';
    if (list.some((r) => r.name === n)) return 'duplicate';
    if (list.length >= s.capacity - 1) return 'full';
    list.push({ name: n, pin });
    return 'ok';
  }
  if (!s) return 'not_found';
  if (started) return 'closed';
  const i = list.findIndex((r) => r.name === n && r.pin === pin);
  if (i === -1) return 'not_found';
  list.splice(i, 1);
  return 'ok';
}

// ── 세미나 ──

// 결과: 'ok' | 'duplicate' | 'full' | 'closed' | 'invalid' | 'busy' | 'error'
export async function reserve(seminarId, name, pin) {
  if (mode === 'mock') return mockReserve('reserve', seminarId, name, pin);
  if (mode !== 'live') throw new Error('신청 기능이 아직 연결되지 않았습니다');
  return result(await postJson({ action: 'reserve', seminarId, name, pin }));
}

// 결과: 'ok' | 'not_found' | 'closed' | 'busy' | 'error'
export async function cancelReservation(seminarId, name, pin) {
  if (mode === 'mock') return mockReserve('cancel', seminarId, name, pin);
  if (mode !== 'live') throw new Error('신청 기능이 아직 연결되지 않았습니다');
  return result(await postJson({ action: 'cancel', seminarId, name, pin }));
}

// 결과: Map(seminar id → 신청 수, 발제자 제외)
export async function seminarCounts() {
  if (mode === 'mock') {
    await delay();
    if (forced === 'error') throw new Error('가짜 오류');
    return new Map([...mockReservations].map(([id, list]) => [id, list.length]));
  }
  if (mode !== 'live') throw new Error('연결되지 않음');
  const data = await getJson('seminars');
  return new Map(Object.entries(data.counts ?? {}).map(([k, v]) => [k, Number(v)]));
}

// 시트 데이터. 결과: { status: 'ok', fetchedAt, rows } | { status: 'not_configured' }
//  - seminars: 사이트 형식의 세미나 목록(발제자 이름은 서버에서 가려서 옴)
//  - books: 사이트 형식의 책 목록(빌린 사람 이름 없음)
export async function sheetRows(kind) {
  if (mode !== 'live') return { status: 'not_configured' };
  const data = await getJson(kind);
  return { status: 'ok', fetchedAt: data.fetchedAt, rows: kind === 'books' ? data.books : data.seminars };
}

// ── 그날의 토론 ──

export async function publishedDiscussions() {
  if (mode === 'mock') return [...mockDiscussions.values()].filter((d) => d.state === 'published');
  if (mode !== 'live') throw new Error('연결되지 않음');
  return (await getJson('discussions')).discussions ?? [];
}

// 결과: 'ok' | 'bad_code' | 'not_found' | 'too_short' | 'too_long' | 'invalid' | 'limit' | 'busy' | 'error'
export async function saveDiscussion(d) {
  if (mode === 'mock') {
    await delay();
    if (d.code !== 'local-test') return 'bad_code'; // 내 컴퓨터에서 화면을 시험할 때만 쓰는 코드
    const text = String(d.text).trim();
    if (text.length < 200) return 'too_short';
    if (text.length > 45000) return 'too_long';
    const s = mockSeminars.get(d.seminarId);
    mockDiscussions.set(d.seminarId, {
      ...d,
      title: s?.title ?? d.seminarId,
      startsAt: s?.startsAt ?? new Date().toISOString(),
      state: d.publish && !d.requestAi ? 'published' : 'draft',
      aiStatus: d.requestAi ? 'requested' : 'none',
    });
    return 'ok';
  }
  if (mode !== 'live') throw new Error('연결되지 않음');
  return result(await postJson({ action: 'saveDiscussion', ...d }));
}

// 운영진: 저장된 기록 불러오기. { status: 'ok' | 'empty' | 'bad_code', … }
export async function discussionForStaff(code, seminarId) {
  if (mode === 'mock') {
    if (code !== 'local-test') return { status: 'bad_code' };
    const d = mockDiscussions.get(seminarId);
    return d ? { status: 'ok', ...d } : { status: 'empty' };
  }
  if (mode !== 'live') throw new Error('연결되지 않음');
  return postJson({ action: 'loadDiscussion', code, seminarId });
}

// ── 독서 지도 ──

// 결과: { categories, places: [{ id, name, category, address, lat, lng, book, memo, naverUrl, source, recommender }] }
export async function getPlaces() {
  if (mode !== 'live') throw new Error('연결되지 않음');
  return getJson('places');
}

// 결과: 'published' | 'ok' | 'missing' | 'invalid_category' | 'too_long' | 'invalid_book' | 'duplicate' | 'limit' | 'busy' | 'error'
export async function suggestPlace(p) {
  if (mode === 'mock') {
    await delay();
    if (mockPlaces.some((x) => x.name === p.name && x.address === p.address)) return 'duplicate';
    mockPlaces.push(p);
    return 'published';
  }
  if (mode !== 'live') throw new Error('연결되지 않음');
  return result(await postJson({ action: 'suggestPlace', ...p }));
}

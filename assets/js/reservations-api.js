// 서버 호출을 한곳에 모은 모듈. Supabase의 공개 함수만 부르고 표는 직접 건드리지 않는다.
//  - sheet_rows: 구글 시트(세미나 일정·도서 목록)를 서버가 읽어 돌려줌 (supabase/sheets.sql)
//  - reserve_from_sheet, cancel_from_sheet: 시트의 최신 일정으로 맞춘 뒤 신청·취소
//  - seminar_counts: 세미나별 신청 수
//
// config.js가 비어 있을 때:
//  - localhost에서는 가짜 응답(메모리)으로 동작한다. 주소 뒤에 ?mock=결과 를 붙이면 모든 호출이 그 결과를 돌려준다.
//    예: ?mock=full, ?mock=closed, ?mock=not_found, ?mock=error
//  - 배포된 사이트에서는 mode가 'off'가 되어 화면이 신청을 막는다.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const mode = configured ? 'live' : isLocal ? 'mock' : 'off';

// ── 실제 서버 ──
// 예전 방식 키(eyJ…로 시작하는 JWT)만 Authorization에 함께 보낸다. 새 키(sb_publishable_/sb_secret_)는 apikey 헤더만 쓴다.
function authHeaders(key) {
  const h = { apikey: key, 'content-type': 'application/json' };
  if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`;
  return h;
}

async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: authHeaders(SUPABASE_ANON_KEY),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
  return res.json();
}

// ── 가짜 응답 (localhost 전용) ──
const forced = new URLSearchParams(location.search).get('mock');
const mockSeminars = new Map(); // id → { startsAt, capacity, status }
const mockReservations = new Map(); // id → [{ name, pin }]

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

async function mockCall(fn, args) {
  await delay();
  if (forced === 'error') throw new Error('가짜 오류');
  if (forced && fn !== 'seminar_counts') return forced;

  if (fn === 'seminar_counts') {
    return [...mockReservations].map(([seminar_id, list]) => ({ seminar_id, count: list.length }));
  }
  const s = mockSeminars.get(args.p_seminar_id);
  const name = String(args.p_name ?? '').trim();
  const pin = String(args.p_pin ?? '');
  const list = mockReservations.get(args.p_seminar_id);
  const started = s && new Date(s.startsAt) <= new Date();

  if (fn === 'reserve') {
    if (!s || !name || !/^\d{4}$/.test(pin)) return 'invalid';
    if (s.status !== 'published' || started) return 'closed';
    if (list.some((r) => r.name === name)) return 'duplicate';
    if (list.length >= s.capacity - 1) return 'full';
    list.push({ name, pin });
    return 'ok';
  }
  if (fn === 'cancel_reservation') {
    if (!s || started) return 'closed';
    const i = list.findIndex((r) => r.name === name && r.pin === pin);
    if (i === -1) return 'not_found';
    list.splice(i, 1);
    return 'ok';
  }
  throw new Error(`알 수 없는 함수 ${fn}`);
}

function call(fn, args) {
  if (mode === 'live') return rpc(fn, args);
  if (mode === 'mock') return mockCall(fn, args);
  return Promise.reject(new Error('신청 기능이 아직 연결되지 않았습니다'));
}

// 결과: 'ok' | 'duplicate' | 'full' | 'closed' | 'invalid'
export function reserve(seminarId, name, pin) {
  const args = { p_seminar_id: seminarId, p_name: name, p_pin: pin };
  return mode === 'live' ? rpc('reserve_from_sheet', args) : call('reserve', args);
}

// 결과: 'ok' | 'not_found' | 'closed'
export function cancelReservation(seminarId, name, pin) {
  const args = { p_seminar_id: seminarId, p_name: name, p_pin: pin };
  return mode === 'live' ? rpc('cancel_from_sheet', args) : call('cancel_reservation', args);
}

// 구글 시트 데이터. 결과: { status: 'ok', fetchedAt, rows } | { status: 'not_configured' } | { status: 'error' }
// 서버가 연결되지 않았으면(내 컴퓨터의 가짜 응답 모드 포함) not_configured → 화면은 예시 데이터를 쓴다.
// fresh=false: 서버에 저장된 값을 바로 받음(빠름) / fresh=true: 필요하면 시트를 다시 읽음(몇 초)
export async function sheetRows(kind, fresh = true) {
  if (mode !== 'live') return { status: 'not_configured' };
  return rpc('sheet_rows', { p_kind: kind, p_fresh: fresh });
}

// 결과: Map(seminar_id → 신청 수, 발제자 제외)
export async function seminarCounts() {
  const rows = await call('seminar_counts', {});
  return new Map(rows.map((r) => [r.seminar_id, Number(r.count)]));
}

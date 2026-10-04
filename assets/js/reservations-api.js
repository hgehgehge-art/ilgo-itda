// 세미나 신청 서버 호출을 한곳에 모은 모듈.
// Supabase의 서버 함수 세 개(reserve, cancel_reservation, seminar_counts)만 부른다. 표는 직접 건드리지 않는다.
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
async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'content-type': 'application/json',
    },
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
  return call('reserve', { p_seminar_id: seminarId, p_name: name, p_pin: pin });
}

// 결과: 'ok' | 'not_found' | 'closed'
export function cancelReservation(seminarId, name, pin) {
  return call('cancel_reservation', { p_seminar_id: seminarId, p_name: name, p_pin: pin });
}

// 결과: Map(seminar_id → 신청 수, 발제자 제외)
export async function seminarCounts() {
  const rows = await call('seminar_counts', {});
  return new Map(rows.map((r) => [r.seminar_id, Number(r.count)]));
}

// 세미나: 일정은 구글 시트(서버의 sheet_rows)에서, 시트가 연결되기 전에는 data/seminars.json(예시)에서 읽는다.
// 인원과 신청·취소는 reservations-api.js로 처리한다.
// 정원(capacity)에는 발제자 1명이 포함된다. 화면 인원 = 서버 신청 수 + 1.
// 신청자 이름은 어디에도 표시하지 않는다.

import { mode, reserve, cancelReservation, seminarCounts, setMockSeminars, sheetRows } from './reservations-api.js';

const DATA_URL = 'data/seminars.json';
const DEFAULT_PLACE = '동아리방';

const $ = (id) => document.getElementById(id);
const upcomingList = $('seminar-upcoming');
const pastList = $('seminar-past');
const pastWrap = $('seminar-past-wrap');
const statusLine = $('seminar-status');
const notice = $('seminar-example');
const mockNotice = $('seminar-mock');

const MESSAGES = {
  reserve: {
    ok: '신청이 완료되었습니다. 확인번호를 잊지 마세요.',
    duplicate: '이미 같은 이름으로 신청되어 있습니다.',
    full: '정원이 마감되었습니다.',
    closed: '이미 시작했거나 신청을 받지 않는 세미나입니다.',
    invalid: '이름과 확인번호 4자리를 확인해 주세요.',
  },
  cancel: {
    ok: '신청이 취소되었습니다.',
    not_found: '이름 또는 확인번호가 맞지 않습니다.',
    closed: '이미 시작한 세미나는 취소할 수 없습니다. 운영진에게 문의해 주세요.',
  },
  error: '일시적인 오류로 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  off: '온라인 신청은 아직 준비 중입니다.',
  example: '예시 일정이라 신청을 받지 않습니다. 실제 일정이 연결되면 신청할 수 있습니다.',
};

let seminars = [];
let counts = null; // Map | null(불러오지 못함)
// 신청을 받는지: 가짜 응답(localhost)이거나, 서버가 연결되어 있고 실제 일정일 때만
let signupOpen = false;

// ── 표시 형식 (모두 한국시간) ──
const KST = 'Asia/Seoul';
const fmt = (opts) => new Intl.DateTimeFormat('ko-KR', { timeZone: KST, ...opts });
const fmtMonth = fmt({ month: 'long' });
const fmtDay = fmt({ day: 'numeric' });
const fmtWeekday = fmt({ weekday: 'short' });
const fmtTime = fmt({ hour: 'numeric', minute: '2-digit' });
const fmtFull = fmt({ month: 'long', day: 'numeric', weekday: 'short' });

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function stateOf(s) {
  if (s.status === 'cancelled') return { key: 'cancelled', label: '취소' };
  if (new Date(s.startsAt) <= new Date()) return { key: 'ended', label: '종료' };
  const n = counts?.get(s.id);
  if (n != null && n + 1 >= s.capacity) return { key: 'full', label: '마감' };
  // 예시 일정이거나 서버가 연결되지 않아 신청을 받지 않는 동안
  if (!signupOpen) return { key: 'pending', label: '신청 준비 중' };
  return { key: 'open', label: '접수 중' };
}

function headcount(s) {
  if (!counts) return null;
  return Math.min((counts.get(s.id) ?? 0) + 1, s.capacity);
}

function countText(s) {
  const hc = headcount(s);
  // 인원을 모를 때(신청을 받지 않는 동안, 또는 불러오기 실패)는 정원만 보여 준다
  return hc == null ? `정원 ${s.capacity}명` : `${hc}/${s.capacity}명`;
}

function setMeter(bar, s) {
  const hc = headcount(s);
  bar.setAttribute('aria-label', `정원 ${s.capacity}명 중 ${hc}명`);
  bar.firstChild.style.width = `${(hc / s.capacity) * 100}%`;
}

// 카드를 다시 그리지 않고 인원 숫자와 막대만 고친다
function updateNumbers() {
  for (const s of seminars) {
    const card = document.getElementById(`seminar-${s.id}`);
    if (!card) continue;
    const c = card.querySelector('.seminar-count');
    if (c) c.textContent = countText(s);
    const bar = card.querySelector('.meter');
    if (bar && headcount(s) != null) setMeter(bar, s);
  }
}

// ── 신청·취소 양식 ──
function buildForm(s, state) {
  const wrap = el('div', { class: 'rsv' });
  const actions = el('div', { class: 'rsv-actions' });
  const form = el('form', { class: 'rsv-form', hidden: '', novalidate: '' });
  const result = el('p', { class: 'rsv-result', role: 'status', 'aria-live': 'polite' });

  const canReserve = state.key === 'open';
  const btnReserve = el('button', { type: 'button', class: 'btn' }, '신청하기');
  const btnCancel = el('button', { type: 'button', class: 'btn btn--quiet' }, '신청 취소');
  if (canReserve) actions.append(btnReserve);
  actions.append(btnCancel);

  const uid = s.id.replace(/[^a-z0-9-]/gi, '');
  const legend = el('p', { class: 'rsv-legend' });
  const nameLabel = el('label', { for: `name-${uid}` }, '이름');
  const name = el('input', {
    id: `name-${uid}`,
    type: 'text',
    autocomplete: 'off',
    maxlength: '30',
    required: '',
  });
  const pinLabel = el('label', { for: `pin-${uid}` }, '확인번호 4자리');
  const pin = el('input', {
    id: `pin-${uid}`,
    type: 'password',
    inputmode: 'numeric',
    autocomplete: 'off',
    pattern: '\\d{4}',
    maxlength: '4',
    required: '',
    'aria-describedby': `pin-help-${uid}`,
  });
  const help = el('p', { class: 'rsv-help', id: `pin-help-${uid}` });
  const submit = el('button', { type: 'submit', class: 'btn' });
  const close = el('button', { type: 'button', class: 'rsv-close' }, '닫기');

  const fields = el('div', { class: 'rsv-fields' });
  const f1 = el('div', { class: 'field' });
  f1.append(nameLabel, name);
  const f2 = el('div', { class: 'field' });
  f2.append(pinLabel, pin);
  fields.append(f1, f2);
  const row = el('div', { class: 'rsv-row' });
  row.append(submit, close);
  form.append(legend, fields, help, row);

  // 숫자 4자리만 받는다
  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
  });

  let action = 'reserve';
  function openForm(kind, trigger) {
    action = kind;
    legend.textContent = kind === 'reserve' ? '참석 신청' : '신청 취소';
    help.textContent =
      kind === 'reserve'
        ? '확인번호는 취소할 때 필요합니다. 잊으면 운영진에게 요청해야 합니다. 동명이인이 있으면 이름 뒤에 구분 표기를 붙여 주세요(예: 김하늘B).'
        : '신청할 때 입력한 이름과 확인번호를 그대로 입력해 주세요.';
    submit.textContent = kind === 'reserve' ? '신청' : '취소하기';
    form.hidden = false;
    actions.hidden = true;
    result.textContent = '';
    form.dataset.trigger = trigger === btnReserve ? 'reserve' : 'cancel';
    name.focus();
  }
  function closeForm() {
    form.hidden = true;
    actions.hidden = false;
    pin.value = '';
    (form.dataset.trigger === 'reserve' && canReserve ? btnReserve : btnCancel).focus();
  }

  btnReserve.addEventListener('click', () => openForm('reserve', btnReserve));
  btnCancel.addEventListener('click', () => openForm('cancel', btnCancel));
  close.addEventListener('click', closeForm);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeForm();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) {
      result.textContent = '이름을 입력해 주세요.';
      name.focus();
      return;
    }
    if (!/^\d{4}$/.test(pin.value)) {
      result.textContent = '확인번호는 숫자 4자리입니다.';
      pin.focus();
      return;
    }
    if (!signupOpen) {
      result.textContent = MESSAGES.off;
      return;
    }

    submit.disabled = true;
    result.textContent = '처리 중…';
    let code;
    try {
      code = await (action === 'reserve' ? reserve : cancelReservation)(s.id, n, pin.value);
    } catch {
      code = null;
    }
    submit.disabled = false;

    const text = code && MESSAGES[action][code];
    result.textContent = text ?? MESSAGES.error;
    if (code === 'ok') {
      pin.value = '';
      name.value = '';
      form.hidden = true;
      actions.hidden = false;
    }
    if (!code) return;
    // 신청·취소 뒤에는 인원을 다시 불러온다.
    await refreshCounts();
    if (['ok', 'full', 'closed'].includes(code)) {
      // 상태가 바뀔 수 있으므로 다시 그리고, 결과 문구는 남겨 둔다
      render({ keep: { id: s.id, message: result.textContent } });
    } else {
      // 입력을 고쳐 다시 시도할 수 있게 양식은 그대로 두고 숫자만 고친다
      updateNumbers();
      (code === 'not_found' ? pin : name).focus();
    }
  });

  wrap.append(actions, form, result);
  return { wrap, result };
}

// ── 카드 ──
function buildCard(s) {
  const state = stateOf(s);
  const start = new Date(s.startsAt);
  const li = el('li', { class: `seminar is-${state.key}`, id: `seminar-${s.id}` });

  const date = el('div', { class: 'seminar-date', 'aria-hidden': 'true' });
  date.append(
    el('span', { class: 'seminar-month' }, `${fmtMonth.format(start)} · ${fmtWeekday.format(start)}`),
    el('span', { class: 'seminar-day' }, fmtDay.format(start).replace('일', '')),
  );

  const body = el('div', { class: 'seminar-body' });
  const top = el('div', { class: 'seminar-top' });
  top.append(el('span', { class: `state state--${state.key}` }, state.label));
  const hc = headcount(s);
  if (state.key !== 'cancelled') top.append(el('span', { class: 'seminar-count' }, countText(s)));
  body.append(top);
  body.append(el('h3', { class: 'seminar-title' }, s.title));

  const meta = el('p', { class: 'seminar-meta' });
  meta.append(
    el('time', { datetime: s.startsAt }, `${fmtFull.format(start)} ${fmtTime.format(start)}`),
    ` · ${s.place || DEFAULT_PLACE}`,
  );
  body.append(meta);
  if (s.presenter) body.append(el('p', { class: 'seminar-presenter' }, `발제 ${s.presenter}`));

  if (hc != null && state.key !== 'cancelled') {
    const bar = el('div', { class: 'meter', role: 'img' });
    bar.append(el('span'));
    setMeter(bar, s);
    body.append(bar);
  }
  if (s.note) body.append(el('p', { class: 'seminar-note' }, s.note));
  if (s.docUrl && /^https:\/\//.test(s.docUrl)) {
    const doc = el('p', { class: 'seminar-doc' });
    doc.append(el('a', { href: s.docUrl, target: '_blank', rel: 'noopener', class: 'link-arrow' }, '발제문 보기'));
    body.append(doc);
  }

  let result = null;
  if (signupOpen && (state.key === 'open' || state.key === 'full')) {
    const f = buildForm(s, state);
    body.append(f.wrap);
    result = f.result;
  }

  li.append(date, body);
  return { li, result };
}

function render({ keep } = {}) {
  const now = new Date();
  const upcoming = seminars
    .filter((s) => new Date(s.startsAt) > now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const past = seminars
    .filter((s) => new Date(s.startsAt) <= now)
    .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));

  upcomingList.replaceChildren();
  for (const s of upcoming) {
    const { li, result } = buildCard(s);
    upcomingList.append(li);
    if (keep && keep.id === s.id && result) result.textContent = keep.message;
  }
  if (upcoming.length === 0) upcomingList.append(el('li', { class: 'empty' }, '예정된 세미나가 없습니다.'));

  pastList.replaceChildren(...past.map((s) => buildCard(s).li));
  pastWrap.hidden = past.length === 0;

  // 결과 문구가 남은 카드의 첫 버튼으로 초점을 돌려 둔다
  if (keep) document.querySelector(`#seminar-${CSS.escape(keep.id)} .rsv-actions button`)?.focus();
}

async function refreshCounts() {
  if (!signupOpen) {
    counts = null;
    return;
  }
  try {
    counts = await seminarCounts();
  } catch {
    counts = null;
  }
}

// 시트가 연결되어 있으면 시트 일정, 아니면 예시 파일
async function loadSeminars() {
  let sheet = null;
  try {
    sheet = await sheetRows('seminars', false);
  } catch {
    sheet = { status: 'error' };
  }
  if (sheet.status === 'ok') {
    return { syncedAt: sheet.fetchedAt, seminars: sheet.rows, fromSheet: true, fetchedRows: JSON.stringify(sheet.rows) };
  }
  if (sheet.status !== 'not_configured') throw new Error('시트를 읽지 못함');
  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  if (!Array.isArray(data.seminars)) throw new Error('형식 오류');
  return data;
}

// 저장된 일정으로 먼저 그린 뒤, 시트를 다시 읽어 바뀐 게 있으면 다시 그린다
async function refreshFromSheet(shownRows) {
  try {
    const fresh = await sheetRows('seminars', true);
    if (fresh.status !== 'ok' || JSON.stringify(fresh.rows) === shownRows) return;
    // 입력 중인 양식이 있으면 지우지 않도록 다시 그리지 않는다
    if ([...document.querySelectorAll('.rsv-form')].some((f) => !f.hidden)) return;
    seminars = normalize(fresh.rows);
    await refreshCounts();
    render();
  } catch {
    // 저장된 일정을 계속 보여 준다
  }
}

function normalize(list) {
  const out = list.filter(
    (s) =>
      s &&
      typeof s.id === 'string' &&
      typeof s.title === 'string' &&
      !Number.isNaN(new Date(s.startsAt).getTime()) &&
      (s.status === 'published' || s.status === 'cancelled'),
  );
  for (const s of out) s.capacity = Number.isInteger(s.capacity) && s.capacity > 1 ? s.capacity : 11;
  return out;
}

async function init() {
  let data;
  try {
    data = await loadSeminars();
  } catch {
    statusLine.textContent = '정보를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.';
    statusLine.classList.add('is-error');
    return;
  }

  seminars = normalize(data.seminars);

  notice.hidden = data.example !== true;
  // 예시 일정은 서버에 없는 세미나이므로 실제 서버에는 신청을 보내지 않는다
  signupOpen = mode === 'mock' || (mode === 'live' && data.example !== true);
  mockNotice.hidden = mode !== 'mock';
  if (mode === 'mock') {
    // 화면 확인용 초기 인원: 첫 예정 세미나 3명, 둘째 10명(마감)
    const now = new Date();
    const next = seminars.filter((s) => s.status === 'published' && new Date(s.startsAt) > now);
    setMockSeminars(seminars, { [next[0]?.id]: 3, [next[1]?.id]: 10 });
  }

  await refreshCounts();
  if (data.fromSheet) refreshFromSheet(data.fetchedRows);
  statusLine.textContent =
    !signupOpen
      ? mode === 'live'
        ? MESSAGES.example
        : MESSAGES.off
      : counts
        ? ''
        : '신청 인원을 불러오지 못했습니다. 신청은 할 수 있지만 인원 표시는 정확하지 않을 수 있습니다.';
  render();
}

init();

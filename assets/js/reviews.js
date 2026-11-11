// 지난 세미나 카드의 '한 줄 후기'. 서버 함수 api/reviews.mjs(Supabase)를 부른다.
// 펼칠 때 처음 한 번만 불러온다. 별명과 후기는 모두 textContent로 넣는다(innerHTML 쓰지 않음).

const API = '/api/reviews';
const fmtDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

const MESSAGES = {
  NO_KEY: '후기 기능을 준비 중입니다.',
  BAD_NICKNAME: '별명은 1~20자로 적어 주세요.',
  BAD_BODY: '후기는 1~200자, 한 줄로 적어 주세요.',
  error: '일시적인 오류로 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  loadError: '후기를 불러오지 못했습니다.',
  empty: '아직 남긴 후기가 없습니다. 첫 후기를 남겨 주세요.',
  ok: '후기를 남겼습니다.',
};

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

async function call(url, options) {
  const res = await fetch(url, { ...options, credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error ?? String(res.status)), { code: data.error });
  return data;
}

function item(r) {
  const li = el('li', { class: 'review' });
  li.append(el('p', { class: 'review-body' }, r.body));
  const meta = el('p', { class: 'review-meta' });
  meta.append(el('span', {}, r.nickname));
  const d = new Date(r.createdAt);
  if (!Number.isNaN(d.getTime())) meta.append(' · ', el('time', { datetime: r.createdAt }, fmtDate.format(d)));
  li.append(meta);
  return li;
}

export function buildReviews(seminarId) {
  const uid = seminarId.replace(/[^a-z0-9-]/gi, '');
  const box = el('details', { class: 'reviews' });
  box.append(el('summary', {}, '한 줄 후기'));

  const status = el('p', { class: 'review-status', role: 'status', 'aria-live': 'polite' });
  const list = el('ul', { class: 'review-list' });

  const form = el('form', { class: 'review-form', novalidate: '' });
  const f1 = el('div', { class: 'field' });
  const nick = el('input', { id: `rv-nick-${uid}`, type: 'text', maxlength: '20', autocomplete: 'off', required: '' });
  f1.append(el('label', { for: nick.id }, '별명'), nick);
  const f2 = el('div', { class: 'field field--wide' });
  const body = el('input', { id: `rv-body-${uid}`, type: 'text', maxlength: '200', autocomplete: 'off', required: '' });
  f2.append(el('label', { for: body.id }, '한 줄 후기 (200자까지)'), body);
  // 사람에게는 보이지 않는 칸. 자동 등록 프로그램만 채운다
  const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'review-trap', 'aria-hidden': 'true' });
  const fields = el('div', { class: 'rsv-fields' });
  fields.append(f1, f2);
  const help = el('p', { class: 'rsv-help' }, '실명 대신 별명을 적어 주세요. 전화번호·학번은 적지 마세요. 남긴 후기는 누구나 볼 수 있습니다.');
  const submit = el('button', { type: 'submit', class: 'btn' }, '남기기');
  const result = el('p', { class: 'rsv-result', role: 'status', 'aria-live': 'polite' });
  const row = el('div', { class: 'rsv-row' });
  row.append(submit);
  form.append(fields, trap, help, row, result);

  box.append(status, list, form);

  let loaded = false;
  async function load() {
    status.textContent = '후기를 불러오는 중…';
    try {
      const { reviews } = await call(`${API}?seminarId=${encodeURIComponent(seminarId)}`);
      list.replaceChildren(...reviews.map(item));
      status.textContent = reviews.length ? `후기 ${reviews.length}개` : MESSAGES.empty;
      loaded = true;
    } catch (e) {
      status.textContent = MESSAGES[e.code] ?? MESSAGES.loadError;
      if (e.code === 'NO_KEY') form.hidden = true;
    }
  }
  box.addEventListener('toggle', () => {
    if (box.open && !loaded) load();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = nick.value.trim();
    const b = body.value.trim();
    if (!n || n.length > 20) {
      result.textContent = MESSAGES.BAD_NICKNAME;
      nick.focus();
      return;
    }
    if (!b || b.length > 200) {
      result.textContent = MESSAGES.BAD_BODY;
      body.focus();
      return;
    }
    submit.disabled = true;
    result.textContent = '남기는 중…';
    try {
      const { review } = await call(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seminarId, nickname: n, body: b, website: trap.value }),
      });
      list.prepend(item(review));
      status.textContent = `후기 ${list.children.length}개`;
      body.value = '';
      result.textContent = MESSAGES.ok;
    } catch (err) {
      result.textContent = MESSAGES[err.code] ?? MESSAGES.error;
    } finally {
      submit.disabled = false;
    }
  });

  return box;
}

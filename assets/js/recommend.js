// 책장의 '책 추천 받기'. 서버 함수 api/recommend.js(오픈하사)를 부른다.
// 답은 모두 textContent로 넣는다(innerHTML 쓰지 않음). 답이 올 때까지 버튼을 잠근다.

const API = '/api/recommend';
const MAX = 200;

const MESSAGES = {
  BAD_QUERY: `조건을 1~${MAX}자로 적어 주세요.`,
  NO_KEY: '책 추천 기능을 준비 중이에요.',
  RATE_LIMIT: '요청이 많아요. 잠시 뒤 다시 해 주세요.',
  TIMEOUT: '응답이 늦어요. 잠시 뒤 다시 해 주세요.',
  error: '추천을 받지 못했어요. 잠시 뒤 다시 해 주세요.',
};

const $ = (id) => document.getElementById(id);
const form = $('rec-form');
const input = $('rec-query');
const submit = $('rec-submit');
const status = $('rec-status');
const list = $('rec-list');
const count = $('rec-count');

function show(items) {
  list.replaceChildren(
    ...items.map((it) => {
      const li = document.createElement('li');
      li.textContent = it.line;
      return li;
    }),
  );
  list.hidden = items.length === 0;
}

if (form) {
  input.addEventListener('input', () => {
    count.textContent = `${input.value.length}/${MAX}`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const query = input.value.trim();
    if (!query || query.length > MAX) {
      status.textContent = MESSAGES.BAD_QUERY;
      input.focus();
      return;
    }
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    show([]);
    status.textContent = '추천을 받는 중이에요… (최대 20초)';
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(25_000),
      });
      let data = {};
      try {
        data = await res.json();
      } catch {}
      if (!res.ok) {
        status.textContent = MESSAGES[data.error] ?? MESSAGES.error;
        return;
      }
      const items = Array.isArray(data.items) ? data.items : [];
      show(items);
      status.textContent = items.length ? (data.message ?? '소장 도서 중 이런 책은 어때요?') : (data.message ?? MESSAGES.error);
    } catch (err) {
      status.textContent = err?.name === 'TimeoutError' ? MESSAGES.TIMEOUT : MESSAGES.error;
    } finally {
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}

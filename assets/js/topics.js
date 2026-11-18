// 책장의 '토론 주제 추천'. 서버 함수 api/topics.js(오픈하사)를 부른다.
// 소장 도서 제목을 자동 완성으로 보여 주고, 답은 모두 textContent로 넣는다(innerHTML 쓰지 않음).
// 답이 올 때까지 버튼을 잠근다.

const API = '/api/topics';
const MAX = 100;

const MESSAGES = {
  BAD_TITLE: `책 제목을 1~${MAX}자로 적어 주세요.`,
  NOT_FOUND: '동아리 소장 목록에 없는 책이에요. 책장에서 제목을 확인해 주세요.',
  AMBIGUOUS: '비슷한 제목이 여러 권이에요. 제목을 조금 더 정확히 적어 주세요.',
  NO_KEY: '토론 주제 추천 기능을 준비 중이에요.',
  RATE_LIMIT: '요청이 많아요. 잠시 뒤 다시 해 주세요.',
  TIMEOUT: '응답이 늦어요. 잠시 뒤 다시 해 주세요.',
  error: '토론 주제를 받지 못했어요. 잠시 뒤 다시 해 주세요.',
};

const $ = (id) => document.getElementById(id);
const form = $('rec-form');
const input = $('rec-query');
const submit = $('rec-submit');
const status = $('rec-status');
const list = $('rec-list');
const titles = $('rec-titles');

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

// 자동 완성: 소장 도서 제목
async function loadTitles() {
  try {
    const res = await fetch('data/books.json');
    const { books } = await res.json();
    const seen = new Set();
    const opts = [];
    for (const b of books) {
      if (seen.has(b.title)) continue;
      seen.add(b.title);
      const o = document.createElement('option');
      o.value = b.title;
      o.label = b.author;
      opts.push(o);
    }
    titles.replaceChildren(...opts);
  } catch {}
}

if (form) {
  loadTitles();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const title = input.value.trim();
    if (!title || title.length > MAX) {
      status.textContent = MESSAGES.BAD_TITLE;
      input.focus();
      return;
    }
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    show([]);
    status.textContent = '토론 주제를 만드는 중이에요… (최대 20초)';
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title }),
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
      const book = data.book ? `『${data.book.title}』(${data.book.author})` : '이 책';
      status.textContent = items.length ? `${book}로 이런 이야기를 나눠 보세요` : (data.message ?? MESSAGES.error);
    } catch (err) {
      status.textContent = err?.name === 'TimeoutError' ? MESSAGES.TIMEOUT : MESSAGES.error;
    } finally {
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}

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
  BAD_DEBATE: '의견을 1~300자로 적어 주세요.',
  DEBATE_OVER: '토론은 4번까지 주고받을 수 있어요. 다른 질문으로 다시 시작해 주세요.',
};

const $ = (id) => document.getElementById(id);
const form = $('rec-form');
const input = $('rec-query');
const submit = $('rec-submit');
const status = $('rec-status');
const list = $('rec-list');
const titles = $('rec-titles');

// 토론 상태
const debate = $('debate');
const dq = $('debate-q');
const log = $('debate-log');
const dInput = $('debate-input');
const dSend = $('debate-send');
const dReset = $('debate-reset');
const dLeft = $('debate-left');
let book = null; // 지금 고른 책 제목
let question = '';
let messages = []; // [{ role, content }]

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function bubble(role, parts) {
  const li = el('li', `bubble bubble--${role}`);
  li.append(el('span', 'bubble-who', role === 'user' ? '나' : '🤖 AI 토론자'));
  for (const [label, text] of parts) {
    const p = el('p', 'bubble-text');
    if (label) p.append(el('strong', null, label));
    p.append(text);
    li.append(p);
  }
  log.append(li);
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function startDebate(q) {
  question = q;
  messages = [];
  log.replaceChildren();
  dq.textContent = q;
  dLeft.textContent = '4번 주고받을 수 있어요';
  dInput.value = '';
  dInput.disabled = false;
  dSend.disabled = false;
  list.hidden = true;
  debate.hidden = false;
  status.textContent = '';
  dInput.focus();
}

function show(items) {
  list.replaceChildren(
    ...items.map((it) => {
      const li = el('li');
      li.append(el('span', 'topic-text', it.line));
      const b = el('button', 'topic-go', '이 질문으로 AI와 토론 →');
      b.type = 'button';
      b.addEventListener('click', () => startDebate(it.line));
      li.append(b);
      return li;
    }),
  );
  list.hidden = items.length === 0;
}

async function sendOpinion() {
  if (dSend.disabled) return;
  const text = dInput.value.trim();
  if (!text || text.length > 300) {
    dLeft.textContent = MESSAGES.BAD_DEBATE;
    dInput.focus();
    return;
  }
  messages.push({ role: 'user', content: text });
  bubble('user', [[null, text]]);
  dInput.value = '';
  dSend.disabled = true;
  dInput.disabled = true;
  debate.setAttribute('aria-busy', 'true');
  dLeft.textContent = 'AI가 반론을 준비하는 중…';
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ title: book, mode: 'debate', question, messages }),
      signal: AbortSignal.timeout(25_000),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok || !data.rebut) {
      messages.pop(); // 실패한 의견은 다시 보낼 수 있게 되돌린다
      log.lastElementChild?.remove();
      dInput.value = text;
      dLeft.textContent = MESSAGES[data.error] ?? data.message ?? MESSAGES.error;
      return;
    }
    const reply = `반론: ${data.rebut}\n질문: ${data.question}`;
    messages.push({ role: 'assistant', content: reply.slice(0, 300) });
    bubble('ai', [['반론 ', data.rebut], ...(data.question ? [['질문 ', data.question]] : [])]);
    if (data.turnsLeft > 0) {
      dLeft.textContent = `${data.turnsLeft}번 더 주고받을 수 있어요`;
    } else {
      dLeft.textContent = '토론이 끝났어요. 다른 질문으로 다시 해 보세요!';
      return; // 입력 잠금 유지
    }
  } catch (err) {
    messages.pop();
    log.lastElementChild?.remove();
    dInput.value = text;
    dLeft.textContent = err?.name === 'TimeoutError' ? MESSAGES.TIMEOUT : MESSAGES.error;
  } finally {
    debate.removeAttribute('aria-busy');
    if (!(messages.length >= 8)) {
      dSend.disabled = false;
      dInput.disabled = false;
    }
  }
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
  dSend.addEventListener('click', sendOpinion);
  dInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendOpinion();
  });
  dReset.addEventListener('click', () => {
    debate.hidden = true;
    list.hidden = list.children.length === 0;
  });

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
    debate.hidden = true;
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
      book = data.book?.title ?? title;
      show(items);
      const name = data.book ? `『${data.book.title}』(${data.book.author})` : '이 책';
      status.textContent = items.length ? `${name}로 이런 이야기를 나눠 보세요. 질문을 고르면 AI와 토론할 수 있어요.` : (data.message ?? MESSAGES.error);
    } catch (err) {
      status.textContent = err?.name === 'TimeoutError' ? MESSAGES.TIMEOUT : MESSAGES.error;
    } finally {
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}

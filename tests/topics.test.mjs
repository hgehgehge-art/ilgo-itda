// 실행: node --test  (오픈하사 대신 가짜 응답으로 api/topics.js를 시험)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, parse, findBook, SYSTEM_PROMPT } from '../api/topics.js';

const ENV = { HASA_API_KEY: 'test-key' };
const GOOD = '1. 뫼르소의 무관심은 비난받아야 할까?\n2. 재판은 살인을 심판했나, 태도를 심판했나?\n3. 부조리 앞에서 우리는 어떻게 살아야 할까?';
const LONG = `1. ${'가'.repeat(70)}?\n2. 짧은 질문?\n3. 또 다른 질문?`;

// 차례대로 답하는 가짜 오픈하사. 부른 기록을 calls에 남긴다
function fake(...replies) {
  const calls = [];
  const fn = async (url, opt) => {
    calls.push({ url, ...opt, body: JSON.parse(opt.body) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (typeof r === 'function') return r(opt);
    if (typeof r === 'number') return new Response('{"error":"x"}', { status: r });
    return new Response(JSON.stringify({ choices: [{ message: { content: r } }] }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}
// 끊길 때까지 답하지 않는 가짜
const hang = (opt) =>
  new Promise((_, reject) => opt.signal.addEventListener('abort', () => reject(opt.signal.reason), { once: true }));

const post = (body, env = ENV, f = fake(GOOD), opts) =>
  handle(
    new Request('http://x/api/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    f,
    opts,
  );
const res = async (p) => {
  const r = await p;
  return [r.status, await r.json()];
};

test('정상: 소장 도서로 토론 질문 세 개', async () => {
  const f = fake(GOOD);
  const [st, body] = await res(post({ title: ' 이방인 ' }, ENV, f));
  assert.equal(st, 200);
  assert.equal(body.book.title, '이방인');
  assert.equal(body.items.length, 3);
  assert.equal(body.items[0].line, '뫼르소의 무관심은 비난받아야 할까?');
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://open.hasa.re.kr/v1/chat/completions');
  assert.equal(c.headers.authorization, 'Bearer test-key');
  assert.equal(c.body.model, 'gemma-4-31b');
  assert.equal(c.body.max_tokens, 300);
  assert.match(c.body.messages[1].content, /『이방인』/);
  assert.ok(!JSON.stringify(body).includes('test-key'), '응답에 키가 없음');
});

test('지시문: 역할·형식·근거·금지', () => {
  for (const s of ['[역할]', '[형식]', '[스타일]', '[근거]', '[금지]', '해외문학회', '밸런스 게임', '60자', '개인정보', '결말']) {
    assert.ok(SYSTEM_PROMPT.includes(s), s);
  }
});

test('제목 찾기: 정확히, 일부만, 여러 권, 없음', () => {
  assert.equal(findBook('햄릿').book.title, '햄릿');
  assert.equal(findBook('베르테르').book.title, '젊은 베르테르의 슬픔');
  assert.equal(findBook('변신 이야기').error, 'AMBIGUOUS');
  assert.equal(findBook('해리 포터').error, 'NOT_FOUND');
});

test('소장 목록에 없는 책 → 404, 오픈하사를 부르지 않음', async () => {
  const f = fake(GOOD);
  const [st, body] = await res(post({ title: '해리 포터' }, ENV, f));
  assert.equal(st, 404);
  assert.equal(body.error, 'NOT_FOUND');
  assert.equal(f.calls.length, 0);
});

test('형식이 틀리면 다시 받는다', async () => {
  const f = fake(LONG, GOOD);
  const [st, body] = await res(post({ title: '이방인' }, ENV, f));
  assert.equal(st, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(body.items[1].line, '재판은 살인을 심판했나, 태도를 심판했나?');
});

test('책을 모른다는 답은 그대로 알린다', async () => {
  const [st, body] = await res(post({ title: '햄릿' }, ENV, fake('이 책은 잘 몰라서 질문을 만들기 어려워요.')));
  assert.equal(st, 200);
  assert.deepEqual(body.items, []);
  assert.match(body.message, /잘 몰라서/);
});

test('parse: 번호 없는 줄은 버림', () => {
  const r = parse('좋은 질문입니다\n1. 가?\n2) 나?\n3. 다?');
  assert.deepEqual(r.items.map((i) => i.line), ['가?', '나?', '다?']);
  assert.equal(r.clean, true);
});

test('400: 빈 입력, 공백만, 100자 초과, 깨진 JSON', async () => {
  for (const b of [{ title: '' }, { title: '   ' }, { title: '가'.repeat(101) }, {}, '{']) {
    const f = fake(GOOD);
    const [st, body] = await res(post(b, ENV, f));
    assert.equal(st, 400, JSON.stringify(b));
    assert.equal(body.error, 'BAD_TITLE');
    assert.equal(f.calls.length, 0, '오픈하사를 부르지 않음');
  }
});

test('키 없음 → 500 NO_KEY, 오픈하사를 부르지 않음', async () => {
  const f = fake(GOOD);
  const [st, body] = await res(post({ title: '이방인' }, {}, f));
  assert.equal(st, 500);
  assert.equal(body.error, 'NO_KEY');
  assert.equal(f.calls.length, 0);
});

test('오픈하사 429 → 429와 안내 문구', async () => {
  const [st, body] = await res(post({ title: '이방인' }, ENV, fake(429)));
  assert.equal(st, 429);
  assert.equal(body.error, 'RATE_LIMIT');
  assert.match(body.message, /잠시 뒤/);
});

test('시간 초과 → 504와 안내 문구', async () => {
  const [st, body] = await res(post({ title: '이방인' }, ENV, fake(hang), { timeoutMs: 50 }));
  assert.equal(st, 504);
  assert.equal(body.error, 'TIMEOUT');
  assert.match(body.message, /늦어요/);
});

test('다시 받다 시간이 넘으면 첫 답을 돌려준다', async () => {
  const [st, body] = await res(post({ title: '이방인' }, ENV, fake(LONG, hang), { timeoutMs: 50 }));
  assert.equal(st, 200);
  assert.equal(body.items.length, 3);
});

test('기본 시간 제한은 20초', () => {
  assert.match(readFileSync('api/topics.js', 'utf8'), /TIMEOUT_MS = 20_000/);
});

test('오픈하사 그 밖의 오류 → 502', async () => {
  const [st, body] = await res(post({ title: '이방인' }, ENV, fake(401)));
  assert.equal(st, 502);
  assert.equal(body.error, 'UPSTREAM');
});

test('지원하지 않는 방식 → 405, JSON 아님 → 415', async () => {
  assert.equal((await handle(new Request('http://x/api/topics'), ENV, fake(GOOD))).status, 405);
  const r = await handle(new Request('http://x/api/topics', { method: 'POST', body: 'a' }), ENV, fake(GOOD));
  assert.equal(r.status, 415);
});

test('화면·서버 코드에 키 값이 없음', () => {
  const strip = (s) => s.replace(/\/\/.*$/gm, '');
  const ui = strip(readFileSync('assets/js/topics.js', 'utf8'));
  assert.ok(!/innerHTML/.test(ui), '화면 코드는 innerHTML을 쓰지 않음');
  assert.ok(!/HASA|process\.env|Bearer/i.test(ui), '화면 코드에 키·환경 변수가 없음');
  const server = readFileSync('api/topics.js', 'utf8');
  assert.ok(/env\.HASA_API_KEY/.test(server));
  assert.ok(!/sk-[A-Za-z0-9_-]{10,}/.test(server), '키 값을 코드에 적지 않음');
  const html = readFileSync('books.html', 'utf8');
  assert.ok(html.includes('입력한 글은 AI에 보내지며 답은 틀릴 수 있어요'));
});

test('토론 모드: 반론과 다음 질문을 돌려준다', async () => {
  const f = fake('반론: 무관심도 선택이에요.\n질문: 그럼 침묵도 책임이 있을까요?');
  const [st, body] = await res(post({ title: '이방인', mode: 'debate', question: '뫼르소는 유죄일까?', messages: [{ role: 'user', content: '무죄라고 생각해요' }] }, ENV, f));
  assert.equal(st, 200);
  assert.equal(body.rebut, '무관심도 선택이에요.');
  assert.equal(body.question, '그럼 침묵도 책임이 있을까요?');
  assert.equal(body.turnsLeft, 3);
  assert.match(f.calls[0].body.messages[0].content, /상대 토론자/);
  assert.equal(f.calls[0].body.messages.at(-1).content, '무죄라고 생각해요');
});

test('토론 모드: 빈 의견·순서 틀림 → 400, 너무 많이 주고받음 → DEBATE_OVER', async () => {
  const base = { title: '이방인', mode: 'debate', question: '질문?' };
  for (const messages of [[], [{ role: 'user', content: '' }], [{ role: 'assistant', content: 'x' }], [{ role: 'user', content: '가'.repeat(301) }]]) {
    const [st] = await res(post({ ...base, messages }));
    assert.equal(st, 400);
  }
  const many = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
  const [st, body] = await res(post({ ...base, messages: many }));
  assert.equal(st, 400);
  assert.equal(body.error, 'DEBATE_OVER');
});

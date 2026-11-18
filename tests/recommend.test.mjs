// 실행: node --test  (오픈하사 대신 가짜 응답으로 api/recommend.js를 시험)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, parse, SYSTEM_PROMPT } from '../api/recommend.js';

const ENV = { HASA_API_KEY: 'test-key' };
const GOOD = '1. 『햄릿』 — 복수와 망설임의 고전 비극\n2. 『동물농장』 — 짧고 날카로운 정치 우화\n3. 『변신, 시골의사』 — 낯설고 기묘한 카프카 단편';
const MIXED = '1. 『햄릿』 — 복수 비극\n2. 『해리 포터』 — 마법 학교 이야기\n3. 『동물농장』 — 정치 우화';

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
    new Request('http://x/api/recommend', {
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

test('정상: 소장 도서 세 권을 한 줄씩 돌려준다', async () => {
  const f = fake(GOOD);
  const [st, body] = await res(post({ query: ' 짧은 고전 ' }, ENV, f));
  assert.equal(st, 200);
  assert.deepEqual(body.items.map((i) => i.title), ['햄릿', '동물농장', '변신, 시골의사']);
  assert.equal(body.items[0].line, '『햄릿』 — 복수와 망설임의 고전 비극');
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://open.hasa.re.kr/v1/chat/completions');
  assert.equal(c.headers.authorization, 'Bearer test-key');
  assert.equal(c.body.model, 'gemma-4-31b');
  assert.equal(c.body.max_tokens, 300);
  assert.equal(c.body.messages[0].role, 'system');
  assert.equal(c.body.messages[1].content, '조건: 짧은 고전');
  assert.ok(!JSON.stringify(body).includes('test-key'), '응답에 키가 없음');
});

test('지시문: 역할·형식·근거·금지와 소장 목록', () => {
  for (const s of ['[역할]', '[형식]', '[근거]', '[금지]', '해외문학회', '40자', '개인정보', '3. 햄릿 / 윌리엄 셰익스피어']) {
    assert.ok(SYSTEM_PROMPT.includes(s), s);
  }
});

test('목록에 없는 책이 섞이면 다시 받는다', async () => {
  const f = fake(MIXED, GOOD);
  const [st, body] = await res(post({ query: '고전' }, ENV, f));
  assert.equal(st, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(body.items.length, 3);
});

test('다시 받아도 섞이면 목록에 있는 줄만 남긴다', async () => {
  const f = fake(MIXED, MIXED);
  const [st, body] = await res(post({ query: '고전' }, ENV, f));
  assert.equal(st, 200);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(body.items.map((i) => i.title), ['햄릿', '동물농장']);
});

test('맞는 책이 없다는 답은 그대로 알린다', async () => {
  const [st, body] = await res(post({ query: '요리책' }, ENV, fake('소장 목록에 맞는 책이 없어요.')));
  assert.equal(st, 200);
  assert.deepEqual(body.items, []);
  assert.match(body.message, /없어요/);
});

test('parse: 번호 없는 줄·중복·40자 초과 처리', () => {
  const r = parse('추천합니다\n1. 『햄릿』 — a\n2. 『햄릿』 — b\n3. 『동물농장』 — ' + '가'.repeat(40));
  assert.deepEqual(r.items.map((i) => i.title), ['햄릿', '동물농장']);
  assert.equal(r.clean, false);
});

test('400: 빈 입력, 공백만, 200자 초과, 깨진 JSON', async () => {
  for (const b of [{ query: '' }, { query: '   ' }, { query: '가'.repeat(201) }, {}, '{']) {
    const f = fake(GOOD);
    const [st, body] = await res(post(b, ENV, f));
    assert.equal(st, 400, JSON.stringify(b));
    assert.equal(body.error, 'BAD_QUERY');
    assert.equal(f.calls.length, 0, '오픈하사를 부르지 않음');
  }
  const [st] = await res(post({ query: '가'.repeat(200) }));
  assert.equal(st, 200, '200자는 받음');
});

test('키 없음 → 500 NO_KEY, 오픈하사를 부르지 않음', async () => {
  const f = fake(GOOD);
  const [st, body] = await res(post({ query: '고전' }, {}, f));
  assert.equal(st, 500);
  assert.equal(body.error, 'NO_KEY');
  assert.equal(f.calls.length, 0);
});

test('오픈하사 429 → 429와 안내 문구', async () => {
  const [st, body] = await res(post({ query: '고전' }, ENV, fake(429)));
  assert.equal(st, 429);
  assert.equal(body.error, 'RATE_LIMIT');
  assert.match(body.message, /잠시 뒤/);
});

test('시간 초과 → 504와 안내 문구', async () => {
  const [st, body] = await res(post({ query: '고전' }, ENV, fake(hang), { timeoutMs: 50 }));
  assert.equal(st, 504);
  assert.equal(body.error, 'TIMEOUT');
  assert.match(body.message, /늦어요/);
});

test('다시 받다 시간이 넘으면 첫 답의 소장 도서만 돌려준다', async () => {
  const [st, body] = await res(post({ query: '고전' }, ENV, fake(MIXED, hang), { timeoutMs: 50 }));
  assert.equal(st, 200);
  assert.deepEqual(body.items.map((i) => i.title), ['햄릿', '동물농장']);
});

test('기본 시간 제한은 20초', () => {
  assert.match(readFileSync('api/recommend.js', 'utf8'), /TIMEOUT_MS = 20_000/);
});

test('오픈하사 그 밖의 오류 → 502, 원래 오류는 내보내지 않음', async () => {
  const [st, body] = await res(post({ query: '고전' }, ENV, fake(401)));
  assert.equal(st, 502);
  assert.equal(body.error, 'UPSTREAM');
});

test('지원하지 않는 방식 → 405, JSON 아님 → 415', async () => {
  assert.equal((await handle(new Request('http://x/api/recommend'), ENV, fake(GOOD))).status, 405);
  const r = await handle(new Request('http://x/api/recommend', { method: 'POST', body: 'a' }), ENV, fake(GOOD));
  assert.equal(r.status, 415);
});

test('화면·서버 코드에 키 값이 없음', () => {
  const strip = (s) => s.replace(/\/\/.*$/gm, '');
  const ui = strip(readFileSync('assets/js/recommend.js', 'utf8'));
  assert.ok(!/innerHTML/.test(ui), '화면 코드는 innerHTML을 쓰지 않음');
  assert.ok(!/HASA|process\.env|Bearer/i.test(ui), '화면 코드에 키·환경 변수가 없음');
  const server = readFileSync('api/recommend.js', 'utf8');
  assert.ok(/env\.HASA_API_KEY/.test(server));
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(server), '키 값을 코드에 적지 않음');
  const html = readFileSync('books.html', 'utf8');
  assert.ok(html.includes('입력한 글은 AI에 보내지며 답은 틀릴 수 있어요'));
});

import { readFileSync, readdirSync } from 'node:fs';
import { handle, validate } from '../api/reviews.mjs';
// 실행: node tests/reviews.test.mjs  (Supabase 대신 가짜 응답으로 api/reviews.mjs를 시험)
let fail = 0;
const check = (label, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  기대 ${JSON.stringify(e)} 실제 ${JSON.stringify(a)}`}`); };

const ENV = { SUPABASE_URL: 'https://demo.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'pub-test', SUPABASE_SECRET_KEY: 'secret-test' };
const calls = [];
const rows = [];
const fakeFetch = async (url, opt = {}) => {
  calls.push({ url: String(url), method: opt.method ?? 'GET', apikey: opt.headers?.apikey, body: opt.body });
  if ((opt.method ?? 'GET') === 'POST') {
    const r = { ...JSON.parse(opt.body), created_at: '2026-11-11T09:00:00Z' };
    rows.unshift(r);
    return new Response(JSON.stringify([r]), { status: 201 });
  }
  return new Response(JSON.stringify(rows), { status: 200 });
};
const get = (q, env = ENV) => handle(new Request(`http://x/api/reviews?${q}`), env, fakeFetch);
const post = (b, env = ENV, type = 'application/json') =>
  handle(new Request('http://x/api/reviews', { method: 'POST', headers: { 'content-type': type }, body: typeof b === 'string' ? b : JSON.stringify(b) }), env, fakeFetch);
const res = async (p) => { const r = await p; return [r.status, await r.json()]; };

// 키
check('키 없음 → 500 NO_KEY (읽기)', await res(get('seminarId=2026-2-w04', {})), [500, { error: 'NO_KEY' }]);
check('키 없음 → 500 NO_KEY (쓰기)', await res(post({ seminarId: 'a', nickname: 'b', body: 'c' }, { SUPABASE_URL: 'u', SUPABASE_PUBLISHABLE_KEY: 'p' })), [500, { error: 'NO_KEY' }]);

// 입력 검사
check('세미나 ID 이상 → 400', (await res(get('seminarId=../x')))[0], 400);
check('빈 별명 → BAD_NICKNAME', validate({ seminarId: 'a', nickname: '  ', body: 'x' }).error, 'BAD_NICKNAME');
check('별명 21자 → BAD_NICKNAME', validate({ seminarId: 'a', nickname: '가'.repeat(21), body: 'x' }).error, 'BAD_NICKNAME');
check('후기 201자 → BAD_BODY', validate({ seminarId: 'a', nickname: 'a', body: '가'.repeat(201) }).error, 'BAD_BODY');
check('후기 줄바꿈 → BAD_BODY', validate({ seminarId: 'a', nickname: 'a', body: '한\n줄' }).error, 'BAD_BODY');
check('숨은 칸 채움 → INVALID', validate({ seminarId: 'a', nickname: 'a', body: 'b', website: 'x' }).error, 'INVALID');
check('JSON 아님 → 415', (await res(post('a', ENV, 'text/plain')))[0], 415);
check('깨진 JSON → 400', (await res(post('{')))[0], 400);
check('Supabase에 아무것도 보내지 않음', calls.length, 0);

// 쓰기·읽기
const [st, body] = await res(post({ seminarId: '2026-2-w04', nickname: ' 책벌레 ', body: ' 데미안 좋았어요 ' }));
check('쓰기 → 201, 앞뒤 공백 정리', [st, body.review.nickname, body.review.body], [201, '책벌레', '데미안 좋았어요']);
check('쓰기는 secret 키로', calls.at(-1).apikey, 'secret-test');
check('보낸 칸은 세 개뿐', Object.keys(JSON.parse(calls.at(-1).body)), ['seminar_id', 'nickname', 'body']);
const [gs, gb] = await res(get('seminarId=2026-2-w04'));
check('읽기 → 200, 1개', [gs, gb.reviews.length], [200, 1]);
check('읽기는 publishable 키로', calls.at(-1).apikey, 'pub-test');
check('읽기는 그 세미나만, 최신순, 50개', ['seminar_id=eq.2026-2-w04', 'order=created_at.desc', 'limit=50'].every((s) => calls.at(-1).url.includes(s)), true);
check('응답에 키가 없음', JSON.stringify([body, gb]).includes('secret'), false);

// 상류 오류
const down = async () => { throw new Error('down'); };
check('Supabase 응답 없음 → 502', (await handle(new Request('http://x/api/reviews?seminarId=a'), ENV, down)).status, 502);
check('지원하지 않는 방식 → 405', (await handle(new Request('http://x/api/reviews', { method: 'DELETE' }), ENV, fakeFetch)).status, 405);

// 화면 코드
const ui = readFileSync('assets/js/reviews.js', 'utf8');
check('화면 코드는 innerHTML을 쓰지 않음', /innerHTML/.test(ui.replace(/\/\/.*$/gm, '')), false);
check('화면 코드에 키·환경 변수가 없음', /SUPABASE|secret|process\.env/i.test(ui.replace(/\/\/.*$/gm, '')), false);
const server = readFileSync('api/reviews.mjs', 'utf8');
check('서버 코드는 process.env에서만 키를 읽음', /sb_(publishable|secret)_|eyJ/.test(server), false);
const sql = readdirSync('supabase/migrations').map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n').replace(/--.*$/gm, '');
check('SQL에 drop·delete·truncate 없음', /\b(drop|delete|truncate)\b/i.test(sql), false);

console.log(fail ? `\n실패 ${fail}개` : '\n모두 통과');
process.exit(fail ? 1 : 0);

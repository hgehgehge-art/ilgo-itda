// 세미나 한 줄 후기 서버 함수 (Vercel). 표 설계는 supabase/README.md.
//   GET  /api/reviews?seminarId=2026-2-w04   → { reviews: [{ nickname, body, createdAt }] }
//   POST /api/reviews  { seminarId, nickname, body }  → 201 { review }
//
// 키는 코드에 넣지 않고 Vercel 환경 변수에서만 읽는다.
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY(읽기), SUPABASE_SECRET_KEY(쓰기, Sensitive)
// Secret key는 이 파일 안에서만 쓰고, 응답이나 화면 코드로 내보내지 않는다.
// 키가 없으면 500 { error: 'NO_KEY' }. 키를 넣고 다시 배포하면 풀린다.

const TABLE = 'seminar_reviews';
const LIMIT = 50;
const SEMINAR_ID = /^[A-Za-z0-9_-]{1,40}$/;
// 제어 문자(줄바꿈 포함)는 받지 않는다. 한 줄 후기다.
const CONTROL = /[\u0000-\u001f\u007f]/;

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function config(env) {
  const url = env.SUPABASE_URL?.replace(/\/+$/, '');
  return { url, publishable: env.SUPABASE_PUBLISHABLE_KEY, secret: env.SUPABASE_SECRET_KEY };
}

// 입력을 검사해 { ok, value } 또는 { ok:false, error } 를 돌려준다
export function validate(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'INVALID' };
  const { seminarId, nickname, body, website } = input;
  // 사람 눈에 보이지 않는 칸에 글이 있으면 자동 등록 프로그램으로 본다
  if (website) return { ok: false, error: 'INVALID' };
  if (typeof seminarId !== 'string' || !SEMINAR_ID.test(seminarId)) return { ok: false, error: 'BAD_SEMINAR' };
  if (typeof nickname !== 'string' || typeof body !== 'string') return { ok: false, error: 'INVALID' };
  const n = nickname.trim();
  const b = body.trim();
  if (n.length < 1 || n.length > 20 || CONTROL.test(n)) return { ok: false, error: 'BAD_NICKNAME' };
  if (b.length < 1 || b.length > 200 || CONTROL.test(b)) return { ok: false, error: 'BAD_BODY' };
  return { ok: true, value: { seminar_id: seminarId, nickname: n, body: b } };
}

const toPublic = (r) => ({ nickname: r.nickname, body: r.body, createdAt: r.created_at });

export async function handle(request, env = process.env, fetchImpl = fetch) {
  const { url, publishable, secret } = config(env);
  const method = request.method;
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'METHOD' });
  if (!url || (method === 'GET' ? !publishable : !secret)) return json(500, { error: 'NO_KEY' });

  if (method === 'GET') {
    const seminarId = new URL(request.url).searchParams.get('seminarId') ?? '';
    if (!SEMINAR_ID.test(seminarId)) return json(400, { error: 'BAD_SEMINAR' });
    const q = new URLSearchParams({
      select: 'nickname,body,created_at',
      seminar_id: `eq.${seminarId}`,
      order: 'created_at.desc',
      limit: String(LIMIT),
    });
    let res;
    try {
      res = await fetchImpl(`${url}/rest/v1/${TABLE}?${q}`, {
        headers: { apikey: publishable, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return json(502, { error: 'UPSTREAM' });
    }
    if (!res.ok) return json(502, { error: 'UPSTREAM' });
    const rows = await res.json();
    return json(200, { reviews: rows.map(toPublic) });
  }

  // POST
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    return json(415, { error: 'CONTENT_TYPE' });
  }
  const raw = await request.text();
  if (raw.length > 4_000) return json(413, { error: 'TOO_LARGE' });
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return json(400, { error: 'INVALID' });
  }
  const v = validate(input);
  if (!v.ok) return json(400, { error: v.error });

  let res;
  try {
    res = await fetchImpl(`${url}/rest/v1/${TABLE}?select=nickname,body,created_at`, {
      method: 'POST',
      headers: {
        apikey: secret,
        'content-type': 'application/json',
        accept: 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify(v.value),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return json(502, { error: 'UPSTREAM' });
  }
  if (!res.ok) return json(502, { error: 'UPSTREAM' });
  const [row] = await res.json();
  return json(201, { review: toPublic(row) });
}

export const GET = (request) => handle(request);
export const POST = (request) => handle(request);

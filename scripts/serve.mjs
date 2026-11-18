// 로컬 미리보기용 정적 서버. 설치할 패키지 없음.
// 사용: node scripts/serve.mjs  →  http://localhost:8000
// ES 모듈과 fetch(data/*.json)는 file:// 로 열면 동작하지 않아 서버가 필요하다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.env.ROOT ?? '.');
const PORT = Number(process.env.PORT ?? 8000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

// /api/reviews, /api/recommend 는 Vercel과 같은 서버 함수(api/ 폴더)를 그대로 부른다.
// 키는 실행할 때 환경 변수로 준다. 없으면 함수가 500(NO_KEY)을 돌려준다.
const APIS = { '/api/reviews': '../api/reviews.mjs', '/api/recommend': '../api/recommend.js' };
async function api(req, res, path) {
  const { handle } = await import(new URL(APIS[path], import.meta.url));
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(new URL(req.url, `http://localhost:${PORT}`), {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const out = await handle(request);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (APIS[path]) return api(req, res, path);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('찾을 수 없음');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

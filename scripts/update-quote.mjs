// 오늘의 한 문장: 한국어 명언 API에서 하루에 한 번 문장을 받아 data/today-quote.json에 저장한다.
// - 같은 한국 날짜에 다시 실행하면 문장을 바꾸지 않는다(FORCE=true일 때만 교체).
// - 호출이나 검증에 실패하면 기존 파일을 그대로 두고 오류로 끝낸다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const API_URL =
  process.env.QUOTE_API_URL ?? 'https://korean-advice-open-api.vercel.app/api/advice';
const OUT = process.env.QUOTE_OUT ?? 'data/today-quote.json';
const FORCE = process.env.FORCE === 'true';
const MAX_TRIES = 4;
const MAX_LENGTH = 300;

// 한국 날짜(YYYY-MM-DD)
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchQuote() {
  const res = await fetch(API_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API 응답 ${res.status}`);
  const body = await res.json();
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const author = typeof body.author === 'string' ? body.author.trim() : '';
  const authorProfile = typeof body.authorProfile === 'string' ? body.authorProfile.trim() : '';
  if (!message) throw new Error('문장이 비어 있음');
  if (message.length > MAX_LENGTH) throw new Error('문장이 너무 김');
  return { message, author, authorProfile };
}

const previous = await readPrevious();

if (previous?.date === today && !FORCE) {
  console.log(`${today} 문장이 이미 있습니다. 바꾸지 않습니다.`);
  process.exit(0);
}

let quote = null;
let lastError = null;
for (let i = 1; i <= MAX_TRIES; i += 1) {
  try {
    const candidate = await fetchQuote();
    // 무작위 API라 어제와 같은 문장이 나올 수 있으므로 다시 받는다.
    if (candidate.message === previous?.message) {
      lastError = new Error('직전 문장과 같음');
      continue;
    }
    quote = candidate;
    break;
  } catch (error) {
    lastError = error;
    console.warn(`시도 ${i}/${MAX_TRIES} 실패: ${error.message}`);
  }
}

if (!quote) {
  console.error(`문장을 갱신하지 못했습니다. 기존 파일을 유지합니다. (${lastError?.message})`);
  process.exit(1);
}

const data = {
  date: today,
  message: quote.message,
  author: quote.author,
  authorProfile: quote.authorProfile,
  source: {
    name: '한국어 명언 API',
    url: 'https://github.com/gwongibeom/korean-advice-open-api',
  },
  fetchedAt: new Date().toISOString(),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(`${today} 문장을 저장했습니다: ${data.message} — ${data.author}`);

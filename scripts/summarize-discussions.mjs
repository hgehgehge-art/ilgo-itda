// 토론 기록 AI 정리: 운영진이 'AI 정리 요청'을 켠 기록을 Claude로 정리해 초안에 채운다.
// GitHub Actions(.github/workflows/discussion-ai.yml)에서 30분마다 실행한다.
//
// 필요한 GitHub Secrets
//   ANTHROPIC_API_KEY  Claude API 키
//   APPS_SCRIPT_URL    구글 시트 백엔드(Apps Script 웹 앱) 주소
//   AI_WORKER_TOKEN    시트 메뉴 '읽고, 잇다 → AI 작업 토큰 만들기'에서 받은 토큰
// 셋 중 하나라도 없으면 아무것도 하지 않고 끝낸다(사이트의 다른 기능에는 영향 없음).
//
// 개인정보: 원문은 Claude API로만 보내고, 결과 기록에는 원문·이름을 남기지 않는다.
// 인상 깊은 말은 원문에 실제로 있는 문장만 남긴다(모델이 지어낸 말은 버린다).

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const { ANTHROPIC_API_KEY, APPS_SCRIPT_URL, AI_WORKER_TOKEN } = process.env;
if (!ANTHROPIC_API_KEY || !APPS_SCRIPT_URL || !AI_WORKER_TOKEN) {
  console.log('ANTHROPIC_API_KEY·APPS_SCRIPT_URL·AI_WORKER_TOKEN 중 없는 값이 있어 건너뜁니다.');
  process.exit(0);
}

// 구글 시트 백엔드(Apps Script)에 토큰과 함께 요청한다. 토큰은 시트 메뉴에서 만들고 해시만 저장된다
async function backend(body) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: AI_WORKER_TOKEN }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Apps Script 응답 ${res.status}`);
  return res.json();
}

const Result = z.object({
  keywords: z.array(z.string()).describe('그날 많이 오간 핵심 개념 5~8개. 명사형 한두 낱말'),
  summary: z.string().describe('토론 흐름을 2~3문장으로 요약'),
  questions: z.array(z.string()).describe('토론에서 실제로 나온 핵심 질문 3개'),
  quotes: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .describe('인상 깊은 발언 2~3개. text는 원문에서 그대로 복사한 문장, speaker는 "참석자 A" 같은 익명 표기'),
});

const SYSTEM = `당신은 한국외대 해외문학회의 세미나(문학 작품 발제·토론) 기록을 정리합니다.
입력은 클로바노트 등으로 받아쓴 토론 원문이며, 받아쓰기 오류가 섞여 있을 수 있습니다.
- 모든 결과는 한국어로 씁니다.
- 원문에 없는 내용을 지어내지 않습니다. 확실하지 않으면 빼세요.
- quotes의 text는 원문에 있는 문장을 한 글자도 바꾸지 말고 그대로 복사합니다.
- 사람 이름, 학번, 연락처는 결과에 넣지 않습니다. 발언자는 '참석자 A', '참석자 B'처럼 처음 나온 순서대로 익명으로 씁니다.`;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// 원문에 실제로 있는 말인지 확인(띄어쓰기 차이는 무시)
const squash = (s) => String(s).replace(/\s+/g, '');
function countIn(text, word) {
  return text.split(word).length - 1;
}

async function summarize(row) {
  const res = await client.messages.parse(
    {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `세미나 제목: ${row.title}\n\n<transcript>\n${row.source_text}\n</transcript>\n\n위 토론을 정리해 주세요.`,
        },
      ],
      output_config: { format: zodOutputFormat(Result), effort: 'medium' },
      // 안전 분류기가 거절하면 서버가 다른 모델로 다시 시도한다
      fallbacks: 'default',
    },
    { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } },
  );
  if (res.stop_reason === 'refusal') throw new Error('모델이 이 기록의 정리를 거절함');
  if (res.stop_reason === 'max_tokens') throw new Error('결과가 너무 길어 잘림');
  const out = res.parsed_output;
  if (!out) throw new Error('결과 형식을 읽지 못함');

  const text = row.source_text;
  const plain = squash(text);
  const quotes = out.quotes
    .filter((q) => q.text.trim() && plain.includes(squash(q.text)))
    .slice(0, 3)
    .map((q) => ({ speaker: /^참석자\s*\S+$/.test(q.speaker.trim()) ? q.speaker.trim() : '참석자', text: q.text.trim() }));

  // 운영진이 이미 고른 키워드가 있으면 그대로 두고, 없을 때만 AI 키워드를 쓴다
  const keywords = row.keywords?.length
    ? row.keywords
    : out.keywords
        .map((w) => w.trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((word) => ({ word, count: Math.max(1, countIn(text, word)) }));

  return {
    keywords,
    summary: out.summary.trim().slice(0, 2000),
    questions: out.questions.map((q) => q.trim()).filter(Boolean).slice(0, 3),
    quotes,
  };
}

const pending = await backend({ action: 'aiPending' });
if (pending.status !== 'ok') {
  console.log(`::error::AI 대기 목록을 받지 못함(${pending.status}). AI_WORKER_TOKEN을 확인하세요.`);
  process.exit(1);
}
console.log(`AI 정리 대기: ${pending.items.length}건`);

let failed = 0;
for (const item of pending.items) {
  const row = { seminar_id: item.seminarId, source_text: item.text, keywords: item.keywords, title: item.title };
  try {
    const result = await summarize(row);
    const saved = await backend({ action: 'aiSave', seminarId: item.seminarId, result });
    if (saved.result !== 'ok') throw new Error(`저장 실패(${saved.result})`);
    console.log(`${item.seminarId}: 정리 완료(키워드 ${result.keywords.length}, 질문 ${result.questions.length}, 인용 ${result.quotes.length})`);
  } catch (e) {
    failed += 1;
    // 오류 문구에는 원문을 넣지 않는다
    const note = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status ?? ''}`.trim() : String(e.message).slice(0, 100);
    console.log(`::error::${item.seminarId}: ${note}`);
    await backend({ action: 'aiSave', seminarId: item.seminarId, error: note }).catch(() => {});
  }
}
process.exit(failed ? 1 : 0);

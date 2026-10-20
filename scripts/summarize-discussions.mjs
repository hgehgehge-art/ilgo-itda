// 토론 기록 AI 정리: 운영진이 'AI 정리 요청'을 켠 기록을 Claude로 정리해 초안에 채운다.
// GitHub Actions(.github/workflows/discussion-ai.yml)에서 30분마다 실행한다.
//
// 필요한 GitHub Secrets
//   ANTHROPIC_API_KEY          Claude API 키
//   SUPABASE_URL               Supabase 프로젝트 주소
//   SUPABASE_SERVICE_ROLE_KEY  Supabase 관리용 키(Secret key)
// 셋 중 하나라도 없으면 아무것도 하지 않고 끝낸다(사이트의 다른 기능에는 영향 없음).
//
// 개인정보: 원문은 Claude API로만 보내고, 결과 기록에는 원문·이름을 남기지 않는다.
// 인상 깊은 말은 원문에 실제로 있는 문장만 남긴다(모델이 지어낸 말은 버린다).

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log('ANTHROPIC_API_KEY·SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY 중 없는 값이 있어 건너뜁니다.');
  process.exit(0);
}

const base = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const sbHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  ...(SUPABASE_SERVICE_ROLE_KEY.startsWith('eyJ') ? { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } : {}),
  'content-type': 'application/json',
};

async function sb(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...sbHeaders, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Supabase 응답 ${res.status}`);
  return res.status === 204 ? null : res.json();
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

const rows = await sb(
  '/discussions?ai_status=eq.requested&select=seminar_id,source_text,keywords,seminars(title)&limit=5',
);
console.log(`AI 정리 대기: ${rows.length}건`);

let failed = 0;
for (const r of rows) {
  const row = { ...r, title: r.seminars?.title ?? '' };
  try {
    const result = await summarize(row);
    await sb(`/discussions?seminar_id=eq.${encodeURIComponent(r.seminar_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...result, ai_status: 'done', ai_note: '', updated_at: new Date().toISOString() }),
    });
    console.log(`${r.seminar_id}: 정리 완료(키워드 ${result.keywords.length}, 질문 ${result.questions.length}, 인용 ${result.quotes.length})`);
  } catch (e) {
    failed += 1;
    // 오류 문구에는 원문을 넣지 않는다
    const note = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status ?? ''}`.trim() : String(e.message).slice(0, 100);
    console.log(`::error::${r.seminar_id}: ${note}`);
    await sb(`/discussions?seminar_id=eq.${encodeURIComponent(r.seminar_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ai_status: 'failed', ai_note: note, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }
}
process.exit(failed ? 1 : 0);

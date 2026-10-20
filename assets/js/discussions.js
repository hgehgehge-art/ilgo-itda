import { DISCUSSIONS_ENABLED } from './config.js';
// 그날의 토론: 게시된 토론 기록을 보여 주고, 운영진이 받아쓰기 텍스트로 기록을 올린다.
// 서버(구글 시트 백엔드)가 연결되면 운영진 코드로 저장·게시하고, 연결 전에는 페이지 안에서만 처리해 파일로 내려받는다.
// 원문은 공개하지 않는다. 키워드 후보는 브라우저에서 만든다(keywords.js).

import { mode, sheetRows, publishedDiscussions, saveDiscussion, discussionForStaff, setMockSeminars } from './reservations-api.js';
import { extractKeywords, renderCloud } from './keywords.js';

const $ = (id) => document.getElementById(id);
const KST = 'Asia/Seoul';
const fmtDate = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, month: 'long', day: 'numeric', weekday: 'short' });

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ── 게시된 기록 보기 ─────────────────────────────────

const list = $('discussion-list');
const listStatus = $('discussion-status');

function renderDiscussion(d) {
  const card = el('article', { class: 'discussion', id: `d-${d.seminarId}`, tabindex: '-1' });
  card.append(el('p', { class: 'eyebrow' }, fmtDate.format(new Date(d.startsAt))));
  card.append(el('h2', { class: 'discussion-title' }, d.title));

  if (d.keywords?.length) {
    const cloud = el('div', { class: 'cloud', role: 'list', 'aria-label': '그날 많이 나온 키워드' });
    renderCloud(cloud, d.keywords);
    cloud.querySelectorAll('.cloud-word').forEach((w) => w.setAttribute('role', 'listitem'));
    card.append(cloud);
  }
  if (d.summary) {
    card.append(el('h3', {}, '한 줄 요약'));
    card.append(el('p', { class: 'discussion-summary' }, d.summary));
  }
  if (d.questions?.length) {
    card.append(el('h3', {}, '함께 던진 질문'));
    const ul = el('ul', { class: 'discussion-questions' });
    d.questions.forEach((q) => ul.append(el('li', {}, q)));
    card.append(ul);
  }
  if (d.quotes?.length) {
    card.append(el('h3', {}, '남기고 싶은 말'));
    for (const q of d.quotes) {
      const bq = el('blockquote', { class: 'discussion-quote' });
      bq.append(el('p', {}, q.text));
      if (q.speaker) bq.append(el('cite', {}, q.speaker));
      card.append(bq);
    }
  }
  return card;
}

async function loadPublished() {
  listStatus.textContent = '토론 기록을 불러오는 중…';
  if (!(mode === 'mock' || (mode === 'live' && DISCUSSIONS_ENABLED))) {
    listStatus.textContent = '아직 게시된 기록이 없어요.';
    return [];
  }
  try {
    const items = await publishedDiscussions();
    list.replaceChildren(...items.map(renderDiscussion));
    listStatus.textContent = items.length ? '' : '아직 게시된 기록이 없어요.';
    // 세미나 화면의 '그날의 토론 보기'로 들어오면 그 기록으로 이동
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.focus();
    return items;
  } catch {
    listStatus.textContent = '토론 기록을 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.';
    return [];
  }
}

// ── 운영진: 기록 올리기 ──────────────────────────────

const form = $('staff-form');
const seminarSel = $('staff-seminar');
const text = $('staff-text');
const textCount = $('staff-text-count');
const textError = $('staff-text-error');
const cloud = $('staff-cloud');
const addWord = $('staff-add-word');
const summary = $('staff-summary');
const questions = $('staff-questions');
const quotes = $('staff-quotes');
const code = $('staff-code');
const result = $('staff-result');
const stateInfo = $('staff-state-info');

let keywords = [];

const MESSAGES = {
  ok_draft: '초안을 저장했습니다. 아직 공개되지 않았습니다.',
  ok_publish: '게시했습니다. 위 목록에 공개됩니다.',
  bad_code: '운영진 코드가 맞지 않습니다.',
  not_found: '세미나를 찾지 못했습니다. 세미나 시트에 있는 일정인지 확인해 주세요.',
  too_short: '텍스트가 너무 짧습니다. 200자 이상 붙여 넣어 주세요.',
  too_long: '텍스트가 너무 깁니다. 60,000자 이하로 나눠 올려 주세요.',
  invalid: '키워드는 40개, 질문·말은 10개까지만 저장할 수 있습니다.',
  limit: '오늘 저장 횟수(50번)를 넘었습니다. 내일 다시 시도해 주세요.',
  error: '저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요. 입력한 내용은 화면에 그대로 있습니다.',
};

function drawCloud() {
  renderCloud(cloud, keywords, {
    removable: true,
    onRemove(word) {
      keywords = keywords.filter((k) => k.word !== word);
      drawCloud();
    },
  });
  if (!keywords.length) cloud.append(el('p', { class: 'hint' }, '키워드가 없습니다. "키워드 뽑기"를 누르거나 직접 추가하세요.'));
}

function checkText() {
  const n = text.value.trim().length;
  textCount.textContent = `${n.toLocaleString('ko-KR')}자`;
  if (n === 0) textError.textContent = '';
  else if (n < 200) textError.textContent = '200자 이상이어야 합니다.';
  else if (n > 60000) textError.textContent = '60,000자 이하여야 합니다.';
  else textError.textContent = '';
}

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

// '참석자 A: 문장' 또는 그냥 '문장'. 이름은 받지 않고 순서대로 참석자 A, B…로 둔다
function parseQuotes(s) {
  return lines(s).map((line, i) => {
    const m = line.match(/^(참석자\s*[A-Z가-힣0-9]+)\s*[:：]\s*(.+)$/);
    return m ? { speaker: m[1], text: m[2] } : { speaker: `참석자 ${String.fromCharCode(65 + (i % 26))}`, text: line };
  });
}

function fill(d) {
  text.value = d.text ?? '';
  keywords = d.keywords ?? [];
  summary.value = d.summary ?? '';
  questions.value = (d.questions ?? []).join('\n');
  quotes.value = (d.quotes ?? []).map((q) => `${q.speaker}: ${q.text}`).join('\n');
  checkText();
  drawCloud();
  stateInfo.textContent = `상태: ${d.state === 'published' ? '게시됨' : '초안'}`;
}

async function setupStaff() {
  const online = mode === 'mock' || (mode === 'live' && DISCUSSIONS_ENABLED);
  $('staff-off').hidden = online;
  form.querySelectorAll('[data-server]').forEach(n => n.hidden = !online);
  // 서버에 저장할 수 있으면 파일 내려받기는 숨긴다
  form.querySelectorAll('[data-offline]').forEach(n => n.hidden = online);
  // 세미나 목록: 시작한 세미나(지난 세미나)만, 최근 순
  try {
    let res = { rows: [] };
    if (mode === 'live') res = await sheetRows('seminars');
    else if (mode === 'mock') {
      // 내 컴퓨터: 예시 일정으로 고르기 시험(운영진 코드는 local-test)
      const ex = await (await fetch('data/seminars.json')).json();
      res = { rows: ex.seminars };
      setMockSeminars(ex.seminars);
    }
    const past = (res.rows ?? [])
      .filter((s) => s.status === 'published' && new Date(s.startsAt) <= new Date())
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    seminarSel.replaceChildren(
      el('option', { value: '' }, '세미나를 고르세요'),
      ...past.map((s) => el('option', { value: s.id }, `${fmtDate.format(new Date(s.startsAt))} · ${s.title}`)),
    );
  } catch {
    seminarSel.replaceChildren(el('option', { value: '' }, '세미나 목록을 불러오지 못했습니다'));
  }

  text.addEventListener('input', checkText);
  $('staff-extract').addEventListener('click', () => {
    keywords = extractKeywords(text.value);
    drawCloud();
    result.textContent = keywords.length
      ? `키워드 후보 ${keywords.length}개를 뽑았습니다. 필요 없는 낱말은 눌러서 빼세요.`
      : '두 번 이상 나온 낱말이 없어 키워드를 뽑지 못했습니다. 직접 추가해 주세요.';
  });
  $('staff-add').addEventListener('click', () => {
    const w = addWord.value.trim();
    if (keywords.length >= 40) { result.textContent = '키워드는 40개까지 추가할 수 있습니다.'; return; }
    if (!w || keywords.some((k) => k.word === w)) return;
    keywords = [...keywords, { word: w, count: 1 }];
    addWord.value = '';
    drawCloud();
    addWord.focus();
  });
  $('staff-load').addEventListener('click', async () => {
    if (!seminarSel.value || !code.value) {
      result.textContent = '불러올 세미나와 운영진 코드를 입력해 주세요.';
      return;
    }
    result.textContent = '불러오는 중…';
    try {
      const d = await discussionForStaff(code.value, seminarSel.value);
      if (d.status === 'bad_code') result.textContent = MESSAGES.bad_code;
      else if (d.status === 'empty') result.textContent = '이 세미나에는 아직 저장된 기록이 없습니다.';
      else {
        fill(d);
        result.textContent = '저장된 기록을 불러왔습니다.';
      }
    } catch {
      result.textContent = MESSAGES.error;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!online) { result.textContent = '온라인 게시는 준비 중입니다. 기록 파일 내려받기를 이용해 주세요.'; return; }
    const publish = e.submitter?.value === 'publish';
    if (!seminarSel.value) {
      result.textContent = '세미나를 골라 주세요.';
      seminarSel.focus();
      return;
    }
    checkText();
    if (textError.textContent || !text.value.trim()) {
      result.textContent = textError.textContent || '받아쓰기 텍스트를 붙여 넣어 주세요.';
      text.focus();
      return;
    }
    if (!code.value) {
      result.textContent = '운영진 코드를 입력해 주세요.';
      code.focus();
      return;
    }
    if (publish && !keywords.length && !summary.value.trim()) {
      result.textContent = '게시하려면 키워드나 요약이 하나 이상 있어야 합니다.';
      return;
    }
    const buttons = form.querySelectorAll('button[type=submit]');
    buttons.forEach((b) => (b.disabled = true));
    result.textContent = '저장하는 중…';
    let code_;
    try {
      code_ = await saveDiscussion({
        code: code.value,
        seminarId: seminarSel.value,
        text: text.value,
        keywords,
        summary: summary.value,
        questions: lines(questions.value),
        quotes: parseQuotes(quotes.value),
        publish,
        requestAi: false,
      });
    } catch {
      code_ = 'error';
    }
    buttons.forEach((b) => (b.disabled = false));
    result.textContent = code_ === 'ok' ? MESSAGES[publish ? 'ok_publish' : 'ok_draft'] : MESSAGES[code_] ?? MESSAGES.error;
    if (code_ === 'ok' && publish) loadPublished();
  });

  drawCloud();
}

loadPublished();
setupStaff();

// 원문과 운영진 코드는 내려받는 파일에 넣지 않는다.
function publicDraft() {
  return { title: $('draft-title').value.trim(), keywords,
    summary: summary.value.trim(), questions: lines(questions.value),
    quotes: parseQuotes(quotes.value).map((q,i)=>({text:q.text,speaker:`참석자 ${String.fromCharCode(65+i%26)}`})),
    status: 'draft', createdAt: new Date().toISOString() };
}
function preview() {
  const d=publicDraft();
  const box=$('draft-preview'); box.replaceChildren();
  // 서버에 올릴 때는 고른 세미나 이름을 제목으로 쓴다
  const chosen = seminarSel.value ? seminarSel.selectedOptions[0].textContent : '';
  const title=el('h3',{},d.title || chosen || '제목 없는 토론 초안'); box.append(title);
  const c=el('div',{class:'cloud'}); renderCloud(c,d.keywords); box.append(c);
  if(d.summary) box.append(el('p',{},d.summary));
  d.questions.forEach(q=>box.append(el('p',{},`질문 · ${q}`)));
  d.quotes.forEach(q=>box.append(el('blockquote',{},`${q.speaker}: ${q.text}`)));
  box.hidden=false; box.focus();
  result.textContent='미리보기입니다. 아직 게시되지 않았습니다.';
}
$('draft-preview-button').addEventListener('click',preview);
$('draft-download').addEventListener('click',()=>{
  const d=publicDraft();
  if(!d.title || (!d.keywords.length && !d.summary)) {
    result.textContent='토론 제목과 키워드 또는 요약을 입력해 주세요.';
    (!d.title ? $('draft-title') : summary).focus(); return;
  }
  if(!$('draft-consent').checked) { result.textContent='공개할 내용에서 개인정보를 지웠는지 확인해 주세요.'; $('draft-consent').focus(); return; }
  const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), a=el('a',{href:url,download:'discussion-draft.json'});
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  result.textContent='기록 파일을 내려받았습니다. 원문과 운영진 코드는 포함하지 않았습니다. 서버에는 게시되지 않았습니다.';
});
$('draft-file').addEventListener('change',async e=>{
  const file=e.target.files[0]; if(!file)return;
  if(!/\.(txt|md)$/i.test(file.name)||file.size>500000){result.textContent='500KB 이하의 .txt 또는 .md 파일을 골라 주세요.';e.target.value='';return;}
  try { const contents=await file.text(); if(contents.length>60000)throw new Error('long'); text.value=contents;checkText();result.textContent='파일을 읽었습니다. 키워드 뽑기를 눌러 주세요.'; }
  catch { result.textContent='파일을 읽지 못했거나 60,000자를 넘었습니다. 나누어 올려 주세요.'; }
});
// ── 예시로 체험하기 ──
// 클로바노트 받아쓰기 모양의 '가상' 토론. 실제 회원의 발언이 아니며 서버에 저장·게시할 수 없다.
const EXAMPLE = {
  title: '체험용 예시 · 프란츠 카프카 『변신』',
  text: `참석자 1 00:00:12
오늘 발제는 카프카의 『변신』이었는데요, 저는 그레고르가 벌레가 된 다음에도 출근 걱정부터 하는 장면이 제일 오래 남았어요. 몸이 바뀌었는데도 가족을 먹여 살려야 한다는 책임감이 먼저 나오잖아요.
참석자 2 00:00:41
저도 그 장면이요. 그레고르한테 일은 가족을 위한 거였는데, 일을 못 하게 되니까 가족 안에서 쓸모가 사라진 거죠. 가족이 그를 대하는 태도가 점점 차가워지는 게 쓸모와 연결된다고 생각했어요.
참석자 3 00:01:20
그런데 가족 입장도 이해가 갔어요. 아버지도, 어머니도, 여동생 그레테도 다시 일을 하기 시작하잖아요. 그레고르가 떠맡던 노동을 가족이 나눠 지면서 오히려 가족이 살아나는 느낌이었어요.
참석자 4 00:02:05
저는 그레테가 제일 복잡한 인물 같아요. 처음에는 오빠 방을 챙기고 먹을 것도 가져다주는데, 나중에는 저건 오빠가 아니라고 말하죠. 돌봄이 지치면 사랑도 변하는 걸까 하는 질문이 생겼어요.
참석자 1 00:02:48
그 질문 좋네요. 돌봄과 사랑은 같은 걸까요, 아니면 돌봄이 의무가 되면 사랑이 사라지는 걸까요.
참석자 2 00:03:15
마지막 장면에서 가족이 소풍을 가잖아요. 그레고르가 죽은 뒤에 가족이 홀가분해지는 게 너무 잔인하면서도 현실적이었어요. 가족에게 그레고르의 죽음은 해방이었던 거죠.
참석자 3 00:03:52
저는 변신이 꼭 벌레가 되는 이야기만은 아니라고 생각해요. 아프거나 일을 잃었을 때 우리도 가족 안에서 쓸모를 의심받잖아요. 그래서 이 소설이 지금 읽어도 낯설지 않은 것 같아요.
참석자 4 00:04:30
결국 이 작품은 쓸모로 사람을 재는 사회에서 가족이 무엇인지 묻는 소설 같아요. 오늘 토론에서 가족, 노동, 쓸모라는 말이 제일 많이 나온 것도 그래서겠죠.`,
  summary:
    "그레고르가 벌레가 된 뒤 가족 안에서 '쓸모'를 잃어 가는 과정을 중심으로, 가족의 차가워지는 태도가 냉정함인지 지친 돌봄의 결과인지 이야기했다. 그레테의 변화와 마지막 소풍 장면을 두고 돌봄과 사랑, 해방의 의미로 토론이 이어졌다.",
  questions: [
    '돌봄이 의무가 되면 사랑은 사라지는 걸까?',
    '가족에게 그레고르의 죽음은 해방이었을까?',
    '쓸모로 사람을 재는 사회에서 가족은 무엇일까?',
  ],
  // 원문에 그대로 있는 문장만 고른다. 발언자는 등장 순서대로 익명 표기
  quotes: [
    '참석자 A: 돌봄이 지치면 사랑도 변하는 걸까 하는 질문이 생겼어요.',
    '참석자 B: 가족에게 그레고르의 죽음은 해방이었던 거죠.',
    '참석자 C: 결국 이 작품은 쓸모로 사람을 재는 사회에서 가족이 무엇인지 묻는 소설 같아요.',
  ],
};
const isExampleText = () => text.value.trim() === EXAMPLE.text.trim();

$('draft-example').addEventListener('click', () => {
  if (text.value.trim() && !isExampleText() && !confirm('작성 중인 텍스트와 초안을 예시로 바꿀까요?')) return;
  $('draft-title').value = EXAMPLE.title;
  text.value = EXAMPLE.text;
  checkText();
  keywords = extractKeywords(text.value);
  drawCloud();
  summary.value = EXAMPLE.summary;
  questions.value = EXAMPLE.questions.join('\n');
  quotes.value = EXAMPLE.quotes.join('\n');
  preview();
  result.textContent =
    '가상 예시를 채웠어요. 필요 없는 낱말을 눌러 빼 보고, 미리보기로 확인해 보세요. (실제 발언이 아니며 저장되지 않아요)';
  $('staff-cloud').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// 예시 텍스트로는 서버에 저장·게시하지 않는다(캡처 단계에서 막음)
form.addEventListener(
  'submit',
  (e) => {
    if (!isExampleText()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    result.textContent = '체험용 예시는 저장·게시할 수 없어요. 실제 받아쓰기 텍스트로 바꾼 뒤 저장해 주세요.';
  },
  true,
);

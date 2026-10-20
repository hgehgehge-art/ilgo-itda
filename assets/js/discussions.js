// 그날의 토론: 게시된 토론 기록을 보여 주고, 운영진이 받아쓰기 텍스트로 기록을 올린다.
// 원문 텍스트는 서버에만 저장되고 공개되지 않는다. 키워드 후보는 브라우저에서 만든다(keywords.js).

import { mode, sheetRows, publishedDiscussions, saveDiscussion, discussionForStaff } from './reservations-api.js';
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
  if (mode !== 'live') {
    listStatus.textContent = '토론 기록은 서버가 연결된 공개 사이트에서 볼 수 있습니다.';
    return [];
  }
  try {
    const items = await publishedDiscussions();
    list.replaceChildren(...items.map(renderDiscussion));
    listStatus.textContent = items.length ? '' : '아직 게시된 토론 기록이 없어요. 세미나가 끝나면 운영진이 기록을 올립니다.';
    // 세미나 화면의 '그날의 토론 보기'로 들어오면 그 기록으로 이동
    if (location.hash) document.querySelector(location.hash)?.focus();
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
const requestAi = $('staff-ai');
const code = $('staff-code');
const result = $('staff-result');
const aiInfo = $('staff-ai-info');

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
  const ai = { requested: 'AI 정리를 기다리는 중입니다(최대 30분).', done: 'AI 정리 초안이 들어와 있습니다. 확인 후 게시하세요.', failed: `AI 정리에 실패했습니다. ${d.aiNote ?? ''}` };
  aiInfo.textContent = `상태: ${d.state === 'published' ? '게시됨' : '초안'}. ${ai[d.aiStatus] ?? ''}`;
}

async function setupStaff() {
  if (mode !== 'live') {
    form.hidden = true;
    $('staff-off').hidden = false;
    return;
  }
  // 세미나 목록: 시작한 세미나(지난 세미나)만, 최근 순
  try {
    const res = await sheetRows('seminars', false);
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
        requestAi: requestAi.checked,
      });
    } catch {
      code_ = 'error';
    }
    buttons.forEach((b) => (b.disabled = false));
    const asDraft = !publish || requestAi.checked;
    result.textContent =
      code_ === 'ok'
        ? requestAi.checked
          ? 'AI 정리를 요청하고 초안으로 저장했습니다. 30분 안에 정리되면 불러와서 확인한 뒤 게시하세요.'
          : MESSAGES[asDraft ? 'ok_draft' : 'ok_publish']
        : MESSAGES[code_] ?? MESSAGES.error;
    if (code_ === 'ok' && publish) loadPublished();
  });

  drawCloud();
}

loadPublished();
setupStaff();

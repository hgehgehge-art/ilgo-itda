// 오늘의 한 문장: data/today-quote.json을 읽어 상단 배너와 첫 방문 카드를 그린다.
// - 브라우저에서 명언 API를 직접 부르지 않는다(사람마다 다른 문장이 나오므로).
// - 카드를 닫으면 그 문장의 date를 저장하고, 같은 date면 다시 자동으로 열지 않는다.
// - 파일이 없거나 읽지 못하면 배너와 카드를 모두 숨긴다(오류 문구 없음).

const DATA_URL = 'data/today-quote.json';
const STORAGE_KEY = 'ilgo-itda:quote-dismissed';

const banner = document.getElementById('quote-banner');

// 한국 날짜(YYYY-MM-DD)
function koreaToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

// '2026-10-04' → '2026년 10월 4일'
function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}년 ${m}월 ${d}일`;
}

// 비공개 창 등에서 저장소 접근이 실패할 수 있으므로 모두 예외 처리
function readDismissed() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeDismissed(date) {
  try {
    localStorage.setItem(STORAGE_KEY, date);
  } catch {
    // 저장하지 못해도 카드는 정상 동작한다. 다음 방문에 다시 뜰 뿐이다.
  }
}

function isValid(q) {
  return (
    q &&
    typeof q.message === 'string' &&
    q.message.trim() !== '' &&
    typeof q.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(q.date)
  );
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function buildDialog(q, label) {
  const dialog = el('dialog', { class: 'quote-dialog', 'aria-labelledby': 'quote-label' });

  const close = el('button', { type: 'button', class: 'quote-close', 'aria-label': '닫기' }, '×');

  const eyebrow = el('p', { class: 'eyebrow', id: 'quote-label' }, label);
  const message = el('blockquote', { class: 'quote-message' });
  message.append(el('p', {}, q.message));

  const who = el('p', { class: 'quote-author' });
  if (q.author) who.append(el('strong', {}, q.author));
  if (q.authorProfile) who.append(el('span', {}, q.authorProfile));

  const meta = el('p', { class: 'quote-meta' });
  meta.append(el('time', { datetime: q.date }, formatDate(q.date)));
  if (q.source?.url && q.source?.name) {
    meta.append(' · 출처 ');
    meta.append(el('a', { href: q.source.url, target: '_blank', rel: 'noopener' }, q.source.name));
  }

  const browse = el('button', { type: 'button', class: 'btn' }, '홈페이지 둘러보기');

  dialog.append(close, eyebrow, message, who, meta, browse);
  close.addEventListener('click', () => dialog.close());
  browse.addEventListener('click', () => dialog.close());
  // 바깥(배경)을 눌러도 닫는다
  // (카드의 여백도 target이 dialog이므로 좌표로 바깥인지 확인)
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog || e.detail === 0) return;
    const r = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  return { dialog, firstFocus: browse };
}

function buildBanner(q, label, onReopen) {
  const inner = el('div', { class: 'container quote-banner-inner' });
  inner.append(el('span', { class: 'quote-banner-label' }, label));
  const full = q.author ? `${q.message} — ${q.author}` : q.message;
  const text = el('span', { class: 'quote-banner-text', title: full }, full);
  inner.append(text);
  const again = el('button', { type: 'button', class: 'quote-banner-btn' }, '다시 읽기');
  again.addEventListener('click', onReopen);
  inner.append(again);
  banner.replaceChildren(inner);
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', label);
  banner.hidden = false;
}

async function init() {
  if (!banner) return;

  let q;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) return;
    q = await res.json();
  } catch {
    return;
  }
  if (!isValid(q)) return;

  // 문장 갱신이 실패해 오늘 날짜가 아니면 '오늘의'라고 부르지 않는다
  const label = q.date === koreaToday() ? '오늘의 한 문장' : `${formatDate(q.date)}의 문장`;

  const { dialog, firstFocus } = buildDialog(q, label);
  document.body.append(dialog);

  let returnTo = null;

  function open() {
    if (dialog.open) return;
    returnTo = document.activeElement;
    // showModal은 바깥을 inert로 만들어 초점이 카드 밖으로 나가지 않는다
    dialog.showModal();
    firstFocus.focus();
  }

  // 닫기 버튼, 둘러보기 버튼, Esc, 배경 클릭 모두 여기로 모인다
  dialog.addEventListener('close', () => {
    writeDismissed(q.date);
    if (returnTo && returnTo !== document.body && document.contains(returnTo)) {
      returnTo.focus();
    }
    returnTo = null;
  });

  buildBanner(q, label, open);

  if (readDismissed() !== q.date && typeof dialog.showModal === 'function') {
    open();
  }
}

init();

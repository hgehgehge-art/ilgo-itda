// 책장: data/books.json을 읽어 검색·필터·나눠 보여 주기를 한다.
// 소장본이 500권 안팎이므로 한 번에 PAGE권씩만 그리고 '더 보기'로 이어서 그린다.
// 빌린 사람 정보는 이 파일에도, 데이터에도 없다.

const DATA_URL = 'data/books.json';
const PAGE = 30;

const $ = (id) => document.getElementById(id);
const form = $('book-search');
const input = $('book-query');
const onlyAvailable = $('only-available');
const list = $('book-list');
const count = $('book-count');
const more = $('book-more');
const synced = $('book-synced');
const notice = $('book-example');

let books = [];
let filtered = [];
let shown = 0;

// 검색 비교용: 공백 제거, 소문자
const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

function formatDue(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}월 ${d}일`;
}

function formatSynced(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function matches(book, q) {
  if (!q) return true;
  // '10', '10권', '제10권'처럼 권번호만 입력하면 권번호로 찾는다
  const num = q.match(/^제?(\d+)권?$/);
  if (num) return book.seriesNo === Number(num[1]);
  return norm(book.title).includes(q) || norm(book.author).includes(q);
}

function renderCard(book) {
  const li = el('li', { class: `book ${book.status === 'on_loan' ? 'is-out' : ''}`.trim(), tabindex: '-1' });
  const onLoan = book.status === 'on_loan';
  li.append(el('p', { class: 'book-no' }, `${book.seriesNo}권`));
  li.append(el('h3', { class: 'book-title' }, book.title));
  const by = [book.author, book.translator && `${book.translator} 옮김`].filter(Boolean).join(' · ');
  li.append(el('p', { class: 'book-by' }, by));

  const status = el('p', { class: `book-status ${onLoan ? 'is-loan' : 'is-free'}` });
  status.append(el('span', { class: 'pill' }, onLoan ? '대출 중' : '대출 가능'));
  if (onLoan && book.dueDate) status.append(el('span', {}, `${formatDue(book.dueDate)} 반납 예정`));
  li.append(status);
  li.append(el('p', { class: 'book-copy' }, `관리번호 ${book.copyId}`));
  return li;
}

function renderMore() {
  const next = filtered.slice(shown, shown + PAGE);
  const frag = document.createDocumentFragment();
  next.forEach((b) => frag.append(renderCard(b)));
  list.append(frag);
  shown += next.length;
  more.hidden = shown >= filtered.length;
  if (!more.hidden) more.textContent = `더 보기 (${filtered.length - shown}권 남음)`;
}

function apply() {
  const q = norm(input.value);
  filtered = books.filter(
    (b) => matches(b, q) && (!onlyAvailable.checked || b.status === 'available'),
  );
  list.replaceChildren();
  shown = 0;
  if (filtered.length === 0) {
    count.textContent = '찾는 책이 없습니다.';
    more.hidden = true;
    return;
  }
  const free = filtered.filter((b) => b.status === 'available').length;
  count.textContent = `${filtered.length}권 · 대출 가능 ${free}권`;
  renderMore();
}

function showError() {
  form.hidden = true;
  synced.textContent = '마지막 동기화 시각 알 수 없음';
  count.textContent = '정보를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.';
  count.classList.add('is-error');
}

function isBook(b) {
  return (
    b &&
    typeof b.copyId === 'string' &&
    typeof b.title === 'string' &&
    Number.isFinite(b.seriesNo) &&
    (b.status === 'available' || b.status === 'on_loan')
  );
}

async function init() {
  let data;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
    if (!Array.isArray(data.books)) throw new Error('형식 오류');
  } catch {
    showError();
    return;
  }

  books = data.books
    .filter(isBook)
    .sort((a, b) => a.seriesNo - b.seriesNo || a.copyId.localeCompare(b.copyId));

  const when = formatSynced(data.syncedAt);
  synced.textContent = when ? `마지막 동기화 ${when}` : '마지막 동기화 시각 알 수 없음';
  notice.hidden = data.example !== true;

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  onlyAvailable.addEventListener('change', apply);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    apply();
  });
  more.addEventListener('click', () => {
    const first = list.children.length;
    renderMore();
    // 키보드 사용자를 위해 새로 나온 첫 책으로 초점을 옮긴다
    list.children[first]?.focus();
  });

  apply();
}

init();

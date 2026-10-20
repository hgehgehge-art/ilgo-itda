// 책장: 구글 시트 '도서 목록'(서버의 sheet_rows)을 읽어 검색·필터·나눠 보여 주기를 한다.
// 시트가 연결되기 전에는 data/books.json(예시)을 읽는다.
// 소장본이 500권 안팎이므로 한 번에 PAGE권씩만 그리고 '더 보기'로 이어서 그린다.
// 빌린 사람 정보는 이 파일에도, 데이터에도 없다.

import { sheetRows } from './reservations-api.js';

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
let listOnly = false; // 대출 기록 없이 책 목록만 있을 때

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

  // 대출 기록이 연결되기 전(목록만 있을 때)에는 대출 상태를 지어 보여 주지 않는다
  const unknown = book.status === 'unknown';
  const status = el('p', { class: `book-status ${unknown ? 'is-unknown' : onLoan ? 'is-loan' : 'is-free'}` });
  status.append(el('span', { class: 'pill' }, unknown ? '대출 상태 확인 중' : onLoan ? '대출 중' : '대출 가능'));
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
  count.textContent = listOnly ? `${filtered.length}권` : `${filtered.length}권 · 대출 가능 ${free}권`;
  renderMore();
}

function showError() {
  form.hidden = true;
  synced.textContent = '';
  count.textContent = '정보를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.';
  count.classList.add('is-error');
}

function isBook(b) {
  return (
    b &&
    typeof b.copyId === 'string' &&
    typeof b.title === 'string' &&
    Number.isFinite(b.seriesNo) &&
    (b.status === 'available' || b.status === 'on_loan' || b.status === 'unknown')
  );
}

// '2026-10-11', '2026. 10. 11', '2026/10/11' → '2026-10-11'
function toIsoDate(text) {
  const m = String(text ?? '').trim().match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

// 시트 한 행 → 책 한 권. 상태 열은 시트 수식이 계산한다('대출 중' / '대출 가능' / '확인 필요').
function fromSheet(r) {
  if (r && typeof r.copyId === 'string') return r;
  const onLoan = r['상태'] === '대출 중' || r['상태'] === '확인 필요';
  return {
    copyId: r['관리번호'],
    seriesNo: Number(r['전집 권번호']),
    title: r['제목'],
    author: r['작가'],
    translator: r['번역자'],
    isbn: r['ISBN'],
    status: onLoan ? 'on_loan' : 'available',
    dueDate: onLoan ? toIsoDate(r['반납 예정일']) : null,
  };
}

// 시트가 연결되어 있으면 시트, 아니면 예시 파일
async function loadBooks() {
  let sheet = null;
  try {
    sheet = await sheetRows('books', false);
  } catch {
    sheet = { status: 'error' };
  }
  // 운영 시트의 도서 목록이 아직 비어 있으면 예시 목록을 보여 준다(화면에 '준비 중' 안내)
  if (sheet.status === 'ok' && sheet.rows.length) {
    return { syncedAt: sheet.fetchedAt, books: sheet.rows.map(fromSheet), fromSheet: true, fetchedRows: JSON.stringify(sheet.rows) };
  }
  // 조회 서버가 중단되어도 공개 서지 목록을 계속 제공한다. 파일에는 example 표시가 있다.

  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  if (!Array.isArray(data.books)) throw new Error('형식 오류');
  return data;
}

function sortBooks(list) {
  return list.filter(isBook).sort((a, b) => a.seriesNo - b.seriesNo || a.copyId.localeCompare(b.copyId));
}

async function init() {
  let data;
  try {
    data = await loadBooks();
  } catch {
    showError();
    return;
  }

  books = sortBooks(data.books);

  const when = formatSynced(data.syncedAt);
  listOnly = data.listOnly === true;
  synced.textContent = listOnly
    ? '대출 기록 연결 전이라 책 목록만 보여 줍니다.'
    : when
      ? `마지막으로 시트를 읽은 시각 ${when}`
      : '마지막으로 시트를 읽은 시각 알 수 없음';
  notice.hidden = !(listOnly || data.example === true);
  // 대출 상태를 모를 때는 '대출 가능한 책만' 거르기를 쓸 수 없다
  onlyAvailable.disabled = listOnly;
  onlyAvailable.closest('label')?.classList.toggle('is-disabled', listOnly);

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
  applyQuery();
}

// 다른 화면(독서 지도의 '관련 책')에서 books.html?q=44 처럼 들어오면 그 검색어로 시작한다
function applyQuery() {
  const q = new URLSearchParams(location.search).get('q');
  if (!q) return;
  input.value = q.slice(0, 50);
  apply();
}

init();

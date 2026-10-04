/**
 * 읽고, 잇다 — 시트 연결용 Apps Script
 *
 * 대출 시트(새로 만든 비공개 스프레드시트)의 '확장 프로그램 → Apps Script'에 붙여 넣어 씁니다.
 * 웹 앱으로 배포하면, 그 주소가 사이트에 필요한 열만 JSON으로 돌려줍니다.
 * GitHub Actions(scripts/sync-sheets.mjs)가 30분마다 이 주소를 읽어 사이트를 갱신합니다.
 *
 * 개인정보: '빌린 회원 이름', '비고' 같은 열은 아래 COLUMNS에 없으므로 이 스크립트 밖으로 나가지 않습니다.
 * 응답에는 사이트에 이미 공개되는 정보(일정, 책 목록, 대출 여부·반납 예정일)만 담깁니다.
 */

// ── 여기만 고치세요 ─────────────────────────────────────
// 세미나 일정 스프레드시트의 ID (주소의 /d/ 와 /edit 사이)
const SEMINAR_SHEET_ID = '여기에_세미나_시트_ID';

const TABS = {
  seminars: '사이트 연동', // 세미나 시트 안의 탭. 기존 '시트1'은 건드리지 않습니다
  books: '도서 목록', // 이 대출 시트 안의 탭
  loans: '대출 기록', // 이 대출 시트 안의 탭
};
// ───────────────────────────────────────────────────────

// 내보내는 열(머리행 이름). 여기에 없는 열은 절대 내보내지 않습니다.
const COLUMNS = {
  seminars: ['세미나 ID', '작가 및 작품명', '개최 일시', '발제자', '장소', '정원', '게시 상태', '발제문 URL', '공개 안내'],
  books: ['관리번호', '전집 권번호', '제목', '작가', '번역자', 'ISBN'],
  loans: ['관리번호', '반납 예정일', '실제 반납일'],
};

// 시트에 만들 머리행. 대출 기록에는 운영진용 열(빌린 회원 이름, 대출일)도 있지만 내보내지는 않습니다.
const HEADERS = {
  seminars: COLUMNS.seminars,
  books: COLUMNS.books,
  loans: ['관리번호', '빌린 회원 이름', '대출일', '반납 예정일', '실제 반납일'],
};

/** 웹 앱 주소로 요청이 오면 실행됩니다. */
function doGet() {
  const out = { generatedAt: new Date().toISOString(), errors: [] };
  const sources = {
    seminars: () => SpreadsheetApp.openById(SEMINAR_SHEET_ID),
    books: loanSpreadsheet_,
    loans: loanSpreadsheet_,
  };
  for (const kind of Object.keys(COLUMNS)) {
    try {
      out[kind] = readTab_(sources[kind](), TABS[kind], COLUMNS[kind]);
    } catch (e) {
      // 오류 문구에는 시트 내용을 넣지 않습니다
      out.errors.push(`${kind}: ${e.message}`);
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 처음 한 번 실행: 필요한 탭과 머리행을 만듭니다. 이미 있는 탭은 건드리지 않습니다. */
function setupSheets() {
  const loan = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('LOAN_SHEET_ID', loan.getId());
  ensureTab_(loan, TABS.books, HEADERS.books);
  ensureTab_(loan, TABS.loans, HEADERS.loans);
  ensureTab_(SpreadsheetApp.openById(SEMINAR_SHEET_ID), TABS.seminars, HEADERS.seminars);
  Logger.log('준비 완료. 이제 배포 → 새 배포 → 웹 앱으로 배포하세요.');
}

/** 배포 전에 응답을 미리 확인합니다(실행 로그에 앞부분만 표시). */
function testPreview() {
  const text = doGet().getContent();
  const data = JSON.parse(text);
  Logger.log('오류: ' + JSON.stringify(data.errors));
  for (const kind of Object.keys(COLUMNS)) {
    Logger.log(`${kind}: ${data[kind] ? data[kind].length - 1 : 0}행, 열 = ${data[kind] ? data[kind][0].join(', ') : '-'}`);
  }
}

function loanSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('LOAN_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function ensureTab_(spreadsheet, name, header) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // 관리번호·날짜가 숫자나 날짜로 바뀌지 않도록 글자 그대로 둡니다
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, header.length).setNumberFormat('@');
  }
}

// 필요한 열만 골라 [머리행, 행...] 형태로 돌려줍니다. 화면에 보이는 그대로의 글자로 읽습니다.
function readTab_(spreadsheet, name, wanted) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error(`'${name}' 탭이 없음`);
  const values = sheet.getDataRange().getDisplayValues();
  const header = (values[0] || []).map((h) => String(h).trim());
  const keep = wanted.map((col) => [col, header.indexOf(col)]).filter(([, i]) => i !== -1);
  return values.map((row, r) => (r === 0 ? keep.map(([col]) => col) : keep.map(([, i]) => row[i])));
}

import { readFileSync } from 'node:fs';
import { makeEnv } from './gas-harness.mjs';
// 실행: node tests/apps-script.test.mjs  (apps-script/Code.gs를 가짜 구글 환경에서 그대로 실행)
const csv = readFileSync(process.env.CSV || 'tests/seminar-sheet-sample.csv', 'utf8');
const env = makeEnv({ seminarCsv: csv, now: '2026-10-05T12:00:00+09:00' }); // 10/7·10/8 세미나가 아직 시작 전인 시점
let fail = 0;
const check = (label, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  기대 ${JSON.stringify(e)} 실제 ${JSON.stringify(a)}`}`); };

// 설정
env.ctx.setupSheets();
check('세미나 시트 미연결 → 오류', env.get('seminars').status, 'error');
env.props.SEMINAR_SHEET_ID = 'SEM';
check('처음 설정이 탭 5개를 만듦', env.ops.getSheets().map((s) => s.getName()), ['도서 목록', '대출 기록', '세미나 신청', '토론 기록', '독서 지도']);

// 세미나
const s = env.get('seminars');
check('세미나 10건(휴회·빈 주차 제외)', s.seminars.length, 10);
check('ID는 날짜, 제목 변환', [s.seminars[8].id, s.seminars[8].title], ['2026-10-07', '김영하 『호출』']);
check('발제자 이름 가림(첫 글자 + ○)', /^.○+$/.test(s.seminars[8].presenter), true);
check('응답 어디에도 원래 발제자 이름이 없음', JSON.stringify(s).includes(csv.split('\n')[5].split(',')[3]), false);
check('기본 시간·장소·정원', [s.seminars[8].startsAt, s.seminars[8].place, s.seminars[8].capacity], ['2026-10-07T18:00:00+09:00', '동아리방', 11]);

// 신청
const R = (name, pin, id = '2026-10-07') => env.post({ action: 'reserve', seminarId: id, name, pin });
const C = (name, pin, id = '2026-10-07') => env.post({ action: 'cancel', seminarId: id, name, pin }).result;
check('빈 이름 → invalid', R('  ', '1234').result, 'invalid');
check('확인번호 문자 → invalid', R('점검1', '12a4').result, 'invalid');
check('없는 세미나 → invalid', R('점검1', '1234', '2099-01-01').result, 'invalid');
check('지난 세미나 → closed', R('점검1', '1234', '2026-09-30').result, 'closed');
check('신청 → ok', R('점검1', '1234').result, 'ok');
check('같은 이름 → duplicate', R(' 점검1 ', '9999').result, 'duplicate');
check('인원 1', env.get('seminars').counts['2026-10-07'], 1);
check('세미나 ID가 시트에 글자로 저장됨', env.ops.getSheetByName('세미나 신청').data[1][0], "'2026-10-07");
check('확인번호 원문이 시트에 없음', JSON.stringify(env.ops.getSheetByName('세미나 신청').data).includes('"1234"'), false);
check('틀린 확인번호 취소 → not_found', C('점검1', '0000'), 'not_found');
check('없는 이름 취소 → not_found', C('없는사람', '1234'), 'not_found');
check('맞는 확인번호 취소 → ok', C('점검1', '1234'), 'ok');
check('취소 후 재신청 → ok', R('점검1', '1234').result, 'ok');
for (let i = 2; i <= 10; i++) R('점검' + i, '1111');
check('회원 10명 → 인원 10(화면 11/11)', env.get('seminars').counts['2026-10-07'], 10);
check('11번째 → full', R('점검11', '1111').result, 'full');
check('지난 세미나 취소 → closed', C('점검1', '1234', '2026-09-30'), 'closed');

// 책장
const books = env.ops.getSheetByName('도서 목록'); const loans = env.ops.getSheetByName('대출 기록');
books.appendRow(['M-001-1', 1, '변신 이야기 1', '오비디우스', '이윤기', '']);
books.appendRow(['M-044-1', 44, '데미안', '헤르만 헤세', '전영애', '']);
books.appendRow(['M-003-1', 3, '햄릿', '셰익스피어', '최종철', '']);
loans.appendRow(['M-044-1', '빌린사람가나다', '2026. 10. 1', '2026. 10. 11', '']);
loans.appendRow(['M-001-1', '빌린사람라마바', '2026. 9. 1', '2026. 9. 15', '2026. 9. 14']);
loans.appendRow(['M-003-1', '빌린사람사아자', '2026. 10. 1', '2026. 10. 10', '']);
loans.appendRow(['M-003-1', '빌린사람차카타', '2026. 10. 2', '2026. 10. 12', '']);
env.clearCache();
const b = env.get('books');
check('책 상태·반납 예정일', b.books.map((x) => `${x.copyId}:${x.status}:${x.dueDate}`), ['M-001-1:available:null', 'M-003-1:on_loan:null', 'M-044-1:on_loan:2026-10-11']);
check('빌린 사람 이름이 응답에 없음', JSON.stringify(b).includes('빌린사람'), false);

// 토론
const longText = ('참석자 1 00:01 오늘 변신에서 가족이 그레고르를 대하는 방식이 잔인하다고 느꼈어요. 참석자 2 저는 가족도 지쳐 있었다고 생각해요. 쓸모와 노동의 문제 같아요. ').repeat(3);
const save = (extra) => env.post({ action: 'saveDiscussion', code: '운영진코드123', seminarId: '2026-09-30', text: longText, keywords: [{ word: '가족', count: 6 }], summary: '', questions: [], quotes: [], publish: true, requestAi: false, ...extra }).result;
check('운영진 코드 없을 때 → bad_code', save(), 'bad_code');
env.props.STAFF_CODE_HASH = env.ctx.hashSecret_('운영진코드123');
check('틀린 코드 → bad_code', save({ code: '틀림' }), 'bad_code');
check('짧은 텍스트 → too_short', save({ text: '짧다' }), 'too_short');
check('없는 세미나 → not_found', save({ seminarId: '2099-01-01' }), 'not_found');
check('키워드 41개 → invalid', save({ keywords: Array.from({ length: 41 }, (_, i) => ({ word: 'w' + i, count: 1 })) }), 'invalid');
check('게시 → ok', save(), 'ok');
const pub = env.get('discussions').discussions;
check('게시된 기록 1건, 원문 없음', [pub.length, JSON.stringify(pub).includes('참석자 1 00:01')], [1, false]);
check('다시 저장해도 한 줄(덮어쓰기)', (save({ summary: '요약 수정' }), env.ops.getSheetByName('토론 기록').data.length), 2);
check('AI 요청하면 초안으로', (save({ requestAi: true }), env.get('discussions').discussions.length), 0);
const loaded = env.post({ action: 'loadDiscussion', code: '운영진코드123', seminarId: '2026-09-30' });
check('운영진 불러오기: 원문·AI 요청 상태', [loaded.status, loaded.aiStatus, loaded.text.length > 200], ['ok', 'requested', true]);
check('운영진 불러오기 틀린 코드', env.post({ action: 'loadDiscussion', code: 'x', seminarId: '2026-09-30' }).status, 'bad_code');
check('AI 토큰 없을 때 → bad_token', env.post({ action: 'aiPending', token: 'x' }).status, 'bad_token');
env.props.AI_TOKEN_HASH = env.ctx.hashSecret_('TOKEN-ABC');
const pending = env.post({ action: 'aiPending', token: 'TOKEN-ABC' });
check('AI 대기 1건', [pending.status, pending.items.length, pending.items[0].seminarId], ['ok', 1, '2026-09-30']);
check('AI 결과 저장', env.post({ action: 'aiSave', token: 'TOKEN-ABC', seminarId: '2026-09-30', result: { keywords: [{ word: '가족', count: 6 }], summary: 'AI 요약', questions: ['질문'], quotes: [{ speaker: '참석자 A', text: '저는 가족도 지쳐 있었다고 생각해요.' }] } }).result, 'ok');
check('AI 결과 후 상태 완료·초안', [env.post({ action: 'loadDiscussion', code: '운영진코드123', seminarId: '2026-09-30' }).aiStatus, env.get('discussions').discussions.length], ['done', 0]);
check('운영진 확인 후 게시', (save({ summary: 'AI 요약' }), env.get('discussions').discussions[0].summary), 'AI 요약');

// 독서 지도
const sug = (x) => env.post({ action: 'suggestPlace', name: '외대 도서관', category: '도서관', address: '서울 동대문구 이문로 107', reason: '조용해서 좋아요', nickname: '', book: '44', ...x }).result;
check('빈 이름 → missing', sug({ name: '' }), 'missing');
check('없는 분류 → invalid_category', sug({ category: '카페' }), 'invalid_category');
check('이유 101자 → too_long', sug({ reason: 'ㄱ'.repeat(101) }), 'too_long');
check('추천 → 바로 게시(published)', sug(), 'published');
check('같은 장소 → duplicate', sug({ address: '서울 동대문구  이문로107' }), 'duplicate');
const ps = env.ops.getSheetByName('독서 지도');
const pl = env.get('places').places;
check('추천하자마자 지도에 나오고 좌표가 채워짐', [pl.length, pl[0].lat, pl[0].source, pl[0].recommender, pl[0].book], [1, 37.5972, '회원 추천', '해문 회원', 44]);
check('좌표가 시트에 적힘', [ps.data[1][4], ps.data[1][5]], [37.5972, 127.0587]);
ps.data[1][11] = '반려'; env.clearCache();
check("운영진이 '반려'로 바꾸면 지도에서 내려감", env.get('places').places.length, 0);

// 그 밖
check('알 수 없는 읽기 요청', env.get('nope').status, 'error');
check('JSON이 아닌 쓰기 요청', JSON.parse(env.ctx.doPost({ postData: { contents: '{깨짐' } }).getContent()).result, 'invalid');
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);

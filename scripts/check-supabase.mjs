// Supabase 신청 저장소 점검. 홈페이지와 똑같이 공개용(anon) 키만 쓴다.
// 먼저 supabase/test-seminars.sql의 [준비]를 실행해 두어야 한다.
//
// 사용: SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=공개용키 node scripts/check-supabase.mjs
// 점검 이름은 '점검회원N'이며 실제 회원 이름을 쓰지 않는다.

const URL_ = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL과 SUPABASE_ANON_KEY 환경 변수가 필요합니다.');
  process.exit(2);
}

// 예전 방식 키(eyJ…로 시작하는 JWT)만 Authorization에 함께 보낸다. 새 키(sb_publishable_/sb_secret_)는 apikey 헤더만 쓴다.
const headers = { apikey: KEY, 'content-type': 'application/json' };
if (KEY.startsWith('eyJ')) headers.authorization = `Bearer ${KEY}`;

async function rpc(fn, args = {}) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`${fn} 응답 ${res.status}: ${await res.text()}`);
  return res.json();
}
const reserve = (id, name, pin) => rpc('reserve', { p_seminar_id: id, p_name: name, p_pin: pin });
const cancel = (id, name, pin) => rpc('cancel_reservation', { p_seminar_id: id, p_name: name, p_pin: pin });
async function count(id) {
  const rows = await rpc('seminar_counts');
  return rows.find((r) => r.seminar_id === id)?.count;
}

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 1. 표 직접 접근 차단
for (const table of ['reservations', 'seminars']) {
  const read = await fetch(`${URL_}/rest/v1/${table}?select=*`, { headers });
  check(`${table} 표 직접 읽기 거절`, read.ok, false);
}
const write = await fetch(`${URL_}/rest/v1/reservations`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ seminar_id: 'zz-test-open', name: '점검직접쓰기', pin_hash: 'x' }),
});
check('reservations 표 직접 쓰기 거절', write.ok, false);

// 2. 시작 상태
check('점검용 세미나가 준비됨(신청 0)', await count('zz-test-open'), 0);
check('초안 세미나는 인원 목록에 없음', await count('zz-test-draft'), undefined);

// 3. 입력 검사
check('빈 이름 → invalid', await reserve('zz-test-open', '   ', '1234'), 'invalid');
check('확인번호 3자리 → invalid', await reserve('zz-test-open', '점검회원1', '123'), 'invalid');
check('확인번호에 문자 → invalid', await reserve('zz-test-open', '점검회원1', '12a4'), 'invalid');
check('없는 세미나 → invalid', await reserve('zz-test-없음', '점검회원1', '1234'), 'invalid');

// 4. 신청·중복
check('신청 → ok', await reserve('zz-test-open', '점검회원1', '1234'), 'ok');
check('같은 이름 다시 신청 → duplicate', await reserve('zz-test-open', '점검회원1', '9999'), 'duplicate');
check('앞뒤 공백만 다른 이름 → duplicate', await reserve('zz-test-open', '  점검회원1 ', '1234'), 'duplicate');

// 5. 취소
check('틀린 확인번호로 취소 → not_found', await cancel('zz-test-open', '점검회원1', '0000'), 'not_found');
check('없는 이름으로 취소 → not_found', await cancel('zz-test-open', '점검회원없음', '1234'), 'not_found');
check('맞는 확인번호로 취소 → ok', await cancel('zz-test-open', '점검회원1', '1234'), 'ok');
check('이미 취소한 신청 다시 취소 → not_found', await cancel('zz-test-open', '점검회원1', '1234'), 'not_found');
check('취소 후 같은 이름 재신청 → ok', await reserve('zz-test-open', '점검회원1', '1234'), 'ok');

// 6. 정원: 회원 10명이면 마감(발제자 포함 11/11)
for (let i = 2; i <= 10; i += 1) await reserve('zz-test-open', `점검회원${i}`, '1234');
check('회원 10명 신청 후 인원 10(화면 11/11)', await count('zz-test-open'), 10);
check('11번째 신청 → full', await reserve('zz-test-open', '점검회원11', '1234'), 'full');
check('한 명 취소 → ok', await cancel('zz-test-open', '점검회원5', '1234'), 'ok');
check('취소로 생긴 자리에 신청 → ok', await reserve('zz-test-open', '점검회원11', '1234'), 'ok');

// 7. 마지막 자리 동시 신청: 9명을 채운 뒤 5명이 동시에 신청 → 한 명만 ok
for (let i = 1; i <= 9; i += 1) await reserve('zz-test-race', `점검회원${i}`, '1234');
const race = await Promise.all(
  [21, 22, 23, 24, 25].map((i) => reserve('zz-test-race', `점검회원${i}`, '1234')),
);
check('마지막 자리 동시 신청 → ok 1건', race.filter((r) => r === 'ok').length, 1);
check('나머지는 full', race.filter((r) => r === 'full').length, 4);
check('동시 신청 후 인원 10을 넘지 않음', await count('zz-test-race'), 10);

// 8. 시작한 세미나·초안
check('시작한 세미나 신청 → closed', await reserve('zz-test-started', '점검회원1', '1234'), 'closed');
check('시작한 세미나 취소 → closed', await cancel('zz-test-started', '점검회원1', '1234'), 'closed');
check('초안 세미나 신청 → closed', await reserve('zz-test-draft', '점검회원1', '1234'), 'closed');

// 9. 결과에 이름·확인번호가 담기지 않음
const rows = await rpc('seminar_counts');
check('seminar_counts 결과에는 seminar_id와 count만 있음', Object.keys(rows[0] ?? {}).sort(), ['count', 'seminar_id']);

console.log(failed === 0 ? '\n모두 통과했습니다.' : `\n실패 ${failed}건`);
console.log('다시 점검하려면 test-seminars.sql의 [준비]를 다시 실행하세요. 끝나면 [정리]를 실행하세요.');
process.exit(failed === 0 ? 0 : 1);

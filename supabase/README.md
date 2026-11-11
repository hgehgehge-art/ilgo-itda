# Supabase 설계: 세미나 한 줄 후기

10주차(데이터베이스와 Supabase) 실습을 이 프로젝트에 적용한 설계입니다. 오늘은 설계와 SQL 파일까지만 둡니다. 실제 Supabase 프로젝트에 적용하고 화면을 붙이는 일은 다음 단계입니다.

## 왜 후기인가

세미나가 끝나면 좋았던 대화가 기록 없이 사라집니다(README 1장, 문제 3). '그날의 토론'은 운영진이 받아쓰기로 정리하는 기록이고, 한 줄 후기는 **참석한 회원이 직접 한 문장씩 남기는 기록**입니다. 지금 쓰는 구글 시트 구조(세미나 신청, 도서, 장소)와 겹치지 않습니다.

## 표: `public.seminar_reviews`

| 칸 | 형식 | 제한 | 설명 |
| --- | --- | --- | --- |
| `id` | bigint, 자동 증가 | 기본 키 | 글 번호 |
| `seminar_id` | text | 1~40자, 필수 | 주간세미나 시트의 세미나 ID (예: `2026-2-w04`) |
| `nickname` | text | 앞뒤 공백 뺀 1~20자, 필수 | 별명. 실명을 받지 않음 |
| `body` | text | 앞뒤 공백 뺀 1~200자, 필수 | 한 줄 후기 |
| `created_at` | timestamptz | 기본값 now() | 남긴 시각 |

색인: `(seminar_id, created_at desc)`. 세미나별 최신 후기부터 읽습니다.

## 권한과 RLS

| 누가 | 읽기 | 쓰기·수정·삭제 |
| --- | --- | --- |
| 방문자 (anon, Publishable key) | 됨 ('누구나 읽기' 정책) | 안 됨 (권한 없음, 쓰기 정책 없음) |
| 로그인 사용자 (authenticated) | 됨 | 안 됨 |
| 서버 함수 (Secret key) | 됨 | 글 쓰기만 코드에서 허용 |

- `enable row level security`로 RLS를 켭니다.
- 공개 역할(anon, authenticated)은 `revoke all` 뒤 `select`만 받습니다.
- 정책은 '누구나 읽기' 하나뿐입니다.
- 글자 수 제한은 `check`로 DB가 직접 지킵니다.
- SQL에 `drop`, `delete`, `truncate`가 없습니다.

## 개인정보

- 이름 대신 별명만 받습니다.
- 전화번호, 학번, 이메일, 확인번호는 받지 않습니다.
- 후기를 지워야 하면 운영진이 Supabase 대시보드에서 직접 지웁니다.

## 지킬 것

- Publishable key와 Secret key, DB 비밀번호는 Vercel 환경 변수와 비밀번호 관리자에만 둡니다. 이 저장소, README, 대화창, 메신저에는 넣지 않습니다.
- Secret key는 서버 함수(`api/` 아래) 안에서만 씁니다. 화면 코드에는 넣지 않습니다.
- 화면에 후기를 넣을 때는 `textContent`를 씁니다(`innerHTML` 아님).

## 파일

- `migrations/20261111000000_seminar_reviews.sql`: 표, 색인, RLS, 권한, 정책

## 다음 단계

1. Supabase 대시보드에서 무료 프로젝트를 만들고 위 SQL을 실행합니다.
2. `api/reviews.js`(서버 함수)와 세미나 화면의 후기 칸을 만듭니다.
3. Vercel 환경 변수에 `SUPABASE_URL`, Publishable key, Secret key(Sensitive)를 넣고 다시 배포합니다.

-- 읽고, 잇다 · 세미나 한 줄 후기
-- 세미나가 끝난 뒤 회원이 별명과 한 줄 후기를 남긴다.
-- 읽기는 누구나, 쓰기는 서버(Vercel 함수, secret 키)만 한다.
-- 개인정보 최소화: 이름 대신 별명, 전화번호·학번·이메일은 받지 않는다.

create table public.seminar_reviews (
  id          bigint generated always as identity primary key,
  seminar_id  text        not null check (char_length(seminar_id) between 1 and 40),
  nickname    text        not null check (char_length(btrim(nickname)) between 1 and 20),
  body        text        not null check (char_length(btrim(body)) between 1 and 200),
  created_at  timestamptz not null default now()
);

comment on table  public.seminar_reviews            is '세미나 한 줄 후기 (별명만, 개인정보 없음)';
comment on column public.seminar_reviews.seminar_id is '주간세미나 시트의 세미나 ID (예: 2026-2-w04)';
comment on column public.seminar_reviews.nickname   is '별명 1~20자. 실명·연락처를 받지 않는다';
comment on column public.seminar_reviews.body       is '후기 1~200자';

-- 세미나별 최신순 조회용
create index seminar_reviews_seminar_created_idx
  on public.seminar_reviews (seminar_id, created_at desc);

-- 행 수준 보안 켜기
alter table public.seminar_reviews enable row level security;

-- 공개 역할은 모든 권한을 걷은 뒤 읽기만 준다
revoke all on table public.seminar_reviews from anon, authenticated;
grant select on table public.seminar_reviews to anon, authenticated;

-- 정책은 '누구나 읽기' 하나뿐. 쓰기 정책이 없으므로 공개 키로는 글을 쓸 수 없다.
create policy "누구나 읽기"
  on public.seminar_reviews
  for select
  to anon, authenticated
  using (true);

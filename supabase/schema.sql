-- 읽고, 잇다 — 세미나 신청 저장소 (Supabase / Postgres)
--
-- 적용: Supabase 관리 화면 → SQL Editor에 이 파일 전체를 붙여 넣고 Run.
--       여러 번 실행해도 되도록 작성했다(표가 이미 있으면 그대로 둔다).
--
-- 원칙
--  - 홈페이지(공개용 anon 키)는 표를 직접 읽거나 쓸 수 없다. 아래 세 함수만 실행할 수 있다.
--      reserve(세미나 ID, 이름, 확인번호)            → ok / duplicate / full / closed / invalid
--      cancel_reservation(세미나 ID, 이름, 확인번호) → ok / not_found / closed
--      seminar_counts()                               → [{ seminar_id, count }]  (발제자 제외)
--  - 정원(capacity)에는 발제자가 포함된다. 회원 신청은 capacity - 1명까지.
--  - 확인번호는 솔트를 넣은 해시(bcrypt)로만 저장한다. 4자리 숫자라 추측은 쉬우므로 원문 노출을 막는 정도의 보호다.
--  - 신청은 지우지 않고 cancelled_at을 채운다.
--  - seminars 표는 시트 동기화(관리용 service_role 키)가 채운다. reservations 표는 함수만 쓴다.
--  - 운영진은 관리 화면(Table Editor)에서 명단을 보고, 대리 취소는 cancelled_at에 시각을 넣는다.

create extension if not exists pgcrypto with schema extensions;

-- ── 표 ──────────────────────────────────────────────

create table if not exists public.seminars (
  id         text primary key,
  title      text not null,
  starts_at  timestamptz not null,
  capacity   integer not null default 11 check (capacity between 2 and 100),
  status     text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  updated_at timestamptz not null default now()
);

create table if not exists public.reservations (
  id           bigint generated always as identity primary key,
  seminar_id   text not null references public.seminars (id) on delete restrict,
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 30),
  pin_hash     text not null,
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz
);

-- 같은 세미나에 취소되지 않은 같은 이름은 하나만
create unique index if not exists reservations_active_name
  on public.reservations (seminar_id, name)
  where cancelled_at is null;

create index if not exists reservations_active_seminar
  on public.reservations (seminar_id)
  where cancelled_at is null;

-- ── 접근 규칙 ───────────────────────────────────────
-- 행 수준 보안을 켜고 정책은 만들지 않는다 → anon·authenticated는 어떤 행도 볼 수 없다.
-- Supabase는 새 표에 anon 권한을 기본으로 주므로 권한도 직접 회수한다.

alter table public.seminars enable row level security;
alter table public.reservations enable row level security;

revoke all on table public.seminars from anon, authenticated;
revoke all on table public.reservations from anon, authenticated;

-- ── 함수 ────────────────────────────────────────────
-- security definer: 함수 소유자(postgres) 권한으로 표에 접근한다.
-- search_path를 비워 두고 모든 이름을 스키마까지 적는다(다른 스키마의 같은 이름 객체에 속지 않도록).

create or replace function public.reserve(p_seminar_id text, p_name text, p_pin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_seminar public.seminars%rowtype;
  v_count   integer;
begin
  if v_name = '' or char_length(v_name) > 30
     or p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return 'invalid';
  end if;

  -- 이 세미나 행을 잠근다. 같은 세미나에 동시에 들어온 신청은 여기서 한 줄로 선다.
  -- 그래서 마지막 자리에 두 명이 동시에 신청해도 한 명만 성공한다.
  select * into v_seminar
  from public.seminars
  where id = p_seminar_id
  for update;

  if not found then
    return 'invalid';
  end if;

  if v_seminar.status <> 'published' or v_seminar.starts_at <= now() then
    return 'closed';
  end if;

  if exists (
    select 1 from public.reservations
    where seminar_id = p_seminar_id and name = v_name and cancelled_at is null
  ) then
    return 'duplicate';
  end if;

  select count(*) into v_count
  from public.reservations
  where seminar_id = p_seminar_id and cancelled_at is null;

  if v_count >= v_seminar.capacity - 1 then
    return 'full';
  end if;

  insert into public.reservations (seminar_id, name, pin_hash)
  values (p_seminar_id, v_name, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));

  return 'ok';
exception
  when unique_violation then
    return 'duplicate';
end;
$$;

create or replace function public.cancel_reservation(p_seminar_id text, p_name text, p_pin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_pin     text := coalesce(p_pin, '');
  v_seminar public.seminars%rowtype;
  v_id      bigint;
  v_hash    text;
begin
  select * into v_seminar
  from public.seminars
  where id = p_seminar_id
  for update;

  if not found then
    return 'not_found';
  end if;

  if v_seminar.starts_at <= now() then
    return 'closed';
  end if;

  select id, pin_hash into v_id, v_hash
  from public.reservations
  where seminar_id = p_seminar_id and name = v_name and cancelled_at is null;

  -- 이름이 없을 때도 해시 계산을 한 번 해서, 응답 시간으로 신청 여부를 짐작하지 못하게 한다.
  -- 이름이 없거나 확인번호가 틀리면 똑같이 not_found.
  if v_id is null then
    perform extensions.crypt(v_pin, extensions.gen_salt('bf', 8));
    return 'not_found';
  end if;

  if extensions.crypt(v_pin, v_hash) <> v_hash then
    return 'not_found';
  end if;

  update public.reservations
  set cancelled_at = now()
  where id = v_id;

  return 'ok';
end;
$$;

create or replace function public.seminar_counts()
returns table (seminar_id text, count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, count(r.id)::integer
  from public.seminars s
  left join public.reservations r
    on r.seminar_id = s.id and r.cancelled_at is null
  where s.status <> 'draft'
  group by s.id;
$$;

-- 공개용 키(anon)에는 이 세 함수의 실행 권한만 준다.
revoke all on function public.reserve(text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_reservation(text, text, text) from public, anon, authenticated;
revoke all on function public.seminar_counts() from public, anon, authenticated;

grant execute on function public.reserve(text, text, text) to anon;
grant execute on function public.cancel_reservation(text, text, text) to anon;
grant execute on function public.seminar_counts() to anon;

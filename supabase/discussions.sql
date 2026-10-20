-- 읽고, 잇다 — 그날의 토론 기록 (schema.sql, sheets.sql 다음에 실행)
--
-- 흐름
--  1. 운영진이 세미나가 끝난 뒤 받아쓰기 텍스트(클로바노트 등)를 '토론' 화면에 붙여 넣는다.
--  2. 브라우저가 자주 나온 낱말로 키워드 후보를 만들고, 운영진이 고친 뒤 초안 저장 또는 게시한다.
--  3. (선택) 'AI 정리 요청'을 켜 두면 GitHub Actions가 Claude로 요약·질문·인상 깊은 말 초안을 채운다.
--     운영진이 확인한 뒤 게시해야 공개된다.
--  4. 게시된 기록만 누구나 볼 수 있다. 원문 텍스트는 공개하지 않는다.
--
-- 운영진 코드 정하기(처음 한 번, SQL Editor에서 직접 실행. 코드는 저장소에 올리지 않는다):
--   select public.set_staff_code('운영진만 아는 코드');

-- ── 표 ──────────────────────────────────────────────

create table if not exists public.staff_settings (
  id              integer primary key default 1 check (id = 1),
  staff_code_hash text not null
);

create table if not exists public.discussions (
  seminar_id   text primary key references public.seminars (id) on delete restrict,
  source_text  text not null,                     -- 받아쓰기 원문. 비공개
  keywords     jsonb not null default '[]',      -- [{ "word": "자유", "count": 12 }]
  summary      text not null default '',
  questions    jsonb not null default '[]',      -- ["…", "…"]
  quotes       jsonb not null default '[]',      -- [{ "text": "…", "speaker": "참석자 A" }]
  status       text not null default 'draft' check (status in ('draft', 'published')),
  ai_status    text not null default 'none' check (ai_status in ('none', 'requested', 'done', 'failed')),
  ai_note      text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz
);

-- 하루 저장 횟수 제한용
create table if not exists public.discussion_saves (
  id       bigint generated always as identity primary key,
  saved_at timestamptz not null default now()
);

alter table public.staff_settings enable row level security;
alter table public.discussions enable row level security;
alter table public.discussion_saves enable row level security;
revoke all on table public.staff_settings from anon, authenticated;
revoke all on table public.discussions from anon, authenticated;
revoke all on table public.discussion_saves from anon, authenticated;

-- ── 함수 ────────────────────────────────────────────

-- 운영진 코드 설정(관리 화면 SQL Editor에서만. anon에게 열지 않음)
create or replace function public.set_staff_code(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code is null or char_length(btrim(p_code)) < 6 then
    return '코드는 6자 이상이어야 합니다';
  end if;
  insert into public.staff_settings (id, staff_code_hash)
  values (1, extensions.crypt(btrim(p_code), extensions.gen_salt('bf', 8)))
  on conflict (id) do update set staff_code_hash = excluded.staff_code_hash;
  return 'ok';
end;
$$;

create or replace function public._staff_ok(p_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select staff_code_hash into v_hash from public.staff_settings where id = 1;
  if v_hash is null or p_code is null then
    -- 코드가 없을 때도 해시 계산을 해 응답 시간을 맞춘다
    perform extensions.crypt(coalesce(p_code, ''), extensions.gen_salt('bf', 8));
    return false;
  end if;
  return extensions.crypt(btrim(p_code), v_hash) = v_hash;
end;
$$;

-- 운영진: 토론 기록 저장(초안 또는 게시)
-- 결과: ok | bad_code | not_found | too_short | too_long | invalid | limit
create or replace function public.save_discussion(
  p_code text,
  p_seminar_id text,
  p_text text,
  p_keywords jsonb,
  p_summary text,
  p_questions jsonb,
  p_quotes jsonb,
  p_publish boolean,
  p_request_ai boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
begin
  if not public._staff_ok(p_code) then
    return 'bad_code';
  end if;
  if (select count(*) from public.discussion_saves where saved_at > now() - interval '1 day') >= 50 then
    return 'limit';
  end if;
  if not exists (select 1 from public.seminars where id = p_seminar_id) then
    return 'not_found';
  end if;
  if char_length(v_text) < 200 then
    return 'too_short';
  end if;
  if char_length(v_text) > 60000 then
    return 'too_long';
  end if;
  if jsonb_typeof(coalesce(p_keywords, '[]')) <> 'array' or jsonb_array_length(coalesce(p_keywords, '[]')) > 40
     or jsonb_typeof(coalesce(p_questions, '[]')) <> 'array' or jsonb_array_length(coalesce(p_questions, '[]')) > 10
     or jsonb_typeof(coalesce(p_quotes, '[]')) <> 'array' or jsonb_array_length(coalesce(p_quotes, '[]')) > 10
     or char_length(coalesce(p_summary, '')) > 2000 then
    return 'invalid';
  end if;

  insert into public.discussion_saves default values;

  insert into public.discussions as d
    (seminar_id, source_text, keywords, summary, questions, quotes, status, ai_status, published_at)
  values (
    p_seminar_id, v_text, coalesce(p_keywords, '[]'), btrim(coalesce(p_summary, '')),
    coalesce(p_questions, '[]'), coalesce(p_quotes, '[]'),
    -- AI 정리를 요청하면 운영진이 결과를 확인할 때까지 초안으로 둔다
    case when p_publish and not p_request_ai then 'published' else 'draft' end,
    case when p_request_ai then 'requested' else 'none' end,
    case when p_publish and not p_request_ai then now() end
  )
  on conflict (seminar_id) do update set
    source_text = excluded.source_text,
    keywords = excluded.keywords,
    summary = excluded.summary,
    questions = excluded.questions,
    quotes = excluded.quotes,
    status = excluded.status,  -- AI 요청 시에는 초안
    ai_status = case when p_request_ai then 'requested' else d.ai_status end,
    updated_at = now(),
    published_at = case when p_publish and not p_request_ai then coalesce(d.published_at, now()) else null end;
  return 'ok';
end;
$$;

-- 운영진: 저장된 기록 불러오기(초안 포함, 원문 포함). 코드가 틀리면 null
create or replace function public.get_discussion_for_staff(p_code text, p_seminar_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not public._staff_ok(p_code) then
    return jsonb_build_object('status', 'bad_code');
  end if;
  select jsonb_build_object(
    'status', 'ok', 'seminarId', seminar_id, 'text', source_text, 'keywords', keywords,
    'summary', summary, 'questions', questions, 'quotes', quotes,
    'state', status, 'aiStatus', ai_status, 'aiNote', ai_note, 'updatedAt', updated_at)
  into v
  from public.discussions where seminar_id = p_seminar_id;
  return coalesce(v, jsonb_build_object('status', 'empty'));
end;
$$;

-- 누구나: 게시된 토론 기록(원문 제외)
create or replace function public.published_discussions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'seminarId', d.seminar_id, 'title', s.title, 'startsAt', s.starts_at,
    'keywords', d.keywords, 'summary', d.summary, 'questions', d.questions,
    'quotes', d.quotes, 'publishedAt', d.published_at
  ) order by s.starts_at desc), '[]')
  from public.discussions d
  join public.seminars s on s.id = d.seminar_id
  where d.status = 'published';
$$;

-- 권한: 공개 함수만 anon에 연다. set_staff_code·_staff_ok는 열지 않는다.
revoke all on function public.set_staff_code(text) from public, anon, authenticated;
revoke all on function public._staff_ok(text) from public, anon, authenticated;
revoke all on function public.save_discussion(text, text, text, jsonb, text, jsonb, jsonb, boolean, boolean) from public, anon, authenticated;
revoke all on function public.get_discussion_for_staff(text, text) from public, anon, authenticated;
revoke all on function public.published_discussions() from public, anon, authenticated;

grant execute on function public.save_discussion(text, text, text, jsonb, text, jsonb, jsonb, boolean, boolean) to anon;
grant execute on function public.get_discussion_for_staff(text, text) to anon;
grant execute on function public.published_discussions() to anon;

notify pgrst, 'reload schema';

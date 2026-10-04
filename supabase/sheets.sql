-- 읽고, 잇다 — Google 시트 직접 연동 (schema.sql 다음에 실행)
--
-- 흐름: 운영진이 시트 수정 → 시트의 '웹에 게시'(CSV) → 이 함수들이 최대 1분 간격으로 읽어 옴 → 사이트 표시
-- GitHub Actions 없이 동작한다. 세미나 신청(reserve)도 같은 일정을 바로 쓴다.
--
-- 적용: SQL Editor에 전체를 붙여 넣고 Run. 여러 번 실행해도 된다.
-- 시트 주소 등록(웹에 게시 CSV 주소, 또는 링크 공유 시트의 export 주소):
--   insert into public.sheet_sources (kind, csv_url) values
--     ('books',    'https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv'),
--     ('seminars', 'https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv')
--   on conflict (kind) do update set csv_url = excluded.csv_url;
--
-- 개인정보: 게시하는 탭에는 공개 정보만 둔다(도서 목록, 사이트 연동). '대출 기록' 탭은 게시하지 않는다.
-- 그래도 아래 COLUMNS에 있는 열만 꺼내 쓰므로, 게시한 탭에 다른 열이 있어도 사이트로 나가지 않는다.

create extension if not exists http with schema extensions;

-- ── 표 ──────────────────────────────────────────────

create table if not exists public.sheet_sources (
  kind    text primary key check (kind in ('seminars', 'books')),
  -- 서버가 아무 주소나 부르지 않도록 구글 시트 CSV 주소 형식만 허용
  --  · 웹에 게시: https://docs.google.com/spreadsheets/d/e/…/pub?…output=csv
  --  · 링크 공유 시트: https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<탭 번호>
  csv_url text not null check (
    csv_url ~ '^https://docs\.google\.com/spreadsheets/d/e/[A-Za-z0-9_-]+/pub\?'
    or csv_url ~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{20,}/export\?format=csv(&gid=[0-9]+)?$'
  )
);

create table if not exists public.sheet_cache (
  kind       text primary key,
  fetched_at timestamptz not null,
  rows       jsonb not null
);

alter table public.sheet_sources enable row level security;
alter table public.sheet_cache enable row level security;
revoke all on table public.sheet_sources from anon, authenticated;
revoke all on table public.sheet_cache from anon, authenticated;

-- ── 도우미 함수 ─────────────────────────────────────

-- CSV 글자 → [[칸, 칸, …], …]. 따옴표 안의 쉼표·줄바꿈, "" 이스케이프를 처리한다.
create or replace function public._csv_rows(p text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  ch     text[] := regexp_split_to_array(coalesce(p, ''), '');
  n      integer := coalesce(array_length(ch, 1), 0);
  i      integer := 1;
  c      text;
  inq    boolean := false;
  field  text := '';
  rec    text[] := '{}';
  result jsonb := '[]';
begin
  while i <= n loop
    c := ch[i];
    if inq then
      if c = '"' then
        if i < n and ch[i + 1] = '"' then
          field := field || '"';
          i := i + 1;
        else
          inq := false;
        end if;
      else
        field := field || c;
      end if;
    elsif c = '"' then
      inq := true;
    elsif c = ',' then
      rec := rec || field;
      field := '';
    elsif c = E'\n' then
      rec := rec || field;
      result := result || jsonb_build_array(to_jsonb(rec));
      rec := '{}';
      field := '';
    elsif c <> E'\r' then
      field := field || c;
    end if;
    i := i + 1;
  end loop;
  if field <> '' or coalesce(array_length(rec, 1), 0) > 0 then
    rec := rec || field;
    result := result || jsonb_build_array(to_jsonb(rec));
  end if;
  return result;
end;
$$;

-- '2026-10-08', '2026. 10. 8', '2026/10/8' (+ '18:00', '오후 6:00', '오후 6:00:00') → 한국시간 시각
-- 시간이 없으면 p_default_time. 해석할 수 없으면 null.
create or replace function public._kst_time(p text, p_default_time text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[];
  h integer;
  mi integer;
begin
  m := regexp_match(
    btrim(coalesce(p, '')),
    '^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?(?:\s*\([^)]*\))?(?:\s+(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?)?$'
  );
  if m is null then
    -- 연도 없는 날짜: '9/7 (월)', '10/8', '10/8 (목) 19:00'
    m := regexp_match(
      btrim(coalesce(p, '')),
      '^(\d{1,2})\s*/\s*(\d{1,2})(?:\s*\([^)]*\))?(?:\s+(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?)?$'
    );
    if m is null then
      return null;
    end if;
    declare
      y integer := extract(year from now() at time zone 'Asia/Seoul')::integer;
      d date;
    begin
      d := make_date(y, m[1]::integer, m[2]::integer);
      if d < (now() at time zone 'Asia/Seoul')::date - 183 then
        y := y + 1;
      elsif d > (now() at time zone 'Asia/Seoul')::date + 183 then
        y := y - 1;
      end if;
      m := array[y::text, m[1], m[2], m[3], m[4], m[5]];
    end;
  end if;
  if m[5] is not null then
    h := m[5]::integer;
    mi := m[6]::integer;
    if m[4] = '오후' and h < 12 then h := h + 12; end if;
    if m[4] = '오전' and h = 12 then h := 0; end if;
  elsif p_default_time is not null then
    h := split_part(p_default_time, ':', 1)::integer;
    mi := split_part(p_default_time, ':', 2)::integer;
  else
    h := 0;
    mi := 0;
  end if;
  return make_timestamptz(m[1]::integer, m[2]::integer, m[3]::integer, h, mi, 0, 'Asia/Seoul');
exception
  when others then
    return null; -- 2월 30일, 25시 같은 값
end;
$$;

-- 게시된 CSV를 받아 온다. 구글은 다른 주소로 넘겨주므로(30x) 직접 따라간다.
create or replace function public._fetch_csv(p_url text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_url  text := p_url;
  v_resp extensions.http_response;
  v_loc  text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');
  for hop in 1..4 loop
    v_resp := extensions.http_get(v_url);
    if v_resp.status = 200 then
      return v_resp.content;
    end if;
    if v_resp.status between 300 and 399 then
      select h.value into v_loc
      from unnest(v_resp.headers) as h
      where lower(h.field) = 'location'
      limit 1;
      if v_loc is null then
        return null;
      end if;
      v_url := v_loc;
    else
      return null;
    end if;
  end loop;
  return null;
end;
$$;

-- 시트를 다시 읽어 sheet_cache(및 세미나는 seminars 표)에 반영한다.
-- 마지막으로 읽은 지 1분이 안 됐으면 건너뛴다. 실패하면 이전 값을 그대로 둔다.
--
-- 세미나 시트는 두 형식을 읽는다.
--  · 동아리 기존 형식(주간세미나 시트1): 주차 (기간) | 발제 날짜 (월/일 요일) | 작가 및 작품명 | 발제자 | 비고
--    - 세미나 ID는 날짜로 만든다(예: 2026-10-07). 행 순서를 바꿔도 같은 세미나로 본다.
--    - 날짜가 하루짜리가 아닌 행(휴회 기간), 작품이 빈 행은 건너뛴다. 작품이 있으면 게시로 본다.
--    - '작가 - 작품'은 '작가 『작품』'으로 보여 준다.
--  · 정리된 형식: 세미나 ID | 작가 및 작품명 | 개최 일시 | 발제자 | 장소 | 정원 | 게시 상태 | 발제문 URL | 공개 안내
-- 머리행은 '작가 및 작품명'(세미나) 또는 '관리번호'(도서)가 있는 첫 행이다. 그 위의 안내 문구 행은 무시한다.
create or replace function public._refresh_sheet(p_kind text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_url     text;
  v_cached  timestamptz;
  v_csv     text;
  v_grid    jsonb;
  v_hrow    integer;
  v_header  text[];
  v_rows    jsonb := '[]';
  v_row     jsonb;
  v_cells   text[];
  v_cols    text[];
  v_col     text;
  v_obj     jsonb;
  v_idx     integer;
  v_id      text;
  v_title   text;
  v_when    text;
  v_start   timestamptz;
  v_status  text;
  v_cap     integer;
  v_seen    text[] := '{}';
  v_key     text := case p_kind when 'books' then '관리번호' else '작가 및 작품명' end;
begin
  select csv_url into v_url from public.sheet_sources where kind = p_kind;
  if v_url is null then
    return;
  end if;

  select fetched_at into v_cached from public.sheet_cache where kind = p_kind;
  if v_cached is not null and v_cached > now() - interval '1 minute' then
    return;
  end if;

  -- 여러 방문자가 동시에 와도 한 번만 읽는다. 다른 요청은 이전 값을 쓴다.
  if not pg_try_advisory_xact_lock(hashtext('ilgo-itda-sheet:' || p_kind)) then
    return;
  end if;

  begin
    v_csv := public._fetch_csv(v_url);
  exception
    when others then
      v_csv := null;
  end;
  if v_csv is null or btrim(v_csv) like '<%' then
    return; -- 받아 오지 못함(공유·게시 해제 등). 이전 값 유지
  end if;

  v_grid := public._csv_rows(v_csv);

  -- 머리행 찾기
  select t.ord::integer into v_hrow
  from jsonb_array_elements(v_grid) with ordinality as t(value, ord)
  where exists (select 1 from jsonb_array_elements_text(t.value) as x where btrim(x) = v_key)
  order by t.ord
  limit 1;
  if v_hrow is null then
    return; -- 필요한 머리행이 없음. 이전 값 유지
  end if;
  -- '발제 날짜 (월/일 요일)'처럼 괄호 설명이 붙은 머리행은 괄호 앞까지만 이름으로 쓴다
  select array_agg(btrim(regexp_replace(x, '\s*\(.*$', '')) order by o)
  into v_header
  from jsonb_array_elements_text(v_grid -> (v_hrow - 1)) with ordinality as h(x, o);

  v_cols := case p_kind
    when 'books' then array['관리번호', '전집 권번호', '제목', '작가', '번역자', 'ISBN', '상태', '반납 예정일']
    else array['세미나 ID', '작가 및 작품명', '개최 일시', '발제 날짜', '발제자', '장소', '정원', '게시 상태', '발제문 URL', '공개 안내', '비고']
  end;

  for v_row in
    select value from jsonb_array_elements(v_grid) with ordinality as t(value, ord) where ord > v_hrow order by ord
  loop
    -- 필요한 열만 꺼낸다. 여기에 없는 열은 읽지 않는다.
    v_obj := '{}';
    foreach v_col in array v_cols loop
      v_idx := array_position(v_header, v_col);
      v_obj := v_obj || jsonb_build_object(
        v_col, btrim(coalesce(case when v_idx is null then '' else v_row ->> (v_idx - 1) end, ''))
      );
    end loop;

    if p_kind = 'books' then
      if v_obj ->> '관리번호' <> '' and v_obj ->> '제목' <> '' then
        v_rows := v_rows || jsonb_build_array(v_obj - '세미나 ID');
      end if;
      continue;
    end if;

    -- ── 세미나 ──
    v_title := v_obj ->> '작가 및 작품명';
    v_when := coalesce(nullif(v_obj ->> '개최 일시', ''), v_obj ->> '발제 날짜');
    if v_title = '' or v_when = '' then
      continue;
    end if;
    v_start := public._kst_time(v_when, '18:00');
    if v_start is null then
      continue; -- '10/12 ~ 10/19' 같은 기간, 해석할 수 없는 날짜
    end if;

    if array_position(v_header, '세미나 ID') is not null then
      v_id := v_obj ->> '세미나 ID';
      v_status := case v_obj ->> '게시 상태'
        when '게시' then 'published' when '취소' then 'cancelled' when '초안' then 'draft' when '' then 'draft' end;
    else
      -- 기존 형식: 날짜가 ID, 작품이 적혀 있으면 게시
      v_id := to_char(v_start at time zone 'Asia/Seoul', 'YYYY-MM-DD');
      v_status := 'published';
      -- 'A - B' → 'A 『B』'
      if v_title ~ '^.+\s+-\s+.+$' then
        v_title := regexp_replace(v_title, '^(.+?)\s+-\s+(.+)$', '\1 『\2』');
      end if;
    end if;
    v_cap := case when v_obj ->> '정원' = '' then 11 when (v_obj ->> '정원') ~ '^\d{1,3}$' then (v_obj ->> '정원')::integer end;
    if v_id = '' or v_status is null or v_cap is null or v_cap not between 2 and 100 then
      continue;
    end if;
    if v_id = any (v_seen) then
      continue; -- 같은 날짜(ID)가 두 번이면 첫 행만
    end if;
    v_seen := v_seen || v_id;

    -- 신청 서버가 아는 일정도 함께 고친다(초안 포함: 게시했다가 초안으로 돌린 세미나의 신청을 막기 위해)
    insert into public.seminars (id, title, starts_at, capacity, status, updated_at)
    values (v_id, v_title, v_start, v_cap, v_status, now())
    on conflict (id) do update
      set title = excluded.title, starts_at = excluded.starts_at, capacity = excluded.capacity,
          status = excluded.status, updated_at = now();

    if v_status <> 'draft' then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'id', v_id,
        'title', v_title,
        'presenter', v_obj ->> '발제자',
        'startsAt', to_char(v_start at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'),
        'place', coalesce(nullif(v_obj ->> '장소', ''), '동아리방'),
        'capacity', v_cap,
        'status', v_status,
        'docUrl', case when (v_obj ->> '발제문 URL') ~ '^https://\S+$' then v_obj ->> '발제문 URL' end,
        'note', coalesce(nullif(v_obj ->> '공개 안내', ''), v_obj ->> '비고')
      ));
    end if;
  end loop;

  insert into public.sheet_cache (kind, fetched_at, rows)
  values (p_kind, now(), v_rows)
  on conflict (kind) do update set fetched_at = excluded.fetched_at, rows = excluded.rows;
end;
$$;

-- ── 공개 함수 ───────────────────────────────────────

-- 사이트가 부르는 함수. 결과: { status: 'ok' | 'not_configured' | 'error', fetchedAt, rows }
-- p_fresh = false 이면 저장된 값을 바로 돌려준다(빠름). 저장된 값이 없을 때만 시트를 읽는다.
-- p_fresh = true 이면 1분이 지났을 때 시트를 다시 읽고 돌려준다(몇 초 걸릴 수 있음).
-- 사이트는 false로 먼저 그리고, true로 한 번 더 불러 바뀐 게 있으면 다시 그린다.
drop function if exists public.sheet_rows(text);
create or replace function public.sheet_rows(p_kind text, p_fresh boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cache public.sheet_cache%rowtype;
begin
  if p_kind not in ('seminars', 'books') then
    return jsonb_build_object('status', 'error');
  end if;
  if not exists (select 1 from public.sheet_sources where kind = p_kind) then
    return jsonb_build_object('status', 'not_configured');
  end if;
  if p_fresh or not exists (select 1 from public.sheet_cache where kind = p_kind) then
    perform public._refresh_sheet(p_kind);
  end if;
  select * into v_cache from public.sheet_cache where kind = p_kind;
  if not found then
    return jsonb_build_object('status', 'error');
  end if;
  return jsonb_build_object('status', 'ok', 'fetchedAt', v_cache.fetched_at, 'rows', v_cache.rows);
end;
$$;

-- 신청·취소 전에 일정을 최신으로 맞춘다(최대 1분 간격). schema.sql의 함수를 감싼다.
create or replace function public.reserve_from_sheet(p_seminar_id text, p_name text, p_pin text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.sheet_sources where kind = 'seminars') then
    perform public._refresh_sheet('seminars');
  end if;
  return public.reserve(p_seminar_id, p_name, p_pin);
end;
$$;

create or replace function public.cancel_from_sheet(p_seminar_id text, p_name text, p_pin text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.sheet_sources where kind = 'seminars') then
    perform public._refresh_sheet('seminars');
  end if;
  return public.cancel_reservation(p_seminar_id, p_name, p_pin);
end;
$$;

-- 권한: 도우미 함수는 아무도 직접 부를 수 없고, 공개 함수만 anon에 연다.
revoke all on function public._csv_rows(text) from public, anon, authenticated;
revoke all on function public._kst_time(text, text) from public, anon, authenticated;
revoke all on function public._fetch_csv(text) from public, anon, authenticated;
revoke all on function public._refresh_sheet(text) from public, anon, authenticated;
revoke all on function public.sheet_rows(text, boolean) from public, anon, authenticated;
revoke all on function public.reserve_from_sheet(text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_from_sheet(text, text, text) from public, anon, authenticated;

grant execute on function public.sheet_rows(text, boolean) to anon;
grant execute on function public.reserve_from_sheet(text, text, text) to anon;
grant execute on function public.cancel_from_sheet(text, text, text) to anon;

-- 점검용 세미나 (scripts/check-supabase.mjs가 사용)
-- 1) 점검 전: 이 파일의 [준비] 부분을 SQL Editor에서 실행. 여러 번 실행해도 처음 상태로 돌아간다.
-- 2) 점검 후: [정리] 부분의 주석을 풀고 실행해 점검용 데이터를 모두 지운다.
-- ID가 'zz-test-'로 시작하는 행만 다룬다. 실제 세미나·신청에는 손대지 않는다.

-- [준비]
delete from public.reservations where seminar_id like 'zz-test-%';
insert into public.seminars (id, title, starts_at, capacity, status) values
  ('zz-test-open',    '점검용 · 접수 중',  now() + interval '7 days', 11, 'published'),
  ('zz-test-race',    '점검용 · 동시 신청', now() + interval '7 days', 11, 'published'),
  ('zz-test-started', '점검용 · 이미 시작', now() - interval '1 hour', 11, 'published'),
  ('zz-test-draft',   '점검용 · 초안',     now() + interval '7 days', 11, 'draft')
on conflict (id) do update
  set title = excluded.title, starts_at = excluded.starts_at,
      capacity = excluded.capacity, status = excluded.status, updated_at = now();

-- [정리]
-- delete from public.reservations where seminar_id like 'zz-test-%';
-- delete from public.seminars where id like 'zz-test-%';

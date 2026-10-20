// Supabase 접속 정보. 공개용(anon) 키만 넣는다. 관리용(service_role) 키는 절대 넣지 않는다.
// 비어 있으면: 내 컴퓨터(localhost)에서는 가짜 응답으로 동작하고, 배포된 사이트에서는 신청을 막는다.
export const SUPABASE_URL = 'https://sgdwvwkwawcclujacdln.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_pQ5hdUjSmWUuKBxSmI5WOA_5Hs2n3xA';

// 토론 서버 스키마와 운영진 코드 설정 후 true로 바꿉니다.
export const DISCUSSIONS_ENABLED = false;

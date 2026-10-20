// 서버 주소: 구글 시트에 붙은 Apps Script 웹 앱(apps-script/Code.gs)을 배포하고 나온 주소를 넣는다.
// 예: 'https://script.google.com/macros/s/…/exec'
// 비밀값이 아니다(누구나 사이트 코드에서 볼 수 있다). 비밀번호·키는 절대 여기에 넣지 않는다.
// 비어 있으면: 내 컴퓨터(localhost)에서는 가짜 응답으로 동작하고,
// 배포된 사이트에서는 시트를 직접 읽어 일정만 보여 주며 신청·온라인 저장은 막는다.
export const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbytQ_nsPLZDbGlWWj8VUQKZd79e-NwpDYcMMPy55V0mheealqZbhd5DaaZxpQkM-2my8w/exec';

// 온라인 토론 기록(저장·게시)은 서버가 연결되면 켜진다.
export const DISCUSSIONS_ENABLED = Boolean(APPS_SCRIPT_URL);

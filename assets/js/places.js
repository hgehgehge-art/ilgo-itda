// 독서 지도: 구글 시트 '독서 지도' 탭의 공개 장소를 지도(Leaflet + OpenStreetMap, 키 없음)와 목록으로 보여 준다.
// 회원 추천은 서버가 '검토 대기'로 저장하고, 운영진이 시트에서 '게시'로 바꾸면 지도에 올라간다.
// 서버가 연결되기 전에는 data/places.json을 보여 주고, 추천은 파일로 내려받는다.

import { mode, getPlaces, suggestPlace } from './reservations-api.js';

const $ = (id) => document.getElementById(id);
const online = mode === 'live' || mode === 'mock';
const HUFS = [37.5972, 127.0587]; // 처음 지도 가운데(한국외대 서울캠퍼스 근처)

let places = [];
let map = null;
const markers = new Map();

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function safeNaver(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^(naver\.me|map\.naver\.com|m\.place\.naver\.com|place\.map\.naver\.com)$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

// data/places.json(이전 형식)도 같은 모양으로 맞춘다
function normalize(p, i) {
  const lat = Number(p.lat ?? p.latitude);
  const lng = Number(p.lng ?? p.longitude);
  return {
    id: p.id ?? `L-${i}`,
    name: String(p.name ?? ''),
    category: p.category ?? '모임 장소',
    address: String(p.address ?? ''),
    lat: Number.isFinite(lat) && Math.abs(lat) <= 90 && (p.lat ?? p.latitude) != null ? lat : null,
    lng: Number.isFinite(lng) && Math.abs(lng) <= 180 && (p.lng ?? p.longitude) != null ? lng : null,
    book: /^\d{1,3}$/.test(String(p.book ?? '')) ? Number(p.book) : null,
    memo: p.memo ?? p.note ?? '',
    naverUrl: safeNaver(p.naverUrl ?? p.url ?? ''),
    source: p.source === '회원 추천' ? '회원 추천' : '운영진',
    recommender: p.recommender ?? '',
  };
}

// ── 지도 ──
function ensureMap() {
  if (map) return map;
  if (!window.L) {
    $('map-note').textContent = '지도를 불러오지 못했어요. 아래 목록은 그대로 볼 수 있어요.';
    return null;
  }
  map = L.map('place-map', { scrollWheelZoom: false }).setView(HUFS, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자',
  }).addTo(map);
  return map;
}

function popupContent(p) {
  const box = el('div', { class: 'map-popup' });
  box.append(el('strong', {}, p.name), el('span', {}, ` · ${p.category}`), el('br'), el('span', {}, p.address));
  if (p.memo) box.append(el('p', {}, p.memo));
  return box;
}

function drawMarkers(rows) {
  const m = ensureMap();
  if (!m) return;
  markers.forEach((mk) => mk.remove());
  markers.clear();
  const pins = rows.filter((p) => p.lat != null && p.lng != null);
  for (const p of pins) {
    const mk = L.marker([p.lat, p.lng], { title: p.name, alt: `${p.name} 위치` }).addTo(m).bindPopup(popupContent(p));
    markers.set(p.id, mk);
  }
  if (pins.length) m.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng])).pad(0.2), { maxZoom: 15 });
  const noPin = rows.length - pins.length;
  $('map-note').textContent = pins.length
    ? `지도에 ${pins.length}곳을 표시했어요.${noPin ? ` 좌표를 아직 찾지 못한 ${noPin}곳은 목록에만 있어요.` : ''}`
    : '지도에 표시할 장소가 아직 없어요.';
}

function showOnMap(p) {
  const box = $('map-box');
  box.open = true;
  const m = ensureMap();
  if (!m) return;
  setTimeout(() => {
    m.invalidateSize();
    m.setView([p.lat, p.lng], 16);
    markers.get(p.id)?.openPopup();
    $('place-map').focus?.();
  }, 50);
}

// ── 목록 ──
function card(p) {
  const c = el('article', { class: 'place' });
  const top = el('p', { class: 'place-top' });
  top.append(el('span', { class: 'state state--open' }, p.category));
  if (p.source === '회원 추천') top.append(el('span', { class: 'state' }, '회원 추천'));
  c.append(top, el('h3', { class: 'place-name' }, p.name), el('p', { class: 'place-address' }, p.address));
  if (p.memo) c.append(el('p', { class: 'place-memo' }, p.memo));
  const links = el('p', { class: 'place-links' });
  if (p.book) {
    links.append(el('a', { href: `books.html?q=${p.book}`, class: 'link-arrow' }, `관련 책 ${p.book}권`));
  }
  if (p.lat != null) {
    const b = el('button', { type: 'button', class: 'linklike' }, '지도에서 보기');
    b.addEventListener('click', () => showOnMap(p));
    links.append(b);
  }
  if (p.naverUrl) links.append(el('a', { href: p.naverUrl, target: '_blank', rel: 'noopener noreferrer', class: 'link-arrow' }, '네이버 지도에서 보기'));
  if (links.childNodes.length) c.append(links);
  if (p.recommender) c.append(el('p', { class: 'hint' }, `추천 · ${p.recommender}`));
  return c;
}

function render() {
  const q = $('place-query').value.trim().toLowerCase();
  const cat = $('place-category').value;
  const memberOnly = $('place-member').checked;
  const rows = places.filter(
    (p) =>
      (!cat || p.category === cat) &&
      (!memberOnly || p.source === '회원 추천') &&
      [p.name, p.address, p.memo].join(' ').toLowerCase().includes(q),
  );
  $('place-list').replaceChildren(...rows.map(card));
  $('place-status').textContent = rows.length
    ? `${rows.length}곳`
    : places.length
      ? '이 조건에는 아직 장소가 없어요. 검색어나 분류를 바꿔 보거나 첫 장소를 추천해 주세요.'
      : '아직 등록된 장소가 없어요. 아래에서 첫 장소를 추천해 주세요.';
  drawMarkers(rows);
}

async function load() {
  $('place-status').textContent = '장소를 불러오는 중…';
  $('place-retry').hidden = true;
  try {
    let list;
    if (mode === 'live') {
      list = (await getPlaces()).places;
    } else {
      const r = await fetch('data/places.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      list = (d.places ?? []).filter((p) => !p.status || p.status === 'published');
      $('place-offline').hidden = mode === 'mock';
    }
    places = list.map(normalize).filter((p) => p.name && p.address);
    render();
  } catch {
    $('place-status').textContent = '장소를 불러오지 못했어요. 연결을 확인하고 다시 불러와 주세요.';
    $('place-retry').hidden = false;
  }
}

// ── 추천 ──
const MESSAGES = {
  ok: '추천 고마워요! 운영진 확인 후 지도에 올라가요.',
  missing: '장소 이름·주소·추천 이유를 모두 적어 주세요.',
  invalid_category: '분류를 다시 골라 주세요.',
  too_long: '글자 수를 줄여 주세요(이름 50자, 주소 120자, 이유 100자, 이름 표시 20자).',
  invalid_book: '관련 책은 전집 권번호 숫자만 적어 주세요(예: 44).',
  duplicate: '이미 추천되었거나 등록된 장소예요.',
  limit: '오늘 받을 수 있는 추천 수를 넘었어요. 내일 다시 보내 주세요.',
  error: '보내지 못했어요. 잠시 뒤 다시 시도해 주세요. 입력한 내용은 그대로 있어요.',
};

function formData() {
  return {
    name: $('place-name').value.trim(),
    address: $('place-address').value.trim(),
    category: $('place-type').value,
    reason: $('place-reason').value.trim(),
    book: $('place-book').value.trim(),
    naverUrl: $('place-link').value.trim(),
    nickname: $('place-nick').value.trim(),
  };
}

function validate(d) {
  const result = $('place-result');
  for (const [key, id] of [['name', 'place-name'], ['address', 'place-address'], ['reason', 'place-reason']]) {
    if (!d[key]) {
      result.textContent = MESSAGES.missing;
      $(id).focus();
      return false;
    }
  }
  if (d.book && !/^\d{1,3}$/.test(d.book)) {
    result.textContent = MESSAGES.invalid_book;
    $('place-book').focus();
    return false;
  }
  if (d.naverUrl && !safeNaver(d.naverUrl)) {
    result.textContent = 'https://naver.me 또는 https://map.naver.com 장소 링크를 넣어 주세요.';
    $('place-link').focus();
    return false;
  }
  if (!$('place-consent').checked) {
    result.textContent = '공개 장소이고 개인정보가 없는지 확인란에 체크해 주세요.';
    $('place-consent').focus();
    return false;
  }
  return true;
}

$('place-reason').addEventListener('input', () => {
  $('place-reason-count').textContent = `${$('place-reason').value.length}/100`;
});

$('place-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = formData();
  if (!validate(d)) return;
  const result = $('place-result');

  if (!online) {
    // 서버 연결 전: 추천서를 파일로 내려받아 운영진에게 전달
    const blob = new Blob([JSON.stringify({ ...d, status: 'pending', source: '회원 추천' }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'place-suggestion.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    result.textContent = '추천서를 내려받았어요. 운영진에게 파일을 전달해 주세요. 사이트에는 아직 게시되지 않았어요.';
    return;
  }

  const btn = $('place-submit');
  btn.disabled = true;
  result.textContent = '보내는 중…';
  let code;
  try {
    code = await suggestPlace(d);
  } catch {
    code = 'error';
  }
  btn.disabled = false;
  result.textContent = MESSAGES[code] ?? MESSAGES.error;
  if (code === 'ok') {
    $('place-form').reset();
    $('place-reason-count').textContent = '0/100';
  }
});

$('place-filter').addEventListener('submit', (e) => e.preventDefault());
$('place-query').addEventListener('input', render);
$('place-category').addEventListener('change', render);
$('place-member').addEventListener('change', render);
$('place-retry').addEventListener('click', load);
$('map-box').addEventListener('toggle', () => {
  if ($('map-box').open && map) setTimeout(() => map.invalidateSize(), 50);
});
// 넓은 화면에서는 지도를 펼쳐 두고, 휴대전화에서는 목록이 먼저 보이게 접어 둔다
if (window.matchMedia('(min-width: 768px)').matches) $('map-box').open = true;
if (!online) $('place-submit').textContent = '추천서 내려받기';

// Leaflet(defer)이 준비된 뒤 그린다
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
else load();

// 받아쓰기 텍스트에서 자주 나온 낱말을 세어 키워드 후보를 만든다(브라우저에서만, 외부 전송 없음).
// 한국어 형태소 분석기가 아니라 간단한 규칙이다: 조사·어미 일부를 떼고, 흔한 말은 뺀다.
// 결과는 운영진이 고치는 '초안'이다.

// 클로바노트 등의 화자 표시와 시각 표시
const NOISE = [/참석자\s*\d+/g, /화자\s*\d+/g, /\b\d{1,2}:\d{2}(:\d{2})?\b/g];

// 낱말 끝에서 떼어 낼 조사·어미(긴 것부터)
const SUFFIXES = [
  '에서는', '으로는', '에게서', '이라는', '이라고', '이라서', '하고는', '했는데', '했어요', '하는데',
  '에서', '에게', '으로', '라고', '이라', '부터', '까지', '처럼', '보다', '이나', '이랑', '한테',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '랑',
];

// 토론에서 흔하지만 뜻이 적은 말
const STOP = new Set(
  `그리고 그런데 그래서 하지만 그러니까 그냥 진짜 너무 정말 사실 약간 뭔가 이제 근데 아니 맞아 맞아요
  이런 저런 그런 어떤 이거 그거 저거 이게 그게 저게 여기 거기 저기 우리 저희 제가 저는 내가 나는 너는
  생각 생각해 생각이 같아 같아요 같은 있는 없는 있다 없다 있어 없어 있어요 없어요 하는 했다 하면 해서 했어
  그렇 그렇게 이렇게 저렇게 때문 이번 다음 지금 오늘 어제 조금 많이 다시 계속 혹시 아마 그럼 그러면
  그래 그래요 네네 예예 음음 어어 아아 이건 그건 저건 하나 그것 이것 무엇 뭐가 뭐지 정도 부분 경우
  얘기 이야기 말씀 말이 그때 이때 결국 일단 우선 아무튼 어쨌든 하여튼 되게 엄청 완전 그나마 참석자 발제
  거죠 거예요 거야 건데 거고 거든요 거잖아요 했어요 해요 하죠 봐요 봤어요 느꼈어요 같았어요 같습니다 합니다
  했습니다 입니다 있었어요 없었어요 됐어요 되는 되고 된다 같고 같다 보면 보고 봤는데 읽으면서 읽고 읽었는데
  제일 가장 것도 것은 것이 것을 안에서 일을 일은 일이 잖아요 하잖아요 생각했어요 생각해요 느낌이었어요 남았어요
  걸까요 걸까 건가요 거예요 처음에는 나중에는 오늘 저도 저는 그런데 그래서 오히려 결국 아니면 그래도 다음에도 다음에`
    .split(/\s+/)
    .filter(Boolean),
);

function stem(word) {
  for (const s of SUFFIXES) {
    if (word.length > s.length + 1 && word.endsWith(s)) return word.slice(0, -s.length);
  }
  return word;
}

// 결과: [{ word, count }] 많이 나온 순. limit개까지, 2번 이상 나온 낱말만
export function extractKeywords(text, limit = 30) {
  let t = String(text ?? '');
  for (const re of NOISE) t = t.replace(re, ' ');
  const counts = new Map();
  for (const raw of t.match(/[가-힣]{2,}|[A-Za-z]{3,}/g) ?? []) {
    const w = stem(raw.toLowerCase());
    if (w.length < 2 || STOP.has(w) || STOP.has(raw)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

// 워드클라우드: 많이 나온 낱말일수록 크게. 순서는 섞어서 보기 좋게
export function renderCloud(container, keywords, { removable = false, onRemove } = {}) {
  container.replaceChildren();
  if (!keywords.length) return;
  const max = Math.max(...keywords.map((k) => k.count || 1));
  const min = Math.min(...keywords.map((k) => k.count || 1));
  // 가운데에 큰 낱말이 오도록 번갈아 배치
  const sorted = [...keywords].sort((a, b) => (b.count || 1) - (a.count || 1));
  const arranged = [];
  sorted.forEach((k, i) => (i % 2 ? arranged.push(k) : arranged.unshift(k)));
  for (const k of arranged) {
    const ratio = max === min ? 0.5 : ((k.count || 1) - min) / (max - min);
    const chip = document.createElement(removable ? 'button' : 'span');
    chip.className = 'cloud-word';
    chip.style.setProperty('--size', `${(15 + ratio * 25).toFixed(0)}px`);
    chip.style.setProperty('--weight', ratio > 0.5 ? '700' : '500');
    chip.textContent = k.word;
    if (k.count) chip.title = `${k.count}번`;
    if (removable) {
      chip.type = 'button';
      chip.setAttribute('aria-label', `${k.word} 키워드 빼기`);
      chip.addEventListener('click', () => onRemove?.(k.word));
    }
    container.append(chip);
  }
}

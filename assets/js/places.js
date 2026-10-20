const $=id=>document.getElementById(id);
let places=[];
function el(tag,text){const n=document.createElement(tag);if(text)n.textContent=text;return n;}
function safeLink(raw){try{const u=new URL(raw);return u.protocol==='https:' && (u.hostname==='map.naver.com'||u.hostname==='naver.me'||u.hostname==='maps.naver.com')?u.href:null;}catch{return null;}}
function render(){
 const q=$('place-query').value.trim().toLowerCase(), category=$('place-category').value;
 const rows=places.filter(p=>(!category||p.category===category)&&[p.name,p.address,p.note,p.book].join(' ').toLowerCase().includes(q));
 $('place-list').replaceChildren();
 $('place-status').textContent=rows.length?`${rows.length}곳`:(places.length?'조건에 맞는 장소가 없습니다. 검색어나 분류를 바꿔 보세요.':'아직 등록된 장소가 없습니다. 아래에서 첫 장소의 추천서를 만들어 보세요.');
 for(const p of rows){const card=el('article');card.className='discussion';card.append(el('p',p.category),el('h2',p.name),el('p',p.address));if(p.note)card.append(el('p',p.note));if(p.book)card.append(el('p',`관련 책 · ${p.book}`));const link=safeLink(p.url);if(link){const a=el('a','네이버 지도에서 보기 ↗');a.href=link;a.target='_blank';a.rel='noopener noreferrer';card.append(a);}
 if(typeof p.latitude==='number'&&typeof p.longitude==='number'&&Math.abs(p.latitude)<=85&&Math.abs(p.longitude)<=180){const d=el('details');d.append(el('summary','지도 보기'));d.addEventListener('toggle',()=>{if(!d.open||d.querySelector('iframe'))return;const f=el('iframe');f.title=`${p.name} 위치`;f.loading='lazy';f.src=`https://www.openstreetmap.org/export/embed.html?bbox=${p.longitude-.01},${p.latitude-.008},${p.longitude+.01},${p.latitude+.008}&layer=mapnik&marker=${p.latitude},${p.longitude}`;d.append(f);const a=el('a','© OpenStreetMap 기여자');a.href='https://www.openstreetmap.org/copyright';d.append(a);});card.append(d);}
 $('place-list').append(card);}
}
async function load(){ $('place-status').textContent='장소를 불러오는 중…';$('place-retry').hidden=true;try{const r=await fetch('data/places.json',{cache:'no-cache'});if(!r.ok)throw Error();const d=await r.json();if(!Array.isArray(d.places))throw Error();places=d.places.filter(p=>p&&typeof p.name==='string'&&typeof p.address==='string'&&p.status==='published');render();}catch{$('place-status').textContent='장소를 불러오지 못했습니다. 연결을 확인하고 다시 불러오세요.';$('place-retry').hidden=false;}}
$('place-filter').addEventListener('submit',e=>e.preventDefault());$('place-query').addEventListener('input',render);$('place-category').addEventListener('change',render);$('place-retry').addEventListener('click',load);
$('place-form').addEventListener('submit',e=>{e.preventDefault();const result=$('place-result');for(const id of ['place-name','place-address','place-reason']){if(!$(id).value.trim()){result.textContent='장소 이름·주소·추천 이유를 모두 입력해 주세요.';$(id).focus();return;}}
 const raw=$('place-link').value.trim();if(raw&&!safeLink(raw)){result.textContent='https://map.naver.com 또는 https://naver.me 장소 링크를 입력해 주세요.';$('place-link').focus();return;}
 if(!$('place-consent').checked){result.textContent='공개 장소와 개인정보 확인란에 체크해 주세요.';$('place-consent').focus();return;}
 const data={name:$('place-name').value.trim(),address:$('place-address').value.trim(),category:$('place-type').value,note:$('place-reason').value.trim(),book:$('place-book').value.trim(),url:raw,status:'pending',source:'회원 추천'};
 if(places.some(p=>p.name===data.name&&p.address===data.address)){result.textContent='이미 등록된 장소입니다. 목록에서 확인해 주세요.';return;}
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='place-suggestion.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);result.textContent='추천서를 내려받았습니다. 운영진에게 파일을 전달해 주세요. 사이트에는 아직 게시되지 않았습니다.';});
load();

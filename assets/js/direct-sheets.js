// 공개된 일정 시트만 직접 읽는다. 회원 이름은 화면용 데이터에 넣지 않는다.
const SHEET_ID='1bwPGXVdnjBCNRWWnNXhC49HDLsW1zm7hONObszPrUO8';
const SEMESTER_YEAR=2026; // 해당 시트는 26-2학기 원본. 연도가 자동으로 바뀌면 안 된다.
export function parseCSV(text){
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw Error('CSV 형식 오류');if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}return rows;
}
export function parseSeminars(csv){
 const grid=parseCSV(csv);const headerIndex=grid.findIndex(r=>r.some(c=>c.trim()==='작가 및 작품명'));
 if(headerIndex<0)throw Error('일정 머리행 없음');const header=grid[headerIndex].map(c=>c.trim().replace(/\s*\(.*$/,''));
 const idx=k=>header.indexOf(k), val=(r,k)=>idx(k)<0?'':(r[idx(k)]||'').trim();const items=[],seen=new Set();
 for(const row of grid.slice(headerIndex+1)){
 const title=val(row,'작가 및 작품명');const date=val(row,'개최 일시')||val(row,'발제 날짜');if(!title||!date)continue;
 const m=date.match(/^(?:(\d{4})\s*[-./]\s*)?(\d{1,2})\s*[-./]\s*(\d{1,2})\.?\s*(?:\([^)]*\))?\s*(?:(\d{1,2}):(\d{2}))?\s*$/);if(!m)continue;
 const y=Number(m[1]||SEMESTER_YEAR), mo=Number(m[2]),day=Number(m[3]),hour=Number(m[4]||18),minute=Number(m[5]||0);
 const check=new Date(Date.UTC(y,mo-1,day));if(check.getUTCFullYear()!==y||check.getUTCMonth()!==mo-1||check.getUTCDate()!==day||hour>23||minute>59)continue;
 const iso=`${y}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 const structured=idx('세미나 ID')>=0;const id=structured?val(row,'세미나 ID'):iso;
 const status=structured?({'게시':'published','취소':'cancelled'}[val(row,'게시 상태')]):'published';
 if(!id||!status||seen.has(id))continue;seen.add(id);
 const rawCap=val(row,'정원'),cap=rawCap?Number(rawCap):11;if(!Number.isInteger(cap)||cap<2||cap>100)continue;
 // 원본의 발제자·비고는 공개 데이터로 복사하지 않는다. 별도 공개 안내만 사용한다.
 items.push({id,title:title.replace(/^(.+?)\s+-\s+(.+)$/,'$1 『$2』'),startsAt:`${iso}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+09:00`,presenter:'',place:val(row,'장소')||'동아리방',capacity:cap,status,docUrl:/^https:\/\//.test(val(row,'발제문 URL'))?val(row,'발제문 URL'):null,note:val(row,'공개 안내')});
 }
 return items;
}
export async function directSeminars(){
 const url=`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;
 const r=await fetch(url,{signal:AbortSignal.timeout(12000),credentials:'omit'});if(!r.ok)throw Error('시트 응답 오류');
 return {seminars:parseSeminars(await r.text()),syncedAt:new Date().toISOString(),direct:true};
}

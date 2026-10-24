
/* ---------- Config ---------- */
const CFG={PUBLIC:document.documentElement.dataset.public==="true",API:"",DETECT:"/detect",MODELS:"/api/models",HEALTH:"/api/health",
  MAX_BYTES:10*1024*1024,   // M-IN.2 — confirm the agreed maximum
  MAX_SIDE:1280,            // photos are downscaled before upload to protect the 3 s target
  LOW:0.6,                  // M-DC.6 low-confidence threshold
  TIMEOUT:120000,TARGET:3,
  DEMO:new URLSearchParams(location.search).has("demo")};   // open /?demo to try the UI without a backend
const PLACEHOLDER_MODELS=["Printer model 1 (placeholder)","Printer model 2 (placeholder)","Printer model 3 (placeholder)"];
const $=id=>document.getElementById(id), sleep=ms=>new Promise(r=>setTimeout(r,ms));
let working=false;
let S={file:null,prep:null,parts:[],sel:0,base:null,model:"",secs:0,version:"",record:""};
const PARTS=[["5PN77-67001","5PN77A","HP LaserJet Fuser 220V Kit"],["W9078-67001","W9078MC","HP LaserJet CYM Managed Imaging Drum"],["W9077-67001","W9077MC","HP LaserJet Black Managed Imaging Drum"],["6SB85-67001","6SB85A","HP LaserJet Toner Collection Unit"],["JC96-13015A","JC96-13015A","Waste toner duct unit"],["5PN66-67001","5PN66A","HP LaserJet Trays 2-x Roller Kit"],["5PN73-67003","5PN73A","HP LaserJet Yellow Developer Unit"],["933853-011","933853-011","Hard disk 500GB SED"],["5RC00-67001","5RC00A","HP LaserJet ADF Maintenance Kit"],["6CF14-67011","6CF14-67011","Main PCA (Formatter)"],["JC97-05149A","JC97-05149A","Laser scanner unit (LSU)"],["5QK42-60104","5QK42-60104","Control panel (10.1 inch)"],["5PN80-67002","5PN80A","T2 transfer assembly"],["JC44-00150C","JC44-00150C","Low Voltage Power Supply (LVPS), 220V"],["JC44-00240C","JC44-00240C","High Voltage Power Supply (HVPS)"],["5QK39-67002","5QK39-67002","HPLJ 300ipm300shtFlw DADFhighspdScnr"],["5QK08-67014","5QK08-67014","ADF Whole Unit Kit, Valiant A3"],["JC44-00236C","JC44-00236C","Fuser drive board (FDB), 220V"],["5QK08-67011","5QK08-67011","SVC-Flat Cable, Faro SICB 50pin"],["5QK08-67012","5QK08-67012","SVC-Flat Cable, Faro SICB 68pin"],["5QK03-50003","5QK03-50003","FLAT CABLE-LSU"],["JC90-01856A","JC90-01856A","Exit unit"],["JC95-02247A","JC95-02247A","Right door assembly"],["6ER04-61001","6ER04-61001","Front cover assembly"],["8GS05-60128","8GS05-60128","Registration unit assembly"],["0604-001381","0604-001381","Registration sensor"],["0604-001490","0604-001490","Feed 2 sensor"],["JC93-01850A","JC93-01850A","Fuser, Exit drive assembly"],["JC31-00123C","JC31-00123C","Drum, ITB motor"],["JC93-01659A","JC93-01659A","Reservoir drive motor"],["3SJ00-60110","None","Tray 3 empty sensor"],["JC93-00336A","None","Duplex 1 motor"],["SS216-80501","None","Toner dispense motor"],["JC31-00078A","None","CPR shutter motor"],["JC31-00198A","None","LVPS fan"],["JC31-00154A","None","FDB fan"],["JC93-01019A","None","LSU fan assembly"],["JC93-01467A","None","Right door switch assembly"],["JC93-00466A","None","Front door switch assembly"],["5QJ90-40002","None","Outer environment sensor assembly"]];   // [SVC part no., Mfg. part no., description] from the 40-part list

/* ---------- Steps / small helpers ---------- */
function step(n){document.querySelectorAll("#steps li").forEach((li,i)=>li.className=i+1<n?"done":i+1===n?"on":"");}
function sync(){step(!$("results").hidden?4:S.file&&$("model").value?3:$("model").value?2:1);}
function banner(kind,text){const d=document.createElement("div");d.className="banner "+kind;d.textContent=text;$("msg").replaceChildren(d);}
function busy(on){working=on;["model","browse","shoot","reset","f1","f2"].forEach(id=>$(id).disabled=on);$("go").disabled=on;$("go").textContent=on?"Analyzing…":"Start recognition";}
function loadImg(src){return new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=src;});}

/* ---------- Init: models, server status, demo flag ---------- */
(async()=>{
  try{
    let models=PLACEHOLDER_MODELS;
    if(CFG.PUBLIC){
      const response=await fetch("./model-parts.json");
      if(!response.ok)throw new Error("Could not load model parts.");
      const data=await response.json();
      PARTS.splice(0,PARTS.length,...data.parts.map(p=>[p.part_number,"",p.description]));
      $("model").replaceChildren(new Option("Recognition server not connected",""));
      return;
    }
    if(!CFG.DEMO){
      const r=await fetch(CFG.API+CFG.MODELS);if(!r.ok)throw new Error("Could not load recognition scopes.");
      models=(await r.json()).models;
      const p=await fetch(CFG.API+"/api/parts");if(!p.ok)throw new Error("Could not load the parts catalogue.");
      const data=await p.json();PARTS.splice(0,PARTS.length,...data.parts.map(p=>[p.part_number,"",p.description]));
    }
    models.forEach(x=>{const o=new Option(x,x);$("model").append(o);});
    if(models.length===1){$("model").value=models[0];sync();}
  }catch(e){banner("err",e.message+" Please restart the server and refresh this page.");}
})();
if(CFG.PUBLIC){
  banner("info","Public preview: browse model parts and the E783 dataset. Photo upload and AI recognition are unavailable because no inference server is connected.");
  ["model","browse","shoot","go","f1","f2"].forEach(id=>$(id).disabled=true);
  $("go").textContent="Recognition unavailable";
  $("dot").className="dot off";$("dot").title="No inference server connected";
}
else if(CFG.DEMO)$("demo").hidden=false;
else fetch(CFG.API+CFG.HEALTH).then(r=>{$("dot").className=r.ok?"dot on":"dot off";}).catch(()=>{$("dot").className="dot off";});
$("model").addEventListener("change",()=>{$("merr").textContent="";sync();});

/* ---------- File selection + validation (M-IN.1-3) ---------- */
$("browse").onclick=()=>$("f1").click();
$("shoot").onclick=()=>$("f2").click();
[$("f1"),$("f2")].forEach(i=>i.onchange=()=>{if(i.files[0])setFile(i.files[0]);});
["dragenter","dragover"].forEach(e=>$("drop").addEventListener(e,ev=>{ev.preventDefault();$("drop").classList.add("drag");}));
["dragleave","drop"].forEach(e=>$("drop").addEventListener(e,ev=>{ev.preventDefault();$("drop").classList.remove("drag");}));
$("drop").addEventListener("drop",e=>{if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0]);});

async function prepare(file){   // downscale + fix phone EXIF rotation by redrawing through a canvas
  const bmp=await createImageBitmap(file),s=Math.min(1,CFG.MAX_SIDE/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas");c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
  c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
  return{canvas:c,blob:await new Promise(r=>c.toBlob(r,"image/jpeg",0.92))};
}
async function setFile(f){
  if(CFG.PUBLIC)return;
  if(working)return;
  $("ferr").textContent="";
  if(!["image/jpeg","image/png"].includes(f.type)){$("ferr").textContent="Unsupported file type. Please upload a JPG or PNG image.";return;}
  if(f.size>CFG.MAX_BYTES){$("ferr").textContent="File is too large. Maximum size is "+CFG.MAX_BYTES/1048576+" MB.";return;}
  try{S.prep=await prepare(f);}catch{$("ferr").textContent="This file could not be read as an image.";return;}
  $("results").hidden=true;S.parts=[];S.file=f;$("pv").src=URL.createObjectURL(f);$("pv").hidden=false;$("dl").textContent=f.name;$("reset").hidden=false;sync();
}

/* ---------- API layer: accepts the unified contract, PV-ML-HPPK and HPSubPick responses ---------- */
function box(b){   // -> [x, y, w, h] top-left, normalized 0-1
  if(Array.isArray(b)){const[cx,cy,w,h]=b;return[cx-w/2,cy-h/2,w,h];}   // xywhn (centre) as stored by PV-ML
  if(b&&"x_pct" in b)return[b.x_pct,b.y_pct,b.w_pct,b.h_pct];            // HPSubPick /boxes
  return null;
}
function fromJson(d){
  const parts=Array.isArray(d.parts)
    ?d.parts.map(p=>({cls:p.class_name||p.cls,num:p.part_number||p.cls,desc:p.description||p.name||"",conf:p.confidence,box:box(p.bbox_norm||p),compat:p.compatibility}))
    :(d.conf||[]).map((c,i)=>({cls:d.cls[i],num:d.cls[i],desc:(d.desc||[])[i]||"",conf:c,box:box((d.bboxes||[])[i])}));
  return{parts,serverImage:d.image?"data:image/jpeg;base64,"+d.image:null,version:d.model_version,record:d.record_id};
}
async function fromHPSubPick(blob){   // /detect returned a JPEG; boxes and part info come from separate calls
  const bx=(await(await fetch(CFG.API+"/boxes")).json()).boxes||[];
  const parts=await Promise.all(bx.map(async x=>{let i={};
    try{i=await(await fetch(CFG.API+"/api/part-info/"+encodeURIComponent(x.class_name))).json();}catch{}
    return{cls:x.class_name,num:i.part_number||x.class_name,desc:i.name||i.description||"",compat:i.compatibility,conf:x.confidence,box:box(x)};}));
  return{parts,serverImage:URL.createObjectURL(blob)};
}
function demo(){return{version:"demo",parts:[
  {cls:"JC97-05149A",num:"JC97-05149A",desc:"Laser scanner unit (LSU)",conf:.93,box:[.08,.1,.38,.3]},
  {cls:"933853-011",num:"933853-011",desc:"Hard disk 500GB SED",conf:.81,box:[.55,.48,.32,.3]},
  {cls:"6CF14-67011",num:"6CF14-67011",desc:"Main PCA (Formatter)",conf:.46,box:[.12,.6,.3,.3]}]};}
async function callApi(blob,name,model){
  if(CFG.PUBLIC)throw new Error("No inference server is connected.");
  if(CFG.DEMO){await sleep(700);return demo();}
  const fd=new FormData();fd.append("file",blob,name);fd.append("printer_model",model);
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),CFG.TIMEOUT);
  try{
    const res=await fetch(CFG.API+CFG.DETECT,{method:"POST",body:fd,signal:ctl.signal});
    const data=await res.json();
    if(!res.ok)throw new Error(typeof data.detail==="string"?data.detail:"The server could not process this image.");
    return fromJson(data);
  }catch(e){
    if(e.name==="AbortError")throw new Error("Recognition timed out. CPU inference may take longer; please retry.");
    throw e;
  }finally{clearTimeout(t);}
}

/* ---------- Run ---------- */
$("go").onclick=async()=>{
  if(working)return;
  $("msg").replaceChildren();$("results").hidden=true;
  if(!$("model").value){$("merr").textContent="Please choose a recognition scope first.";$("model").focus();return;}   // M-ER.1
  if(!S.file){$("ferr").textContent="Please select an image to analyze.";return;}
  busy(true);const t0=performance.now();
  try{const r=await callApi(S.file,S.file.name,$("model").value);S.secs=(performance.now()-t0)/1000;await show(r);}
  catch(e){banner("err",e.message);}   // M-ER.2
  finally{busy(false);sync();}
};
async function show(r){
  S.parts=r.parts.filter(p=>typeof p.conf==="number").sort((a,b)=>b.conf-a.conf);
  S.parts.forEach(p=>{const x=PARTS.find(y=>y[0]===p.num);if(x){p.desc=p.desc||x[2];p.mfg=x[1];}});   // fill specs from the catalogue when the backend sends none
  if(!S.parts.length){banner("info","No printer part was detected in this image. Try a clearer or closer photo, and check the lighting.");return;}   // M-ER.3
  S.base=!S.parts.some(p=>p.box)&&r.serverImage?await loadImg(r.serverImage):S.prep.canvas;   // draw boxes ourselves when we have coordinates
  S.model=$("model").value;S.version=r.version||"";S.record=r.record||"";S.sel=0;
  $("count").textContent=S.parts.length+(S.parts.length===1?" part detected":" parts detected");
  $("meta").textContent=S.model+" · "+S.secs.toFixed(1)+" s"+(S.secs>CFG.TARGET?" (over the "+CFG.TARGET+" s target)":"")+(S.version?" · model "+S.version:"");
  const L=$("list");L.replaceChildren();
  S.parts.forEach((p,i)=>{const row=document.createElement("div"),l=document.createElement("span"),b=document.createElement("b"),s=document.createElement("small"),c=document.createElement("span");
    row.className="part";row.dataset.i=i;b.textContent=p.num;s.textContent=p.desc;l.append(b,s);
    c.textContent=Math.round(p.conf*100)+"%";
    if(p.conf<CFG.LOW){const g=document.createElement("span");g.className="badge";g.textContent="Low confidence";c.prepend(g);}   // M-DC.6
    row.append(l,c);row.onclick=()=>select(i);L.append(row);});
  $("results").hidden=false;zoom(1);select(0);saveHistory();$("results").scrollIntoView({behavior:"smooth",block:"start"});
}

/* ---------- Review: overlay, selection, spec panel (M-IL.2-4) ---------- */
function select(i){
  S.sel=i;document.querySelectorAll(".part").forEach(r=>r.classList.toggle("sel",+r.dataset.i===i));
  const p=S.parts[i],d=$("detail");d.replaceChildren();
  [["Part number",p.num],["Description",p.desc],["Mfg. part number",p.mfg],["Class",p.cls!==p.num?p.cls:""],
   ["Confidence",(p.conf*100).toFixed(1)+"%"+(p.conf<CFG.LOW?" — low, please verify":"")],["Recognition scope",S.model],["Compatible with",(p.compat||[]).join(", ")]]
  .forEach(([k,v])=>{if(!v)return;const r=document.createElement("div"),a=document.createElement("span"),b=document.createElement("span");a.textContent=k;b.textContent=v;r.append(a,b);d.append(r);});
  feedbackUI(d,p);render();
}
function render(){
  const cv=$("cv"),b=S.base,w=b.naturalWidth||b.width,h=b.naturalHeight||b.height;
  cv.width=w;cv.height=h;const g=cv.getContext("2d");g.drawImage(b,0,0,w,h);
  const fs=Math.max(13,w/48);g.font="600 "+fs+"px sans-serif";g.textBaseline="top";
  S.parts.forEach((p,i)=>{if(!p.box)return;const[x,y,bw,bh]=p.box,low=p.conf<CFG.LOW,sel=i===S.sel;
    g.lineWidth=sel?Math.max(4,w/180):Math.max(2,w/320);g.strokeStyle=low?"#E0A100":sel?"#0074C8":"#2BB673";g.setLineDash(low?[fs/1.5,fs/2]:[]);
    g.strokeRect(x*w,y*h,bw*w,bh*h);
    if(sel){const t=p.num+" "+Math.round(p.conf*100)+"%",tw=g.measureText(t).width+10,ty=Math.max(0,y*h-fs-8);
      g.setLineDash([]);g.fillStyle=g.strokeStyle;g.fillRect(x*w,ty,tw,fs+8);g.fillStyle="#fff";g.fillText(t,x*w+5,ty+4);}});
}
$("cv").addEventListener("click",e=>{   // click a box to select it; the smallest box under the cursor wins
  const r=e.target.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;let best=-1,area=9;
  S.parts.forEach((p,i)=>{if(!p.box)return;const[bx,by,bw,bh]=p.box;if(x>=bx&&x<=bx+bw&&y>=by&&y<=by+bh&&bw*bh<area){area=bw*bh;best=i;}});
  if(best>=0)select(best);
});
window.addEventListener("resize",()=>{if(!$("results").hidden)render();});

/* ---------- Export package: annotated.png + results.json + results.csv (M-EX.1-3) ---------- */
$("exp").onclick=async()=>{
  const enc=new TextEncoder(),png=new Uint8Array(await(await new Promise(r=>$("cv").toBlob(r,"image/png"))).arrayBuffer());
  const rows=S.parts.map(p=>({part_number:p.num,class:p.cls,description:p.desc,confidence:+p.conf.toFixed(4),low_confidence:p.conf<CFG.LOW,mfg_part_number:p.mfg||null,user_feedback:p.fb||null,bbox_norm_xywh:p.box?p.box.map(v=>+v.toFixed(4)):null}));
  const q=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  const csv="part_number,class,description,confidence,low_confidence,printer_model\n"+rows.map(r=>[q(r.part_number),q(r.class),q(r.description),r.confidence,r.low_confidence,q(S.model)].join(",")).join("\n");
  const meta={created:new Date().toISOString(),printer_model:S.model,source_file:S.file.name,model_version:S.version||null,record_id:S.record||null,response_seconds:+S.secs.toFixed(2),parts:rows};
  const z=makeZip([{name:"annotated.png",data:png},{name:"results.json",data:enc.encode(JSON.stringify(meta,null,2))},{name:"results.csv",data:enc.encode("\ufeff"+csv)}]);
  const a=document.createElement("a");a.href=URL.createObjectURL(z);a.download="kamero-results.zip";document.body.append(a);a.click();a.remove();step(5);
};
function makeZip(files){   // minimal uncompressed ZIP writer, no libraries needed
  const T=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c>>>0;}
  const crc=d=>{let c=0xFFFFFFFF;for(let i=0;i<d.length;i++)c=T[(c^d[i])&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0;};
  const enc=new TextEncoder(),loc=[],cen=[];let off=0;
  files.forEach(f=>{const nm=enc.encode(f.name),sz=f.data.length,c=crc(f.data),lh=new DataView(new ArrayBuffer(30)),ch=new DataView(new ArrayBuffer(46));
    lh.setUint32(0,0x04034b50,true);lh.setUint16(4,20,true);lh.setUint16(12,33,true);lh.setUint32(14,c,true);lh.setUint32(18,sz,true);lh.setUint32(22,sz,true);lh.setUint16(26,nm.length,true);
    ch.setUint32(0,0x02014b50,true);ch.setUint16(4,20,true);ch.setUint16(6,20,true);ch.setUint16(14,33,true);ch.setUint32(16,c,true);ch.setUint32(20,sz,true);ch.setUint32(24,sz,true);ch.setUint16(28,nm.length,true);ch.setUint32(42,off,true);
    loc.push(new Uint8Array(lh.buffer),nm,f.data);cen.push(new Uint8Array(ch.buffer),nm);off+=30+nm.length+sz;});
  const cs=cen.reduce((s,a)=>s+a.length,0),e=new DataView(new ArrayBuffer(22));
  e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,cs,true);e.setUint32(16,off,true);
  return new Blob([...loc,...cen,new Uint8Array(e.buffer)],{type:"application/zip"});
}

/* ---------- Reset ---------- */
$("reset").onclick=()=>{if(working)return;S.file=S.prep=null;S.parts=[];["f1","f2"].forEach(i=>$(i).value="");$("pv").hidden=true;$("dl").textContent="Drag and drop a printer photo here";
  $("msg").replaceChildren();$("results").hidden=true;$("ferr").textContent=$("merr").textContent="";$("reset").hidden=true;sync();};
/* ---------- Expansion: tabs, catalogue, history, feedback, zoom ---------- */
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("on",x===b));
  ["rec","cat","his","dataset"].forEach(v=>$("v-"+v).hidden=v!==b.dataset.v);
  if(b.dataset.v==="dataset"){
    const frame=$("dataset-frame");
    if(!frame.getAttribute("src"))frame.src=frame.dataset.src;
  }
  if(b.dataset.v==="cat")renderCat();if(b.dataset.v==="his")renderHistory();});
function renderCat(){
  const q=$("q").value.trim().toLowerCase(),L=$("clist"),hit=PARTS.filter(x=>!q||x.join(" ").toLowerCase().includes(q));L.replaceChildren();
  hit.forEach(x=>{const r=document.createElement("div"),b=document.createElement("b"),s=document.createElement("small");r.className="crow";b.textContent=x[0];s.textContent=x[2]+(x[1]?" · Mfg. "+x[1]:"");r.append(b,s);L.append(r);});
  $("cn").textContent=hit.length+" of "+PARTS.length+" parts";}
$("q").oninput=renderCat;
const HK="kamero.history.v1";
function hist(){try{return JSON.parse(localStorage.getItem(HK))||[];}catch{return[];}}
function saveHistory(){   // thumbnail + results only, newest 20, stored in this browser
  const cv=$("cv"),k=160/Math.max(cv.width,cv.height),c=document.createElement("canvas");c.width=Math.round(cv.width*k);c.height=Math.round(cv.height*k);
  c.getContext("2d").drawImage(cv,0,0,c.width,c.height);
  const e={t:Date.now(),model:S.model,file:S.file.name,secs:+S.secs.toFixed(1),img:c.toDataURL("image/jpeg",0.6),parts:S.parts.map(p=>[p.num,p.desc,+p.conf.toFixed(3)])};
  try{localStorage.setItem(HK,JSON.stringify([e,...hist()].slice(0,20)));}catch{}}
function renderHistory(){
  const L=$("hlist"),h=hist();L.replaceChildren();
  if(!h.length){const p=document.createElement("p");p.className="meta";p.textContent="No recognitions yet. Results from this device will appear here.";L.append(p);return;}
  h.forEach(e=>{const r=document.createElement("div"),i=new Image(),t=document.createElement("div"),b=document.createElement("b"),s=document.createElement("small"),u=document.createElement("small");
    r.className="hrow";i.src=e.img;i.alt="";b.textContent=e.file;s.textContent=new Date(e.t).toLocaleString()+" · "+e.model+" · "+e.secs+" s";
    u.textContent=e.parts.map(p=>p[0]+" ("+Math.round(p[2]*100)+"%)").join(", ");t.append(b,s,u);r.append(i,t);L.append(r);});}
$("hclr").onclick=()=>{try{localStorage.removeItem(HK);}catch{}renderHistory();};
function feedbackUI(d,p){   // lets the user flag a wrong detection; the choice is included in the export for retraining review
  const w=document.createElement("div"),sel=document.createElement("select"),note=document.createElement("small");w.className="fb";
  sel.append(new Option("Flag as incorrect — choose the correct part…",""));
  PARTS.forEach(x=>sel.append(new Option(x[0]+" — "+x[2],x[0])));sel.append(new Option("Not a printer part / unknown","none"));
  sel.value=p.fb||"";note.textContent=p.fb?"Saved in the export for review.":"";
  sel.onchange=()=>{p.fb=sel.value||undefined;note.textContent=p.fb?"Saved in the export for review.":"";};
  w.append(sel,note);d.append(w);}
let Z=1;function zoom(z){Z=Math.max(1,Math.min(4,z));$("cv").style.width=Z*100+"%";}
$("zi").onclick=()=>zoom(Z+.5);$("zo").onclick=()=>zoom(Z-.5);$("zr").onclick=()=>zoom(1);
sync();

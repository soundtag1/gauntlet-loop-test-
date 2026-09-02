// Downscale the newest render of each canonical shot to a base64 JPEG.
// Uses a browser canvas because the bundled ffmpeg has no PNG decoder.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const SHOTS='shots';
const labels=fs.readdirSync(SHOTS).filter(d=>{try{return fs.statSync(path.join(SHOTS,d)).isDirectory()}catch{return false}});
const byName=new Map();
for(const l of labels){
  let files=[]; try{ files=fs.readdirSync(path.join(SHOTS,l)); }catch{ continue; }
  for(const f of files){
    if(!f.endsWith('.png')||f==='FAILED.png') continue;
    const full=path.join(SHOTS,l,f);
    let st; try{ st=fs.statSync(full); }catch{ continue; }
    if(st.size<10000) continue;                 // still being written
    const name=f.replace(/\.png$/,'');
    if(!byName.has(name)) byName.set(name,[]);
    byName.get(name).push({url:'/'+full, label:l, mt:st.mtimeMs});
  }
}
for(const arr of byName.values()) arr.sort((a,b)=>b.mt-a.mt);

const b=await chromium.launch({args:['--no-sandbox']});
const p=await b.newPage();
await p.goto('http://127.0.0.1:5177/index.html'); // any same-origin page
const out=[];
for(const [name,cands] of [...byName.entries()].sort()){
  for(const c of cands.slice(0,3)){
    const r=await p.evaluate(async ({url,w})=>{
      try{
        const img=new Image(); img.src=url;
        await img.decode();
        const s=w/img.naturalWidth;
        const cv=document.createElement('canvas');
        cv.width=w; cv.height=Math.round(img.naturalHeight*s);
        cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
        return cv.toDataURL('image/jpeg',0.70).split(',')[1];
      }catch(e){ return null; }
    }, {url:c.url, w:760});
    if(r){ out.push({name,label:c.label,mt:c.mt,b64:r,kb:Math.round(r.length*0.75/1024)}); break; }
  }
}
await b.close();
fs.mkdirSync('progress',{recursive:true});
fs.writeFileSync('progress/thumbs.json',JSON.stringify(out));
console.log(out.map(o=>`${o.name}(${o.label},${o.kb}kb)`).join('\n'));
console.log('TOTAL kb:', out.reduce((a,c)=>a+c.kb,0));

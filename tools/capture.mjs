import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const label = process.argv[2] || 'run';
const specFile = process.argv[3] || 'tools/shots.json';
const W = +(process.env.SHOT_W || 1280), H = +(process.env.SHOT_H || 720);
const outDir = path.join('shots', label);
fs.mkdirSync(outDir, { recursive: true });

const shots = JSON.parse(fs.readFileSync(specFile, 'utf8'));

const browser = await chromium.launch({
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
         '--no-sandbox','--disable-dev-shm-usage','--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport:{ width:W, height:H }, deviceScaleFactor:1 });
const errors=[];
page.on('pageerror', e=>{ errors.push(String(e.message)); });
page.on('console', m=>{ if(m.type()==='error') errors.push('[console] '+m.text()); });

console.log('loading…');
await page.goto('http://127.0.0.1:5177/index.html', { waitUntil:'load', timeout:120000 });
try {
  await page.waitForFunction(()=>window.HARNESS && window.HARNESS.ready, null, { timeout:180000 });
} catch(e){
  console.log('HARNESS NEVER READY');
  console.log('ERRORS:\n' + (errors.join('\n')||'(none)'));
  await page.screenshot({ path: path.join(outDir,'FAILED.png') });
  await browser.close(); process.exit(1);
}
console.log('harness ready. building shots…');

const results=[];
for(const s of shots){
  const t0=Date.now();
  await page.evaluate(([s])=>{
    window.HARNESS.setTime(s.hour);
    window.HARNESS.setCamera(...s.cam, ...s.tgt, s.fov);
  }, [s]);
  // let async work (textures) flush, then settle deterministically
  await page.waitForTimeout(350);
  await page.evaluate(()=>window.HARNESS.settle(4));
  const file=path.join(outDir, s.name+'.png');
  await page.screenshot({ path:file });
  const st=await page.evaluate(()=>window.HARNESS.stats());
  results.push({ ...s, file, ms:Date.now()-t0, ...st });
  console.log(`  ${s.name}  ${Date.now()-t0}ms  calls=${st.calls} tris=${st.tris}`);
}
fs.writeFileSync(path.join(outDir,'manifest.json'), JSON.stringify({label, W,H, errors, results}, null, 2));
if(errors.length) console.log('PAGE ERRORS:\n'+errors.slice(0,20).join('\n'));
console.log('done ->', outDir);
await browser.close();

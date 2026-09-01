import fs from 'node:fs';
const thumbs = JSON.parse(fs.readFileSync('progress/thumbs.json','utf8'));
const S = JSON.parse(fs.readFileSync('progress/status.json','utf8'));

const SHOT_META = {
  '01_dusk_skyline':{t:'Dusk skyline',    h:'19:18'},
  '02_street_dusk' :{t:'Street, dusk',    h:'19:18'},
  '03_night_neon'  :{t:'Neon, night',     h:'21:36'},
  '04_golden_hour' :{t:'Golden hour',     h:'17:36'},
  '05_noon_wide'   :{t:'Midday, wide',    h:'13:00'},
  '06_dawn_low'    :{t:'Dawn, low angle', h:'06:36'},
  '07_downtown_up' :{t:'Downtown, upward','h':'20:24'},
  '08_beach_dusk'  :{t:'Beach, dusk',     h:'19:00'},
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stamp = new Date().toISOString().replace('T',' ').slice(0,16)+' UTC';

const frames = thumbs.map(t=>{
  const m = SHOT_META[t.name] || {t:t.name, h:''};
  return `<figure class="frame">
    <img src="data:image/jpeg;base64,${t.b64}" alt="${esc(m.t)} — rendered frame" loading="lazy">
    <figcaption><span class="fname">${esc(m.t)}</span><span class="fmeta">${esc(m.h)}<i></i>${esc(t.label)}</span></figcaption>
  </figure>`;
}).join('\n');

const agents = S.agents.map(a=>`<li class="agent is-${a.state}">
    <span class="dot" aria-hidden="true"></span>
    <span class="acol"><span class="aname">${esc(a.name)}</span><span class="adetail">${esc(a.detail)}</span></span>
    <code class="ascope">${esc(a.scope)}</code>
    <span class="astate">${esc(a.state)}</span>
  </li>`).join('\n');

const running = S.agents.filter(a=>a.state==='running').length;
const doneN   = S.agents.filter(a=>a.state==='done').length;

const html = `<title>Neon Coast Build Monitor</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ink:#0a0d18; --panel:#121828; --panel-2:#171e31; --edge:#232c45;
  --text:#ccd4e6; --dim:#7b87a5; --faint:#55618087;
  --magenta:#ff2f8e; --cyan:#23e0d5; --amber:#ffcf3f;
  --ok:#3ddc97; --wait:#5b6787;
  --display:"Oswald","Haettenschweiler",Impact,sans-serif;
  --body:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--text);font-family:var(--body);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:34px 22px 72px}

header{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px 26px;
  padding-bottom:20px;border-bottom:1px solid var(--edge)}
h1{font-family:var(--display);font-weight:600;font-size:clamp(34px,6vw,54px);
  letter-spacing:.055em;text-transform:uppercase;margin:0;line-height:.98;
  background:linear-gradient(96deg,var(--magenta),var(--cyan) 62%,var(--amber));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-family:var(--mono);font-size:12px;color:var(--dim);letter-spacing:.06em}
.pulse{margin-left:auto;display:flex;align-items:center;gap:9px;font-family:var(--mono);
  font-size:12px;color:var(--dim);letter-spacing:.05em}
.pulse b{width:8px;height:8px;border-radius:50%;background:var(--cyan);
  box-shadow:0 0 0 0 #23e0d5aa;animation:p 2.4s ease-out infinite}
@keyframes p{0%{box-shadow:0 0 0 0 #23e0d599}70%{box-shadow:0 0 0 11px #23e0d500}100%{box-shadow:0 0 0 0 #23e0d500}}
@media (prefers-reduced-motion:reduce){.pulse b{animation:none}}

.lede{margin:22px 0 0;max-width:66ch;color:var(--text)}
.lede strong{color:#fff;font-weight:600}

h2{font-family:var(--display);font-weight:400;text-transform:uppercase;
  letter-spacing:.14em;font-size:14px;color:var(--dim);margin:44px 0 14px;
  display:flex;align-items:center;gap:12px}
h2::after{content:"";flex:1;height:1px;background:var(--edge)}

/* ---- render gallery: the point of the page ---- */
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(310px,1fr))}
.frame{margin:0;background:var(--panel);border:1px solid var(--edge);overflow:hidden}
.frame img{display:block;width:100%;height:auto;background:#05060c}
figcaption{display:flex;justify-content:space-between;align-items:baseline;
  gap:10px;padding:9px 12px 10px;border-top:1px solid var(--edge)}
.fname{font-weight:600;font-size:13.5px;color:#e6ecf8}
.fmeta{font-family:var(--mono);font-size:11px;color:var(--faint);
  letter-spacing:.04em;display:flex;align-items:center;gap:8px;white-space:nowrap}
.fmeta i{width:3px;height:3px;border-radius:50%;background:var(--faint);display:block}

/* ---- agents ---- */
ul.agents{list-style:none;margin:0;padding:0;border:1px solid var(--edge);background:var(--panel)}
.agent{display:grid;grid-template-columns:14px minmax(0,1.35fr) minmax(0,1fr) 74px;
  gap:14px;align-items:center;padding:11px 14px;border-bottom:1px solid var(--edge)}
.agent:last-child{border-bottom:0}
.dot{width:8px;height:8px;border-radius:50%;background:var(--wait)}
.is-running .dot{background:var(--cyan);box-shadow:0 0 9px #23e0d5}
.is-done .dot{background:var(--ok)}
.acol{display:flex;flex-direction:column;min-width:0}
.aname{font-weight:600;color:#e6ecf8;font-size:14px}
.adetail{color:var(--dim);font-size:12.5px}
.ascope{font-family:var(--mono);font-size:11px;color:var(--faint);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.astate{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;
  letter-spacing:.09em;color:var(--wait);text-align:right}
.is-running .astate{color:var(--cyan)}
.is-done .astate{color:var(--ok)}

/* ---- lists ---- */
.cols{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.pane{background:var(--panel);border:1px solid var(--edge);padding:15px 17px 17px}
.pane h3{font-family:var(--mono);font-size:11px;letter-spacing:.11em;
  text-transform:uppercase;margin:0 0 11px;color:var(--dim);font-weight:500}
.pane ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.pane li{padding-left:17px;position:relative;font-size:13.5px;color:var(--text)}
.pane.good li::before{content:"";position:absolute;left:0;top:.52em;width:7px;height:7px;
  border-left:1.6px solid var(--ok);border-bottom:1.6px solid var(--ok);
  transform:rotate(-45deg) translateY(-1px)}
.pane.gap li::before{content:"";position:absolute;left:1px;top:.56em;width:7px;height:7px;
  background:var(--amber);clip-path:polygon(50% 0,100% 100%,0 100%)}

footer{margin-top:46px;padding-top:16px;border-top:1px solid var(--edge);
  font-family:var(--mono);font-size:11.5px;color:var(--faint);
  display:flex;flex-wrap:wrap;gap:8px 20px}
</style>

<div class="wrap">
<header>
  <div>
    <h1>Neon Coast</h1>
    <div class="sub">OPEN-WORLD BUILD MONITOR &nbsp;/&nbsp; WAVE ${S.wave}</div>
  </div>
  <div class="pulse"><b></b>${running} BUILDING &nbsp;·&nbsp; ${doneN} LANDED</div>
</header>

<p class="lede"><strong>${esc(S.headline)}.</strong> ${esc(S.note)}</p>

<h2>Latest renders</h2>
<div class="grid">
${frames}
</div>

<h2>Specialists</h2>
<ul class="agents">
${agents}
</ul>

<h2>Status</h2>
<div class="cols">
  <div class="pane good"><h3>Landed &amp; verified</h3><ul>${S.done.map(d=>`<li>${esc(d)}</li>`).join('')}</ul></div>
  <div class="pane gap"><h3>Known gaps</h3><ul>${S.known_gaps.map(d=>`<li>${esc(d)}</li>`).join('')}</ul></div>
</div>

<footer>
  <span>three.js 0.180 · WebGL2</span>
  <span>headless SwiftShader capture</span>
  <span>1280×720 source frames</span>
  <span>updated ${stamp}</span>
</footer>
</div>`;

fs.writeFileSync('progress/index.html', html);
console.log('progress/index.html', Math.round(html.length/1024)+'kb');

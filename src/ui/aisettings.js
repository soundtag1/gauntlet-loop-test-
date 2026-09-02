// AI Settings overlay — press O in game.
//
// Owns nothing but the DOM: the dialogue system hands it the live config and a
// tester callback, it hands back edits. Values persist in localStorage under
// `neoncoast.ai` and are never committed, never logged.
//
// Keys (apiKey/fishKey) are masked, stored locally only, and never printed to
// the console by this module or by dialogue.js.

export const STORE_KEY = 'neoncoast.ai';

// Model strings are passed straight through to the endpoint, so the right value
// is whatever the user has actually pulled. These are one-click fills, not a
// closed list — the field stays free text. Qwen3 leads because the NPCs live or
// die on tool calling; Gemma is one click away.
export const MODEL_PRESETS = [
  'qwen3:8b', 'qwen3:4b', 'qwen3:14b', 'gemma3:12b', 'gemma3:4b',
];

export const DEFAULT_ENDPOINTS = {
  sttUrl: '',
  chatUrl: '',
  apiKey: '',
  fishKey: '',
  fishUrl: 'https://api.fish.audio/v1/tts',
  ttsFormat: 'mp3',
  timeoutMs: 20000,
  voice: true,
};

function clone(o){ return JSON.parse(JSON.stringify(o)); }

/** Merge stored config over the shipped defaults. Never throws. */
export function loadConfig(defaults){
  const base = clone(defaults);
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch(e){ /* private mode */ }
  if(!raw) return base;
  let saved = null;
  try { saved = JSON.parse(raw); } catch(e){ return base; }
  if(!saved || typeof saved !== 'object') return base;
  for(const k of Object.keys(base)){
    if(k === 'npcs') continue;
    if(saved[k] !== undefined && typeof saved[k] === typeof base[k]) base[k] = saved[k];
  }
  if(saved.npcs && typeof saved.npcs === 'object'){
    for(const id of Object.keys(base.npcs)){
      const s = saved.npcs[id];
      if(!s || typeof s !== 'object') continue;
      for(const f of ['model','voice','prompt']) if(typeof s[f] === 'string') base.npcs[id][f] = s[f];
      if(typeof s.temperature === 'number' && isFinite(s.temperature)){
        base.npcs[id].temperature = Math.max(0, Math.min(2, s.temperature));
      }
    }
  }
  return base;
}

/** Persist. Returns true on success — quota/private-mode failures are non-fatal. */
export function saveConfig(cfg){
  try {
    const out = { sttUrl:cfg.sttUrl, chatUrl:cfg.chatUrl, apiKey:cfg.apiKey,
      fishKey:cfg.fishKey, fishUrl:cfg.fishUrl, ttsFormat:cfg.ttsFormat,
      timeoutMs:cfg.timeoutMs, voice:cfg.voice, npcs:{} };
    for(const id of Object.keys(cfg.npcs || {})){
      const n = cfg.npcs[id];
      out.npcs[id] = { model:n.model, voice:n.voice, temperature:n.temperature, prompt:n.prompt };
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(out));
    return true;
  } catch(e){ return false; }
}

const CSS = `
#nc-ai, #nc-ai *{ box-sizing:border-box; }
#nc-ai{
  position:fixed; inset:0; z-index:60; display:none;
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#dceffb; -webkit-font-smoothing:antialiased;
  background:radial-gradient(120% 90% at 50% 0%, rgba(255,47,142,.16), rgba(4,6,14,.86) 60%), rgba(4,6,14,.82);
  backdrop-filter:blur(7px) saturate(1.1);
}
#nc-ai.on{ display:flex; align-items:center; justify-content:center; }
#nc-ai .card{
  position:relative; width:min(920px,94vw); height:min(660px,90vh);
  display:flex; flex-direction:column; overflow:hidden; border-radius:14px;
  background:linear-gradient(163deg,#131a3c 0%,#0a0d1f 46%,#170d24 100%);
  border:1px solid rgba(35,224,213,.26);
  box-shadow:0 0 0 1px rgba(255,47,142,.10), 0 30px 90px -20px rgba(0,0,0,.9),
             0 0 70px -28px rgba(35,224,213,.65);
}
#nc-ai .card::before{
  content:''; position:absolute; inset:0; pointer-events:none; opacity:.45;
  background:repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 3px);
  mix-blend-mode:overlay;
}
#nc-ai .rule{ height:2px; flex:0 0 2px; background:linear-gradient(90deg,#ff2f8e,#a8447e 28%,#23e0d5 64%,#ffcf3f); }
#nc-ai header{ display:flex; align-items:center; gap:14px; padding:14px 18px 12px; flex:0 0 auto; }
#nc-ai h1{
  margin:0; font-size:17px; letter-spacing:.30em; font-weight:600; color:#fff;
  text-shadow:0 0 14px rgba(255,47,142,.75), 0 0 34px rgba(255,47,142,.35);
}
#nc-ai .sub{ font-size:10.5px; letter-spacing:.16em; color:#6f93aa; text-transform:uppercase; }
#nc-ai .spacer{ flex:1 1 auto; }
#nc-ai .x{
  cursor:pointer; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.03);
  color:#9fc3d6; width:26px; height:26px; border-radius:7px; font-size:14px; line-height:1;
}
#nc-ai .x:hover{ color:#fff; border-color:#ff2f8e; box-shadow:0 0 12px -2px #ff2f8e; }
#nc-ai .body{ flex:1 1 auto; display:grid; grid-template-columns:196px 1fr; min-height:0; }
#nc-ai .rail{
  border-right:1px solid rgba(255,255,255,.07); padding:6px 8px 14px; overflow:auto;
  background:linear-gradient(180deg,rgba(35,224,213,.05),transparent 40%);
}
#nc-ai .railhead{ font-size:9.5px; letter-spacing:.2em; color:#5d7f95; padding:12px 8px 6px; text-transform:uppercase; }
#nc-ai .tab{
  display:flex; align-items:center; gap:9px; width:100%; text-align:left; cursor:pointer;
  padding:8px 9px; margin:2px 0; border-radius:8px; border:1px solid transparent;
  background:transparent; color:#a9c6d6; font:inherit; font-size:12px;
}
#nc-ai .tab:hover{ background:rgba(255,255,255,.045); color:#e6f6ff; }
#nc-ai .tab.sel{ background:linear-gradient(90deg,rgba(255,47,142,.20),rgba(255,47,142,0)); border-color:rgba(255,47,142,.42); color:#fff; }
#nc-ai .dot{ width:7px; height:7px; border-radius:50%; flex:0 0 7px; box-shadow:0 0 9px currentColor; background:currentColor; }
#nc-ai .tab .who{ flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#nc-ai .tab .role{ font-size:9px; letter-spacing:.12em; color:#5d7f95; text-transform:uppercase; }
#nc-ai .pane{ overflow:auto; padding:16px 20px 22px; min-height:0; }
#nc-ai .pane::-webkit-scrollbar, #nc-ai .rail::-webkit-scrollbar{ width:9px; }
#nc-ai .pane::-webkit-scrollbar-thumb, #nc-ai .rail::-webkit-scrollbar-thumb{ background:rgba(35,224,213,.22); border-radius:9px; }
#nc-ai .ptitle{ font-size:12px; letter-spacing:.22em; color:#23e0d5; text-transform:uppercase; margin:0 0 3px; }
#nc-ai .pnote{ font-size:11px; color:#7d9cb0; margin:0 0 16px; max-width:62ch; }
#nc-ai .f{ margin:0 0 14px; }
#nc-ai label{ display:block; font-size:9.5px; letter-spacing:.18em; color:#8fb6c9; text-transform:uppercase; margin:0 0 5px; }
#nc-ai label b{ color:#ffcf3f; font-weight:600; }
#nc-ai input,#nc-ai textarea,#nc-ai select{
  width:100%; padding:8px 10px; color:#eaf7ff; font:inherit; font-size:12px;
  background:rgba(6,9,20,.86); border:1px solid rgba(120,175,200,.22); border-radius:7px; outline:none;
}
#nc-ai textarea{ min-height:118px; resize:vertical; line-height:1.55; }
#nc-ai input:focus,#nc-ai textarea:focus{ border-color:#ff2f8e; box-shadow:0 0 0 1px rgba(255,47,142,.35),0 0 18px -6px #ff2f8e; }
#nc-ai .hint{ font-size:10.5px; color:#6b8ca1; margin-top:5px; }
#nc-ai .row{ display:flex; gap:12px; }
#nc-ai .row>*{ flex:1 1 0; min-width:0; }
#nc-ai .chips{ display:flex; flex-wrap:wrap; gap:6px; margin-top:7px; }
#nc-ai .chip{
  cursor:pointer; font:inherit; font-size:11px; padding:4px 9px; border-radius:20px;
  background:rgba(35,224,213,.08); border:1px solid rgba(35,224,213,.30); color:#9ff0ea;
}
#nc-ai .chip:hover{ background:rgba(35,224,213,.20); color:#fff; box-shadow:0 0 14px -4px #23e0d5; }
#nc-ai .chip.alt{ background:rgba(255,207,63,.08); border-color:rgba(255,207,63,.34); color:#ffdf8a; }
#nc-ai .chip.alt:hover{ background:rgba(255,207,63,.2); box-shadow:0 0 14px -4px #ffcf3f; }
#nc-ai .chip.on{ background:#ff2f8e; border-color:#ff2f8e; color:#fff; }
#nc-ai footer{
  flex:0 0 auto; display:flex; align-items:center; gap:10px; padding:11px 18px;
  border-top:1px solid rgba(255,255,255,.08); background:rgba(4,6,14,.5);
}
#nc-ai .btn{
  cursor:pointer; font:inherit; font-size:11.5px; letter-spacing:.13em; text-transform:uppercase;
  padding:8px 15px; border-radius:8px; border:1px solid rgba(35,224,213,.4);
  background:rgba(35,224,213,.09); color:#b9f6f1;
}
#nc-ai .btn:hover{ background:rgba(35,224,213,.2); color:#fff; box-shadow:0 0 18px -6px #23e0d5; }
#nc-ai .btn.pri{ border-color:#ff2f8e; background:rgba(255,47,142,.16); color:#ffd7e9; }
#nc-ai .btn.pri:hover{ background:#ff2f8e; color:#fff; box-shadow:0 0 22px -5px #ff2f8e; }
#nc-ai .btn.ghost{ border-color:rgba(255,255,255,.14); background:transparent; color:#8fb0c2; }
#nc-ai .status{ flex:1 1 auto; font-size:11px; color:#8fb0c2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#nc-ai .status.ok{ color:#7ef0c0; } #nc-ai .status.bad{ color:#ff7a9c; } #nc-ai .status.warn{ color:#ffcf3f; }
#nc-ai .probe{ display:grid; grid-template-columns:auto 1fr; gap:5px 10px; align-items:center;
  font-size:11px; margin:12px 0 0; padding:11px 12px; border-radius:9px;
  background:rgba(6,9,20,.6); border:1px solid rgba(255,255,255,.07); }
#nc-ai .probe .k{ color:#8fb6c9; letter-spacing:.1em; text-transform:uppercase; font-size:9.5px; }
#nc-ai .probe .v{ color:#cfe6f2; overflow:hidden; text-overflow:ellipsis; }
#nc-ai .probe .v.ok{ color:#7ef0c0; } #nc-ai .probe .v.bad{ color:#ff7a9c; } #nc-ai .probe .v.warn{ color:#ffcf3f; }
#nc-ai .warnbox{
  margin:16px 0 0; padding:11px 13px; border-radius:9px; font-size:11px; line-height:1.6; color:#f0d9a8;
  background:rgba(255,207,63,.06); border:1px solid rgba(255,207,63,.26);
}
#nc-ai .warnbox b{ color:#ffcf3f; }
#nc-ai .keyrow{ display:flex; gap:8px; }
#nc-ai .keyrow input{ flex:1 1 auto; }
#nc-ai .reveal{ flex:0 0 auto; width:44px; cursor:pointer; font:inherit; font-size:10px; letter-spacing:.1em;
  border-radius:7px; border:1px solid rgba(120,175,200,.22); background:rgba(6,9,20,.86); color:#8fb6c9; }
`;

export class AISettings {
  /**
   * @param {object} o
   * @param {()=>object} o.getConfig      live config object (mutated in place on save)
   * @param {(cfg:object)=>void} o.onSave applied + persisted by the caller
   * @param {(cfg:object)=>Promise<object>} o.onTest returns {stt,chat,tts} probe results
   * @param {object} o.npcs               roster: id -> {name, role, accent}
   */
  constructor(o){
    this.o = o;
    this.isOpen = false;
    this.sel = 'endpoints';
    this.draft = null;
    this._build();
  }

  _build(){
    if(!document.getElementById('nc-ai-css')){
      const st = document.createElement('style');
      st.id = 'nc-ai-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = document.createElement('div');
    root.id = 'nc-ai';
    root.innerHTML =
      '<div class="card"><div class="rule"></div>' +
      '<header><h1>AI SETTINGS</h1><div class="sub">local whisper &middot; local llm &middot; fish.audio</div>' +
      '<div class="spacer"></div><button class="x" title="Close (Esc)">&times;</button></header>' +
      '<div class="body"><div class="rail"></div><div class="pane"></div></div>' +
      '<footer><button class="btn" data-a="test">Test endpoints</button>' +
      '<button class="btn ghost" data-a="reset">Reset</button>' +
      '<div class="status"></div>' +
      '<button class="btn pri" data-a="save">Save</button></footer></div>';
    document.body.appendChild(root);
    this.root = root;
    this.rail = root.querySelector('.rail');
    this.pane = root.querySelector('.pane');
    this.statusEl = root.querySelector('.status');
    root.querySelector('.x').addEventListener('click', ()=>this.close());
    root.addEventListener('mousedown', e=>{ if(e.target === root) this.close(); });
    root.addEventListener('click', e=>{
      const a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
      if(a === 'save') this._save();
      else if(a === 'reset') this._reset();
      else if(a === 'test') this._test();
    });
    // Never let panel typing drive the player, and never let the game's key
    // handlers see keys meant for a text field.
    this._keyGuard = (e)=>{
      if(!this.isOpen) return;
      if(e.key === 'Escape' && e.type === 'keydown'){ this.close(); }
      e.stopPropagation();
    };
    for(const t of ['keydown','keyup','keypress']) window.addEventListener(t, this._keyGuard, true);
  }

  open(){
    this.draft = JSON.parse(JSON.stringify(this.o.getConfig()));
    this.isOpen = true;
    this.root.classList.add('on');
    this._renderRail();
    this._renderPane();
    this._status('', '');
  }

  close(){
    this.isOpen = false;
    this.root.classList.remove('on');
  }

  toggle(){ this.isOpen ? this.close() : this.open(); }

  _status(text, tone){
    this.statusEl.textContent = text || '';
    this.statusEl.className = 'status' + (tone ? ' ' + tone : '');
  }

  _renderRail(){
    const rail = this.rail;
    rail.textContent = '';
    const head = (t)=>{ const d = document.createElement('div'); d.className = 'railhead'; d.textContent = t; rail.appendChild(d); };
    const tab = (id, name, role, colour)=>{
      const b = document.createElement('button');
      b.className = 'tab' + (this.sel === id ? ' sel' : '');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.color = colour;
      const who = document.createElement('span'); who.className = 'who'; who.textContent = name;
      b.appendChild(dot); b.appendChild(who);
      if(role){ const r = document.createElement('span'); r.className = 'role'; r.textContent = role; b.appendChild(r); }
      b.addEventListener('click', ()=>{ this._collect(); this.sel = id; this._renderRail(); this._renderPane(); });
      rail.appendChild(b);
    };
    head('Connection');
    tab('endpoints', 'Endpoints', '', '#23e0d5');
    head('Characters');
    const npcs = this.o.npcs;
    for(const id of Object.keys(npcs)) tab(id, npcs[id].name, npcs[id].role, npcs[id].accent || '#ff2f8e');
  }

  // Read the visible fields back into the draft so switching tabs never loses edits.
  _collect(){
    if(!this._fields) return;
    for(const f of this._fields) f();
    this._fields = null;
  }

  _field(parent, opts){
    const wrap = document.createElement('div'); wrap.className = 'f';
    const lab = document.createElement('label');
    lab.textContent = opts.label;
    if(opts.badge){ const b = document.createElement('b'); b.textContent = '  ' + opts.badge; lab.appendChild(b); }
    wrap.appendChild(lab);
    const el = document.createElement(opts.area ? 'textarea' : 'input');
    if(!opts.area) el.type = opts.secret ? 'password' : 'text';
    el.value = opts.value == null ? '' : String(opts.value);
    if(opts.placeholder) el.placeholder = opts.placeholder;
    if(opts.secret){
      const row = document.createElement('div'); row.className = 'keyrow';
      const rev = document.createElement('button'); rev.className = 'reveal'; rev.type = 'button'; rev.textContent = 'SHOW';
      rev.addEventListener('click', ()=>{
        el.type = el.type === 'password' ? 'text' : 'password';
        rev.textContent = el.type === 'password' ? 'SHOW' : 'HIDE';
      });
      row.appendChild(el); row.appendChild(rev); wrap.appendChild(row);
    } else wrap.appendChild(el);
    if(opts.hint){ const h = document.createElement('div'); h.className = 'hint'; h.textContent = opts.hint; wrap.appendChild(h); }
    if(opts.chips && opts.chips.length){
      const cw = document.createElement('div'); cw.className = 'chips';
      for(const c of opts.chips){
        const b = document.createElement('button');
        b.className = 'chip' + (c.alt ? ' alt' : ''); b.type = 'button';
        b.textContent = c.label;
        b.addEventListener('click', ()=>{ el.value = c.value; el.focus(); });
        cw.appendChild(b);
      }
      wrap.appendChild(cw);
    }
    parent.appendChild(wrap);
    this._fields.push(()=>{ opts.set(opts.num ? parseFloat(el.value) : el.value); });
    return el;
  }

  _renderPane(){
    const p = this.pane;
    p.textContent = '';
    this._fields = [];
    const d = this.draft;
    const title = (t, note)=>{
      const h = document.createElement('div'); h.className = 'ptitle'; h.textContent = t; p.appendChild(h);
      const n = document.createElement('p'); n.className = 'pnote'; n.textContent = note; p.appendChild(n);
    };

    if(this.sel === 'endpoints'){
      title('Endpoints', 'Everything runs on your machine except fish.audio. Leave any field blank to disable that stage — the game falls back to typed text and scripted replies, and never breaks.');
      this._field(p, { label:'STT URL — local whisper', value:d.sttUrl,
        placeholder:'http://127.0.0.1:8081/stt',
        hint:'POST multipart/form-data, field "audio", returns {"text": "..."}',
        chips:[{label:'127.0.0.1:8081/stt', value:'http://127.0.0.1:8081/stt'},
               {label:'mock 8188', value:'http://127.0.0.1:8188/stt', alt:true}],
        set:v=>d.sttUrl = v.trim() });
      this._field(p, { label:'Chat URL — OpenAI-compatible', value:d.chatUrl,
        placeholder:'http://127.0.0.1:8080/v1/chat/completions',
        hint:'llama.cpp, Ollama (/v1), vLLM and LM Studio all work unmodified.',
        chips:[{label:'ollama 11434', value:'http://127.0.0.1:11434/v1/chat/completions'},
               {label:'llama.cpp 8080', value:'http://127.0.0.1:8080/v1/chat/completions'},
               {label:'mock 8188', value:'http://127.0.0.1:8188/v1/chat/completions', alt:true}],
        set:v=>d.chatUrl = v.trim() });
      this._field(p, { label:'API key — optional', value:d.apiKey, secret:true,
        hint:'Sent as Authorization: Bearer. Stored in this browser only, never committed, never logged.',
        set:v=>d.apiKey = v.trim() });

      const row = document.createElement('div'); row.className = 'row'; p.appendChild(row);
      const a = document.createElement('div'), b = document.createElement('div');
      row.appendChild(a); row.appendChild(b);
      this._field(a, { label:'TTS URL — fish.audio', value:d.fishUrl,
        placeholder:'https://api.fish.audio/v1/tts',
        chips:[{label:'fish.audio', value:'https://api.fish.audio/v1/tts'},
               {label:'mock 8188', value:'http://127.0.0.1:8188/v1/tts', alt:true}],
        set:v=>d.fishUrl = v.trim() });
      this._field(b, { label:'fish.audio key', value:d.fishKey, secret:true,
        hint:'Blank = subtitles only, no voice.', set:v=>d.fishKey = v.trim() });

      const row2 = document.createElement('div'); row2.className = 'row'; p.appendChild(row2);
      const c = document.createElement('div'), e = document.createElement('div');
      row2.appendChild(c); row2.appendChild(e);
      this._field(c, { label:'Request timeout (ms)', value:d.timeoutMs, num:true,
        set:v=>d.timeoutMs = (isFinite(v) && v > 1000) ? Math.min(120000, v) : 20000 });
      this._field(e, { label:'Audio format', value:d.ttsFormat,
        hint:'Passed through as "format". mp3, wav, opus…', set:v=>d.ttsFormat = v.trim() || 'mp3' });

      const w = document.createElement('div'); w.className = 'warnbox';
      w.appendChild(document.createTextNode('CORS is the one thing that will bite you. The game is served from '));
      const b1 = document.createElement('b'); b1.textContent = location.origin; w.appendChild(b1);
      w.appendChild(document.createTextNode('; your servers are a different origin, so they must send Access-Control-Allow-Origin (plus Allow-Headers: Content-Type, Authorization) and answer OPTIONS with 204. A failure with no server log is almost always this. See docs/LOCAL_AI_SETUP.md.'));
      p.appendChild(w);

      const probe = document.createElement('div'); probe.className = 'probe'; probe.id = 'nc-ai-probe';
      probe.style.display = 'none';
      p.appendChild(probe);
      return;
    }

    const npc = this.o.npcs[this.sel];
    const cfg = d.npcs[this.sel];
    if(!npc || !cfg) return;
    title(npc.name + '  —  ' + npc.role, npc.blurb || '');
    this._field(p, { label:'Model', badge:'per NPC · no restart needed', value:cfg.model,
      placeholder:'qwen3:8b',
      hint:'Passed straight through to your endpoint, so it must match what you have pulled (ollama pull qwen3:8b). Qwen3 is the default because these NPCs depend on tool calling. Gemma works too — one click, no code change.',
      chips:MODEL_PRESETS.map(m=>({ label:m, value:m, alt:m.indexOf('gemma') === 0 })),
      set:v=>cfg.model = v.trim() });
    const row = document.createElement('div'); row.className = 'row'; p.appendChild(row);
    const a = document.createElement('div'), b = document.createElement('div');
    row.appendChild(a); row.appendChild(b);
    this._field(a, { label:'fish.audio voice id', value:cfg.voice,
      placeholder:'reference_id', hint:'Sent as reference_id.', set:v=>cfg.voice = v.trim() });
    this._field(b, { label:'Temperature', value:cfg.temperature, num:true,
      hint:'0 = flat and literal, 1 = loose.',
      set:v=>cfg.temperature = (isFinite(v) ? Math.max(0, Math.min(2, v)) : 0.7) });
    this._field(p, { label:'System prompt', area:true, value:cfg.prompt,
      hint:'Personality and job knowledge. The tool list is appended automatically — the NPC can only ever call the allowlisted tools.',
      set:v=>cfg.prompt = v });
    const tw = document.createElement('div'); tw.className = 'warnbox';
    tw.appendChild(document.createTextNode('Tools available to ' + npc.name + ': '));
    const tb = document.createElement('b'); tb.textContent = (npc.tools || []).join(', ') || 'none';
    tw.appendChild(tb);
    tw.appendChild(document.createTextNode('. Spending is verified game-side; the model is never trusted to decide what you can afford, and the game reports the real outcome even if the NPC says otherwise.'));
    p.appendChild(tw);
  }

  _save(){
    this._collect();
    const ok = this.o.onSave(JSON.parse(JSON.stringify(this.draft)));
    this._status(ok === false ? 'Applied, but could not persist to localStorage.' : 'Saved. Live immediately — no restart.',
                 ok === false ? 'warn' : 'ok');
  }

  _reset(){
    this.draft = JSON.parse(JSON.stringify(this.o.defaults()));
    this._renderPane();
    this._status('Reset to shipped defaults — press Save to apply.', 'warn');
  }

  async _test(){
    this._collect();
    this.o.onSave(JSON.parse(JSON.stringify(this.draft)));
    this.sel = 'endpoints';
    this._renderRail(); this._renderPane();
    const box = this.root.querySelector('#nc-ai-probe');
    box.style.display = 'grid';
    box.textContent = '';
    const line = (k, v, tone)=>{
      const a = document.createElement('div'); a.className = 'k'; a.textContent = k;
      const b = document.createElement('div'); b.className = 'v' + (tone ? ' ' + tone : ''); b.textContent = v;
      box.appendChild(a); box.appendChild(b);
    };
    line('probe', 'contacting endpoints…');
    this._status('Testing…', '');
    let res = {};
    try { res = await this.o.onTest(); } catch(e){ res = { error:String(e && e.message || e) }; }
    box.textContent = '';
    let bad = 0;
    for(const k of ['stt','chat','tts']){
      const r = res[k];
      if(!r){ line(k, 'not configured — falls back gracefully', 'warn'); continue; }
      if(r.ok) line(k, 'OK  ' + r.ms + 'ms' + (r.note ? '  ' + r.note : ''), 'ok');
      else { bad++; line(k, r.message || 'failed', 'bad'); }
    }
    this._status(bad ? bad + ' endpoint(s) failed — see the report above.' : 'All configured endpoints answered.',
                 bad ? 'bad' : 'ok');
  }
}

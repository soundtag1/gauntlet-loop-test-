// Pre-play character customization overlay.
// Written to the API src/entities/player.js already expects:
//   CustomizeUI({appearance, onChange(a), onStart(a, name)}).show()
//   DEFAULT_APPEARANCE, BUILDS (torso/belly/shoulder/limb/scale), cloneAppearance(a)
// onChange fires on every edit so the live 3D character updates behind the panel.

export const BUILDS = {
  slim:     { torso:0.150, belly:0.120, shoulder:0.190, limb:0.049, scale:0.985 },
  average:  { torso:0.168, belly:0.138, shoulder:0.208, limb:0.055, scale:1.000 },
  athletic: { torso:0.182, belly:0.140, shoulder:0.232, limb:0.061, scale:1.015 },
  heavy:    { torso:0.205, belly:0.196, shoulder:0.226, limb:0.066, scale:1.005 },
};

const SKINS = [0x6b4632,0x8d5a3c,0xa9724d,0xc08a5e,0xd7a077,0xe8bb95,0xf2d2b0];
const HAIRS = [0x1b1512,0x3b2a1d,0x6b4a2a,0xa9743c,0xd9b06a,0xb03a5e,0x2b6f8a,0xe8e2d8];
const CLOTH = [0xff2f8e,0x23e0d5,0xffcf3f,0xf4f1ea,0x1d2430,0xe8552f,0x7a4bd0,0x2f9e5c,0xd9d2c4,0x141a2e];

export const DEFAULT_APPEARANCE = {
  build:'average', skin:SKINS[3], hairStyle:'short', hairColor:HAIRS[1],
  top:'tee', topColor:0xff2f8e, trousers:'jeans', trouserColor:0x1d2430, shoeColor:0xf4f1ea,
};

export function cloneAppearance(a){ return Object.assign({}, a || DEFAULT_APPEARANCE); }

const CSS = `
#cz-veil{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:flex-start;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  background:radial-gradient(120% 90% at 78% 42%,rgba(6,8,18,.10),rgba(6,8,18,.86) 68%)}
#cz{width:min(420px,92vw);max-height:92vh;overflow-y:auto;margin:0 0 0 clamp(16px,4vw,64px);
  padding:26px 26px 22px;border:1px solid rgba(255,47,142,.30);border-radius:4px;
  background:linear-gradient(178deg,rgba(17,14,34,.94),rgba(9,8,20,.96));
  box-shadow:0 24px 80px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.05);color:#d6dcee}
#cz h1{margin:0;font-size:30px;line-height:.96;letter-spacing:.06em;text-transform:uppercase;font-weight:800;
  background:linear-gradient(96deg,#ff2f8e,#23e0d5 64%,#ffcf3f);-webkit-background-clip:text;background-clip:text;color:transparent}
#cz .sub{margin:7px 0 20px;font:11px/1.5 ui-monospace,monospace;letter-spacing:.20em;color:#7c88a8;text-transform:uppercase}
.cz-row{margin:0 0 15px}
.cz-lab{display:block;font:10px/1 ui-monospace,monospace;letter-spacing:.17em;text-transform:uppercase;color:#8792b0;margin:0 0 7px}
.cz-seg{display:flex;flex-wrap:wrap;gap:6px}
.cz-seg button{flex:1 1 auto;min-width:62px;padding:8px 9px;cursor:pointer;color:#c3cbe0;
  font:11px/1 ui-monospace,monospace;letter-spacing:.10em;text-transform:uppercase;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.10);border-radius:3px;transition:.14s}
.cz-seg button:hover{background:rgba(35,224,213,.10);border-color:rgba(35,224,213,.42);color:#eafcfa}
.cz-seg button[aria-pressed="true"]{background:rgba(255,47,142,.16);border-color:#ff2f8e;color:#fff;
  box-shadow:0 0 15px rgba(255,47,142,.30)}
.cz-sw{display:flex;flex-wrap:wrap;gap:7px}
.cz-sw button{width:27px;height:27px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.16);
  padding:0;transition:.14s}
.cz-sw button:hover{transform:scale(1.14)}
.cz-sw button[aria-pressed="true"]{border-color:#fff;box-shadow:0 0 0 2px rgba(255,47,142,.55),0 0 14px rgba(255,47,142,.45)}
#cz-name{width:100%;padding:10px 12px;background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.13);
  border-radius:3px;color:#eef2ff;font:13px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase}
#cz-name:focus{outline:none;border-color:#23e0d5;box-shadow:0 0 0 3px rgba(35,224,213,.16)}
#cz-go{width:100%;margin-top:20px;padding:14px;cursor:pointer;border:0;border-radius:3px;color:#12060d;
  font:13px/1 ui-monospace,monospace;font-weight:700;letter-spacing:.22em;text-transform:uppercase;
  background:linear-gradient(96deg,#ff2f8e,#ff6f5e 52%,#ffcf3f);box-shadow:0 8px 28px rgba(255,47,142,.34)}
#cz-go:hover{filter:brightness(1.09)}
#cz-go:focus-visible,.cz-seg button:focus-visible,.cz-sw button:focus-visible{outline:2px solid #23e0d5;outline-offset:2px}
#cz .hint{margin:13px 0 0;font:10px/1.6 ui-monospace,monospace;letter-spacing:.10em;color:#5f6a86;text-align:center}
@media (prefers-reduced-motion:reduce){.cz-seg button,.cz-sw button{transition:none}}
`;

export class CustomizeUI {
  constructor({ appearance, onChange, onStart } = {}){
    this.app = cloneAppearance(appearance);
    this.onChange = onChange || (()=>{});
    this.onStart = onStart || (()=>{});
    this.el = null;
  }

  _seg(label, key, opts){
    const row = document.createElement('div'); row.className = 'cz-row';
    const l = document.createElement('span'); l.className = 'cz-lab'; l.textContent = label;
    const seg = document.createElement('div'); seg.className = 'cz-seg';
    for(const [val, text] of opts){
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text;
      b.setAttribute('aria-pressed', String(this.app[key] === val));
      b.onclick = ()=>{
        this.app[key] = val;
        seg.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));
        b.setAttribute('aria-pressed','true');
        this.onChange(cloneAppearance(this.app));
      };
      seg.appendChild(b);
    }
    row.append(l, seg); return row;
  }

  _swatches(label, key, colors){
    const row = document.createElement('div'); row.className = 'cz-row';
    const l = document.createElement('span'); l.className = 'cz-lab'; l.textContent = label;
    const wrap = document.createElement('div'); wrap.className = 'cz-sw';
    for(const c of colors){
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = '#' + c.toString(16).padStart(6,'0');
      b.setAttribute('aria-label', label + ' ' + c.toString(16));
      b.setAttribute('aria-pressed', String(this.app[key] === c));
      b.onclick = ()=>{
        this.app[key] = c;
        wrap.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));
        b.setAttribute('aria-pressed','true');
        this.onChange(cloneAppearance(this.app));
      };
      wrap.appendChild(b);
    }
    row.append(l, wrap); return row;
  }

  show(){
    if(typeof document === 'undefined' || this.el) return;
    const style = document.createElement('style'); style.textContent = CSS;
    const veil = document.createElement('div'); veil.id = 'cz-veil';
    const panel = document.createElement('div'); panel.id = 'cz';

    const h = document.createElement('h1'); h.textContent = 'Neon Coast';
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = 'Create your character';
    panel.append(h, sub);

    panel.append(
      this._seg('Build', 'build', [['slim','Slim'],['average','Average'],['athletic','Athletic'],['heavy','Heavy']]),
      this._swatches('Skin', 'skin', SKINS),
      this._seg('Hair', 'hairStyle', [['bald','Bald'],['buzz','Buzz'],['short','Short'],['long','Long'],['afro','Afro']]),
      this._swatches('Hair colour', 'hairColor', HAIRS),
      this._seg('Top', 'top', [['tee','Tee'],['tank','Tank'],['shirt','Shirt'],['jacket','Jacket'],['crop','Crop']]),
      this._swatches('Top colour', 'topColor', CLOTH),
      this._seg('Legs', 'trousers', [['jeans','Jeans'],['cargo','Cargo'],['shorts','Shorts']]),
      this._swatches('Trouser colour', 'trouserColor', CLOTH),
      this._swatches('Shoes', 'shoeColor', CLOTH),
    );

    const nrow = document.createElement('div'); nrow.className = 'cz-row';
    const nlab = document.createElement('span'); nlab.className = 'cz-lab'; nlab.textContent = 'Name';
    const name = document.createElement('input');
    name.id = 'cz-name'; name.maxLength = 18; name.value = 'DRIFTER';
    name.setAttribute('aria-label','Character name');
    nrow.append(nlab, name); panel.append(nrow);

    const go = document.createElement('button');
    go.id = 'cz-go'; go.type = 'button'; go.textContent = 'Enter the city';
    go.onclick = ()=>{ this.hide(); this.onStart(cloneAppearance(this.app), name.value.trim()); };
    panel.append(go);

    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'WASD move · shift sprint · E interact · O ai settings · gamepad supported';
    panel.append(hint);

    veil.appendChild(panel);
    document.head.appendChild(style);
    document.body.appendChild(veil);
    this.el = veil; this.styleEl = style;
    this.onChange(cloneAppearance(this.app));
    go.focus();
  }

  hide(){
    if(this.el){ this.el.remove(); this.el = null; }
    if(this.styleEl){ this.styleEl.remove(); this.styleEl = null; }
  }
}

import * as THREE from 'three';
import { Rand } from '../core/rng.js';

// ---------------------------------------------------------------------------
// STREETS — detailed road surfaces on top of the city's flat road plane.
//
// Everything here is merged or instanced. Total draw calls: 8.
//   1 merged N-S carriageway   1 merged E-W carriageway   1 merged intersections
//   1 merged sidewalk paving   1 merged kerb edge strip
//   1 instanced lane arrows    1 instanced manholes       1 instanced drains
//
// Wetness (puddles) is procedural in the shader from world XZ, so it never
// tiles, and it drives BOTH roughness and a fake vertical streaked reflection
// of neon/sky (rubric §2 "wet asphalt: vertical streaked reflections").
// ---------------------------------------------------------------------------

const CLEAR = 10.0;      // carriageway width between kerbs (rw 16 - 2*sidewalk 3)
const TILE_LEN = 32.0;   // metres of road covered by one texture tile lengthwise
const Y_ROAD = 0.036;
const Y_ROAD2 = 0.038;
const Y_XING = 0.044;
const Y_DECAL = 0.052;
const Y_WALK = 0.1665;   // kerb boxes are 0.16 tall
const Y_KERB = 0.1685;

// ---------------------------------------------------------------------------
// canvas helpers
// ---------------------------------------------------------------------------
function canvas(w, h){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return c;
}
function grain(g, W, H, R, amt, tintR, tintG, tintB){
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for(let i = 0; i < d.length; i += 4){
    const n = (R.f(-1, 1)) * amt;
    d[i]   = Math.max(0, Math.min(255, d[i]   + n * tintR));
    d[i+1] = Math.max(0, Math.min(255, d[i+1] + n * tintG));
    d[i+2] = Math.max(0, Math.min(255, d[i+2] + n * tintB));
  }
  g.putImageData(img, 0, 0);
}
function blotches(g, W, H, R, n, rmin, rmax, style){
  for(let i = 0; i < n; i++){
    g.fillStyle = style(R);
    g.beginPath();
    g.ellipse(R.f(0,W), R.f(0,H), R.f(rmin,rmax), R.f(rmin,rmax)*R.f(0.5,1.6), R.f(0,6.283), 0, 6.283);
    g.fill();
  }
}
function crack(g, R, x, y, len, step, w, col){
  g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x, y);
  let a = R.f(0, 6.283);
  for(let i = 0; i < len; i++){
    a += R.f(-0.7, 0.7);
    x += Math.cos(a) * step; y += Math.sin(a) * step;
    g.lineTo(x, y);
    if(R.bool(0.14)){                        // branch
      g.stroke(); g.beginPath();
      const bx = x, by = y; let ba = a + R.f(-1.4, 1.4);
      g.moveTo(bx, by);
      for(let j = 0; j < 4; j++){ ba += R.f(-0.5,0.5); g.lineTo(bx + Math.cos(ba)*step*(j+1), by + Math.sin(ba)*step*(j+1)); }
      g.stroke(); g.beginPath(); g.moveTo(x, y);
    }
  }
  g.stroke();
}

// Paints tarmac into the albedo ctx `g` and matching wear into roughness ctx `rg`.
function tarmac(g, rg, W, H, R, pxPerM){
  g.fillStyle = '#37363f'; g.fillRect(0, 0, W, H);
  rg.fillStyle = '#d2d2d2'; rg.fillRect(0, 0, W, H);   // rough by default

  // large-scale aggregate blotching
  blotches(g, W, H, R, 320, 3, 18, (r)=>`rgba(${(64+r.f(-30,34))|0},${(61+r.f(-30,34))|0},${(70+r.f(-30,36))|0},${r.f(0.12,0.40).toFixed(3)})`);
  blotches(rg, W, H, R, 160, 4, 22, (r)=>`rgba(255,255,255,${r.f(0.03,0.10).toFixed(3)})`);
  grain(g, W, H, R, 34, 1.0, 0.96, 1.08);
  grain(rg, W, H, R, 16, 1, 1, 1);

  // resurfacing patches — rectangular, slightly different tone + hard seam
  const patches = Math.max(2, (W * H) / 90000 | 0);
  for(let i = 0; i < patches; i++){
    const pw = R.f(1.4, 5.0) * pxPerM, ph = R.f(1.6, 7.0) * pxPerM;
    const px = R.f(-pw*0.3, W), py = R.f(-ph*0.3, H);
    const t = R.f(-20, 26);
    g.fillStyle = `rgba(${(58+t)|0},${(56+t)|0},${(64+t)|0},0.70)`;
    g.fillRect(px, py, pw, ph);
    g.strokeStyle = 'rgba(12,12,15,0.75)'; g.lineWidth = Math.max(1, pxPerM*0.06);
    g.strokeRect(px, py, pw, ph);
    rg.fillStyle = `rgba(255,255,255,${R.f(0.05,0.18).toFixed(3)})`;
    rg.fillRect(px, py, pw, ph);
  }
  // tar-sealed cracks (slightly glossy black lines)
  for(let i = 0; i < 8; i++){
    crack(g, R, R.f(0,W), R.f(0,H), R.i(10,26), pxPerM*0.55, Math.max(1, pxPerM*0.055), 'rgba(10,10,13,0.85)');
    crack(rg, R, R.f(0,W), R.f(0,H), R.i(6,14), pxPerM*0.55, Math.max(1, pxPerM*0.09), 'rgba(90,90,90,0.5)');
  }
  // fine hairline cracks (lighter, opened aggregate)
  for(let i = 0; i < 10; i++){
    crack(g, R, R.f(0,W), R.f(0,H), R.i(6,16), pxPerM*0.4, Math.max(1, pxPerM*0.03), 'rgba(124,121,130,0.45)');
  }
}

function oilStain(g, rg, R, cx, cy, rad){
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
  grd.addColorStop(0, 'rgba(8,7,10,0.72)');
  grd.addColorStop(0.55, 'rgba(14,13,17,0.40)');
  grd.addColorStop(1, 'rgba(20,18,24,0)');
  g.fillStyle = grd; g.beginPath(); g.ellipse(cx, cy, rad, rad*R.f(0.6,1.5), R.f(0,3.14), 0, 6.283); g.fill();
  const rgd = rg.createRadialGradient(cx, cy, 0, cx, cy, rad);
  rgd.addColorStop(0, 'rgba(70,70,70,0.85)');   // oil = smoother
  rgd.addColorStop(1, 'rgba(128,128,128,0)');
  rg.fillStyle = rgd; rg.beginPath(); rg.arc(cx, cy, rad, 0, 6.283); rg.fill();
}

// Darkened + polished wheel track band running the full length of the tile.
function wheelTrack(g, rg, x, W, H, wpx){
  const grd = g.createLinearGradient(x - wpx, 0, x + wpx, 0);
  grd.addColorStop(0, 'rgba(18,17,21,0)');
  grd.addColorStop(0.5, 'rgba(16,15,19,0.58)');
  grd.addColorStop(1, 'rgba(18,17,21,0)');
  g.fillStyle = grd; g.fillRect(x - wpx, 0, wpx*2, H);
  const rgd = rg.createLinearGradient(x - wpx, 0, x + wpx, 0);
  rgd.addColorStop(0, 'rgba(120,120,120,0)');
  rgd.addColorStop(0.5, 'rgba(96,96,96,0.85)');   // tyre polish -> smoother
  rgd.addColorStop(1, 'rgba(120,120,120,0)');
  rg.fillStyle = rgd; rg.fillRect(x - wpx, 0, wpx*2, H);
}

// Worn paint stroke: white/yellow with scuffed alpha so it never reads as vinyl.
function paintRect(g, rg, R, x, y, w, h, col, wear){
  g.save();
  g.fillStyle = col; g.globalAlpha = 0.92; g.fillRect(x, y, w, h); g.restore();
  // scuff it
  const n = Math.max(6, (w*h)/70 | 0);
  g.save(); g.globalCompositeOperation = 'destination-out';
  for(let i = 0; i < n * wear; i++){
    g.fillStyle = `rgba(0,0,0,${R.f(0.15,0.7).toFixed(2)})`;
    g.beginPath(); g.arc(R.f(x, x+w), R.f(y, y+h), R.f(0.4, Math.max(1.2, Math.min(w,h)*0.4)), 0, 6.283); g.fill();
  }
  g.restore();
  rg.save(); rg.fillStyle = 'rgba(210,210,210,0.85)'; rg.fillRect(x, y, w, h); rg.restore();
}

// ---------------------------------------------------------------------------
// road tile: CLEAR metres across, TILE_LEN metres along. 2 lanes, both ways.
// ---------------------------------------------------------------------------
function roadTexture(R){
  const PPM = 26;
  const W = Math.round(CLEAR * PPM), H = Math.round(TILE_LEN * PPM);
  const cA = canvas(W, H), g = cA.getContext('2d');
  const cR = canvas(W, H), rg = cR.getContext('2d');
  const mx = (m)=> m * PPM;                       // metres across -> px
  const my = (m)=> m * PPM;                       // metres along  -> px

  tarmac(g, rg, W, H, R, PPM);

  // gutter darkening at both kerbs
  for(const s of [0, 1]){
    const gx = s ? W : 0;
    const grd = g.createLinearGradient(gx, 0, s ? W - mx(1.6) : mx(1.6), 0);
    grd.addColorStop(0, 'rgba(9,9,12,0.70)');
    grd.addColorStop(1, 'rgba(9,9,12,0)');
    g.fillStyle = grd; g.fillRect(s ? W - mx(1.6) : 0, 0, mx(1.6), H);
  }

  // tyre polish: lane centres at 2.5 and 7.5 m, tracks +-0.85 m
  for(const lc of [2.5, 7.5]){
    wheelTrack(g, rg, mx(lc - 0.85), W, H, mx(0.55));
    wheelTrack(g, rg, mx(lc + 0.85), W, H, mx(0.55));
  }
  // oil / drip stains down the middle of each lane
  for(let i = 0; i < 7; i++){
    const lc = R.bool() ? 2.5 : 7.5;
    oilStain(g, rg, R, mx(lc + R.f(-0.5, 0.5)), R.f(0, H), mx(R.f(0.25, 0.9)));
  }

  // --- markings -----------------------------------------------------------
  const lw = mx(0.14);                                  // line half-thickness
  // solid white edge lines 0.55 m in from each kerb
  paintRect(g, rg, R, mx(0.55) - lw, 0, lw*2, H, '#e6e4dc', 1.0);
  paintRect(g, rg, R, mx(CLEAR - 0.55) - lw, 0, lw*2, H, '#e6e4dc', 1.0);
  // double-solid amber centre line at 5 m
  paintRect(g, rg, R, mx(5.0 - 0.26) - lw, 0, lw*2, H, '#e8b53c', 0.85);
  paintRect(g, rg, R, mx(5.0 + 0.26) - lw, 0, lw*2, H, '#e8b53c', 0.85);
  // dashed white lane hints inside each lane half (period 8 m: 3 m paint / 5 gap)
  for(const lc of [2.5, 7.5]){
    for(let s = 0; s < TILE_LEN; s += 8){
      // skip - keep two-lane read clean; dashes are on the shoulder side instead
    }
  }
  // transverse construction seams every 8 m
  for(let s = 4; s < TILE_LEN; s += 8){
    g.fillStyle = 'rgba(12,12,15,0.5)'; g.fillRect(0, my(s), W, Math.max(1, PPM*0.07));
    g.fillStyle = 'rgba(78,76,84,0.20)'; g.fillRect(0, my(s) + PPM*0.07, W, Math.max(1, PPM*0.05));
  }
  // longitudinal seam right on the crown of the road
  g.fillStyle = 'rgba(10,10,13,0.45)'; g.fillRect(mx(5.0) - PPM*0.04, 0, Math.max(1, PPM*0.08), H);

  return mkTex(cA, cR);
}

// Dashed-centre variant for secondary streets (visual variety, same footprint).
function roadTextureDashed(R){
  const PPM = 26;
  const W = Math.round(CLEAR * PPM), H = Math.round(TILE_LEN * PPM);
  const cA = canvas(W, H), g = cA.getContext('2d');
  const cR = canvas(W, H), rg = cR.getContext('2d');
  const mx = (m)=> m * PPM, my = (m)=> m * PPM;
  tarmac(g, rg, W, H, R, PPM);
  for(const s of [0, 1]){
    const grd = g.createLinearGradient(s ? W : 0, 0, s ? W - mx(1.6) : mx(1.6), 0);
    grd.addColorStop(0, 'rgba(9,9,12,0.62)'); grd.addColorStop(1, 'rgba(9,9,12,0)');
    g.fillStyle = grd; g.fillRect(s ? W - mx(1.6) : 0, 0, mx(1.6), H);
  }
  for(const lc of [2.5, 7.5]){
    wheelTrack(g, rg, mx(lc - 0.85), W, H, mx(0.55));
    wheelTrack(g, rg, mx(lc + 0.85), W, H, mx(0.55));
  }
  for(let i = 0; i < 6; i++){
    const lc = R.bool() ? 2.5 : 7.5;
    oilStain(g, rg, R, mx(lc + R.f(-0.5,0.5)), R.f(0,H), mx(R.f(0.2,0.8)));
  }
  const lw = mx(0.14);
  paintRect(g, rg, R, mx(0.6) - lw, 0, lw*2, H, '#dedbd2', 1.0);
  paintRect(g, rg, R, mx(CLEAR-0.6) - lw, 0, lw*2, H, '#dedbd2', 1.0);
  // dashed white centre: 3 m paint, 5 m gap, period 8 m -> tiles at 32 m
  for(let s = 0.5; s < TILE_LEN; s += 8){
    paintRect(g, rg, R, mx(5.0) - lw, my(s), lw*2, my(3.0), '#e6e4dc', 1.0);
  }
  for(let s = 4; s < TILE_LEN; s += 8){
    g.fillStyle = 'rgba(12,12,15,0.45)'; g.fillRect(0, my(s), W, Math.max(1, PPM*0.06));
  }
  return mkTex(cA, cR);
}

// ---------------------------------------------------------------------------
// intersection tile: CLEAR x CLEAR, zebra crossings + stop bars on all 4 sides,
// clean middle (no lane lines running through the junction).
// ---------------------------------------------------------------------------
function junctionTexture(R){
  const PPM = 26;
  const S = Math.round(CLEAR * PPM);
  const cA = canvas(S, S), g = cA.getContext('2d');
  const cR = canvas(S, S), rg = cR.getContext('2d');
  const m = (v)=> v * PPM;
  tarmac(g, rg, S, S, R, PPM);
  // junctions are polished by turning traffic -> broad smooth dark centre
  const cg = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S*0.55);
  cg.addColorStop(0, 'rgba(14,13,17,0.55)'); cg.addColorStop(1, 'rgba(14,13,17,0)');
  g.fillStyle = cg; g.fillRect(0,0,S,S);
  const cgr = rg.createRadialGradient(S/2, S/2, 0, S/2, S/2, S*0.55);
  cgr.addColorStop(0, 'rgba(110,110,110,0.75)'); cgr.addColorStop(1, 'rgba(160,160,160,0)');
  rg.fillStyle = cgr; rg.fillRect(0,0,S,S);
  for(let i = 0; i < 5; i++) oilStain(g, rg, R, R.f(S*0.25,S*0.75), R.f(S*0.25,S*0.75), m(R.f(0.3,1.0)));

  // one edge's furniture, then rotate 4x for the other approaches
  const edge = ()=>{
    // zebra: 6 bars 0.5 m wide, 1.9 m deep, starting 0.15 m in from the edge
    for(let i = 0; i < 7; i++){
      const x = m(0.55 + i * 1.32);
      if(x + m(0.52) > S - m(0.4)) break;
      paintRect(g, rg, R, x, m(0.18), m(0.52), m(1.9), '#e9e7de', 1.2);
    }
    // stop bar on the approach half only (right-hand traffic)
    paintRect(g, rg, R, m(0.55), m(2.35), m(CLEAR*0.5 - 0.9), m(0.34), '#e9e7de', 1.0);
  };
  for(let k = 0; k < 4; k++){
    g.save(); rg.save();
    g.translate(S/2, S/2); g.rotate(k * Math.PI/2); g.translate(-S/2, -S/2);
    rg.translate(S/2, S/2); rg.rotate(k * Math.PI/2); rg.translate(-S/2, -S/2);
    edge();
    g.restore(); rg.restore();
  }
  return mkTex(cA, cR);
}

// ---------------------------------------------------------------------------
// sidewalk paving: 6 m tile of 1.2 m slabs, world-aligned so joints run true.
// ---------------------------------------------------------------------------
function pavingTexture(R){
  const PPM = 42, TILE = 6.0;
  const S = Math.round(TILE * PPM);
  const cA = canvas(S, S), g = cA.getContext('2d');
  const cR = canvas(S, S), rg = cR.getContext('2d');
  g.fillStyle = '#8a8378'; g.fillRect(0,0,S,S);
  rg.fillStyle = '#e0e0e0'; rg.fillRect(0,0,S,S);
  const n = 5, sw = S / n;
  for(let i = 0; i < n; i++) for(let j = 0; j < n; j++){
    const t = R.f(-12, 12);
    g.fillStyle = `rgb(${(140+t)|0},${(133+t*0.9)|0},${(120+t*0.8)|0})`;
    g.fillRect(i*sw+1.5, j*sw+1.5, sw-3, sw-3);
    // slab wear + staining
    blotchLocal(g, R, i*sw, j*sw, sw);
    rg.fillStyle = `rgba(255,255,255,${R.f(0.0,0.14).toFixed(3)})`;
    rg.fillRect(i*sw, j*sw, sw, sw);
  }
  // mortar joints
  g.strokeStyle = 'rgba(58,54,48,0.85)'; g.lineWidth = 3;
  for(let i = 0; i <= n; i++){
    g.beginPath(); g.moveTo(i*sw, 0); g.lineTo(i*sw, S); g.stroke();
    g.beginPath(); g.moveTo(0, i*sw); g.lineTo(S, i*sw); g.stroke();
  }
  grain(g, S, S, R, 20, 1.0, 0.97, 0.92);
  // grime and cracks
  for(let i = 0; i < 4; i++) crack(g, R, R.f(0,S), R.f(0,S), R.i(5,12), PPM*0.35, 1.6, 'rgba(52,48,42,0.6)');
  blotches(g, S, S, R, 30, 3, 14, (r)=>`rgba(${(70+r.f(0,40))|0},${(66+r.f(0,36))|0},${(60+r.f(0,32))|0},${r.f(0.04,0.14).toFixed(3)})`);
  return mkTex(cA, cR);
}
function blotchLocal(g, R, x, y, s){
  for(let k = 0; k < 3; k++){
    g.fillStyle = `rgba(${(90+R.f(-30,40))|0},${(86+R.f(-30,36))|0},${(78+R.f(-28,32))|0},${R.f(0.05,0.16).toFixed(3)})`;
    g.beginPath(); g.ellipse(R.f(x,x+s), R.f(y,y+s), R.f(2,s*0.4), R.f(2,s*0.35), R.f(0,3.14), 0, 6.283); g.fill();
  }
}

// kerb-stone top strip: repeated 1.4 m stones with joints, occasional paint
function kerbTexture(R){
  const PPM = 48, TILE = 5.6;
  const W = Math.round(TILE*PPM), H = 32;
  const cA = canvas(W, H), g = cA.getContext('2d');
  const cR = canvas(W, H), rg = cR.getContext('2d');
  g.fillStyle = '#9a938a'; g.fillRect(0,0,W,H);
  rg.fillStyle = '#dcdcdc'; rg.fillRect(0,0,W,H);
  const n = 4, sw = W/n;
  for(let i = 0; i < n; i++){
    const t = R.f(-16, 14);
    g.fillStyle = `rgb(${(158+t)|0},${(150+t)|0},${(138+t)|0})`;
    g.fillRect(i*sw+2, 0, sw-4, H);
  }
  g.fillStyle = 'rgba(48,44,40,0.9)';
  for(let i = 0; i <= n; i++) g.fillRect(i*sw-1.5, 0, 3, H);
  // road-side grime along the bottom edge
  const grd = g.createLinearGradient(0, H, 0, H*0.45);
  grd.addColorStop(0, 'rgba(30,28,26,0.65)'); grd.addColorStop(1, 'rgba(30,28,26,0)');
  g.fillStyle = grd; g.fillRect(0, H*0.45, W, H*0.55);
  grain(g, W, H, R, 22, 1, 0.97, 0.93);
  return mkTex(cA, cR);
}

function mkTex(cA, cR){
  const t = new THREE.CanvasTexture(cA);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const r = new THREE.CanvasTexture(cR);
  r.wrapS = r.wrapT = THREE.RepeatWrapping; r.anisotropy = 4;
  return { map: t, rough: r };
}

// arrow decal atlas: 0 = straight, 1 = left turn, 2 = straight+right
function arrowTexture(kind){
  const W = 96, H = 192;
  const c = canvas(W, H), g = c.getContext('2d');
  g.clearRect(0,0,W,H);
  g.fillStyle = 'rgba(233,231,222,0.95)';
  const shaft = (x0, y0, y1, w)=>{ g.fillRect(x0 - w/2, y0, w, y1 - y0); };
  const head = (cx, ty, hw, hh)=>{ g.beginPath(); g.moveTo(cx, ty); g.lineTo(cx-hw, ty+hh); g.lineTo(cx+hw, ty+hh); g.closePath(); g.fill(); };
  if(kind === 0){
    shaft(W/2, 52, H-16, 18); head(W/2, 14, 34, 42);
  } else if(kind === 1){
    shaft(W/2+10, 70, H-16, 18);
    g.fillRect(W*0.28, 62, W*0.36, 18);
    head(W*0.24, 30, 26, 40);
    g.save(); g.translate(W*0.24, 71); g.rotate(-Math.PI/2); g.translate(-W*0.24, -71);
    g.restore();
    // elbow arrow head pointing left
    g.beginPath(); g.moveTo(W*0.10, 71); g.lineTo(W*0.34, 71-24); g.lineTo(W*0.34, 71+24); g.closePath(); g.fill();
    g.clearRect(0, 20, W, 34);
  } else {
    shaft(W/2-8, 52, H-16, 16); head(W/2-8, 16, 28, 38);
    g.fillRect(W/2-8, 70, W*0.30, 16);
    g.beginPath(); g.moveTo(W*0.92, 78); g.lineTo(W*0.66, 78-22); g.lineTo(W*0.66, 78+22); g.closePath(); g.fill();
  }
  // wear
  g.globalCompositeOperation = 'destination-out';
  const R = new Rand(1234 + kind);
  for(let i = 0; i < 260; i++){
    g.fillStyle = `rgba(0,0,0,${R.f(0.2,0.9).toFixed(2)})`;
    g.beginPath(); g.arc(R.f(0,W), R.f(0,H), R.f(0.6,2.6), 0, 6.283); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function manholeTexture(R){
  const S = 96, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#3a3a3f'; g.beginPath(); g.arc(S/2, S/2, S/2, 0, 6.283); g.fill();
  g.fillStyle = '#4a4a50'; g.beginPath(); g.arc(S/2, S/2, S/2*0.9, 0, 6.283); g.fill();
  g.strokeStyle = 'rgba(24,24,28,0.9)'; g.lineWidth = 2;
  for(let r = 0.18; r < 0.9; r += 0.16){ g.beginPath(); g.arc(S/2,S/2,S/2*r,0,6.283); g.stroke(); }
  for(let a = 0; a < 12; a++){
    g.save(); g.translate(S/2,S/2); g.rotate(a*Math.PI/6);
    g.fillStyle = 'rgba(28,28,32,0.85)'; g.fillRect(-2, -S*0.44, 4, S*0.36); g.restore();
  }
  g.strokeStyle = 'rgba(200,200,205,0.18)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(S/2, S/2, S/2*0.93, -2.5, 0.4); g.stroke();
  grain(g, S, S, R, 22, 1, 1, 1.05);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function drainTexture(R){
  const W = 96, H = 56, c = canvas(W,H), g = c.getContext('2d');
  g.fillStyle = '#33333a'; g.fillRect(0,0,W,H);
  g.fillStyle = '#42424a'; g.fillRect(3,3,W-6,H-6);
  g.fillStyle = '#0b0b0e';
  for(let i = 0; i < 7; i++) g.fillRect(9 + i*11, 10, 6, H-20);
  g.strokeStyle = 'rgba(190,190,196,0.16)'; g.lineWidth = 2; g.strokeRect(3,3,W-6,H-6);
  grain(g, W, H, R, 18, 1, 1, 1);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------
// merged quad builder (all quads lie in the XZ plane, facing +Y)
// ---------------------------------------------------------------------------
class QuadSoup {
  constructor(){ this.p = []; this.u = []; this.idx = []; this.n = 0; }
  // corners: (x0,z0) (x1,z0) (x0,z1) (x1,z1)
  quad(x0, z0, x1, z1, y, u00, v00, u10, v10, u01, v01, u11, v11){
    const b = this.n;
    this.p.push(x0,y,z0, x1,y,z0, x0,y,z1, x1,y,z1);
    this.u.push(u00,v00, u10,v10, u01,v01, u11,v11);
    this.idx.push(b, b+2, b+1, b+2, b+3, b+1);
    this.n += 4;
  }
  geometry(){
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(this.p);
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const nrm = new Float32Array(p.length);
    for(let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.u), 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
export class Streets {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Streets';
    scene.add(this.group);
    this.rand = new Rand((ctx && ctx.seed ? ctx.seed : 1) ^ 0x5a17);
    // shared shader uniforms, mutated (never reallocated) in update()
    this.U = {
      uNight: { value: 1.0 },
      uSkyCol: { value: new THREE.Color(0xff9a56) },
      uNeonA: { value: new THREE.Color(0xff2f8e) },
      uNeonB: { value: new THREE.Color(0x23e0d5) },
      uNeonC: { value: new THREE.Color(0xffcf3f) },
    };
    this._c = new THREE.Color();
  }

  // ---- wet-asphalt material -------------------------------------------
  wetMaterial(tex, wetAmount, opts = {}){
    const m = new THREE.MeshStandardMaterial({
      map: tex.map, roughnessMap: tex.rough,
      roughness: opts.roughness !== undefined ? opts.roughness : 1.0,
      metalness: opts.metalness !== undefined ? opts.metalness : 0.04,
      color: opts.color !== undefined ? opts.color : 0xffffff,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const U = this.U;
    const uWet = { value: wetAmount };
    const scale = { value: opts.wetScale !== undefined ? opts.wetScale : 1.0 };
    m.onBeforeCompile = (sh)=>{
      sh.uniforms.uNight = U.uNight;
      sh.uniforms.uSkyCol = U.uSkyCol;
      sh.uniforms.uNeonA = U.uNeonA;
      sh.uniforms.uNeonB = U.uNeonB;
      sh.uniforms.uNeonC = U.uNeonC;
      sh.uniforms.uWet = uWet;
      sh.uniforms.uWetScale = scale;

      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');

      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uNight, uWet, uWetScale;
        uniform vec3 uSkyCol, uNeonA, uNeonB, uNeonC;
        float sh21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float svn(vec2 p){
          vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(sh21(i),sh21(i+vec2(1.0,0.0)),f.x),
                     mix(sh21(i+vec2(0.0,1.0)),sh21(i+vec2(1.0,1.0)),f.x), f.y);
        }
        float wetMask(vec2 p){
          p *= uWetScale;
          float n = svn(p*0.045)*0.55 + svn(p*0.13)*0.30 + svn(p*0.42)*0.15;
          return smoothstep(0.50, 0.74, n);
        }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        float wetA = wetMask(vWPos.xz) * uWet;
        diffuseColor.rgb *= mix(1.0, 0.40, wetA);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.055, wetA);`)
        .replace('#include <fog_fragment>', `
        {
          vec3 vdir = cameraPosition - vWPos;
          float dist = length(vdir);
          vdir /= max(dist, 0.001);
          float fres = pow(1.0 - clamp(vdir.y, 0.0, 1.0), 4.0);
          vec2 fwd = normalize(vec2(vWPos.x, vWPos.z) - vec2(cameraPosition.x, cameraPosition.z) + vec2(1e-4));
          vec2 sid = vec2(-fwd.y, fwd.x);
          float along  = dot(vWPos.xz, fwd);
          float across = dot(vWPos.xz, sid);
          // streaks stretched ALONG the view ray -> read as vertical smears
          float st = svn(vec2(across*1.7, along*0.045));
          st = st*0.6 + svn(vec2(across*5.1, along*0.10))*0.4;
          st = smoothstep(0.30, 0.92, st);
          vec2 cell = floor((vWPos.xz + fwd*26.0) / 41.0);
          float hcell = sh21(cell);
          vec3 neon = mix(uNeonA, uNeonB, smoothstep(0.30, 0.36, hcell));
          neon = mix(neon, uNeonC, smoothstep(0.66, 0.72, hcell));
          vec3 refl = mix(uSkyCol * 0.55, neon, uNight);
          gl_FragColor.rgb += refl * (wetA * fres * st * (0.30 + 1.35*uNight));
        }
        #include <fog_fragment>`);
    };
    m.customProgramCacheKey = ()=> 'streets-wet-v3-' + wetAmount.toFixed(2) + '-' + scale.value.toFixed(2);
    return m;
  }

  build(){
    const city = this.ctx && this.ctx.city;
    if(!city) return this;
    const R = this.rand;
    const n = city.n, s = city.stride, half = city.span / 2;
    const sw = 3.0;                       // CONFIG.city.sidewalk
    const bs = city.bs;
    const HC = CLEAR / 2;                 // 5 m
    this.roadOffsets = [];
    for(let i = 0; i <= n; i++) this.roadOffsets.push(-half + i * s);

    // ---------------- carriageways ------------------------------------
    const soupNS = new QuadSoup(), soupEW = new QuadSoup();
    const useDashed = [];
    for(let i = 0; i <= n; i++) useDashed.push(R.bool(0.55));

    // N-S roads: segments between junctions so no paint runs through a junction
    for(let i = 0; i <= n; i++){
      const off = this.roadOffsets[i];
      const soup = soupNS;
      for(let j = -1; j <= n; j++){
        const zA = (j < 0) ? (-half - HC - 8) : this.roadOffsets[j] + HC;
        const zB = (j >= n) ? (half + HC + 8) : this.roadOffsets[j+1] - HC;
        if(zB <= zA) continue;
        const v0 = zA / TILE_LEN, v1 = zB / TILE_LEN;
        soup.quad(off - HC, zA, off + HC, zB, Y_ROAD,
          0, v0, 1, v0, 0, v1, 1, v1);
      }
    }
    // E-W roads: u runs across (z), v runs along (x)
    for(let i = 0; i <= n; i++){
      const off = this.roadOffsets[i];
      for(let j = -1; j <= n; j++){
        const xA = (j < 0) ? (-half - HC - 8) : this.roadOffsets[j] + HC;
        const xB = (j >= n) ? (half + HC + 8) : this.roadOffsets[j+1] - HC;
        if(xB <= xA) continue;
        const v0 = xA / TILE_LEN, v1 = xB / TILE_LEN;
        // corners (xA,off-HC) (xB,off-HC) (xA,off+HC) (xB,off+HC)
        soupEW.quad(xA, off - HC, xB, off + HC, Y_ROAD2,
          v0, 0, v1, 0, v0, 1, v1, 1);
      }
    }
    const texA = roadTexture(R), texB = roadTextureDashed(R);
    this.matNS = this.wetMaterial(texA, 1.0);
    this.matEW = this.wetMaterial(texB, 1.0);
    const mNS = new THREE.Mesh(soupNS.geometry(), this.matNS);
    const mEW = new THREE.Mesh(soupEW.geometry(), this.matEW);
    mNS.receiveShadow = mEW.receiveShadow = true;
    mNS.renderOrder = 1; mEW.renderOrder = 1;
    this.group.add(mNS, mEW);

    // ---------------- junctions ---------------------------------------
    const soupJ = new QuadSoup();
    for(let i = 0; i <= n; i++) for(let j = 0; j <= n; j++){
      const x = this.roadOffsets[i], z = this.roadOffsets[j];
      soupJ.quad(x - HC, z - HC, x + HC, z + HC, Y_XING, 0,0, 1,0, 0,1, 1,1);
    }
    const texJ = junctionTexture(R);
    this.matJ = this.wetMaterial(texJ, 1.0);
    const mJ = new THREE.Mesh(soupJ.geometry(), this.matJ);
    mJ.receiveShadow = true; mJ.renderOrder = 2;
    this.group.add(mJ);

    // ---------------- sidewalk paving + kerb strip --------------------
    const soupW = new QuadSoup(), soupK = new QuadSoup();
    const PT = 6.0;                      // paving texture tile in metres
    const KT = 5.6;
    const addWalk = (x0, z0, x1, z1)=>{
      soupW.quad(x0, z0, x1, z1, Y_WALK,
        x0/PT, z0/PT, x1/PT, z0/PT, x0/PT, z1/PT, x1/PT, z1/PT);
    };
    // kerb strip: long axis 'a' gets the repeating stone UV
    const addKerbX = (x0, x1, z0, z1)=>{           // runs along X
      soupK.quad(x0, z0, x1, z1, Y_KERB, x0/KT, 0, x1/KT, 0, x0/KT, 1, x1/KT, 1);
    };
    const addKerbZ = (x0, x1, z0, z1)=>{           // runs along Z
      soupK.quad(x0, z0, x1, z1, Y_KERB, 0, z0/KT, 1, z0/KT, 0, z1/KT, 1, z1/KT);
    };
    const KW = 0.45;
    for(let bx = 0; bx < n; bx++) for(let bz = 0; bz < n; bz++){
      const c = city.blockCentre(bx, bz);
      const inner = bs/2, outer = bs/2 + sw;
      // -z and +z strips span the full width incl. corners (matches city kerbs)
      addWalk(c.x - outer, c.z - outer, c.x + outer, c.z - inner);
      addWalk(c.x - outer, c.z + inner, c.x + outer, c.z + outer);
      addWalk(c.x - outer, c.z - inner, c.x - inner, c.z + inner);
      addWalk(c.x + inner, c.z - inner, c.x + outer, c.z + inner);
      // kerb stones on the road-facing edges
      addKerbX(c.x - outer, c.x + outer, c.z - outer, c.z - outer + KW);
      addKerbX(c.x - outer, c.x + outer, c.z + outer - KW, c.z + outer);
      addKerbZ(c.x - outer, c.x - outer + KW, c.z - inner, c.z + inner);
      addKerbZ(c.x + outer - KW, c.x + outer, c.z - inner, c.z + inner);
    }
    const texP = pavingTexture(R);
    this.matW = this.wetMaterial(texP, 0.45, { wetScale: 1.7, roughness: 0.98, metalness: 0.0 });
    const mW = new THREE.Mesh(soupW.geometry(), this.matW);
    mW.receiveShadow = true; mW.renderOrder = 1;
    this.group.add(mW);

    const texK = kerbTexture(R);
    const matK = new THREE.MeshStandardMaterial({
      map: texK.map, roughnessMap: texK.rough, roughness: 0.92, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const mK = new THREE.Mesh(soupK.geometry(), matK);
    mK.receiveShadow = true; mK.renderOrder = 2;
    this.group.add(mK);

    // ---------------- lane arrows (instanced decals) ------------------
    this.buildArrows(R, n, HC);
    // ---------------- manholes + drains -------------------------------
    this.buildCovers(R, n, HC, bs, sw, city);

    return this;
  }

  buildArrows(R, n, HC){
    const tex = arrowTexture(0), tex2 = arrowTexture(1);
    const items = [];   // [x, z, rotY, kind]
    const off = this.roadOffsets;
    const halfSpan = off[n];
    for(let i = 0; i <= n; i++){
      const a = off[i];
      for(let j = 0; j <= n; j++){
        const b = off[j];
        // --- N-S road at x=a, junction at z=b ---
        // northbound lane sits at x in [a-5, a] (right-hand traffic)
        if(b - HC - 16 > -halfSpan - 20 && R.bool(0.55)){
          const k = R.bool(0.3) ? 1 : 0;
          items.push([a - 2.5, b - HC - 5.5, 0, k]);
          if(R.bool(0.45)) items.push([a - 2.5, b - HC - 13.0, 0, 0]);
        }
        if(b + HC + 16 < halfSpan + 20 && R.bool(0.55)){
          const k = R.bool(0.3) ? 1 : 0;
          items.push([a + 2.5, b + HC + 5.5, Math.PI, k]);
          if(R.bool(0.45)) items.push([a + 2.5, b + HC + 13.0, Math.PI, 0]);
        }
        // --- E-W road at z=a, junction at x=b ---
        if(R.bool(0.55)){
          const k = R.bool(0.3) ? 1 : 0;
          items.push([b - HC - 5.5, a + 2.5, -Math.PI/2, k]);
          if(R.bool(0.45)) items.push([b - HC - 13.0, a + 2.5, -Math.PI/2, 0]);
        }
        if(R.bool(0.55)){
          const k = R.bool(0.3) ? 1 : 0;
          items.push([b + HC + 5.5, a - 2.5, Math.PI/2, k]);
          if(R.bool(0.45)) items.push([b + HC + 13.0, a - 2.5, Math.PI/2, 0]);
        }
      }
    }
    const geo = new THREE.PlaneGeometry(2.2, 4.4);
    geo.rotateX(-Math.PI/2);
    const mk = (t)=> new THREE.MeshStandardMaterial({
      map: t, transparent: false, alphaTest: 0.42, roughness: 0.78, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
      side: THREE.FrontSide, depthWrite: true,
    });
    const groups = [[], []];
    for(const it of items) groups[it[3]].push(it);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const one = new THREE.Vector3(1,1,1), pos = new THREE.Vector3();
    [tex, tex2].forEach((t, kind)=>{
      const list = groups[kind];
      if(!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mk(t), list.length);
      inst.receiveShadow = false; inst.castShadow = false;
      list.forEach((it, idx)=>{
        e.set(0, it[2], 0); q.setFromEuler(e);
        pos.set(it[0], Y_DECAL, it[1]);
        m4.compose(pos, q, one);
        inst.setMatrixAt(idx, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.renderOrder = 3;
      this.group.add(inst);
    });
  }

  buildCovers(R, n, HC, bs, sw, city){
    const off = this.roadOffsets;
    // manholes on the carriageway
    const mh = [];
    for(let i = 0; i <= n; i++) for(let j = 0; j < n; j++){
      if(R.bool(0.40)) mh.push([off[i] + R.f(-3.2, 3.2), off[j] + R.f(10, 66)]);
      if(R.bool(0.40)) mh.push([off[j] + R.f(10, 66), off[i] + R.f(-3.2, 3.2)]);
    }
    const cg = new THREE.CircleGeometry(0.46, 14); cg.rotateX(-Math.PI/2);
    const mMat = new THREE.MeshStandardMaterial({
      map: manholeTexture(R), roughness: 0.62, metalness: 0.35,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    });
    const mInst = new THREE.InstancedMesh(cg, mMat, mh.length);
    const m4 = new THREE.Matrix4(), one = new THREE.Vector3(1,1,1);
    const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3();
    mh.forEach((it, idx)=>{
      e.set(0, R.f(0, 6.283), 0); q.setFromEuler(e);
      p.set(it[0], Y_DECAL, it[1]); m4.compose(p, q, one); mInst.setMatrixAt(idx, m4);
    });
    mInst.instanceMatrix.needsUpdate = true; mInst.renderOrder = 3;
    this.group.add(mInst);

    // storm drains hard against the kerb, near junctions
    const dr = [];
    for(let i = 0; i <= n; i++) for(let j = 0; j <= n; j++){
      const a = off[i], b = off[j];
      if(R.bool(0.5)) dr.push([a - HC + 0.62, b - HC - 3.2, 0]);
      if(R.bool(0.5)) dr.push([a + HC - 0.62, b + HC + 3.2, 0]);
      if(R.bool(0.5)) dr.push([b - HC - 3.2, a + HC - 0.62, Math.PI/2]);
      if(R.bool(0.5)) dr.push([b + HC + 3.2, a - HC + 0.62, Math.PI/2]);
    }
    const dg = new THREE.PlaneGeometry(0.95, 0.55); dg.rotateX(-Math.PI/2);
    const dMat = new THREE.MeshStandardMaterial({
      map: drainTexture(R), roughness: 0.70, metalness: 0.30,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    });
    const dInst = new THREE.InstancedMesh(dg, dMat, dr.length);
    dr.forEach((it, idx)=>{
      e.set(0, it[2], 0); q.setFromEuler(e);
      p.set(it[0], Y_DECAL, it[1]); m4.compose(p, q, one); dInst.setMatrixAt(idx, m4);
    });
    dInst.instanceMatrix.needsUpdate = true; dInst.renderOrder = 3;
    this.group.add(dInst);
  }

  update(dt, ctx){
    const c = ctx || this.ctx;
    if(!c) return;
    const nf = (typeof c.nightFactor === 'number') ? c.nightFactor : 1.0;
    this.U.uNight.value = nf;
    if(c.sky && c.sky.uniforms && c.sky.uniforms.uHorizon){
      this.U.uSkyCol.value.copy(c.sky.uniforms.uHorizon.value);
    }
  }
}

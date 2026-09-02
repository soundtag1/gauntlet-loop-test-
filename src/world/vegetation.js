import * as THREE from 'three';
import { Rand } from '../core/rng.js';

// ---------------------------------------------------------------------------
// NEON COAST — vegetation.
//
// One hand-built low-poly palm (~200 tris: curved tapered trunk + 8 serrated
// fronds) instanced a few hundred times, plus shrub clumps and potted plants.
// Everything sways in the vertex shader off a single time uniform; nothing
// moves on the CPU. Three draw calls total.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function pushTri(idx, a, b, c){ idx.push(a, b, c); }

// --- one palm, built around the origin, trunk base at y=0 -------------------
function buildPalmGeometry(rand){
  const pos = [], nor = [], col = [], sway = [], idx = [];
  const c = new THREE.Color();
  const v = new THREE.Vector3();

  const H = 10.4;                       // trunk height
  const CURVE = 1.45;                   // lean of the trunk tip in +X
  const SEG = 7, SIDES = 6;
  const rBase = 0.40, rTop = 0.19;

  const trunkPt = (t) => new THREE.Vector3(CURVE * t * t * 1.02, H * t, CURVE * 0.22 * t * t);

  // ---- trunk -------------------------------------------------------------
  const ringStart = [];
  for (let j = 0; j <= SEG; j++){
    const t = j / SEG;
    const p = trunkPt(t);
    const r = rBase + (rTop - rBase) * Math.pow(t, 0.78);
    // slight bulge rings so the trunk reads as scaly, not a smooth cone
    const bulge = 1.0 + 0.085 * Math.sin(t * 22.0);
    ringStart.push(pos.length / 3);
    for (let i = 0; i < SIDES; i++){
      const a = (i / SIDES) * TAU + t * 0.30;
      const nx = Math.cos(a), nz = Math.sin(a);
      pos.push(p.x + nx * r * bulge, p.y, p.z + nz * r * bulge);
      nor.push(nx, 0.16, nz);
      // sun-bleached grey-brown bark, darker at the base
      c.setHex(0x7d6a55).multiplyScalar(0.62 + 0.42 * t + 0.10 * Math.sin(i * 2.1 + t * 9.0));
      col.push(c.r, c.g, c.b);
      sway.push(Math.pow(t, 1.9) * 0.30);
    }
  }
  for (let j = 0; j < SEG; j++){
    const a = ringStart[j], b = ringStart[j + 1];
    for (let i = 0; i < SIDES; i++){
      const i2 = (i + 1) % SIDES;
      pushTri(idx, a + i, b + i, a + i2);
      pushTri(idx, b + i, b + i2, a + i2);
    }
  }

  // ---- crown knuckle -----------------------------------------------------
  const top = trunkPt(1.0);
  const crownBase = pos.length / 3;
  const cr = 0.52;
  const crownPts = [[0,1,0],[1,0.15,0],[0,0.15,1],[-1,0.15,0],[0,0.15,-1],[0,-0.6,0]];
  for (const p of crownPts){
    v.set(p[0], p[1], p[2]).normalize();
    pos.push(top.x + v.x * cr, top.y + v.y * cr * 1.15, top.z + v.z * cr);
    nor.push(v.x, v.y, v.z);
    c.setHex(0x5c4c39); col.push(c.r, c.g, c.b);
    sway.push(0.34);
  }
  const CF = [[0,1,2],[0,2,3],[0,3,4],[0,4,1],[5,2,1],[5,3,2],[5,4,3],[5,1,4]];
  for (const f of CF) pushTri(idx, crownBase + f[0], crownBase + f[1], crownBase + f[2]);

  // ---- fronds ------------------------------------------------------------
  // Each frond is a V-folded strip: a raised centre rib with the two halves
  // falling away, so the leaf self-shades and reads as form rather than a flat
  // black cutout in silhouette.
  const NF = 9, RIB = 6;
  const side = new THREE.Vector3(), dir = new THREE.Vector3(), nrm = new THREE.Vector3();
  const nL = new THREE.Vector3(), nR = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < NF; k++){
    const young = k >= 6;                       // shorter, more upright inner fronds
    const az = young ? (k - 6) / 3 * TAU + 0.9 + rand.f(-0.2, 0.2)
                     : (k / 6) * TAU + rand.f(-0.16, 0.16);
    const L = young ? rand.f(2.5, 3.4) : rand.f(4.6, 6.1);
    const droop = young ? rand.f(0.55, 0.85) : rand.f(1.30, 1.95);
    const lift = young ? rand.f(1.35, 1.75) : rand.f(0.50, 1.00);
    const roll = rand.f(-0.42, 0.42);
    const W = young ? rand.f(0.50, 0.70) : rand.f(0.80, 1.16);
    const tint = rand.f(-0.16, 0.16) + (young ? 0.12 : 0);
    const fold = rand.f(0.30, 0.50);
    const ca = Math.cos(az), sa = Math.sin(az);
    const start = pos.length / 3;

    for (let j = 0; j <= RIB; j++){
      const s = j / RIB;
      // rachis: out and up, then arcing over and down
      const hx = L * s;
      const hy = L * (lift * s - droop * s * s) * 0.62;
      const px = top.x + ca * hx, py = top.y + hy + 0.35, pz = top.z + sa * hx;

      dir.set(ca, (lift - 2 * droop * s) * 0.62, sa).normalize();
      side.set(-sa, 0, ca);
      side.multiplyScalar(Math.cos(roll)).addScaledVector(up, Math.sin(roll)).normalize();
      nrm.crossVectors(side, dir).normalize();
      if (nrm.y < 0) nrm.multiplyScalar(-1);
      nL.copy(nrm).addScaledVector(side, -0.55).normalize();
      nR.copy(nrm).addScaledVector(side, 0.55).normalize();

      // serrated width -> the ragged silhouette of a palm frond
      const taperTip = Math.pow(1.0 - s, 0.55);
      const serr = 0.50 + 0.50 * Math.abs(Math.sin(s * Math.PI * 4.0));
      const w = W * (0.30 + 0.85 * Math.sin(Math.pow(s, 0.7) * Math.PI)) * taperTip * serr + 0.045;
      const h = fold * w;                        // how far the centre rib is raised

      const g = 0.40 + 0.34 * s + tint;
      const cm = 1.0;
      const sw = 0.42 + 1.15 * Math.pow(s, 1.25);

      // left edge
      c.setRGB(0.21 * g * 1.30 * 0.82, 0.54 * g * 0.82, 0.25 * g * 1.05 * 0.82);
      pos.push(px - side.x * w, py - side.y * w, pz - side.z * w);
      nor.push(nL.x, nL.y, nL.z); col.push(c.r, c.g, c.b); sway.push(sw);
      // raised centre rib (brighter — catches the sky)
      c.setRGB(0.21 * g * 1.30 * cm, 0.54 * g * cm, 0.25 * g * 1.05 * cm);
      pos.push(px + nrm.x * h, py + nrm.y * h, pz + nrm.z * h);
      nor.push(nrm.x, nrm.y, nrm.z); col.push(c.r, c.g, c.b); sway.push(sw);
      // right edge
      c.setRGB(0.21 * g * 1.30 * 0.90, 0.54 * g * 0.90, 0.25 * g * 1.05 * 0.90);
      pos.push(px + side.x * w, py + side.y * w, pz + side.z * w);
      nor.push(nR.x, nR.y, nR.z); col.push(c.r, c.g, c.b); sway.push(sw);
    }
    for (let j = 0; j < RIB; j++){
      const a0 = start + j * 3, b0 = a0 + 3;
      pushTri(idx, a0, b0, a0 + 1);
      pushTri(idx, b0, b0 + 1, a0 + 1);
      pushTri(idx, a0 + 1, b0 + 1, a0 + 2);
      pushTri(idx, b0 + 1, b0 + 2, a0 + 2);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// --- shrub / grass clump: squashed low-poly dome ----------------------------
function buildShrubGeometry(){
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  const col = [];
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++){
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // squash into a clump and roughen it
    const n = 0.78 + 0.35 * Math.abs(Math.sin(x * 5.1 + z * 3.3 + y * 2.2));
    p.setXYZ(i, x * n, Math.max(y, -0.15) * 0.62 * n + 0.42, z * n);
    const up = (y + 1) * 0.5;
    c.setRGB(0.15 + 0.17 * up, 0.31 + 0.25 * up, 0.16 + 0.12 * up);
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const sw = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) sw[i] = Math.max(0, p.getY(i)) * 0.30;
  g.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  return g;
}

// --- potted plant: hex pot + leafy blob -------------------------------------
function buildPotGeometry(){
  const pos = [], nor = [], col = [], sway = [], idx = [];
  const c = new THREE.Color();
  const S = 6, rB = 0.32, rT = 0.42, hP = 0.62;
  const base = 0;
  for (let ring = 0; ring < 2; ring++){
    const r = ring ? rT : rB, y = ring ? hP : 0;
    for (let i = 0; i < S; i++){
      const a = (i / S) * TAU;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      nor.push(Math.cos(a), 0.25, Math.sin(a));
      c.setHex(ring ? 0xb98a6a : 0x8d6650); col.push(c.r, c.g, c.b);
      sway.push(0);
    }
  }
  for (let i = 0; i < S; i++){
    const i2 = (i + 1) % S;
    pushTri(idx, base + i, base + S + i, base + i2);
    pushTri(idx, base + S + i, base + S + i2, base + i2);
  }
  // leaves: 5 blades fanning up
  const v = new THREE.Vector3();
  for (let k = 0; k < 5; k++){
    const a = (k / 5) * TAU + 0.4;
    const lean = 0.42 + (k % 2) * 0.20;
    const L = 1.15 + (k % 3) * 0.18;
    const st = pos.length / 3;
    for (let j = 0; j <= 3; j++){
      const s = j / 3;
      const px = Math.cos(a) * lean * L * s * s, pz = Math.sin(a) * lean * L * s * s;
      const py = hP + L * s * (1.15 - 0.35 * s);
      const w = 0.20 * (1 - s * 0.75) + 0.02;
      v.set(-Math.sin(a), 0, Math.cos(a));
      pos.push(px - v.x * w, py, pz - v.z * w);
      nor.push(0, 1, 0);
      pos.push(px + v.x * w, py, pz + v.z * w);
      nor.push(0, 1, 0);
      c.setRGB(0.20 + 0.10 * s, 0.44 + 0.16 * s, 0.22);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      const sw = 0.5 + s * 0.9;
      sway.push(sw, sw);
    }
    for (let j = 0; j < 3; j++){
      const a0 = st + j * 2, b0 = a0 + 2;
      pushTri(idx, a0, b0, a0 + 1);
      pushTri(idx, b0, b0 + 1, a0 + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// --- beach umbrella: 12 panelled canopy with a scalloped drooping rim -------
function buildUmbrellaGeometry(){
  const pos = [], nor = [], col = [], sway = [], idx = [];
  const c = new THREE.Color();
  const N = 12, R = 2.15, poleH = 3.15;
  const h0 = poleH, h1 = poleH - 0.30, h2 = poleH - 0.88;

  // pole
  const pr = 0.055, base = 0;
  for (let ring = 0; ring < 2; ring++){
    const y = ring ? poleH + 0.10 : 0;
    for (let i = 0; i < 6; i++){
      const a = (i / 6) * TAU;
      pos.push(Math.cos(a) * pr, y, Math.sin(a) * pr);
      nor.push(Math.cos(a), 0.1, Math.sin(a));
      c.setHex(0xcfc6b4).multiplyScalar(ring ? 1.0 : 0.66);
      col.push(c.r, c.g, c.b);
      sway.push(ring ? 0.05 : 0);
    }
  }
  for (let i = 0; i < 6; i++){
    const i2 = (i + 1) % 6;
    pushTri(idx, base + i, base + 6 + i, base + i2);
    pushTri(idx, base + 6 + i, base + 6 + i2, base + i2);
  }

  // canopy — each panel gets its own vertices so the colours stay crisp
  const PAL = [0xf2f0ea, 0xe2564f, 0xf2f0ea, 0x2fa8b8, 0xf2f0ea, 0xf0a83c];
  for (let k = 0; k < N; k++){
    const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU, am = (a0 + a1) * 0.5;
    const P = (r, a, y) => { pos.push(Math.cos(a) * r, y, Math.sin(a) * r); };
    const st = pos.length / 3;
    const tone = PAL[k % PAL.length];
    P(0, a0, h0);                       // 0 apex
    P(0.50 * R, a0, h1);                // 1 rib mid
    P(0.53 * R, am, h1 - 0.10);         // 2 sag mid
    P(0.50 * R, a1, h1);                // 3 rib mid
    P(R, a0, h2);                       // 4 rib tip
    P(1.03 * R, am, h2 - 0.30);         // 5 scallop droop
    P(R, a1, h2);                       // 6 rib tip
    for (let v = 0; v < 7; v++){
      nor.push(0, 1, 0);
      // ribs slightly darker than the sagging fabric between them: reads as
      // panels rather than one flat disc
      const ribby = (v === 0 || v === 1 || v === 3 || v === 4 || v === 6) ? 0.86 : 1.0;
      c.setHex(tone).multiplyScalar(ribby);
      col.push(c.r, c.g, c.b);
      sway.push(v >= 4 ? 0.16 : 0.07);
    }
    pushTri(idx, st + 0, st + 1, st + 2); pushTri(idx, st + 0, st + 2, st + 3);
    pushTri(idx, st + 1, st + 4, st + 5); pushTri(idx, st + 1, st + 5, st + 2);
    pushTri(idx, st + 2, st + 5, st + 6); pushTri(idx, st + 2, st + 6, st + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// --- sun lounger: slatted seat + raised back on short legs ------------------
function buildLoungerGeometry(){
  const pos = [], nor = [], col = [], sway = [], idx = [];
  const c = new THREE.Color();
  const box = (cx, cy, cz, w, h, d, hex, pitch = 0) => {
    const st = pos.length / 3;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const P = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
    for (const [x, y, z] of P){
      const lx = x * w * 0.5, ly = y * h * 0.5, lz = z * d * 0.5;
      // pitch about X so the backrest can lean
      const ry = ly * cp - lz * sp, rz = ly * sp + lz * cp;
      pos.push(cx + lx, cy + ry, cz + rz);
      nor.push(x, y, z);
      c.setHex(hex); col.push(c.r, c.g, c.b);
      sway.push(0);
    }
    const F = [[0,1,2],[0,2,3],[5,4,7],[5,7,6],[4,0,3],[4,3,7],[1,5,6],[1,6,2],[3,2,6],[3,6,7],[4,5,1],[4,1,0]];
    for (const f of F) pushTri(idx, st + f[0], st + f[1], st + f[2]);
  };
  const frame = 0xe8e4dc, fabric = 0xdfe6ea;
  box(0, 0.20, 0, 0.10, 0.40, 1.75, frame);            // side rails
  box(0, 0.20, 0, 0.60, 0.36, 0.10, frame);
  box(0, 0.44, -0.12, 0.62, 0.09, 1.45, fabric);       // seat pad
  box(0, 0.74, 0.62, 0.62, 0.09, 0.86, fabric, -0.72); // raised back
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// --- beach towel: a striped rectangle lying on the sand ---------------------
function buildTowelGeometry(){
  const pos = [], nor = [], col = [], sway = [], idx = [];
  const c = new THREE.Color();
  const STR = 5, W = 0.95, L = 1.9;
  for (let i = 0; i <= STR; i++){
    const t = i / STR;
    for (const sgn of [-1, 1]){
      pos.push(sgn * W * 0.5, 0, (t - 0.5) * L);
      nor.push(0, 1, 0);
      c.setHex(i % 2 ? 0xf0f0ea : 0xe0564f);
      col.push(c.r, c.g, c.b);
      sway.push(0);
    }
  }
  for (let i = 0; i < STR; i++){
    const a = i * 2, b = a + 2;
    pushTri(idx, a, b, a + 1);
    pushTri(idx, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class Vegetation {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Vegetation';
    scene.add(this.group);
    this.uTime = { value: 0 };
    this.t = 0;
  }

  // material shared by every plant: cheap lambert + vertex-shader sway
  makeMat(swayAmp, side){
    // MeshStandardMaterial so the project's neon light rig (which only patches
    // standard/physical materials) can inject its forward light loop — palms
    // near a magenta sign must pick up magenta.
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, side, flatShading: false,
      roughness: 0.88, metalness: 0.0,
    });
    const uTime = this.uTime;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.uniforms.uSwayAmp = { value: swayAmp };
      sh.vertexShader = `
        uniform float uTime; uniform float uSwayAmp;
        attribute float aSway;
        #ifdef USE_INSTANCING
        attribute float aPhase;
        #endif
      ` + sh.vertexShader;
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = aPhase;
        #else
          float ph = 0.0;
        #endif
        float w = aSway * uSwayAmp;
        float t1 = uTime * 0.85 + ph;
        float flut = smoothstep(0.45, 1.35, aSway);
        transformed.x += (sin(t1) * 0.55 + sin(t1 * 2.7 + 1.3) * 0.22 * flut) * w;
        transformed.z += (cos(t1 * 0.83 + 0.7) * 0.42 + sin(t1 * 3.1 + ph) * 0.18 * flut) * w;
        transformed.y -= abs(sin(t1)) * 0.10 * w;
      `);
      // Foliage is two-sided: force every normal to point skyward so the
      // undersides of fronds are not shaded black.
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        {
          vec3 vUpF = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          if (dot(normal, vUpF) < 0.0) normal = -normal;
          normal = normalize(mix(normal, vUpF, 0.18));
        }
      `);
    };
    m.customProgramCacheKey = () => 'veg-sway-' + swayAmp;
    return m;
  }

  // world-space ground height, matching the beach ramp where there is sand
  groundY(x, z){
    const w = this.ctx && this.ctx.water;
    if (w && w.heightAt) return w.heightAt(x, z);
    return 0;
  }

  blocked(x, z, rad){
    const city = this.ctx.city;
    if (city.isRoad(x, z)) return true;
    const cell = this._grid, cs = this._cs;
    const gx = Math.floor(x / cs), gz = Math.floor(z / cs);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++){
      const list = cell.get(((gx + i) * 7919) ^ (gz + j));
      if (!list) continue;
      for (const b of list){
        if (Math.abs(x - b.x) < b.w * 0.5 + rad && Math.abs(z - b.z) < b.d * 0.5 + rad) return true;
      }
    }
    return false;
  }

  build(){
    const ctx = this.ctx, city = ctx.city;
    const rand = new Rand((ctx.seed || 1337) + 4421);

    // spatial hash of buildings for fast rejection
    this._cs = 48;
    this._grid = new Map();
    for (const b of city.buildings){
      const gx = Math.floor(b.x / this._cs), gz = Math.floor(b.z / this._cs);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++){
        const k = ((gx + i) * 7919) ^ (gz + j);
        if (!this._grid.has(k)) this._grid.set(k, []);
      }
      const k = (gx * 7919) ^ gz;
      this._grid.get(k).push(b);
      // also register in neighbours so wide buildings are still found
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++){
        if (!i && !j) continue;
        const kk = ((gx + i) * 7919) ^ (gz + j);
        this._grid.get(kk).push(b);
      }
    }

    // ------------------------------------------------------------------ palms
    const palms = [];
    const half = city.span / 2, s = city.stride;
    const water = ctx.water;
    const shoreR = (water && water.shoreRadiusAt) ? water.shoreRadiusAt : null;
    const cityEdge = (water && water.cityEdge) || 545;

    // (a) beach front — a promenade row of palms following the shoreline,
    // dense along the +Z beach district, thinning round the rest of the island
    const shoreAt = (th) => (shoreR ? shoreR(th) : (cityEdge + 90) /
      Math.max(Math.abs(Math.cos(th)), Math.abs(Math.sin(th))));
    for (let th = 0; th < TAU; th += 0.042){
      const facingZ = Math.max(0, Math.sin(th));
      const dens = 0.10 + 0.90 * facingZ * facingZ;
      if (!rand.bool(dens)) continue;
      const R0 = shoreAt(th + rand.f(-0.012, 0.012));
      // front row on the dry sand, plus an occasional second row behind it
      const rows = rand.bool(0.34) ? 2 : 1;
      for (let k = 0; k < rows; k++){
        const back = k === 1 ? rand.f(34, 62) : 0;
        const r = R0 - rand.f(46, 82) - back;
        const inner = cityEdge / Math.max(Math.abs(Math.cos(th)), Math.abs(Math.sin(th)));
        if (r < inner + 4) continue;
        const x = Math.cos(th) * r, z = Math.sin(th) * r;
        if (city.isRoad(x, z) || this.blocked(x, z, 2.0)) continue;
        palms.push({ x, z, sc: rand.f(0.9, 1.55), lean: rand.f(0.06, 0.34) });
      }
    }

    // (b) boulevard rows — palms marching down the sidewalk verges
    const PALM_CAP = 360;
    const boulevards = [2, 4, 7, 10, 12];
    for (const bi of boulevards){
      const off = -half + bi * s;
      for (const sgn of [-1, 1]){
        for (let d = -half + 20; d < half - 20; d += rand.f(15, 22)){
          if (palms.length >= PALM_CAP) break;
          const lat = off + sgn * rand.f(9.2, 10.4);
          // north-south boulevard
          if (rand.bool(0.80) && !city.isRoad(lat, d) && !this.blocked(lat, d, 1.5))
            palms.push({ x: lat, z: d, sc: rand.f(0.9, 1.25), lean: rand.f(0.02, 0.14) });
          // east-west boulevard
          const lat2 = off + sgn * rand.f(9.2, 10.4);
          if (rand.bool(0.80) && !city.isRoad(d, lat2) && !this.blocked(d, lat2, 1.5))
            palms.push({ x: d, z: lat2, sc: rand.f(0.9, 1.25), lean: rand.f(0.02, 0.14) });
        }
      }
    }

    // (c) scattered in blocks / plazas
    for (let i = 0; i < 700 && palms.length < PALM_CAP; i++){
      const x = rand.f(-half + 10, half - 10), z = rand.f(-half + 10, half - 10);
      if (city.isRoad(x, z) || this.blocked(x, z, 3.0)) continue;
      palms.push({ x, z, sc: rand.f(0.8, 1.3), lean: rand.f(0.03, 0.26) });
    }

    const palmGeo = buildPalmGeometry(new Rand((ctx.seed || 1337) + 77));
    const palmMat = this.makeMat(1.0, THREE.DoubleSide);
    const palmMesh = new THREE.InstancedMesh(palmGeo, palmMat, palms.length);
    palmMesh.castShadow = true;
    palmMesh.frustumCulled = false;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    const e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
    const phase = new Float32Array(palms.length);
    palms.forEach((p, i) => {
      const yaw = rand.f(0, TAU), leanDir = rand.f(0, TAU);
      e.set(Math.cos(leanDir) * p.lean, yaw, Math.sin(leanDir) * p.lean, 'YXZ');
      q.setFromEuler(e);
      sv.set(p.sc * rand.f(0.9, 1.08), p.sc, p.sc * rand.f(0.9, 1.08));
      pv.set(p.x, this.groundY(p.x, p.z) - 0.15, p.z);
      m4.compose(pv, q, sv);
      palmMesh.setMatrixAt(i, m4);
      phase[i] = rand.f(0, TAU);
    });
    palmMesh.instanceMatrix.needsUpdate = true;
    palmGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    this.group.add(palmMesh);
    this.palms = palmMesh;

    // ----------------------------------------------------------------- shrubs
    const shrubs = [];
    for (let i = 0; i < 2600 && shrubs.length < 500; i++){
      const mode = rand.f(0, 1);
      let x, z;
      if (mode < 0.42){
        // verges beside roads
        const bi = rand.i(0, city.n);
        const off = -half + bi * s;
        const d = rand.f(-half + 12, half - 12);
        const lat = off + (rand.bool() ? 1 : -1) * rand.f(9.0, 12.5);
        if (rand.bool()){ x = lat; z = d; } else { x = d; z = lat; }
      } else if (mode < 0.72){
        // sea grass on the sand
        const th = rand.f(0, TAU);
        const facingZ = Math.max(0, Math.sin(th));
        if (rand.f(0, 1) > 0.15 + 0.85 * facingZ * facingZ) continue;
        const inner = cityEdge / Math.max(Math.abs(Math.cos(th)), Math.abs(Math.sin(th)));
        const outer = shoreR ? shoreR(th) : inner + 90;
        const r = inner - rand.f(0, 20) + (outer - inner) * Math.pow(rand.f(0, 1), 2.2) * 0.5;
        x = Math.cos(th) * r; z = Math.sin(th) * r;
      } else {
        x = rand.f(-half, half); z = rand.f(-half, half);
      }
      if (city.isRoad(x, z) || this.blocked(x, z, 1.2)) continue;
      shrubs.push({ x, z, sc: rand.f(0.7, 2.1) });
    }
    const shrubGeo = buildShrubGeometry();
    const shrubMat = this.makeMat(0.55, THREE.FrontSide);
    const shrubMesh = new THREE.InstancedMesh(shrubGeo, shrubMat, shrubs.length);
    shrubMesh.frustumCulled = false;
    const sPhase = new Float32Array(shrubs.length);
    shrubs.forEach((p, i) => {
      q.setFromEuler(e.set(0, rand.f(0, TAU), 0, 'YXZ'));
      sv.set(p.sc * rand.f(0.8, 1.3), p.sc * rand.f(0.55, 0.95), p.sc * rand.f(0.8, 1.3));
      pv.set(p.x, this.groundY(p.x, p.z) - 0.05, p.z);
      m4.compose(pv, q, sv);
      shrubMesh.setMatrixAt(i, m4);
      sPhase[i] = rand.f(0, TAU);
    });
    shrubMesh.instanceMatrix.needsUpdate = true;
    shrubGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(sPhase, 1));
    this.group.add(shrubMesh);
    this.shrubs = shrubMesh;

    // ------------------------------------------------------------------ pots
    const pots = [];
    for (const b of city.buildings){
      if (pots.length >= 220) break;
      if (!rand.bool(0.16)) continue;
      const side2 = rand.i(0, 3);
      const ox = (side2 === 0 ? -1 : side2 === 1 ? 1 : 0) * (b.w * 0.5 + 1.1);
      const oz = (side2 === 2 ? -1 : side2 === 3 ? 1 : 0) * (b.d * 0.5 + 1.1);
      const jx = (side2 < 2 ? rand.f(-b.d * 0.3, b.d * 0.3) : 0);
      const x = b.x + ox + (side2 >= 2 ? rand.f(-b.w * 0.3, b.w * 0.3) : 0);
      const z = b.z + oz + (side2 < 2 ? jx : 0);
      if (city.isRoad(x, z)) continue;
      pots.push({ x, z, sc: rand.f(0.85, 1.5) });
    }
    const potGeo = buildPotGeometry();
    const potMat = this.makeMat(0.35, THREE.DoubleSide);
    const potMesh = new THREE.InstancedMesh(potGeo, potMat, pots.length);
    potMesh.frustumCulled = false;
    const pPhase = new Float32Array(pots.length);
    pots.forEach((p, i) => {
      q.setFromEuler(e.set(0, rand.f(0, TAU), 0, 'YXZ'));
      sv.setScalar(p.sc);
      pv.set(p.x, 0.02, p.z);
      m4.compose(pv, q, sv);
      potMesh.setMatrixAt(i, m4);
      pPhase[i] = rand.f(0, TAU);
    });
    potMesh.instanceMatrix.needsUpdate = true;
    potGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(pPhase, 1));
    this.group.add(potMesh);
    this.pots = potMesh;

    this.counts = { palms: palms.length, shrubs: shrubs.length, pots: pots.length,
      tris: (palmGeo.index.count / 3) * palms.length + (shrubGeo.index ? shrubGeo.index.count / 3 : 20) * shrubs.length + (potGeo.index.count / 3) * pots.length };
    return this;
  }

  update(dt){
    this.t += dt;
    this.uTime.value = this.t;
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rand } from '../core/rng.js';
import { districtAt } from './city.js';

// ---------------------------------------------------------------------------
// PROPS & NEON  —  street furniture + the neon layer of NEON COAST.
//
// Everything here is instanced: the whole module is ~10 draw calls.
// No real lights are added. Every "light" is emissive geometry plus additive
// gradient billboards (ground pools + haze cones) so UnrealBloomPass
// (threshold 0.72) does the glowing for us.
// ---------------------------------------------------------------------------

const NEON = [0xff2f8e, 0x23e0d5, 0xffcf3f, 0xff2f8e, 0x23e0d5, 0xff6ad5, 0x9d7bff, 0xfff2c8];
const LAMP_WARM = 0xffb264;

function radialGlowTexture(){
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.82)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.34)');
  grd.addColorStop(0.70, 'rgba(255,255,255,0.09)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function coneHazeTexture(){
  const W = 8, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);   // image top == v=1 == cone apex
  grd.addColorStop(0.00, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.34)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.08)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Props {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Props';
    scene.add(this.group);
    this.t = 0;
    this.flick = [];
    // batches: {p:[x,y,z], s:[x,y,z], r:[rx,ry,rz], c:[r,g,b]}
    this.B = { neon: [], flick: [], plate: [], glow: [], cone: [], pole: [], furn: [], hyd: [], glass: [] };
    this._cable = [];
  }

  // -------------------------------------------------------------- helpers
  push(list, px, py, pz, sx, sy, sz, ry, col, rx = 0){
    list.push({ p: [px, py, pz], s: [sx, sy, sz], r: [rx, ry, 0], c: col });
  }
  // emissive box. hex + intensity -> linear colour possibly > 1 so bloom bites.
  neonCol(hex, intensity){
    const c = new THREE.Color(hex); c.multiplyScalar(intensity);
    return [c.r, c.g, c.b];
  }
  addNeon(px, py, pz, sx, sy, sz, ry, hex, inten, flicker, R){
    const col = this.neonCol(hex, inten);
    if(flicker){
      const i = this.B.flick.length;
      this.push(this.B.flick, px, py, pz, sx, sy, sz, ry, col);
      this.flick.push({ i, r: col[0], g: col[1], b: col[2],
        ph: R.f(0, 6.28), sp: R.f(0.7, 5.0), kind: R.bool(0.4) ? 1 : 0 });
    } else {
      this.push(this.B.neon, px, py, pz, sx, sy, sz, ry, col);
    }
  }
  addGlow(px, py, pz, sx, sy, ry, hex, inten, rx = 0){
    this.push(this.B.glow, px, py, pz, sx, sy, 1, ry, this.neonCol(hex, inten), rx);
  }
  addFurn(px, py, pz, sx, sy, sz, ry, hex){
    const c = new THREE.Color(hex);
    this.push(this.B.furn, px, py, pz, sx, sy, sz, ry, [c.r, c.g, c.b]);
  }

  // ------------------------------------------------------------------ build
  build(){
    const ctx = this.ctx;
    if(!ctx || !ctx.city) return this;
    this.glowTex = radialGlowTexture();
    this.coneTex = coneHazeTexture();
    const R = new Rand((ctx.seed | 0) + 4241);
    try {
      this.buildSigns(R);
      this.buildStreet(R);
    } catch(e){ console.error('Props build failed:', e.message); }
    this.commit();
    return this;
  }

  // ---- neon signage on building faces -----------------------------------
  buildSigns(R){
    const city = this.ctx.city;
    for(const b of city.buildings){
      const faces = [];
      const cand = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for(const [nx, nz] of cand){
        const half = nx ? b.w / 2 : b.d / 2;
        const px = b.x + nx * (half + 5.0), pz = b.z + nz * (half + 5.0);
        if(city.isRoad(px, pz)) faces.push({ nx, nz, half, along: nx ? b.d : b.w });
      }
      if(!faces.length) continue;
      const neon = b.neon;
      for(const f of faces){
        this.facadeProps(b, f, neon, R);
      }
      // rooftop signage on the taller stock
      if(b.h >= 22 && R.bool(neon * 0.75)){
        const f = faces[R.i(0, faces.length - 1)];
        this.roofSign(b, f, R);
      }
    }
  }

  // world point on a face: u = along-tangent offset, o = outward offset
  fpt(b, f, u, o){
    const tx = -f.nz, tz = f.nx;
    return [ b.x + f.nx * (f.half + o) + tx * u, b.z + f.nz * (f.half + o) + tz * u ];
  }

  facadeProps(b, f, neon, R){
    const ry = Math.atan2(f.nx, f.nz);
    const maxU = f.along * 0.42;
    const hex = () => NEON[R.i(0, NEON.length - 1)];

    // ---- horizontal box sign over the shopfront -------------------------
    if(R.bool(0.30 + neon * 0.62)){
      const w = Math.min(f.along * R.f(0.42, 0.72), 10), h = R.f(1.2, 2.0);
      const u = R.f(-maxU + w / 2, maxU - w / 2), y = R.f(3.6, 5.4);
      const c = hex(), inten = R.f(2.0, 3.6), fl = R.bool(0.22);
      let [x, z] = this.fpt(b, f, u, 0.06);
      this.push(this.B.plate, x, y, z, w + 0.7, h + 0.6, 0.22, ry, [0.06, 0.06, 0.09]);
      [x, z] = this.fpt(b, f, u, 0.26);
      this.addNeon(x, y, z, w, h, 0.22, ry, c, inten, fl, R);
      [x, z] = this.fpt(b, f, u, 0.16);
      this.addGlow(x, y, z, w * 2.1, h * 4.2, ry, c, R.f(0.7, 1.1));
    }

    // ---- vertical blade sign hanging off the wall -----------------------
    if(R.bool(0.10 + neon * 0.45)){
      const dep = R.f(1.6, 2.6), h = Math.min(R.f(4.0, 8.0), Math.max(b.h - 3.0, 2.5));
      const u = R.f(-maxU, maxU), y = R.f(5.0, 6.0) + h / 2;
      const c = hex(), inten = R.f(2.2, 3.8), fl = R.bool(0.3);
      const [x, z] = this.fpt(b, f, u, 0.15 + dep / 2);
      this.addNeon(x, y, z, dep, h, 0.24, ry + Math.PI / 2, c, inten, fl, R);
      this.addGlow(x, y, z, dep * 2.6, h * 1.5, ry + Math.PI / 2, c, R.f(0.55, 0.9));
      // little bracket back to the wall
      const [bx2, bz2] = this.fpt(b, f, u, 0.15 + dep * 0.25);
      this.addFurn(bx2, y + h / 2 - 0.2, bz2, dep * 0.5, 0.14, 0.14, ry + Math.PI / 2, 0x1a1a22);
    }

    // ---- tube-outline rectangle (window neon) ---------------------------
    if(R.bool(0.08 + neon * 0.40)){
      const w = Math.min(f.along * R.f(0.22, 0.40), 5.5), h = R.f(1.6, 3.0);
      const u = R.f(-maxU + w / 2, maxU - w / 2), y = R.f(3.4, 4.8);
      const c = hex(), inten = R.f(2.4, 4.0), t = 0.2, fl = R.bool(0.25);
      const seg = [[0, h / 2, w, t], [0, -h / 2, w, t], [-w / 2, 0, t, h], [w / 2, 0, t, h]];
      for(const [du, dy, sw, sh] of seg){
        const [x, z] = this.fpt(b, f, u + du, 0.24);
        this.addNeon(x, y + dy, z, sw, sh, 0.16, ry, c, inten, fl, R);
      }
      const [gx, gz] = this.fpt(b, f, u, 0.16);
      this.addGlow(gx, y, gz, w * 2.2, h * 2.6, ry, c, R.f(0.5, 0.8));
    }

    // ---- glowing letter strip -------------------------------------------
    if(R.bool(0.08 + neon * 0.36)){
      const n = R.i(4, 8), gap = R.f(0.55, 0.9);
      const wTot = n * gap;
      const u0 = R.f(-maxU + wTot / 2, maxU - wTot / 2), y = R.f(6.4, Math.max(7.0, Math.min(b.h - 2.0, 16)));
      const c = hex(), inten = R.f(2.6, 4.0), fl = R.bool(0.3);
      for(let i = 0; i < n; i++){
        const u = u0 - wTot / 2 + gap * (i + 0.5);
        const [x, z] = this.fpt(b, f, u, 0.24);
        this.addNeon(x, y + R.f(-0.08, 0.08), z, gap * 0.62, R.f(0.7, 1.0), 0.16, ry, c, inten, fl, R);
      }
      const [gx, gz] = this.fpt(b, f, u0, 0.16);
      this.addGlow(gx, y, gz, wTot * 1.7, 5.0, ry, c, R.f(0.45, 0.75));
    }

    // ---- continuous cornice strip above the ground floor ----------------
    if(R.bool(0.06 + neon * 0.42)){
      const w = f.along * 0.92, y = R.f(6.6, 7.6);
      const c = hex(), inten = R.f(1.8, 3.0);
      const [x, z] = this.fpt(b, f, 0, 0.22);
      this.addNeon(x, y, z, w, 0.22, 0.16, ry, c, inten, R.bool(0.12), R);
      this.addGlow(x, y, z, w * 1.05, 3.4, ry, c, R.f(0.4, 0.65));
    }

    // ---- AC units at window level ---------------------------------------
    if(b.h > 9 && R.bool(0.55)){
      const n = R.i(2, 5);
      for(let i = 0; i < n; i++){
        const u = R.f(-maxU, maxU), y = R.f(9.0, Math.max(9.5, b.h - 2.0));
        const [x, z] = this.fpt(b, f, u, 0.42);
        this.addFurn(x, y, z, R.f(0.8, 1.2), R.f(0.6, 0.9), 0.85, ry, 0x9a9a94);
      }
    }
  }

  roofSign(b, f, R){
    const ry = Math.atan2(f.nx, f.nz);
    const w = Math.min(f.along * R.f(0.5, 0.85), 14), h = R.f(2.4, 4.2);
    const y = b.h + 1.6 + h / 2;
    const c = NEON[R.i(0, NEON.length - 1)], inten = R.f(2.4, 4.0);
    const fl = R.bool(0.3);
    const [x, z] = this.fpt(b, f, 0, -Math.min(f.half * 0.5, 2.0));
    // legs
    this.addFurn(x - 0, 1e-3 + b.h + 0.8, z, w * 0.9, 1.6, 0.18, ry, 0x141419);
    this.addNeon(x, y, z, w, h, 0.3, ry, c, inten, fl, R);
    this.addGlow(x, y, z, w * 1.5, h * 3.0, ry, c, R.f(0.7, 1.1));
  }

  // ---- streetlights, furniture, traffic lights, utility poles -----------
  buildStreet(R){
    const city = this.ctx.city, n = city.n, s = city.stride, half = city.span / 2, rw = city.rw;
    const SP = 36;              // lamp spacing
    const EDGE = rw / 2 + 1.3;  // on the kerb
    let prevPole = null;

    for(let axis = 0; axis < 2; axis++){
      for(let i = 0; i <= n; i++){
        const off = -half + i * s;
        const side = ((i + axis) % 2) ? 1 : -1;
        prevPole = null;
        let k = 0;
        for(let u = -half + 12; u < half; u += SP, k++){
          // skip intersections
          const m = (((u + half) % s) + s) % s;
          if(m < rw + 5 || m > s - 5) continue;
          const px = axis ? u : off + side * EDGE;
          const pz = axis ? off + side * EDGE : u;
          const dx = axis ? 0 : -side, dz = axis ? -side : 0;   // toward road centre
          this.streetlight(px, pz, dx, dz, R);

          // side furniture, pushed a little further onto the pavement
          const fx = px - dx * 1.9, fz = pz - dz * 1.9;
          const fry = Math.atan2(dx, dz);
          const roll = R.f(0, 1);
          if(roll < 0.16) this.bench(fx, fz, fry, R);
          else if(roll < 0.26) this.hydrant(px + dz * 5, pz + dx * 5, R);
          else if(roll < 0.36) this.bin(fx, fz, fry, R);
          else if(roll < 0.44) this.newsbox(fx, fz, fry, R);
          else if(roll < 0.485) this.shelter(fx, fz, fry, R);

          // utility poles + catenary cables (industrial / residential edges)
          const bx = Math.round(px / s + n / 2 - 0.5), bz = Math.round(pz / s + n / 2 - 0.5);
          const d = districtAt(Math.max(0, Math.min(n - 1, bx)), Math.max(0, Math.min(n - 1, bz)), n);
          if((d === 'industrial' || d === 'residential') && (k % 2 === 0)){
            const ux = px + dz * 0.0 - dx * 0.6, uz = pz + dx * 0.0 - dz * 0.6;
            this.utilityPole(ux, uz, fry, R);
            if(prevPole) this.cable(prevPole, [ux, uz]);
            prevPole = [ux, uz];
          } else prevPole = null;
        }
      }
    }

    // traffic lights at intersections
    for(let i = 1; i < n; i++) for(let j = 1; j < n; j++){
      if(!R.bool(0.42)) continue;
      const ox = -half + i * s, oz = -half + j * s;
      const sx = R.bool() ? 1 : -1, sz = R.bool() ? 1 : -1;
      this.trafficLight(ox + sx * (rw / 2 + 1.2), oz + sz * (rw / 2 + 1.2), sx, sz, R);
    }
  }

  streetlight(px, pz, dx, dz, R){
    const ry = Math.atan2(-dz, dx);       // local +x -> (dx,dz)
    this.push(this.B.pole, px, 0.16, pz, 1, 1, 1, ry, [0.09, 0.095, 0.11]);
    const hx = px + dx * 2.05, hz = pz + dz * 2.05, hy = 8.35;
    // lamp head: emissive amber slab
    this.addNeon(hx, hy, hz, 1.15, 0.3, 0.6, ry, LAMP_WARM, 3.2, R.bool(0.06), R);
    // tight halo on the head
    this.addGlow(hx, hy - 0.1, hz, 3.4, 2.4, ry + Math.PI / 2, LAMP_WARM, 1.0);
    // haze cone hanging under the lamp
    this.push(this.B.cone, hx, hy / 2 + 0.1, hz, 3.9, hy - 0.3, 3.9, 0, this.neonCol(LAMP_WARM, 0.55));
    // ground pool
    this.push(this.B.glow, hx, 0.07, hz, 15.5, 15.5, 1, 0, this.neonCol(LAMP_WARM, 0.95), -Math.PI / 2);
  }

  bench(x, z, ry, R){
    this.addFurn(x, 0.62, z, 2.6, 0.14, 0.7, ry, 0x6b4a34);
    this.addFurn(x, 0.95, z - 0.28 * Math.cos(ry), 2.6, 0.6, 0.12, ry, 0x6b4a34);
    this.addFurn(x - 1.1 * Math.cos(ry), 0.38, z + 1.1 * Math.sin(ry), 0.14, 0.6, 0.6, ry, 0x24242c);
    this.addFurn(x + 1.1 * Math.cos(ry), 0.38, z - 1.1 * Math.sin(ry), 0.14, 0.6, 0.6, ry, 0x24242c);
  }
  bin(x, z, ry, R){
    this.addFurn(x, 0.62, z, 0.72, 1.0, 0.72, ry, 0x2b3038);
    this.addFurn(x, 1.16, z, 0.86, 0.12, 0.86, ry, 0x1a1d22);
  }
  newsbox(x, z, ry, R){
    const cols = [0xd94f3a, 0x2f6fb0, 0x3f8f5a, 0xc9a23a];
    const n = R.i(1, 3);
    for(let i = 0; i < n; i++){
      const o = (i - (n - 1) / 2) * 0.75;
      this.addFurn(x + o * Math.cos(ry), 0.72, z - o * Math.sin(ry), 0.66, 1.2, 0.6, ry, cols[R.i(0, 3)]);
    }
  }
  hydrant(x, z, R){
    const c = new THREE.Color(0xc23a2a);
    this.push(this.B.hyd, x, 0.52, z, 1, 1, 1, R.f(0, 3.14), [c.r, c.g, c.b]);
  }
  shelter(x, z, ry, R){
    const c = Math.cos(ry), s = Math.sin(ry);
    for(const o of [-2.1, 2.1]){
      this.addFurn(x + o * c, 1.45, z - o * s, 0.16, 2.6, 0.16, ry, 0x22252c);
      this.addFurn(x + o * c - 0.7 * s, 1.45, z - o * s - 0.7 * c, 0.16, 2.6, 0.16, ry, 0x22252c);
    }
    this.addFurn(x - 0.35 * s, 2.85, z - 0.35 * c, 4.7, 0.18, 1.9, ry, 0x2a2e36);
    // glass back
    this.push(this.B.glass, x - 0.75 * s, 1.5, z - 0.75 * c, 4.4, 2.5, 1, ry, [0.55, 0.78, 0.82]);
    // lit ad panel — a proper little bloom source
    const c2 = R.bool(0.5) ? 0x23e0d5 : 0xfff2c8;
    this.addNeon(x + 2.1 * c - 0.35 * s, 1.55, z - 2.1 * s - 0.35 * c, 1.3, 2.1, 0.14, ry, c2, 2.2, false, R);
    this.addGlow(x + 2.1 * c - 0.45 * s, 1.55, z - 2.1 * s - 0.45 * c, 4.0, 5.0, ry, c2, 0.6);
  }
  utilityPole(x, z, ry, R){
    this.addFurn(x, 4.6, z, 0.3, 9.2, 0.3, ry, 0x4a3c2e);
    this.addFurn(x, 8.5, z, 2.6, 0.16, 0.16, ry + Math.PI / 2, 0x4a3c2e);
    this.addFurn(x, 7.7, z, 2.0, 0.14, 0.14, ry + Math.PI / 2, 0x4a3c2e);
    this._poleTops = this._poleTops || {};
    this._poleTops[x.toFixed(2) + ',' + z.toFixed(2)] = 1;
  }
  cable(a, b){
    const [x0, z0] = a, [x1, z1] = b;
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if(dist > 90) return;
    const sag = Math.min(1.6, dist * 0.035);
    for(const [yTop, lat] of [[8.5, -0.9], [8.5, 0.9], [7.7, 0.0]]){
      const nxp = -(z1 - z0) / dist, nzp = (x1 - x0) / dist;
      const SEG = 5; let prev = null;
      for(let i = 0; i <= SEG; i++){
        const t = i / SEG;
        const x = x0 + (x1 - x0) * t + nxp * lat, z = z0 + (z1 - z0) * t + nzp * lat;
        const y = yTop - Math.sin(Math.PI * t) * sag;
        if(prev){ this._cable.push(prev[0], prev[1], prev[2], x, y, z); }
        prev = [x, y, z];
      }
    }
  }
  trafficLight(x, z, sx, sz, R){
    const ry = Math.atan2(-sx, -sz);         // arm reaches back over the junction
    this.addFurn(x, 3.2, z, 0.32, 6.4, 0.32, ry, 0x23262c);
    const ax = x - sx * 2.6, az = z - sz * 2.6;
    this.addFurn(ax, 6.3, az, 5.4, 0.18, 0.18, Math.atan2(-sx, -sz) + Math.PI / 2, 0x23262c);
    const hx = x - sx * 5.0, hz = z - sz * 5.0;
    this.addFurn(hx, 5.3, hz, 0.62, 1.7, 0.55, ry, 0x16181d);
    const phase = R.i(0, 2);
    const lens = [0xff3b30, 0xffb020, 0x2fe07a];
    for(let i = 0; i < 3; i++){
      const on = i === phase;
      const y = 5.9 - i * 0.5;
      this.addNeon(hx, y, hz - 0.0, 0.34, 0.34, 0.34, ry, lens[i], on ? 3.2 : 0.25, false, R);
      if(on) this.addGlow(hx, y, hz, 2.4, 2.4, ry, lens[i], 0.8);
    }
  }

  // ------------------------------------------------------------- commit
  mkInstanced(items, geo, mat, name, castShadow = false){
    if(!items.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    im.name = name;
    im.castShadow = castShadow; im.receiveShadow = false;
    im.frustumCulled = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    for(let i = 0; i < items.length; i++){
      const it = items[i];
      e.set(it.r[0], it.r[1], it.r[2]);
      q.setFromEuler(e);
      p.set(it.p[0], it.p[1], it.p[2]);
      sc.set(it.s[0], it.s[1], it.s[2]);
      m4.compose(p, q, sc);
      im.setMatrixAt(i, m4);
      col.setRGB(it.c[0], it.c[1], it.c[2]);
      im.setColorAt(i, col);
    }
    im.instanceMatrix.needsUpdate = true;
    if(im.instanceColor) im.instanceColor.needsUpdate = true;
    this.group.add(im);
    return im;
  }

  commit(){
    const box = new THREE.BoxGeometry(1, 1, 1);
    const plane = new THREE.PlaneGeometry(1, 1);

    this.matNeon = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
    this.matPlate = new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.85, metalness: 0.1 });
    this.matGlow = new THREE.MeshBasicMaterial({
      map: this.glowTex, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: true });
    this.matCone = new THREE.MeshBasicMaterial({
      map: this.coneTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.matFurn = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 });
    this.matGlass = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.18, metalness: 0.2, transparent: true, opacity: 0.22, side: THREE.DoubleSide });

    // one merged geometry for the whole streetlight body (pole + arm)
    const poleGeo = (() => {
      const g1 = new THREE.CylinderGeometry(0.16, 0.24, 8.2, 6, 1);
      g1.translate(0, 4.1, 0);
      const g2 = new THREE.BoxGeometry(2.3, 0.18, 0.18); g2.translate(1.15, 8.2, 0);
      const g3 = new THREE.BoxGeometry(0.5, 0.5, 0.5); g3.translate(0, 0.05, 0);
      return mergeGeometries([g1, g2, g3], false);
    })();
    const hydGeo = (() => {
      const a = new THREE.CylinderGeometry(0.2, 0.24, 0.9, 6); a.translate(0, 0, 0);
      const b = new THREE.SphereGeometry(0.2, 6, 4); b.translate(0, 0.46, 0);
      const c = new THREE.BoxGeometry(0.62, 0.14, 0.16); c.translate(0, 0.16, 0);
      return mergeGeometries([a, b, c], false);
    })();
    const coneGeo = new THREE.ConeGeometry(0.5, 1, 7, 1, true);

    this.mkInstanced(this.B.plate, box, this.matPlate, 'signPlates');
    this.mkInstanced(this.B.furn, box, this.matFurn, 'furniture', true);
    this.mkInstanced(this.B.hyd, hydGeo, this.matFurn, 'hydrants', true);
    this.poleMesh = this.mkInstanced(this.B.pole, poleGeo, this.matFurn, 'lightPoles', true);
    this.mkInstanced(this.B.glass, plane, this.matGlass, 'shelterGlass');
    this.neonMesh = this.mkInstanced(this.B.neon, box, this.matNeon, 'neonStatic');
    this.flickMesh = this.mkInstanced(this.B.flick, box, this.matNeon, 'neonFlicker');
    this.glowMesh = this.mkInstanced(this.B.glow, plane, this.matGlow, 'glowQuads');
    this.coneMesh = this.mkInstanced(this.B.cone, coneGeo, this.matCone, 'lampHaze');

    if(this._cable.length){
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this._cable, 3));
      this.cableMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0b0b11, fog: true }));
      this.cableMesh.name = 'cables';
      this.group.add(this.cableMesh);
    }

    this.stats = {
      neon: this.B.neon.length, flicker: this.B.flick.length, glow: this.B.glow.length,
      lamps: this.B.pole.length, furniture: this.B.furn.length,
      draws: this.group.children.length,
    };
    console.log('[Props]', JSON.stringify(this.stats));
    // free the build scratch
    this.B = null;
  }

  // ------------------------------------------------------------- update
  update(dt, ctx){
    this.t += dt;
    const nf = (ctx && typeof ctx.nightFactor === 'number') ? ctx.nightFactor : 1;
    const lvl = 0.16 + 0.84 * nf;
    if(this.matNeon) this.matNeon.color.setScalar(lvl);
    if(this.matGlow) this.matGlow.opacity = 0.10 + 0.85 * nf;
    if(this.matCone) this.matCone.opacity = 0.02 + 0.42 * nf;

    const fm = this.flickMesh;
    if(fm && fm.instanceColor){
      const arr = fm.instanceColor.array, t = this.t;
      for(let k = 0; k < this.flick.length; k++){
        const f = this.flick[k];
        let m;
        if(f.kind === 0){
          m = 0.62 + 0.38 * Math.sin(t * f.sp + f.ph);
        } else {
          const s = Math.sin(t * f.sp + f.ph) + Math.sin(t * f.sp * 2.71 + f.ph * 1.7);
          m = s > 0.15 ? 1.05 : (s > -0.5 ? 0.18 : 0.9);
        }
        const i3 = f.i * 3;
        arr[i3] = f.r * m; arr[i3 + 1] = f.g * m; arr[i3 + 2] = f.b * m;
      }
      fm.instanceColor.needsUpdate = true;
    }
  }
}

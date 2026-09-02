import * as THREE from 'three';
import { Rand } from '../core/rng.js';
import { Input } from '../systems/input.js';
import { CustomizeUI, DEFAULT_APPEARANCE, BUILDS, cloneAppearance } from '../ui/customize.js';

// ---------------------------------------------------------------------------
// PLAYER — a skinned low-poly humanoid (~1.75 m) with procedural locomotion.
//
// One SkinnedMesh, one MeshStandardMaterial, vertex colours: the whole body,
// clothes, hair and face are 1 draw call (+1 shadow draw). Customisation edits
// the geometry, never the material, so the neon light rig's shader patch (applied
// once at boot) survives every wardrobe change.
//
// Locomotion is foot-IK driven: the stance foot's local Z travels backwards at
// exactly the ground speed, so stride length is DERIVED from the geometry and
// feet cannot skate. Everything else (bob, pelvis yaw/list, chest counter-turn,
// arm swing, head stabilisation) hangs off the same phase accumulator.
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;

// bone name, parent, rest offset from parent
const BONE_SPEC = [
  ['hips',   null,     [0,     0.895, 0]],
  ['spine',  'hips',   [0,     0.130, 0]],
  ['chest',  'spine',  [0,     0.170, 0]],
  ['neck',   'chest',  [0,     0.185, 0]],
  ['head',   'neck',   [0,     0.075, 0]],
  ['armL',   'chest',  [ 0.170, 0.100, 0]],
  ['foreL',  'armL',   [0,    -0.275, 0]],
  ['handL',  'foreL',  [0,    -0.245, 0]],
  ['armR',   'chest',  [-0.170, 0.100, 0]],
  ['foreR',  'armR',   [0,    -0.275, 0]],
  ['handR',  'foreR',  [0,    -0.245, 0]],
  ['thighL', 'hips',   [ 0.093, 0,     0]],
  ['shinL',  'thighL', [0,    -0.425, 0]],
  ['footL',  'shinL',  [0,    -0.400, 0]],
  ['thighR', 'hips',   [-0.093, 0,     0]],
  ['shinR',  'thighR', [0,    -0.425, 0]],
  ['footR',  'shinR',  [0,    -0.400, 0]],
];
const BI = {};                                  // bone name -> index
BONE_SPEC.forEach((b, i) => BI[b[0]] = i);

const THIGH_LEN = 0.425, SHIN_LEN = 0.400, LEG_LEN = THIGH_LEN + SHIN_LEN;
const HIP_Y = 0.895, SHOULDER_Y = 0.895 + 0.130 + 0.170 + 0.100; // 1.295
const ANKLE_REST = HIP_Y - LEG_LEN;             // 0.070

// ===========================================================================
// GEOMETRY BUILDER
// ===========================================================================
class MeshBuf {
  constructor(){ this.pos=[]; this.col=[]; this.si=[]; this.sw=[]; this.idx=[]; }
  get count(){ return this.pos.length / 3; }
  vert(x,y,z, c, w){
    this.pos.push(x,y,z);
    this.col.push(c[0],c[1],c[2]);
    this.si.push(w[0]|0, w[2]|0, 0, 0);
    this.sw.push(w[1], w[3], 0, 0);
    return this.count - 1;
  }
  tri(a,b,c){ this.idx.push(a,b,c); }
  quad(a,b,c,d){ this.idx.push(a,b,d, b,c,d); }
}

// Superellipse cross-section: e<1 squares it off (torso), e=1 is a circle.
function ringPoint(a, rx, rz, e){
  const c = Math.cos(a), s = Math.sin(a);
  if(e === 1) return [c*rx, s*rz];
  const px = Math.sign(c) * Math.pow(Math.abs(c), e) * rx;
  const pz = Math.sign(s) * Math.pow(Math.abs(s), e) * rz;
  return [px, pz];
}

// A chain of rings stitched into a closed-ish tube. rings: {y,x,z,rx,rz,e,bones}
function pushTube(buf, rings, segs, colorFn, opts = {}){
  const capTop = opts.capTop !== false, capBot = opts.capBot !== false;
  let prev = null;
  for(let i = 0; i < rings.length; i++){
    const R = rings[i];
    const row = [];
    for(let j = 0; j < segs; j++){
      const a = (j / segs) * Math.PI * 2;
      const [dx, dz] = ringPoint(a, R.rx, R.rz, R.e ?? 1);
      const x = (R.x || 0) + dx, y = R.y, z = (R.z || 0) + dz;
      row.push(buf.vert(x, y, z, colorFn(x, y, z, R, a), R.bones));
    }
    if(prev){
      for(let j = 0; j < segs; j++){
        const k = (j + 1) % segs;
        buf.quad(prev[j], prev[k], row[k], row[j]);
      }
    }
    prev = row;
    if(i === 0 && capBot){
      const c = buf.vert(R.x || 0, R.y, R.z || 0, colorFn(R.x||0, R.y, R.z||0, R, 0), R.bones);
      for(let j = 0; j < segs; j++) buf.tri(c, row[(j + 1) % segs], row[j]);
    }
    if(i === rings.length - 1 && capTop){
      const c = buf.vert(R.x || 0, R.y, R.z || 0, colorFn(R.x||0, R.y, R.z||0, R, 0), R.bones);
      for(let j = 0; j < segs; j++) buf.tri(c, row[j], row[(j + 1) % segs]);
    }
  }
}

// Hard-edged box (own vertices per face so shoes/hands keep crisp silhouettes)
function pushBox(buf, cx, cy, cz, sx, sy, sz, col, bones, pitch = 0){
  const hx = sx/2, hy = sy/2, hz = sz/2;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const P = [];
  for(const [ox, oy, oz] of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]){
    let y = oy*hy, z = oz*hz;
    P.push([cx + ox*hx, cy + y*cp - z*sp, cz + y*sp + z*cp]);
  }
  const faces = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]];
  for(const f of faces){
    const v = f.map(i => buf.vert(P[i][0], P[i][1], P[i][2], col(P[i][0],P[i][1],P[i][2]), bones));
    buf.quad(v[0], v[1], v[2], v[3]);
  }
}

function pushBlob(buf, cx, cy, cz, rx, ry, rz, colorFn, bones, segs = 10, rows = 6){
  const rings = [];
  for(let i = 0; i <= rows; i++){
    const t = i / rows, phi = (t - 0.5) * Math.PI;
    rings.push({ x:cx, y:cy + Math.sin(phi)*ry, z:cz,
                 rx:Math.max(0.001, Math.cos(phi)*rx), rz:Math.max(0.001, Math.cos(phi)*rz),
                 e:1, bones });
  }
  pushTube(buf, rings, segs, colorFn, { capTop:false, capBot:false });
}

// ---------------------------------------------------------------------------
// Bone weight helpers. [indexA, weightA, indexB, weightB]
const W = (a, wa, b = 0, wb = 0) => [a, wa, b, wb];
const blend = (a, b, t) => W(a, 1 - t, b, t);

// ---------------------------------------------------------------------------
export function buildBody(app, rand){
  const B = BUILDS[app.build] || BUILDS.average;
  const buf = new MeshBuf();

  const skin  = new THREE.Color(app.skin);
  const skinD = skin.clone().multiplyScalar(0.80);
  const hair  = new THREE.Color(app.hairColor);
  const top   = new THREE.Color(app.topColor);
  const topD  = top.clone().multiplyScalar(0.72);
  const trs   = new THREE.Color(app.trouserColor);
  const shoe  = new THREE.Color(app.shoeColor);
  const sole  = shoe.clone().lerp(new THREE.Color(0xf3ece0), 0.62);
  const dark  = new THREE.Color(0x14121a);

  // baked occlusion + fabric microvariation, per vertex
  const noiseAmp = 0.045;
  function shade(c, x, y, z, extra = 1){
    let ao = 1;
    if(y < 1.53 && y > 1.40) ao *= 0.80 + 0.20 * Math.max(0, (1.53 - y) / 0.13);   // under jaw
    if(y > 1.20 && y < 1.34 && Math.abs(x) > 0.115) ao *= 0.82;                     // armpit
    if(Math.abs(x) < 0.07 && y < 0.92 && y > 0.55) ao *= 0.86;                      // inner thigh
    if(y < 0.14) ao *= 0.80 + 0.20 * (y / 0.14);                                    // ground contact
    if(z < -0.02) ao *= 0.94;                                                       // back plane
    ao *= extra;
    const n = 1 + (rand.f(-1, 1) * noiseAmp);
    return [c.r * ao * n, c.g * ao * n, c.b * ao * n];
  }
  const flat = (c, extra = 1) => (x, y, z) => shade(c, x, y, z, extra);

  // ---- torso + neck ------------------------------------------------------
  const jacket = app.top === 'jacket';
  const tw = B.torso, bl = B.belly, sh = B.shoulder;
  const pad = jacket ? 0.014 : 0;
  const torsoRings = [
    { y:0.760, rx:0.140*tw,       rz:0.104*tw*bl,  e:0.72, bones:W(BI.hips,1) },
    { y:0.860, rx:0.152*tw,       rz:0.112*tw*bl,  e:0.72, bones:W(BI.hips,1) },
    { y:0.945, rx:0.148*tw,       rz:0.110*tw*bl,  e:0.74, bones:blend(BI.hips, BI.spine, 0.25) },
    { y:1.020, rx:0.136*tw+pad,   rz:0.101*tw*bl+pad, e:0.76, bones:blend(BI.hips, BI.spine, 0.65) },
    { y:1.095, rx:0.142*tw+pad,   rz:0.104*tw*(1+(bl-1)*0.5)+pad, e:0.78, bones:blend(BI.spine, BI.chest, 0.30) },
    { y:1.175, rx:0.156*tw+pad,   rz:0.110*tw+pad, e:0.80, bones:blend(BI.spine, BI.chest, 0.72) },
    { y:1.250, rx:0.166*tw*sh+pad,rz:0.114*tw+pad, e:0.82, bones:W(BI.chest,1) },
    { y:1.318, rx:0.168*tw*sh+pad,rz:0.111*tw+pad, e:0.84, bones:W(BI.chest,1) },
    { y:1.372, rx:0.140*tw*sh,    rz:0.098*tw,     e:0.86, bones:W(BI.chest,1) },
    { y:1.418, rx:0.072,          rz:0.070,        e:1,    bones:blend(BI.chest, BI.neck, 0.55) },
    { y:1.478, rx:0.062,          rz:0.062,        e:1,    bones:blend(BI.neck, BI.head, 0.30) },
  ];
  const topHem = app.top === 'crop' ? 1.06 : 0.92;
  const tankTop = app.top === 'tank';
  pushTube(buf, torsoRings, 14, (x, y, z) => {
    if(y > 1.40) return shade(skin, x, y, z);                 // neck
    if(y < topHem) return shade(trs, x, y, z);                // waistband below the hem
    if(tankTop && y > 1.235){
      // vest: bare shoulders, straps over the front and back
      const strap = Math.abs(Math.abs(x) - 0.075) < 0.052;
      if(!strap || y > 1.35) return shade(skin, x, y, z);
    }
    return shade(top, x, y, z);
  }, { capBot:true, capTop:false });

  // collar for the jacket / shirt
  if(jacket || app.top === 'shirt'){
    pushTube(buf, [
      { y:1.372, rx:0.098, rz:0.082, e:0.9, bones:W(BI.chest,1) },
      { y:1.432, rx:0.086, rz:0.076, e:0.95, bones:blend(BI.chest,BI.neck,0.5) },
    ], 12, flat(topD), { capTop:false, capBot:false });
  }

  // ---- head --------------------------------------------------------------
  const headRings = [
    { y:1.498, z:0.000, rx:0.060, rz:0.060, bones:blend(BI.neck, BI.head, 0.55) },
    { y:1.528, z:0.008, rx:0.064, rz:0.072, bones:blend(BI.neck, BI.head, 0.86) },
    { y:1.556, z:0.010, rx:0.073, rz:0.087, bones:W(BI.head,1) },
    { y:1.588, z:0.004, rx:0.078, rz:0.095, bones:W(BI.head,1) },
    { y:1.628, z:0.000, rx:0.080, rz:0.098, bones:W(BI.head,1) },
    { y:1.668, z:-0.003, rx:0.078, rz:0.094, bones:W(BI.head,1) },
    { y:1.702, z:-0.006, rx:0.068, rz:0.080, bones:W(BI.head,1) },
    { y:1.728, z:-0.008, rx:0.044, rz:0.052, bones:W(BI.head,1) },
    { y:1.742, z:-0.008, rx:0.016, rz:0.019, bones:W(BI.head,1) },
  ];
  pushTube(buf, headRings, 14, (x, y, z) => {
    // brow ridge + slight temple shading gives the face some form
    let e = 1;
    if(z > 0.04 && y > 1.655 && y < 1.685) e = 0.94;
    return shade(skin, x, y, z, e);
  }, { capBot:false, capTop:true });

  // ears
  for(const s of [1, -1]){
    pushBlob(buf, s*0.079, 1.622, -0.004, 0.012, 0.024, 0.016, flat(skinD, 1.02), W(BI.head,1), 6, 4);
  }
  // nose
  pushBox(buf, 0, 1.600, 0.098, 0.020, 0.040, 0.026, flat(skin, 0.98), W(BI.head,1), 0.18);
  // eyes (dark almonds) + brows + mouth line
  for(const s of [1, -1]){
    pushBlob(buf, s*0.032, 1.634, 0.083, 0.019, 0.011, 0.012, flat(dark, 1), W(BI.head,1), 8, 4);
    pushBox(buf, s*0.033, 1.660, 0.082, 0.038, 0.008, 0.014, flat(hair.clone().multiplyScalar(0.8)), W(BI.head,1), 0.25);
  }
  pushBox(buf, 0, 1.566, 0.086, 0.034, 0.007, 0.012, flat(skinD, 0.8), W(BI.head,1), 0.1);

  // ---- hair --------------------------------------------------------------
  const HS = app.hairStyle;
  if(HS !== 'bald'){
    const grow = HS === 'afro' ? 0.030 : (HS === 'buzz' ? 0.004 : 0.012);
    const bottom = HS === 'buzz' ? 1.640 : 1.628;
    const rings = [];
    for(const r of headRings){
      if(r.y < bottom) continue;
      rings.push({ y:r.y + (r.y > 1.72 ? grow*0.5 : 0), z:(r.z||0),
                   rx:r.rx + grow, rz:r.rz + grow, bones:W(BI.head,1) });
    }
    rings.push({ y:1.752 + grow*0.4, z:-0.008, rx:0.012, rz:0.014, bones:W(BI.head,1) });
    pushTube(buf, rings, 14, (x, y, z) => {
      // fringe: hair sweeps lower at the front, and never over the face for buzz
      if(z > 0.02 && y < 1.660 && HS !== 'long' && HS !== 'afro') return shade(hair, x, y, z, 0.9);
      return shade(hair, x, y, z);
    }, { capBot:false, capTop:true });

    if(HS === 'long'){
      pushTube(buf, [
        { y:1.700, z:-0.030, rx:0.080, rz:0.062, e:0.9, bones:W(BI.head,1) },
        { y:1.620, z:-0.036, rx:0.086, rz:0.066, e:0.9, bones:W(BI.head,1) },
        { y:1.530, z:-0.038, rx:0.084, rz:0.060, e:0.9, bones:blend(BI.head,BI.neck,0.35) },
        { y:1.440, z:-0.036, rx:0.076, rz:0.052, e:0.9, bones:blend(BI.neck,BI.chest,0.5) },
        { y:1.380, z:-0.032, rx:0.058, rz:0.040, e:0.9, bones:W(BI.chest,1) },
      ], 12, flat(hair, 0.94), { capBot:false, capTop:false });
    }
    if(HS === 'bun'){
      pushBlob(buf, 0, 1.716, -0.070, 0.042, 0.040, 0.040, flat(hair, 0.95), W(BI.head,1), 8, 5);
    }
    if(HS === 'afro'){
      pushBlob(buf, 0, 1.672, -0.004, 0.116, 0.098, 0.112, flat(hair), W(BI.head,1), 12, 7);
    }
  }

  // ---- arms --------------------------------------------------------------
  const sleeve = app.top === 'tank' ? 1.330 : (app.top === 'tee' ? 1.150 : 0.900);
  const lw = B.limb;
  for(const s of [1, -1]){
    const L = s > 0;
    const bArm = L ? BI.armL : BI.armR, bFore = L ? BI.foreL : BI.foreR, bHand = L ? BI.handL : BI.handR;
    const x = s * 0.170;
    const armRings = [
      { y:1.372, x, rx:0.062*lw*sh, rz:0.060*lw*sh, bones:blend(BI.chest, bArm, 0.55) },
      { y:1.310, x, rx:0.058*lw,    rz:0.057*lw,    bones:blend(BI.chest, bArm, 0.88) },
      { y:1.245, x, rx:0.050*lw,    rz:0.049*lw,    bones:W(bArm,1) },
      { y:1.180, x, rx:0.046*lw,    rz:0.045*lw,    bones:W(bArm,1) },
      { y:1.130, x, rx:0.043*lw,    rz:0.042*lw,    bones:blend(bArm, bFore, 0.30) },
      { y:1.085, x, rx:0.042*lw,    rz:0.041*lw,    bones:blend(bArm, bFore, 0.72) },
      { y:1.030, x, rx:0.044*lw,    rz:0.043*lw,    bones:W(bFore,1) },
      { y:0.960, x, rx:0.039*lw,    rz:0.038*lw,    bones:W(bFore,1) },
      { y:0.895, x, rx:0.032*lw,    rz:0.032*lw,    bones:W(bFore,1) },
      { y:0.862, x, rx:0.029*lw,    rz:0.030*lw,    bones:blend(bFore, bHand, 0.55) },
    ];
    for(const r of armRings){ if(r.y > sleeve && r.y < sleeve + 0.045){ r.rx += 0.007; r.rz += 0.007; } }
    pushTube(buf, armRings, 10, (px, py, pz) =>
      shade(py > sleeve ? top : skin, px, py, pz), { capBot:false, capTop:false });
    // hand
    pushBlob(buf, x, 0.812, 0.004, 0.031*lw, 0.052, 0.023*lw, flat(skin), W(bHand,1), 8, 5);
  }

  // ---- legs --------------------------------------------------------------
  const trouser = app.trousers === 'shorts' ? 0.520 : 0.105;
  const legW = app.trousers === 'cargo' ? 1.06 : 1.0;
  for(const s of [1, -1]){
    const L = s > 0;
    const bT = L ? BI.thighL : BI.thighR, bS = L ? BI.shinL : BI.shinR, bF = L ? BI.footL : BI.footR;
    const x = s * 0.093;
    const legRings = [
      { y:0.905, x, rx:0.090*lw*legW, rz:0.090*lw*legW, bones:blend(BI.hips, bT, 0.55) },
      { y:0.840, x, rx:0.086*lw*legW, rz:0.088*lw*legW, bones:blend(BI.hips, bT, 0.85) },
      { y:0.740, x, rx:0.080*lw*legW, rz:0.082*lw*legW, bones:W(bT,1) },
      { y:0.640, x, rx:0.073*lw*legW, rz:0.076*lw*legW, bones:W(bT,1) },
      { y:0.545, x, rx:0.065*lw*legW, rz:0.068*lw*legW, bones:blend(bT, bS, 0.22) },
      { y:0.470, x, rx:0.059*lw,      rz:0.062*lw,      bones:blend(bT, bS, 0.68) },
      { y:0.400, x, rx:0.062*lw*legW, rz:0.066*lw*legW, bones:W(bS,1) },
      { y:0.310, x, rx:0.058*lw*legW, rz:0.060*lw*legW, bones:W(bS,1) },
      { y:0.200, x, rx:0.044*lw,      rz:0.048*lw,      bones:W(bS,1) },
      { y:0.100, x, rx:0.036*lw,      rz:0.040*lw,      bones:blend(bS, bF, 0.45) },
    ];
    for(const r of legRings){ if(r.y > trouser && r.y < trouser + 0.055){ r.rx += 0.008; r.rz += 0.008; } }
    pushTube(buf, legRings, 10, (px, py, pz) =>
      shade(py > trouser ? trs : skin, px, py, pz), { capBot:false, capTop:false });
    // shoe: upper + sole, hard edges
    pushBox(buf, x, 0.070, 0.042, 0.092*lw, 0.070, 0.235, flat(shoe), W(bF,1));
    pushBox(buf, x, 0.020, 0.046, 0.098*lw, 0.032, 0.245, flat(sole), W(bF,1));
    pushBox(buf, x, 0.106, -0.012, 0.086*lw, 0.060, 0.110, flat(shoe, 0.92), W(bF,1));
  }

  // ---- assemble ----------------------------------------------------------
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(buf.col, 3));
  g.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(buf.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(buf.sw, 4));
  g.setIndex(buf.idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 1.6;               // slack for animation
  return g;
}

// ===========================================================================
// PLAYER
// ===========================================================================
export class Player {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Player';
    scene.add(this.group);
    this.rand = new Rand((ctx && ctx.seed || 1337) + 4241);
    this.appearance = cloneAppearance(DEFAULT_APPEARANCE);
    this.name = 'DRIFTER';

    // motion state
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.yaw = Math.PI;                 // faces -Z (down the street toward camera 02)
    this.yawVel = 0;
    this.speed = 0;
    this.grounded = true;
    this.vy = 0;
    this.phase = 0;
    this.locoW = 0;                     // 0 idle .. 1 full stride
    this.runW = 0;
    this.landTimer = 0;
    this.airTime = 0;
    this.mode = 'customize';            // 'customize' | 'play' | 'menu'
    this.frame = 0;
    this.promptLabel = null;
    this._probeT = 0;
    this._forced = null;
    this._hudOn = true;

    // scratch — nothing here is allocated per frame
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._ik = { hipY:0, thigh:0, knee:0 };
    this._foot = [{ z:0, y:0, pitch:0 }, { z:0, y:0, pitch:0 }];
    this._lookYaw = 0; this._lookTarget = 0; this._lookT = 2;
  }

  // ---------------------------------------------------------------- build
  build(){
    const ctx = this.ctx;
    this.automated = (typeof navigator !== 'undefined' && navigator.webdriver === true) ||
                     /[?&]nointro/.test(location.search);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors:true, roughness:0.74, metalness:0.02,
      color:0xffffff, side:THREE.FrontSide,
    });

    // skeleton
    const bones = BONE_SPEC.map(([name,, off]) => {
      const b = new THREE.Bone(); b.name = name; b.position.set(off[0], off[1], off[2]); return b;
    });
    BONE_SPEC.forEach(([name, parent], i) => {
      if(parent) bones[BI[parent]].add(bones[i]);
    });
    this.bones = bones;
    this.root = bones[0];
    this.group.add(this.root);
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);

    this.mesh = new THREE.SkinnedMesh(buildBody(this.appearance, new Rand(11)), this.material);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'PlayerBody';
    this.group.add(this.mesh);
    this.mesh.bind(this.skeleton, new THREE.Matrix4());

    // spawn on the main north-south street, facing the city centre
    this.pos.set(2.6, 0, 126);
    this.pushOutOfBuildings(this.pos, 0.5);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;

    this.input = new Input({ canvas: ctx && ctx.renderer ? ctx.renderer.domElement : undefined });
    if(ctx) ctx.input = this.input;

    this.buildHud();

    if(this.automated){
      this.mode = 'play';
      this.input.state.enabled = true;
    } else {
      this.ui = new CustomizeUI({
        appearance: this.appearance,
        onChange: (a) => this.setAppearance(a),
        onStart: (a, name) => { this.name = name || 'DRIFTER'; this.startPlay(); },
      });
      this.ui.show();
      this.input.state.enabled = false;
    }
    this.applyScale();
    return this;
  }

  buildHud(){
    if(typeof document === 'undefined') return;
    const wrap = document.createElement('div');
    wrap.id = 'pl-hud';
    wrap.innerHTML =
      '<div id="pl-prompt"><span id="pl-key">E</span><span id="pl-label"></span></div>' +
      '<div id="pl-hint"></div>';
    const css = document.createElement('style');
    css.textContent = `
    #pl-hud{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:ui-monospace,"SF Mono",Menlo,monospace;display:none}
    #pl-prompt{position:absolute;left:50%;bottom:13%;transform:translateX(-50%);display:none;
      align-items:center;gap:10px;padding:9px 18px 9px 10px;border-radius:999px;
      background:linear-gradient(180deg,rgba(12,10,28,.82),rgba(8,7,20,.88));
      border:1px solid rgba(35,224,213,.45);box-shadow:0 0 26px rgba(35,224,213,.28),inset 0 0 18px rgba(35,224,213,.07);
      color:#dffcf8;font-size:14px;letter-spacing:.14em;text-transform:uppercase;backdrop-filter:blur(3px)}
    #pl-key{display:inline-grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border-radius:7px;
      background:linear-gradient(180deg,#23e0d5,#0f9f9a);color:#04121a;font-weight:800;font-size:13px;
      box-shadow:0 0 14px rgba(35,224,213,.7)}
    #pl-hint{position:absolute;left:14px;bottom:12px;color:rgba(214,238,255,.42);font-size:11px;letter-spacing:.1em}`;
    document.head.appendChild(css);
    document.body.appendChild(wrap);
    this.hud = wrap;
    this.hudPrompt = wrap.querySelector('#pl-prompt');
    this.hudLabel = wrap.querySelector('#pl-label');
    this.hudKey = wrap.querySelector('#pl-key');
    this.hudHint = wrap.querySelector('#pl-hint');
  }

  applyScale(){
    const B = BUILDS[this.appearance.build] || BUILDS.average;
    this.group.scale.setScalar(B.scale);
  }

  setAppearance(a){
    Object.assign(this.appearance, a);
    const old = this.mesh.geometry;
    this.mesh.geometry = buildBody(this.appearance, new Rand(11));
    old.dispose();
    this.applyScale();
  }

  startPlay(){
    this.mode = 'play';
    this.input.state.enabled = true;
    this.input.requestPointerLock();
    if(this.ui) this.ui.hide();
  }

  openMenu(){
    this.mode = 'menu';
    this.input.state.enabled = false;
    this.input.exitPointerLock();
    if(this.ui) this.ui.showPause();
  }

  // ------------------------------------------------------------ collision
  // Circle-vs-AABB push-out against city buildings and interior volumes.
  pushOutOfBuildings(p, r){
    const ctx = this.ctx;
    const city = ctx && ctx.city;
    if(city && city.buildings){
      const B = city.buildings;
      for(let pass = 0; pass < 2; pass++){
        for(let i = 0; i < B.length; i++){
          const b = B[i];
          const dx = p.x - b.x, dz = p.z - b.z;
          const hw = b.w * 0.5 + r, hd = b.d * 0.5 + r;
          if(dx > hw || dx < -hw || dz > hd || dz < -hd) continue;
          const px = hw - Math.abs(dx), pz = hd - Math.abs(dz);
          if(px < pz) p.x = b.x + Math.sign(dx || 1) * hw;
          else        p.z = b.z + Math.sign(dz || 1) * hd;
        }
      }
    }
    const inter = ctx && ctx.interiors;
    if(inter){
      // a doorway is an explicit hole in the collision set
      const doors = inter.doorways;
      if(Array.isArray(doors)){
        for(let i = 0; i < doors.length; i++){
          const d = doors[i];
          if(!d) continue;
          const dx = p.x - d.x, dz = p.z - d.z, rr = (d.r || 1.2) + 0.1;
          if(dx*dx + dz*dz < rr*rr) return p;      // inside a doorway: nothing blocks
        }
      }
      const cols = inter.colliders;
      if(Array.isArray(cols)){
        const feet = this.pos.y, head = this.pos.y + 1.75;
        for(let pass = 0; pass < 2; pass++){
          for(let i = 0; i < cols.length; i++){
            const c = cols[i];
            if(!c) continue;
            if(c.maxY !== undefined && c.maxY < feet + 0.12) continue;   // step over low kerbs
            if(c.minY !== undefined && c.minY > head) continue;
            const minX = c.minX - r, maxX = c.maxX + r, minZ = c.minZ - r, maxZ = c.maxZ + r;
            if(p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) continue;
            const pL = p.x - minX, pR = maxX - p.x, pD = p.z - minZ, pU = maxZ - p.z;
            const m = Math.min(pL, pR, pD, pU);
            if(m === pL) p.x = minX; else if(m === pR) p.x = maxX;
            else if(m === pD) p.z = minZ; else p.z = maxZ;
          }
        }
      }
    }
    return p;
  }

  // kerb height so the character stands ON the pavement, not through it
  groundAt(x, z){
    const city = this.ctx && this.ctx.city;
    if(!city) return 0;
    const s = city.stride, half = city.span / 2, bs = city.bs, sw = 3.0;
    const bx = Math.floor((x + half) / s), bz = Math.floor((z + half) / s);
    if(bx < 0 || bz < 0 || bx >= city.n || bz >= city.n) return 0;
    const cx = (bx - city.n / 2 + 0.5) * s, cz = (bz - city.n / 2 + 0.5) * s;
    const dx = Math.abs(x - cx), dz = Math.abs(z - cz);
    const m = Math.max(dx, dz);
    if(m <= bs / 2 + sw && m >= bs / 2 - 0.05) return 0.16;   // kerb ring
    if(m < bs / 2) return 0.16;                               // block interior
    return 0;
  }

  // ---------------------------------------------------------------- update
  update(dt, ctx){
    this.frame++;
    if(dt > 0.1) dt = 0.1;
    const inp = this.input.poll(dt, this.frame);
    this.exposeApi();

    if(this.mode === 'play'){
      if(this.input.pressed.menu) this.openMenu();
      this.step(dt, inp, ctx);
    } else {
      this.stepIdleOnly(dt);
    }
    this.animate(dt);
    this.updatePrompt(dt, ctx);
  }

  stepIdleOnly(dt){
    this.speed *= Math.exp(-6 * dt);
    this.vel.set(0, 0, 0);
    this.locoW += (0 - this.locoW) * Math.min(1, dt * 8);
  }

  step(dt, inp, ctx){
    const cam = ctx && ctx.gamecamera;
    const camYaw = cam && typeof cam.yaw === 'number' ? cam.yaw : this.yaw;

    // stick/keys are camera-relative
    let ix = inp.move.x, iy = inp.move.y;
    const mag = Math.min(1, Math.hypot(ix, iy));
    let wantX = 0, wantZ = 0;
    if(mag > 0.001){
      const sy = Math.sin(camYaw), cy = Math.cos(camYaw);
      wantX = ix * cy + iy * sy;
      wantZ = -ix * sy + iy * cy;
      const l = Math.hypot(wantX, wantZ);
      wantX /= l; wantZ /= l;
    }

    const sprint = inp.sprint;
    const target = mag < 0.001 ? 0 : (sprint ? this.RUN : this.WALK) * Math.min(1, mag * 1.25);
    const accel = mag < 0.001 ? 12.0 : (this.speed < target ? 9.0 : 11.0);
    this.speed += (target - this.speed) * Math.min(1, accel * dt);
    if(this.speed < 0.02) this.speed = 0;

    if(mag > 0.001){
      const want = Math.atan2(wantX, wantZ);
      let d = want - this.yaw;
      while(d > Math.PI) d -= Math.PI * 2;
      while(d < -Math.PI) d += Math.PI * 2;
      // turn faster when stationary, slower at speed (momentum)
      const rate = (9.0 - Math.min(5.0, this.speed)) * dt;
      const step = Math.max(-Math.abs(d), Math.min(Math.abs(d), d * Math.min(1, rate)));
      this.yaw += step;
      this.yawVel = this.yawVel * 0.82 + (step / Math.max(dt, 1e-4)) * 0.18;
    } else {
      this.yawVel *= 0.86;
    }

    // jump
    if(this.grounded && (this.input.pressed.jump)){
      this.vy = 4.9; this.grounded = false; this.airTime = 0;
    }
    if(!this.grounded){
      this.vy -= 17.5 * dt;
      this.airTime += dt;
      this.pos.y += this.vy * dt;
    }

    // integrate ground motion
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    this.vel.set(fwdX * this.speed, 0, fwdZ * this.speed);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const lim = (ctx && ctx.city ? ctx.city.span * 0.5 + 220 : 900);
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));

    this.pushOutOfBuildings(this.pos, 0.34);

    const gy = this.groundAt(this.pos.x, this.pos.z);
    if(this.grounded){
      this.pos.y += (gy - this.pos.y) * Math.min(1, dt * 14);
    } else if(this.pos.y <= gy){
      this.pos.y = gy; this.vy = 0; this.grounded = true;
      this.landTimer = 0.30;
    }
    if(this.landTimer > 0) this.landTimer -= dt;

    // stride phase — DERIVED from ground speed so feet cannot skate
    const sp = this.speed;
    this.runW += (Math.min(1, Math.max(0, (sp - 2.1) / 2.6)) - this.runW) * Math.min(1, dt * 6);
    const shuffle = Math.min(1.2, Math.abs(this.yawVel) * 0.28);
    const effective = Math.max(sp, sp < 0.25 ? shuffle : 0);
    const cyc = this.cycleLen(sp);
    if(effective > 0.02) this.phase += (effective / cyc) * Math.PI * 2 * dt;
    const want = Math.min(1, effective / 0.9);
    this.locoW += (want - this.locoW) * Math.min(1, dt * (want > this.locoW ? 9 : 6));
    if(this.phase > Math.PI * 4) this.phase -= Math.PI * 4;
  }

  get WALK(){ return 1.65; }
  get RUN(){ return 5.0; }

  // stride length per full cycle, derived from foot excursion / duty factor
  cycleLen(sp){
    const r = Math.min(1, Math.max(0, (sp - 1.4) / 3.4));
    const front = 0.34 + 0.02 * r, back = 0.44 + 0.20 * r;
    const duty = 0.62 - 0.26 * r;
    return (front + back) / duty;
  }

  // ------------------------------------------------------------- animation
  animate(dt){
    const B = this.bones;
    const w = this.locoW;
    const run = this.runW;
    const sp = this._forced ? this._forced.speed : this.speed;
    const t = this.time = (this.time || 0) + dt;

    const r = Math.min(1, Math.max(0, (sp - 1.4) / 3.4));
    const front = 0.34 + 0.02 * r, back = 0.44 + 0.20 * r;
    const duty = 0.62 - 0.26 * r;
    const E = front + back;
    const lift = 0.075 + 0.115 * r;
    const strikeY = 0.085 + 0.055 * r;
    const toeY = 0.135 + 0.150 * r;

    const ph = this.phase;
    const cyc = (x) => x - Math.floor(x);

    // ---- feet: stance travels backwards at exactly ground speed ----------
    for(let i = 0; i < 2; i++){
      const tt = cyc(ph / (Math.PI * 2) + (i === 0 ? 0 : 0.5));
      const F = this._foot[i];
      if(tt < duty){
        const s = tt / duty;
        F.z = front - E * s;
        F.y = strikeY * Math.pow(1 - s, 2.0) + toeY * Math.pow(s, 2.8) + 0.052 * (1 - Math.pow(2*s - 1, 2)) * 0.35;
        F.pitch = 0.30 * Math.pow(1 - s, 2.2) - (0.55 + 0.35 * r) * Math.pow(s, 3.0);
      } else {
        const u = (tt - duty) / (1 - duty);
        const e = u * u * (3 - 2 * u);
        F.z = -back + E * e;
        F.y = strikeY + (lift + 0.02) * Math.sin(Math.PI * Math.pow(u, 0.88));
        F.pitch = -0.45 * Math.pow(1 - u, 2.0) + 0.30 * Math.pow(u, 2.0);
      }
    }

    // ---- pelvis ----------------------------------------------------------
    const bob = (0.030 + 0.045 * r) * w;
    const hipsY = -bob * (0.5 + 0.5 * Math.cos(ph * 2));
    const sway = (0.020 + 0.010 * r) * w * Math.sin(ph);
    const pelvisYaw = (0.10 + 0.09 * r) * w * Math.sin(ph);
    const pelvisList = (0.055 + 0.03 * r) * w * Math.sin(ph);

    // idle: breathing + slow weight shift
    const breathe = Math.sin(t * 1.35) * 0.010;
    const shift = Math.sin(t * 0.42) * 0.016 * (1 - w);
    const idleTilt = Math.sin(t * 0.42 + 0.4) * 0.030 * (1 - w);

    const land = this.landTimer > 0 ? Math.sin((this.landTimer / 0.30) * Math.PI) : 0;
    const airW = this.grounded ? 0 : Math.min(1, this.airTime * 5 + 0.35);

    B[BI.hips].position.set(sway + shift, HIP_Y + hipsY - land * 0.11 - breathe * 0.3, 0);
    B[BI.hips].rotation.set(
      (0.02 + 0.12 * r) * w + land * 0.10,
      pelvisYaw,
      pelvisList + idleTilt
    );

    // ---- legs: 2-bone IK to the foot targets -----------------------------
    for(let i = 0; i < 2; i++){
      const F = this._foot[i];
      const bT = i === 0 ? BI.thighL : BI.thighR;
      const bS = i === 0 ? BI.shinL : BI.shinR;
      const bF = i === 0 ? BI.footL : BI.footR;
      const side = i === 0 ? 1 : -1;

      // blend between the idle stance and the walk cycle
      const idleZ = side * 0.0 + (i === 0 ? 0.028 : -0.030);
      const targetZ = idleZ * (1 - w) + F.z * w;
      const targetY = (ANKLE_REST * (1 - w) + F.y * w) - (land * 0.02);

      // in air: tuck instead of IK
      let thigh, knee, footPitch;
      if(airW > 0.02){
        const tuck = this.vy > 0 ? 0.35 : 0.85;
        thigh = -(0.30 + 0.30 * tuck) * (i === 0 ? 1 : 0.55);
        knee = (0.55 + 0.85 * tuck) * (i === 0 ? 1 : 0.7);
        footPitch = -0.25;
        const ik = this.solveLeg(B[BI.hips].position.y, targetY, targetZ);
        thigh = ik.thigh * (1 - airW) + thigh * airW;
        knee = ik.knee * (1 - airW) + knee * airW;
        footPitch = (F.pitch * w) * (1 - airW) + footPitch * airW;
      } else {
        const ik = this.solveLeg(B[BI.hips].position.y, targetY, targetZ);
        thigh = ik.thigh; knee = ik.knee;
        footPitch = F.pitch * w;
      }

      B[bT].rotation.set(-thigh, 0, side * (0.030 - 0.020 * r) - side * (1 - w) * 0.012);
      B[bS].rotation.x = knee + land * 0.55 + (1 - w) * 0.045;
      // absolute foot pitch = local + parent chain
      const shinAbs = -(thigh - knee);
      B[bF].rotation.x = footPitch + (thigh - knee) + land * 0.18;
      B[bF].rotation.z = 0;
      B[bF].rotation.y = 0;
    }

    // ---- spine / chest / head -------------------------------------------
    const lean = (0.045 + 0.20 * r) * w + (this.grounded ? 0 : 0.10);
    const turnLean = Math.max(-0.16, Math.min(0.16, -this.yawVel * 0.055));
    B[BI.spine].rotation.set(lean * 0.45 + breathe * 0.25, -pelvisYaw * 0.55, -pelvisList * 0.35 + turnLean * 0.5);
    B[BI.chest].rotation.set(lean * 0.55 - breathe * 0.6, -pelvisYaw * 1.15 + Math.max(-0.2, Math.min(0.2, this.yawVel * 0.05)),
                             -pelvisList * 0.5 + turnLean * 0.5);

    // head stabilisation: undo most of the chest/pelvis rotation, then look about
    this._lookT -= dt;
    if(this._lookT <= 0){ this._lookT = this.rand.f(2.6, 6.0); this._lookTarget = this.rand.f(-0.55, 0.55) * (1 - w * 0.7); }
    this._lookYaw += (this._lookTarget - this._lookYaw) * Math.min(1, dt * 2.4);
    B[BI.neck].rotation.set(-lean * 0.35, pelvisYaw * 0.5, 0);
    B[BI.head].rotation.set(
      -lean * 0.55 + Math.sin(ph * 2) * 0.012 * w + (this.grounded ? 0 : -0.12),
      pelvisYaw * 0.55 + this._lookYaw * (this.mode === 'play' ? 0.4 : 1.0),
      -turnLean * 0.35
    );

    // ---- arms ------------------------------------------------------------
    const swing = (0.42 + 0.52 * r) * w;
    const elbowBase = 0.16 + (0.55 + 0.55 * r) * w;
    for(let i = 0; i < 2; i++){
      const sgn = i === 0 ? 1 : -1;                 // L, R
      const bA = i === 0 ? BI.armL : BI.armR;
      const bF = i === 0 ? BI.foreL : BI.foreR;
      // arm opposes the same-side leg
      const psi = -sgn * swing * Math.cos(ph);
      const idleSway = Math.sin(t * 0.42 + (i ? 1.7 : 0)) * 0.030 * (1 - w);
      let pitch = psi + idleSway;
      let elbow = elbowBase + Math.max(0, -sgn * Math.cos(ph)) * (0.25 + 0.5 * r) * w;
      let splay = sgn * (0.115 + 0.055 * (1 - w) + 0.05 * r * w);
      if(airW > 0.02){
        pitch = pitch * (1 - airW) + (-1.05 - 0.5 * (this.vy > 0 ? 1 : 0)) * airW;
        elbow = elbow * (1 - airW) + 0.9 * airW;
        splay = splay * (1 - airW) + sgn * 0.32 * airW;
      }
      if(land > 0){ elbow += land * 0.4; pitch -= land * 0.25; }
      B[bA].rotation.set(-pitch, 0, splay);
      B[bF].rotation.x = -elbow;
      B[bF].rotation.z = 0;
    }

    // ---- world transform -------------------------------------------------
    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.group.rotation.y = this.yaw;
  }

  // 2-bone IK in the sagittal plane. Returns absolute thigh angle (rad, forward
  // positive) and knee flexion (rad).
  solveLeg(hipY, footY, footZ){
    const dy = hipY - footY;
    const dz = footZ;
    let d = Math.hypot(dy, dz);
    const maxD = LEG_LEN - 0.012;
    if(d > maxD) d = maxD;
    if(d < 0.22) d = 0.22;
    const cosK = (THIGH_LEN * THIGH_LEN + SHIN_LEN * SHIN_LEN - d * d) / (2 * THIGH_LEN * SHIN_LEN);
    const kneeInterior = Math.acos(Math.max(-1, Math.min(1, cosK)));
    const knee = Math.PI - kneeInterior;
    const cosA = (THIGH_LEN * THIGH_LEN + d * d - SHIN_LEN * SHIN_LEN) / (2 * THIGH_LEN * d);
    const A = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const alpha = Math.atan2(dz, Math.max(0.05, dy));
    const out = this._ik;
    out.thigh = alpha + A;
    out.knee = knee;
    return out;
  }

  // -------------------------------------------------------------- prompt
  updatePrompt(dt, ctx){
    if(!this.hud) return;
    const show = this.mode === 'play' && this._hudOn &&
                 !(ctx && ctx.gamecamera && ctx.gamecamera.harnessDriving && !this._forceHud);
    if(this.hud.style.display !== (show ? 'block' : 'none')) this.hud.style.display = show ? 'block' : 'none';
    if(!show) return;

    this._probeT -= dt;
    if(this._probeT <= 0){
      this._probeT = 0.18;
      let hit = null;
      const inter = ctx && ctx.interiors;
      if(inter && typeof inter.interact === 'function'){
        try {
          this._v.set(this.pos.x, this.pos.y + 1.0, this.pos.z);
          hit = inter.interact(this._v);
        } catch(e){ hit = null; }
      }
      const label = hit && hit.label ? String(hit.label) : null;
      if(label !== this.promptLabel){
        this.promptLabel = label;
        this.hudLabel.textContent = label || '';
        this.hudPrompt.style.display = label ? 'flex' : 'none';
      }
      this.hudKey.textContent = this.input.state.padConnected ? 'X' : 'E';
      const hint = this.input.state.padConnected
        ? 'LSTICK MOVE · RSTICK LOOK · RT SPRINT · A JUMP · X INTERACT'
        : 'WASD MOVE · MOUSE LOOK · SHIFT SPRINT · SPACE JUMP · E INTERACT · ESC MENU';
      if(this.hudHint.textContent !== hint) this.hudHint.textContent = hint;
    }
    if(this.promptLabel && this.input.pressed.interact){
      this.hudPrompt.animate ? null : null;   // (interaction handled by the interiors module)
    }
  }

  // -------------------------------------------------------- harness bridge
  exposeApi(){
    if(this._api || typeof window === 'undefined' || !window.HARNESS) return;
    this._api = true;
    const self = this;
    window.HARNESS.player = {
      teleport:(x, z, yaw)=>{ self.pos.set(x, self.groundAt(x, z), z); if(yaw !== undefined) self.yaw = yaw; self.animate(0.016); },
      pose:(mode, t)=>{
        const table = { idle:0, walk:1.65, run:5.0 };
        if(mode === 'none'){ self._forced = null; self.locoW = 0; self.speed = 0; return; }
        const sp = table[mode] !== undefined ? table[mode] : 0;
        self._forced = { speed:sp };
        self.speed = sp;
        self.runW = Math.min(1, Math.max(0, (sp - 2.1) / 2.6));
        self.locoW = Math.min(1, sp / 0.9);
        self.phase = (t || 0) * (sp > 0 ? (sp / self.cycleLen(sp)) * Math.PI * 2 : 0);
        self.grounded = true; self.airTime = 0;
        self.animate(0.016);
      },
      appearance:(a)=>{ self.setAppearance(a); },
      customize:(on)=>{
        if(on){
          if(!self.ui){
            self.ui = new CustomizeUI({
              appearance:self.appearance,
              onChange:(a)=>self.setAppearance(a),
              onStart:(a, n)=>{ self.name = n || 'DRIFTER'; self.startPlay(); },
            });
          }
          self.ui.show(); self.mode = 'customize';
        } else { if(self.ui) self.ui.hide(); self.mode = 'play'; }
      },
      hud:(on)=>{ self._hudOn = !!on; self._forceHud = !!on; },
      state:()=>({ pos:self.pos.toArray(), yaw:self.yaw, speed:self.speed, mode:self.mode,
                   phase:self.phase, locoW:self.locoW, grounded:self.grounded }),
    };
  }
}

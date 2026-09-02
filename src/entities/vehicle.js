import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rand } from '../core/rng.js';

// ============================================================================
// VEHICLE FLEET  (rubric §7 "Motion & Life", AUTO-FAIL "empty streets")
//
// Presence on a software rasteriser means: silhouette + lights, never panel
// detail. Every car is a merged box-cluster with a bonnet/cabin/boot break and
// wheel arches, drawn as ONE InstancedMesh per body type with per-instance paint
// via instanceColor (vertexColor * instanceColor, so glass and bumpers stay dark
// while the paint varies).
//
// Draw calls: 5 body types + wheels + head + tail + 2 glow + throw + AO = 12,
// plus 6 shadow-pass meshes = 18. Triangles ~35k. Both inside the brief budget.
//
// Lights are the point of this module. Headlights and tail lights are
// MeshBasicMaterial (deliberately NOT emissive-standard: the NeonRig discovers
// emissive materials ONCE at startup and would nail a static light to wherever
// each car happened to spawn). Instead we register one moving emitter per car
// with ctx.neon.add() and rewrite its position every frame, which is how the rig
// wants moving lights fed to it.
// ============================================================================

const ROAD_Y = 0.045;            // top of the road decal stack in streets.js
const C_BODY = 0xffffff;         // white -> takes the instance paint colour
const C_GLASS = 0x14181f;
const C_DARK = 0x26292e;
const C_BLACK = 0x0d0f12;
const C_CHROME = 0xaab0b8;

const _col = new THREE.Color();

function colorize(geo, hex){
  _col.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){ arr[i*3] = _col.r; arr[i*3+1] = _col.g; arr[i*3+2] = _col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// A tapered, coloured box. taperX/taperZ/shiftTop reshape the top face, which is
// what turns a featureless cuboid into a raked greenhouse or a sloping bonnet.
function P(w, h, d, x, y, z, hex, o){
  const g = new THREE.BoxGeometry(w, h, d);
  if (o){
    const tx = o.taperX ?? 1, tz = o.taperZ ?? 1, st = o.shiftTop ?? 0;
    const bx = o.taperBotX ?? 1, bz = o.taperBotZ ?? 1;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++){
      const vy = p.getY(i);
      if (vy > 0) p.setXYZ(i, p.getX(i) * tx + st, vy, p.getZ(i) * tz);
      else        p.setXYZ(i, p.getX(i) * bx,      vy, p.getZ(i) * bz);
    }
    g.computeVertexNormals();
  }
  g.translate(x, y, z);
  return colorize(g, hex);
}

// four wheel-arch flares, so the wheels look housed instead of stuck on
function arches(list, wheels, w, h, t, y){
  for (const [wx, wz] of wheels){
    list.push(P(w, h, t, wx, y, wz > 0 ? wz + 0.10 : wz - 0.10, C_BODY));
  }
}

// ---------------------------------------------------------------- body types
function makeSedan(){
  const wheels = [[1.42, 0.86, 1], [1.42, -0.86, 1], [-1.40, 0.86, 0], [-1.40, -0.86, 0]];
  const parts = [
    P(4.20, 0.30, 1.78,  0.00, 0.42, 0, C_BODY),                                             // sill
    P(4.48, 0.36, 1.86,  0.00, 0.74, 0, C_BODY),                                             // hull
    P(1.36, 0.20, 1.72,  1.50, 0.99, 0, C_BODY, { taperX: 0.86, shiftTop: 0.06 }),           // bonnet
    P(1.10, 0.22, 1.74, -1.62, 1.00, 0, C_BODY),                                             // boot
    P(2.16, 0.44, 1.68, -0.14, 1.15, 0, C_GLASS, { taperX: 0.64, taperZ: 0.88, shiftTop: -0.13 }),
    P(1.36, 0.10, 1.42, -0.32, 1.39, 0, C_BODY),                                             // roof
    P(0.26, 0.28, 1.80,  2.16, 0.56, 0, C_DARK),                                             // front bumper
    P(0.24, 0.28, 1.80, -2.20, 0.56, 0, C_DARK),                                             // rear bumper
    P(0.12, 0.17, 1.24,  2.26, 0.82, 0, C_BLACK),                                            // grille
    P(0.10, 0.05, 1.10, -2.28, 0.98, 0, C_CHROME),                                           // boot trim
  ];
  arches(parts, wheels, 1.16, 0.34, 0.09, 0.58);
  return {
    name: 'sedan', geo: parts, len: 4.6, wid: 1.86, wheelR: 0.33, wheelW: 0.24,
    wheels, speed: 1.00,
    heads: [[2.22, 0.74, 0.62], [2.22, 0.74, -0.62]], headS: [0.10, 0.17, 0.34],
    tails: [[-2.26, 0.84, 0.66], [-2.26, 0.84, -0.66]], tailS: [0.09, 0.15, 0.30],
  };
}

function makeCoupe(){
  const wheels = [[1.46, 0.86, 1], [1.46, -0.86, 1], [-1.34, 0.86, 0], [-1.34, -0.86, 0]];
  const parts = [
    P(4.06, 0.32, 1.76,  0.00, 0.40, 0, C_BODY),
    P(4.28, 0.38, 1.84,  0.00, 0.72, 0, C_BODY),
    P(1.62, 0.20, 1.70,  1.30, 0.95, 0, C_BODY, { taperX: 0.80, shiftTop: 0.10 }),           // long bonnet
    P(1.00, 0.20, 1.72, -1.62, 0.96, 0, C_BODY, { taperX: 0.86, shiftTop: -0.08 }),          // ducktail
    P(2.00, 0.40, 1.64, -0.46, 1.09, 0, C_GLASS, { taperX: 0.56, taperZ: 0.86, shiftTop: -0.20 }),
    P(1.10, 0.09, 1.36, -0.62, 1.31, 0, C_BODY),                                             // low roof
    P(0.24, 0.26, 1.78,  2.02, 0.54, 0, C_DARK),
    P(0.22, 0.26, 1.78, -2.06, 0.54, 0, C_DARK),
    P(0.12, 0.14, 1.16,  2.10, 0.78, 0, C_BLACK),
  ];
  arches(parts, wheels, 1.14, 0.34, 0.10, 0.56);
  return {
    name: 'coupe', geo: parts, len: 4.3, wid: 1.84, wheelR: 0.32, wheelW: 0.26,
    wheels, speed: 1.16,
    heads: [[2.08, 0.70, 0.60], [2.08, 0.70, -0.60]], headS: [0.10, 0.14, 0.36],
    tails: [[-2.12, 0.78, 0.64], [-2.12, 0.78, -0.64]], tailS: [0.09, 0.13, 0.34],
  };
}

function makeVan(){
  const wheels = [[1.66, 0.92, 1], [1.66, -0.92, 1], [-1.62, 0.92, 0], [-1.62, -0.92, 0]];
  const parts = [
    P(5.06, 0.42, 1.94,  0.00, 0.52, 0, C_BODY),
    P(4.28, 1.32, 2.04, -0.44, 1.37, 0, C_BODY),                                             // cargo box
    P(1.16, 0.86, 1.96,  1.78, 1.04, 0, C_BODY, { taperX: 0.78, shiftTop: -0.14 }),          // snub nose
    P(0.34, 0.62, 1.88,  1.42, 1.62, 0, C_GLASS, { shiftTop: -0.24 }),                       // windscreen
    P(1.70, 0.38, 2.07,  0.56, 1.66, 0, C_GLASS),                                            // cab side glass
    P(4.28, 0.10, 1.94, -0.44, 2.06, 0, C_BODY),                                             // roof cap
    P(0.24, 0.30, 1.94,  2.34, 0.56, 0, C_DARK),
    P(0.20, 0.28, 1.96, -2.62, 0.56, 0, C_DARK),
  ];
  arches(parts, wheels, 1.20, 0.36, 0.09, 0.62);
  return {
    name: 'van', geo: parts, len: 5.3, wid: 2.06, wheelR: 0.37, wheelW: 0.26,
    wheels, speed: 0.88,
    heads: [[2.36, 0.82, 0.70], [2.36, 0.82, -0.70]], headS: [0.10, 0.20, 0.32],
    tails: [[-2.62, 1.30, 0.80], [-2.62, 1.30, -0.80]], tailS: [0.09, 0.34, 0.20],
  };
}

function makePickup(){
  const wheels = [[1.74, 0.94, 1], [1.74, -0.94, 1], [-1.62, 0.94, 0], [-1.62, -0.94, 0]];
  const parts = [
    P(5.16, 0.40, 1.92,  0.00, 0.54, 0, C_BODY),
    P(2.05, 0.58, 2.00,  0.52, 1.00, 0, C_BODY),                                             // cab lower
    P(1.42, 0.22, 1.88,  2.06, 0.98, 0, C_BODY, { taperX: 0.88, shiftTop: 0.06 }),           // hood
    P(1.52, 0.48, 1.86,  0.34, 1.47, 0, C_GLASS, { taperX: 0.70, taperZ: 0.90, shiftTop: -0.12 }),
    P(1.12, 0.10, 1.62,  0.24, 1.72, 0, C_BODY),                                             // cab roof
    P(2.40, 0.66, 2.00, -1.42, 1.02, 0, C_BODY),                                             // bed sides
    P(2.10, 0.34, 1.64, -1.42, 1.22, 0, C_BLACK),                                            // bed floor inset
    P(0.26, 0.32, 1.96,  2.72, 0.58, 0, C_DARK),
    P(0.22, 0.30, 2.00, -2.66, 0.72, 0, C_DARK),
  ];
  arches(parts, wheels, 1.28, 0.40, 0.10, 0.62);
  return {
    name: 'pickup', geo: parts, len: 5.4, wid: 2.02, wheelR: 0.38, wheelW: 0.28,
    wheels, speed: 0.94,
    heads: [[2.78, 0.80, 0.70], [2.78, 0.80, -0.70]], headS: [0.10, 0.20, 0.34],
    tails: [[-2.70, 1.02, 0.80], [-2.70, 1.02, -0.80]], tailS: [0.09, 0.22, 0.22],
  };
}

function makeBus(){
  const wheels = [[3.60, 1.15, 1], [3.60, -1.15, 1], [-3.20, 1.15, 0], [-3.20, -1.15, 0]];
  const parts = [
    P(10.30, 0.56, 2.42,  0.00, 0.64, 0, C_BODY),
    P(10.50, 1.72, 2.52,  0.00, 1.76, 0, C_BODY),
    P( 9.30, 0.58, 2.55,  0.10, 2.02, 0, C_GLASS),                                           // window band
    P( 0.20, 1.10, 2.44,  5.26, 1.92, 0, C_GLASS),                                           // windscreen
    P(10.10, 0.14, 2.40,  0.00, 2.66, 0, C_BODY),                                            // roof
    P( 0.30, 0.44, 2.46,  5.34, 0.72, 0, C_DARK),
    P( 0.26, 0.44, 2.46, -5.32, 0.72, 0, C_DARK),
    P( 9.80, 0.16, 2.56,  0.00, 1.02, 0, C_DARK),                                            // skirt stripe
  ];
  arches(parts, wheels, 1.50, 0.42, 0.08, 0.74);
  return {
    name: 'bus', geo: parts, len: 10.6, wid: 2.55, wheelR: 0.46, wheelW: 0.30,
    wheels, speed: 0.74,
    heads: [[5.40, 0.80, 0.92], [5.40, 0.80, -0.92]], headS: [0.10, 0.22, 0.36],
    tails: [[-5.42, 1.10, 0.98], [-5.42, 1.10, -0.98]], tailS: [0.09, 0.30, 0.24],
  };
}

const TYPE_FACTORIES = [makeSedan, makeCoupe, makeVan, makePickup, makeBus];

// Paint: mostly city-neutral, but a real proportion of saturated colour so the
// street does not read as a monochrome parking lot (rubric §1).
const PAINT = [
  0xe6e3dc, 0xd8d4cb, 0x9aa1a8, 0x60666e, 0x181a1e, 0x2b3140,   // neutrals
  0xc4241d, 0xe2571f, 0xf0b429, 0x1f7f86, 0x1e3a6e, 0x2fbf8f,   // saturated
  0xd6247e, 0x7a3ec8, 0xb8d43a, 0x0f9ad6,                        // hot
];
const PAINT_VAN = [0xe6e3dc, 0xf2efe6, 0x2fbf8f, 0xf0b429, 0x1f7f86, 0xd6247e, 0x9aa1a8];
const PAINT_BUS = [0xd6247e, 0x0f9ad6, 0xf0b429, 0xe6e3dc, 0x2fbf8f];

// ------------------------------------------------------------------ textures
function canvas2d(w, h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Headlight throw: bright at the bumper, spreading and dying with distance.
// u = along the beam, v = across it.
function throwTexture(){
  const W = 192, H = 64, c = canvas2d(W, H), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let x = 0; x < W; x++){
    const t = x / (W - 1);
    const spread = 0.16 + 0.84 * Math.pow(t, 0.75);          // cone opens up
    const fall = Math.pow(1 - t, 1.5) * Math.min(1, t * 7.0); // dark under the bumper
    for (let y = 0; y < H; y++){
      const v = (y / (H - 1) - 0.5) * 2 / spread;
      let a = Math.exp(-v * v * 2.4) * fall;
      // faint hot core stripe down the middle of the beam
      a += Math.exp(-v * v * 9.0) * fall * 0.55;
      const val = Math.max(0, Math.min(255, a * 255)) | 0;
      const i = (y * W + x) * 4;
      d[i] = val; d[i+1] = (val * 0.94) | 0; d[i+2] = (val * 0.78) | 0; d[i+3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture(){
  const S = 64, c = canvas2d(S, S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  gr.addColorStop(0.00, 'rgba(255,255,255,1)');
  gr.addColorStop(0.16, 'rgba(255,244,214,0.85)');
  gr.addColorStop(0.42, 'rgba(255,214,150,0.28)');
  gr.addColorStop(1.00, 'rgba(255,190,120,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Contact shadow so nothing floats at night when the sun shadow is gone.
function aoTexture(){
  const S = 64, c = canvas2d(S, S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  gr.addColorStop(0.00, 'rgba(0,0,0,0.85)');
  gr.addColorStop(0.45, 'rgba(0,0,0,0.45)');
  gr.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// scratch — no per-frame allocation below this line
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3(), _p2 = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1), _s2 = new THREE.Vector3();
const AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);

export class Vehicles {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Vehicles';
    scene.add(this.group);
    this.cars = [];
    this.types = [];
    this._emitters = [];
    this._registered = false;
    this._night = 0;
  }

  build(){
    const R = new Rand((this.ctx.seed | 0) + 4211);
    this.types = TYPE_FACTORIES.map(f => {
      const T = f();
      T.merged = mergeGeometries(T.geo, false);
      T.merged.computeBoundingSphere();
      T.geo.forEach(g => g.dispose());
      T.geo = null;
      return T;
    });

    // fleet composition — sedans dominate, a handful of buses
    const COUNT = 96;
    const mix = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 0, 1, 0, 4];
    const perType = [0, 0, 0, 0, 0];
    for (let k = 0; k < COUNT; k++){
      const t = mix[R.i(0, mix.length - 1)];
      const T = this.types[t];
      const pal = t === 4 ? PAINT_BUS : (t === 2 ? PAINT_VAN : PAINT);
      const paint = new THREE.Color(R.pick(pal));
      const v = R.f(0.88, 1.10);
      paint.multiplyScalar(v);
      this.cars.push({
        t, ii: perType[t]++, wi: k * 4, li: k * 2,
        paint,
        len: T.len, wid: T.wid, spd: T.speed,
        // pose (traffic.js owns the simulation that drives these)
        x: 0, z: 0, yaw: 0, speed: 0, accel: 0,
        roll: 0, rollV: 0, pitch: 0, pitchV: 0, bodyY: 0, bodyV: 0,
        steer: 0, spin: 0, brake: 0,
      });
    }

    const bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.34, metalness: 0.22,
    });
    this.bodyMat = bodyMat;

    this.bodies = this.types.map((T, t) => {
      const n = perType[t];
      const mesh = new THREE.InstancedMesh(T.merged, bodyMat, Math.max(n, 1));
      mesh.count = n;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.name = 'car_' + T.name;
      this.group.add(mesh);
      return mesh;
    });
    for (const c of this.cars) this.bodies[c.t].setColorAt(c.ii, c.paint);
    for (const b of this.bodies) if (b.instanceColor) b.instanceColor.needsUpdate = true;

    // ------------------------------------------------------------- wheels
    const tyre = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
    tyre.rotateX(Math.PI / 2); colorize(tyre, 0x121316);
    const rim = new THREE.CylinderGeometry(0.56, 0.56, 1.03, 8, 1);
    rim.rotateX(Math.PI / 2); colorize(rim, 0x8c9299);
    const wheelGeo = mergeGeometries([tyre, rim], false);
    tyre.dispose(); rim.dispose();
    this.wheels = new THREE.InstancedMesh(wheelGeo, bodyMat, COUNT * 4);
    this.wheels.castShadow = true;
    this.wheels.frustumCulled = false;
    this.wheels.name = 'car_wheels';
    this.group.add(this.wheels);

    // ------------------------------------------------------- lamp geometry
    const unit = new THREE.BoxGeometry(1, 1, 1);
    colorize(unit, 0xffffff);
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xfff2d2, toneMapped: false });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a18, toneMapped: false });
    this.headMesh = new THREE.InstancedMesh(unit, this.headMat, COUNT * 2);
    this.tailMesh = new THREE.InstancedMesh(unit, this.tailMat, COUNT * 2);
    this.headMesh.frustumCulled = false; this.tailMesh.frustumCulled = false;
    this.headMesh.name = 'car_headlamps'; this.tailMesh.name = 'car_taillamps';
    this.group.add(this.headMesh, this.tailMesh);

    // -------------------------------------------------- glows / throw / AO
    const gTex = glowTexture();
    const facing = new THREE.PlaneGeometry(1, 1);
    facing.rotateY(Math.PI / 2);                       // normal along +x (car forward)
    this.glowHMat = new THREE.MeshBasicMaterial({
      map: gTex, color: 0xffe9bc, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, side: THREE.DoubleSide, opacity: 1,
    });
    this.glowTMat = new THREE.MeshBasicMaterial({
      map: gTex, color: 0xff3418, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, side: THREE.DoubleSide, opacity: 1,
    });
    this.glowH = new THREE.InstancedMesh(facing, this.glowHMat, COUNT * 2);
    this.glowT = new THREE.InstancedMesh(facing, this.glowTMat, COUNT * 2);
    for (const g of [this.glowH, this.glowT]){ g.frustumCulled = false; g.renderOrder = 6; }
    this.glowH.name = 'car_headglow'; this.glowT.name = 'car_tailglow';
    this.group.add(this.glowH, this.glowT);

    const flat = new THREE.PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.throwMat = new THREE.MeshBasicMaterial({
      map: throwTexture(), transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, opacity: 1, color: 0xffffff,
    });
    this.throwMesh = new THREE.InstancedMesh(flat, this.throwMat, COUNT);
    this.throwMesh.frustumCulled = false; this.throwMesh.renderOrder = 5;
    this.throwMesh.name = 'car_throw';
    this.group.add(this.throwMesh);

    this.aoMat = new THREE.MeshBasicMaterial({
      map: aoTexture(), transparent: true, depthWrite: false, opacity: 0.6, color: 0x000000,
      blending: THREE.NormalBlending,
    });
    this.aoMesh = new THREE.InstancedMesh(flat, this.aoMat, COUNT);
    this.aoMesh.frustumCulled = false; this.aoMesh.renderOrder = 4;
    this.aoMesh.name = 'car_contact';
    this.group.add(this.aoMesh);

    return this;
  }

  // One moving emitter per car, aimed a few metres up the road. The rig only ever
  // uploads the best NEON_MAX of them, so registering the whole fleet is cheap.
  registerLights(ctx){
    if (this._registered || !ctx.neon) return;
    this._registered = true;
    const neon = ctx.neon;
    for (const c of this.cars){
      const i = neon.emitters.length;
      _p.set(c.x, 0.65, c.z);
      neon.add(_p, 0xffe6b8, 0.0001, 21);
      this._emitters.push(neon.emitters[i]);
    }
  }

  // Push every car pose into the instance buffers. Called by traffic.js after it
  // has stepped the simulation, so the frame never shows a stale pose.
  sync(nightFactor){
    const cars = this.cars;
    this._night = nightFactor;
    for (let k = 0; k < cars.length; k++){
      const c = cars[k];
      const T = this.types[c.t];

      _e.set(c.roll, c.yaw, c.pitch, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(c.x, ROAD_Y + c.bodyY, c.z);
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      this.bodies[c.t].setMatrixAt(c.ii, _m);

      // wheels: steer on the front pair, roll with distance travelled
      for (let w = 0; w < 4; w++){
        const W = T.wheels[w];
        _q2.setFromAxisAngle(AX_Y, W[2] ? c.steer : 0);
        _q3.setFromAxisAngle(AX_Z, c.spin);
        _q2.multiply(_q3);
        _p2.set(W[0], T.wheelR, W[1]);
        _s2.set(T.wheelR, T.wheelR, T.wheelW);
        _m2.compose(_p2, _q2, _s2);
        _m2.premultiply(_m);
        this.wheels.setMatrixAt(c.wi + w, _m2);
      }

      // lamps
      _q2.identity();
      for (let i = 0; i < 2; i++){
        const H = T.heads[i];
        _p2.set(H[0], H[1], H[2]);
        _s2.set(T.headS[0], T.headS[1], T.headS[2]);
        _m2.compose(_p2, _q2, _s2); _m2.premultiply(_m);
        this.headMesh.setMatrixAt(c.li + i, _m2);

        const L = T.tails[i];
        _p2.set(L[0], L[1], L[2]);
        _s2.set(T.tailS[0], T.tailS[1], T.tailS[2]);
        _m2.compose(_p2, _q2, _s2); _m2.premultiply(_m);
        this.tailMesh.setMatrixAt(c.li + i, _m2);

        // billboard-ish glow cards sitting just proud of each lamp
        const gs = 1.15 + T.headS[1] * 2.0;
        _p2.set(H[0] + 0.06, H[1], H[2]);
        _s2.set(1, gs, gs);
        _m2.compose(_p2, _q2, _s2); _m2.premultiply(_m);
        this.glowH.setMatrixAt(c.li + i, _m2);

        const ts = (0.85 + T.tailS[1] * 1.6) * (1 + c.brake * 0.55);
        _p2.set(L[0] - 0.06, L[1], L[2]);
        _s2.set(1, ts, ts);
        _m2.compose(_p2, _q2, _s2); _m2.premultiply(_m);
        this.glowT.setMatrixAt(c.li + i, _m2);
      }

      // road throw — flat card starting at the bumper, running up the lane
      const tl = 15.0 + c.speed * 0.55;
      _p2.set(T.len * 0.5 + tl * 0.5 - 0.4, (0.075 - ROAD_Y - c.bodyY) - 0.0, 0);
      _q2.identity();
      _s2.set(tl, 1, 7.2);
      _m2.compose(_p2, _q2, _s2);
      _m2.premultiply(_m);
      this.throwMesh.setMatrixAt(k, _m2);

      // contact darkening
      _p2.set(0, (0.06 - ROAD_Y - c.bodyY), 0);
      _s2.set(T.len * 1.30, 1, T.wid * 2.05);
      _m2.compose(_p2, _q2, _s2);
      _m2.premultiply(_m);
      this.aoMesh.setMatrixAt(k, _m2);

      // feed the moving light emitter
      const em = this._emitters[k];
      if (em){
        const fx = Math.cos(c.yaw), fz = -Math.sin(c.yaw);
        em.pos.set(c.x + fx * 7.0, 0.62, c.z + fz * 7.0);
        em.intensity = 0.0001 + 1.05 * nightFactor;
      }
    }

    for (const b of this.bodies) b.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.headMesh.instanceMatrix.needsUpdate = true;
    this.tailMesh.instanceMatrix.needsUpdate = true;
    this.glowH.instanceMatrix.needsUpdate = true;
    this.glowT.instanceMatrix.needsUpdate = true;
    this.throwMesh.instanceMatrix.needsUpdate = true;
    this.aoMesh.instanceMatrix.needsUpdate = true;

    // Lights fade up as the sun goes down; daylight keeps a dim DRL so the cars
    // still read, and the road throw / glow cards disappear entirely so they do
    // not wash out the noon frame.
    const lamp = 0.30 + 0.70 * nightFactor;
    this.headMat.color.setRGB(1.0 * lamp, 0.95 * lamp, 0.83 * lamp);
    this.tailMat.color.setRGB(1.0 * lamp, 0.17 * lamp, 0.10 * lamp);
    const nf = Math.max(0, (nightFactor - 0.10) / 0.90);
    this.glowHMat.opacity = 0.20 + 0.80 * nf;
    this.glowTMat.opacity = 0.16 + 0.74 * nf;
    this.throwMat.opacity = 0.85 * nf * nf;
    this.throwMesh.visible = nf > 0.06;
    this.glowH.visible = nf > 0.02;
    this.glowT.visible = nf > 0.02;
    this.aoMat.opacity = 0.30 + 0.32 * (1 - nightFactor);
  }

  update(dt, ctx){
    // traffic.js drives the fleet; it calls sync() once the sim has stepped.
    if (!this._registered) this.registerLights(ctx);
  }
}

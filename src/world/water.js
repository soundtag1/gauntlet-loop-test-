import * as THREE from 'three';
import { Rand } from '../core/rng.js';

// ---------------------------------------------------------------------------
// NEON COAST — ocean, shoreline foam and beach sand.
//
// The city sits on a low island/peninsula. Everything outside a wavy square
// shoreline is water; between the city edge and the shoreline is sand.
// Two draw calls total (sand ring + ocean ring), all wave/foam/glitter work is
// analytic in the fragment shader so the geometry stays tiny.
// ---------------------------------------------------------------------------

const CITY_EDGE   = 545;    // half-extent of the last road + kerb, sand starts here
const SHORE_BASE  = 632;    // half-extent of the mean waterline
const SHORE_BEACH = 118;    // extra shore push on the +Z (beach district) side
const OCEAN_OUT   = 3400;   // ocean outer radius — far past the fog horizon
const SEA_Y       = 0.0;    // sea level (city ground plane is at -0.05)

// Deterministic wobble of the shoreline. MUST be identical in sand + ocean so
// the two rings share an exact edge.
function shoreHalf(theta){
  // square -> radius, plus a wider beach where we face +Z
  const s = Math.sin(theta), c = Math.cos(theta);
  const facingZ = Math.max(0.0, s);
  let S = SHORE_BASE + SHORE_BEACH * facingZ * facingZ;
  S += 26.0 * Math.sin(theta * 3.0 + 0.7)
     + 14.0 * Math.sin(theta * 7.0 - 1.9)
     +  7.0 * Math.sin(theta * 13.0 + 2.6);
  return S;
}
function squareR(theta, half){
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta));
  return half / Math.max(c, s);
}
function shoreR(theta){ return squareR(theta, shoreHalf(theta)); }

// Ring mesh between two radius functions. `power` biases the radial rings
// towards the inner (shore) edge where detail matters.
function ringGeometry(NA, NR, rInFn, rOutFn, power, yFn){
  const verts = (NA + 1) * (NR + 1);
  const pos = new Float32Array(verts * 3);
  const uv  = new Float32Array(verts * 2);
  const sh  = new Float32Array(verts);       // metres from shoreline
  const idx = [];
  let p = 0, q = 0, k = 0;
  for (let i = 0; i <= NA; i++){
    const th = (i / NA) * Math.PI * 2;
    const ct = Math.cos(th), st = Math.sin(th);
    const ri = rInFn(th), ro = rOutFn(th);
    for (let j = 0; j <= NR; j++){
      const t = Math.pow(j / NR, power);
      const r = ri + (ro - ri) * t;
      const x = ct * r, z = st * r;
      const d = r - ri;
      pos[p++] = x; pos[p++] = yFn ? yFn(d, r, th) : 0; pos[p++] = z;
      uv[q++] = th / (Math.PI * 2) * 40.0; uv[q++] = t;
      sh[k++] = d;
    }
  }
  for (let i = 0; i < NA; i++){
    for (let j = 0; j < NR; j++){
      const a = i * (NR + 1) + j, b = a + (NR + 1);
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aShore', new THREE.BufferAttribute(sh, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// --------------------------------------------------------------------- ocean
const OCEAN_VERT = /* glsl */`
precision highp float;
attribute float aShore;
uniform float uTime;
varying vec3 vWorld;
varying float vShore;
#include <fog_pars_vertex>
void main(){
  vShore = aShore;
  vec3 p = position;
  // gentle swell on the geometry itself; goes to zero at the waterline so the
  // ocean never lifts off the wet sand.
  float ramp = smoothstep(0.0, 90.0, aShore);
  p.y += ramp * (sin(p.x*0.0125 + uTime*0.62) * 0.34
               + sin(p.z*0.0171 - uTime*0.47) * 0.26);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}`;

const OCEAN_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;
varying float vShore;
uniform vec3  uZenith, uHorizon, uDeep, uShallow;
uniform vec3  uSpecDir, uSpecCol, uSunDir;
uniform vec3  uCamPos, uNeon;
uniform float uTime, uSpecPow, uSpecGain, uNight, uSunI;
#include <fog_pars_fragment>

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
             mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
}

// analytic wave normal — sum of directional sines, no derivatives needed
vec3 waveNormal(vec2 p, float t, float fade){
  vec2 g = vec2(0.0);
  // long directional swell rolling towards the beach (+Z)
  vec2 d1 = normalize(vec2(0.18, 1.0));
  float k1 = 0.0165, a1 = 3.1;
  g += d1 * (a1 * k1 * cos(dot(d1, p) * k1 + t * 0.75));
  vec2 d2 = normalize(vec2(-0.85, 0.52));
  float k2 = 0.031, a2 = 1.05;
  g += d2 * (a2 * k2 * cos(dot(d2, p) * k2 - t * 0.95));
  // chop
  vec2 d3 = normalize(vec2(0.92, -0.38));
  float k3 = 0.108, a3 = 0.30;
  g += fade * d3 * (a3 * k3 * cos(dot(d3, p) * k3 + t * 2.1));
  vec2 d4 = normalize(vec2(0.35, 0.94));
  float k4 = 0.205, a4 = 0.115;
  g += fade * d4 * (a4 * k4 * cos(dot(d4, p) * k4 - t * 3.3));
  // fine ripple, drives the glitter sparkle
  g += fade * vec2(
      0.055 * cos(p.x * 0.62 + t * 3.9 + vnoise(p * 0.06) * 6.28),
      0.055 * cos(p.y * 0.58 - t * 4.3 + vnoise(p * 0.05) * 6.28));
  return normalize(vec3(-g.x, 1.0, -g.y));
}

void main(){
  vec3 V = uCamPos - vWorld;
  float dist = length(V);
  V /= dist;

  float fade = exp(-dist * 0.0042);              // kill high freq in the distance
  vec3 N = waveNormal(vWorld.xz, uTime, fade);
  N = normalize(mix(vec3(0.0,1.0,0.0), N, 0.25 + 0.75 * fade));

  // --- sky reflection (cheap analytic match to the sky dome shader) --------
  vec3 R = reflect(-V, N);
  float ty = clamp(R.y * 1.15 + 0.12, 0.0, 1.0);
  vec3 skyC = mix(uHorizon, uZenith, pow(ty, 0.62));
  // sun/moon glow smeared across the reflected ray
  float sd = max(dot(R, uSpecDir), 0.0);
  skyC += uSpecCol * (pow(sd, 6.0) * 0.30 + pow(sd, 40.0) * 0.55) * uSpecGain;

  // --- body colour --------------------------------------------------------
  float depthF = smoothstep(0.0, 210.0, vShore);
  vec3 body = mix(uShallow, uDeep, depthF);

  // fresnel
  float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  f = clamp(0.026 + 0.974 * f, 0.0, 1.0);
  vec3 col = mix(body, skyC, f);

  // --- specular glitter track --------------------------------------------
  vec3 H = normalize(V + uSpecDir);
  float ndh = max(dot(N, H), 0.0);
  float sharp = pow(ndh, uSpecPow);
  float broad = pow(ndh, 26.0);
  // sparkle: break the sharp lobe up with high-frequency noise so it reads as
  // thousands of individual glints rather than a smooth blob
  float sp = vnoise(vWorld.xz * 0.55 + uTime * 0.35)
           * vnoise(vWorld.xz * 1.9 - uTime * 0.21);
  float glint = sharp * (0.35 + 2.4 * sp * fade);
  col += uSpecCol * uSpecGain * (glint * 2.6 + broad * 0.16);

  // --- shoreline foam -----------------------------------------------------
  float swash = 5.0 * sin(uTime * 0.55 + vWorld.x * 0.012)
              + 3.0 * sin(uTime * 0.83 - vWorld.z * 0.017);
  float e = vShore - swash;
  float band = 1.0 - smoothstep(0.0, 26.0, e);
  float crumble = vnoise(vWorld.xz * 0.16 + vec2(uTime * 0.25, 0.0)) * 0.55
                + vnoise(vWorld.xz * 0.55 - vec2(0.0, uTime * 0.4)) * 0.45;
  float foam = clamp(band * (crumble * 1.45 - 0.18), 0.0, 1.0);
  foam += (1.0 - smoothstep(0.0, 5.0, e)) * 0.55;              // hard edge line
  // a second breaker line further out
  float e2 = vShore - 46.0 - swash * 1.6;
  foam += (1.0 - smoothstep(0.0, 9.0, abs(e2))) * crumble * 0.45;
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamCol = mix(uHorizon, vec3(1.0), 0.55) * (0.30 + 0.70 * uSunI);
  foamCol = mix(foamCol, foamCol * 0.30 + uNeon * 0.25, uNight);
  col = mix(col, foamCol, foam * 0.92);

  // --- night: city neon bleeding onto the water ---------------------------
  float cityGlow = exp(-vShore * 0.0075) * uNight;
  float streak = 0.45 + 0.55 * vnoise(vec2(vWorld.x * 0.09, vWorld.z * 0.012 + uTime * 0.15));
  col += uNeon * cityGlow * streak * 0.55;

  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------------- sand
const SAND_VERT = /* glsl */`
precision highp float;
attribute float aShore;
varying vec3 vWorld;
varying float vShore;
#include <fog_pars_vertex>
void main(){
  vShore = aShore;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}`;

const SAND_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;
varying float vShore;
uniform vec3 uSandDry, uSandWet, uAmb, uSunCol, uSpecDir, uCamPos, uNeon, uHorizon;
uniform float uTime, uSunI, uNight;
#include <fog_pars_fragment>

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
             mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
}

void main(){
  // aShore counts *inland* from the waterline for the sand ring
  float d = -vShore;                   // 0 at water, negative inland
  float e = vShore;

  float grain = vnoise(vWorld.xz * 2.3) * 0.55 + vnoise(vWorld.xz * 0.31) * 0.45;
  float dunes = vnoise(vWorld.xz * 0.052);

  float wet = 1.0 - smoothstep(0.0, 34.0, e);
  vec3 base = mix(uSandDry, uSandWet, wet * 0.92);
  base *= 0.86 + 0.28 * grain;
  base *= 0.90 + 0.20 * dunes;

  // lighting: warm key from the (possibly set) sun + sky ambient
  float ndl = max(uSpecDir.y, 0.0);
  vec3 lit = base * (uAmb + uSunCol * ndl * uSunI * 1.15);

  // wet sand takes a sheen of the sky/sun near grazing angles
  vec3 V = normalize(uCamPos - vWorld);
  float f = pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
  lit += uHorizon * f * wet * 0.55 * (0.25 + uSunI);

  // swash — the thin sheet of foam sliding up the sand, matched to the ocean
  float swash = 5.0 * sin(uTime * 0.55 + vWorld.x * 0.012)
              + 3.0 * sin(uTime * 0.83 - vWorld.z * 0.017);
  float ee = e - swash;
  float sheet = 1.0 - smoothstep(0.0, 13.0, ee);
  float crumble = vnoise(vWorld.xz * 0.30 + vec2(uTime * 0.22, 0.0));
  float foam = clamp(sheet * (0.55 + crumble * 0.9) - 0.12, 0.0, 1.0);
  vec3 foamCol = mix(uHorizon, vec3(1.0), 0.55) * (0.30 + 0.70 * uSunI);
  foamCol = mix(foamCol, foamCol * 0.30 + uNeon * 0.25, uNight);
  lit = mix(lit, foamCol, foam * 0.8);

  lit += uNeon * uNight * exp(-max(-d, 0.0) * 0.02) * 0.05;

  gl_FragColor = vec4(lit, 1.0);
  #include <fog_fragment>
}`;

export class Water {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Water';
    scene.add(this.group);
    this.t = 0;
    this._sun = new THREE.Vector3();
    this._spec = new THREE.Vector3();
    this._c1 = new THREE.Color(); this._c2 = new THREE.Color();
  }

  build(){
    const rand = new Rand((this.ctx?.seed ?? 1337) + 991);
    this.seaLevel = SEA_Y;

    // ---- ocean ring -----------------------------------------------------
    const oceanGeo = ringGeometry(
      144, 9,
      (th) => shoreR(th),
      () => OCEAN_OUT,
      2.3, null
    );
    this.oceanUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime:{ value:0 },
        uZenith:{ value:new THREE.Color(0x2b1e5c) },
        uHorizon:{ value:new THREE.Color(0xff9a56) },
        uDeep:{ value:new THREE.Color(0x0a3a46) },
        uShallow:{ value:new THREE.Color(0x1a7e83) },
        uSpecDir:{ value:new THREE.Vector3(0,0.2,-1) },
        uSpecCol:{ value:new THREE.Color(0xffd9a0) },
        uSunDir:{ value:new THREE.Vector3(0,0.2,-1) },
        uCamPos:{ value:new THREE.Vector3() },
        uNeon:{ value:new THREE.Color(0xff2f8e) },
        uSpecPow:{ value:520 },
        uSpecGain:{ value:1 },
        uNight:{ value:0 },
        uSunI:{ value:1 },
      },
    ]);
    const oceanMat = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG,
      uniforms: this.oceanUniforms, fog: true, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    });
    const ocean = new THREE.Mesh(oceanGeo, oceanMat);
    ocean.position.y = SEA_Y;
    ocean.frustumCulled = false;
    ocean.renderOrder = -5;
    ocean.name = 'Ocean';
    this.group.add(ocean);
    this.ocean = ocean;

    // ---- beach sand ring ------------------------------------------------
    // inner edge hugs the city, outer edge is exactly the waterline.
    const sandGeo = ringGeometry(
      144, 7,
      (th) => shoreR(th),
      (th) => squareR(th, CITY_EDGE) * 0.999,   // note: runs *inland*
      1.55,
      (d) => {
        // beach slopes up away from the water; slightly under the sea at the
        // waterline so the two rings never crack apart.
        const t = Math.min(d / 60, 1);
        return -0.10 + 0.85 * Math.pow(t, 0.75);
      }
    );
    this.sandUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime:{ value:0 },
        uSandDry:{ value:new THREE.Color(0xd9c09a) },
        uSandWet:{ value:new THREE.Color(0x8a6f56) },
        uAmb:{ value:new THREE.Color(0x404a68) },
        uSunCol:{ value:new THREE.Color(0xffd9a0) },
        uHorizon:{ value:new THREE.Color(0xff9a56) },
        uSpecDir:{ value:new THREE.Vector3(0,0.2,-1) },
        uCamPos:{ value:new THREE.Vector3() },
        uNeon:{ value:new THREE.Color(0xff2f8e) },
        uSunI:{ value:1 },
        uNight:{ value:0 },
      },
    ]);
    const sandMat = new THREE.ShaderMaterial({
      vertexShader: SAND_VERT, fragmentShader: SAND_FRAG,
      uniforms: this.sandUniforms, fog: true, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3,
    });
    const sand = new THREE.Mesh(sandGeo, sandMat);
    sand.frustumCulled = false;
    sand.renderOrder = -6;
    sand.name = 'BeachSand';
    this.group.add(sand);
    this.sand = sand;

    // public helpers for the vegetation module
    this.shoreHalfAt = shoreHalf;
    this.shoreRadiusAt = shoreR;
    this.cityEdge = CITY_EDGE;
    void rand;
    this.update(0, this.ctx);
    return this;
  }

  update(dt, ctx){
    this.t += dt;
    const c = ctx || this.ctx;
    const ou = this.oceanUniforms, su = this.sandUniforms;
    if (!ou) return;
    ou.uTime.value = this.t;
    su.uTime.value = this.t;

    const sky = c.sky;
    const sd = this._sun.copy(sky.uniforms.uSunDir.value);
    const sunI = sky.uniforms.uSunIntensity.value;
    const hor = sky.uniforms.uHorizon.value;
    const zen = sky.uniforms.uZenith.value;

    ou.uHorizon.value.copy(hor);
    ou.uZenith.value.copy(zen);
    su.uHorizon.value.copy(hor);
    ou.uSunDir.value.copy(sd);

    // night factor from sun elevation (independent of ctx so it can't throw)
    const night = THREE.MathUtils.clamp(1.0 - (sd.y + 0.14) / 0.30, 0, 1);
    ou.uNight.value = night;
    su.uNight.value = night;
    ou.uSunI.value = sunI;
    su.uSunI.value = sunI;

    // --- specular source: the sun, lifted just above the horizon so the
    // glitter track survives after sunset; swaps to a cool moon at night.
    const dayW = THREE.MathUtils.clamp((sd.y + 0.30) / 0.36, 0, 1);
    const sx = sd.x, sz = sd.z;
    const inv = 1 / Math.max(Math.hypot(sx, sz), 1e-4);
    // sun-ish direction with a floor on elevation
    const sunElev = Math.max(sd.y, 0.030);
    this._spec.set(sx * inv, 0, sz * inv);
    // moon sits opposite the sun, higher up
    const mx = -sx * inv, mz = -sz * inv;
    const dirX = THREE.MathUtils.lerp(mx, sx * inv, dayW);
    const dirZ = THREE.MathUtils.lerp(mz, sz * inv, dayW);
    const dirY = THREE.MathUtils.lerp(0.34, sunElev, dayW);
    ou.uSpecDir.value.set(dirX, dirY, dirZ).normalize();
    su.uSpecDir.value.copy(ou.uSpecDir.value);

    // colour of the glitter track
    const keys = c.time && c.time.skyKeys;
    const sunCol = this._c1.copy(keys ? keys.sun : hor);
    const moonCol = this._c2.setHex(0x9db4ff);
    ou.uSpecCol.value.copy(moonCol).lerp(sunCol, dayW);
    // strong right at/after sunset (that is the hero hour), dim at night
    ou.uSpecGain.value = 0.30 + 1.55 * Math.pow(dayW, 0.6) * (0.35 + 0.65 * sunI);
    ou.uSpecPow.value = THREE.MathUtils.lerp(180, 620, dayW);

    // body colour: deep teal by day, near-black indigo at night, tinted by sky
    const deep = this._c1.setHex(0x0f5f6b).multiplyScalar(0.16 + 0.55 * sunI);
    deep.lerp(this._c2.setHex(0x05070f), night * 0.86);
    deep.lerp(zen, 0.14);
    ou.uDeep.value.copy(deep);
    const shal = this._c1.setHex(0x1c8f92).multiplyScalar(0.22 + 0.70 * sunI);
    shal.lerp(this._c2.setHex(0x0b1024), night * 0.80);
    ou.uShallow.value.copy(shal);

    // sand ambient: lit by the sky, never neutral grey
    const amb = this._c1.copy(zen).multiplyScalar(0.55).lerp(this._c2.copy(hor).multiplyScalar(0.55), 0.55);
    amb.multiplyScalar(0.45 + 0.85 * sunI);
    su.uAmb.value.copy(amb);
    su.uSunCol.value.copy(keys ? keys.sun : hor);
    // sand goes cool/dark at night, warm and bleached by day
    su.uSandDry.value.setHex(0xd9c09a).lerp(this._c2.setHex(0x2a2a44), night * 0.72);
    su.uSandWet.value.setHex(0x8a6f56).lerp(this._c2.setHex(0x141a30), night * 0.75);

    const cam = c.camera;
    ou.uCamPos.value.copy(cam.position);
    su.uCamPos.value.copy(cam.position);
  }
}

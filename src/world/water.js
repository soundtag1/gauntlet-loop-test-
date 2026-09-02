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

const CITY_EDGE   = 539;    // half-extent of the last road + kerb, sand starts here
const SHORE_BASE  = 604;    // half-extent of the mean waterline
const SHORE_BEACH = 74;    // extra shore push on the +Z (beach district) side
const OCEAN_OUT   = 3400;   // ocean outer radius — far past the fog horizon
const SEA_Y       = 0.0;    // sea level (city ground plane is at -0.05)

// Deterministic wobble of the shoreline. MUST be identical in sand + ocean so
// the two rings share an exact edge.
function shoreHalf(theta){
  // square -> radius, plus a wider beach where we face +Z
  const s = Math.sin(theta), c = Math.cos(theta);
  const facingZ = Math.max(0.0, s);
  let S = SHORE_BASE + SHORE_BEACH * facingZ * facingZ;
  S += 18.0 * Math.sin(theta * 3.0 + 0.7)
     + 11.0 * Math.sin(theta * 7.0 - 1.9)
     +  6.0 * Math.sin(theta * 13.0 + 2.6)
     +  3.2 * Math.sin(theta * 29.0 - 0.4);
  return S;
}
function squareR(theta, half){
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta));
  return half / Math.max(c, s);
}
function shoreR(theta){ return squareR(theta, shoreHalf(theta)); }

// Beach height as a function of distance inland from the nominal shore line.
// Starts under water (-0.55), breaks the surface ~18u in, crests, then eases
// back to the city ground level so there is no step at the inland edge.
function sandProfile(d, theta){
  const inner = squareR(theta, CITY_EDGE), outer = shoreR(theta);
  const u = Math.min(Math.max(d / Math.max(outer - inner, 1), 0), 1);
  const t = 1 - 0.55 * THREE.MathUtils.smoothstep(u, 0.45, 1.0);
  return -0.55 + Math.min(d * 0.030, 1.25) * t;
}

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
      const d = Math.abs(r - ri);
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
  float ramp = smoothstep(0.0, 110.0, aShore);
  // biased so the surface never dips under the city ground plane (y=-0.05)
  p.y += ramp * (0.58 + sin(p.x*0.0125 + uTime*0.62) * 0.30
                      + sin(p.z*0.0171 - uTime*0.47) * 0.22);
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
  float wob = (vnoise(p * 0.0021) + vnoise(p * 0.0072) * 0.5) * 6.28;
  float wob2 = vnoise(p * 0.0085 + 11.3) * 6.28;
  // long directional swell rolling towards the beach (+Z)
  vec2 d1 = normalize(vec2(0.18, 1.0));
  float k1 = 0.0165, a1 = 3.1;
  g += d1 * (a1 * k1 * cos(dot(d1, p) * k1 + t * 0.75 + wob));
  vec2 d2 = normalize(vec2(-0.85, 0.52));
  float k2 = 0.031, a2 = 1.05;
  g += d2 * (a2 * k2 * cos(dot(d2, p) * k2 - t * 0.95 + wob2));
  // chop
  vec2 d3 = normalize(vec2(0.92, -0.38));
  float k3 = 0.108, a3 = 0.22;
  g += fade * d3 * (a3 * k3 * cos(dot(d3, p) * k3 + t * 2.1 + wob2 * 1.7));
  vec2 d4 = normalize(vec2(0.35, 0.94));
  float k4 = 0.205, a4 = 0.085;
  g += fade * d4 * (a4 * k4 * cos(dot(d4, p) * k4 - t * 3.3 + wob * 2.3));
  // fine ripple, drives the glitter sparkle (rotated dirs, never axis-aligned)
  vec2 d5 = normalize(vec2(0.62, 0.79));
  g += fade * d5 * (0.050 * cos(dot(d5, p) * 0.66 + t * 3.9 + vnoise(p * 0.05) * 6.28));
  vec2 d6 = normalize(vec2(-0.74, 0.67));
  g += fade * d6 * (0.044 * cos(dot(d6, p) * 0.83 - t * 4.6 + vnoise(p * 0.07) * 6.28));
  return normalize(vec3(-g.x, 1.0, -g.y));
}

void main(){
  vec3 V = uCamPos - vWorld;
  float dist = length(V);
  V /= dist;

  float fade = exp(-dist * 0.0016);              // kill high freq in the distance
  vec3 N = waveNormal(vWorld.xz, uTime, fade);
  N = normalize(mix(vec3(0.0,1.0,0.0), N, 0.25 + 0.75 * fade));

  // --- sky reflection (cheap analytic match to the sky dome shader) --------
  vec3 R = reflect(-V, N);
  float ty = clamp(R.y * 1.15 + 0.12, 0.0, 1.0);
  vec3 skyC = mix(uHorizon, uZenith, pow(ty, 0.62)) * 0.88;
  // sun/moon glow smeared across the reflected ray
  float sd = max(dot(R, uSpecDir), 0.0);
  skyC += uSpecCol * (pow(sd, 2.0) * 0.14 + pow(sd, 6.0) * 0.30 + pow(sd, 40.0) * 0.55) * uSpecGain;

  // --- body colour --------------------------------------------------------
  float depthF = smoothstep(0.0, 260.0, vShore);
  vec3 body = mix(uShallow, uDeep, depthF);
  // translucent shallows: light punches through the back of the small waves
  body += uShallow * (1.0 - depthF) * max(0.0, N.z * 0.5 + 0.5) * 0.35;

  // fresnel — damped in the shallows so the water keeps its teal there
  float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  f = clamp(0.026 + 0.974 * f, 0.0, 1.0);
  f *= mix(0.68, 1.0, smoothstep(0.0, 340.0, vShore));
  vec3 col = mix(body, skyC, f);

  // --- specular glitter track --------------------------------------------
  vec3 H = normalize(V + uSpecDir);
  float ndh = max(dot(N, H), 0.0);
  float sharp = pow(ndh, uSpecPow);
  float broad = pow(ndh, 26.0);
  // sparkle: break the sharp lobe up with high-frequency noise so it reads as
  // thousands of individual glints rather than a smooth blob
  float sp = vnoise(vWorld.xz * 0.30 + uTime * 0.26)
           * vnoise(vWorld.xz * 1.15 - uTime * 0.17)
           * (0.55 + 0.85 * vnoise(vWorld.xz * 3.7 + uTime * 0.9));
  sp = pow(clamp(sp * 3.4, 0.0, 1.0), 1.35);
  float glint = sharp * (0.18 + 4.2 * sp * fade);
  float wide = pow(ndh, 5.0);
  col += uSpecCol * uSpecGain * (glint * 3.4 + broad * 0.26 + wide * 0.12);

  // Glitter track from the bright horizon band: wherever a wave facet throws the
  // view ray out along the horizon it picks up the sunset glow, and the sparkle
  // noise breaks that into thousands of individual glints running to the viewer.
  float horiz = 1.0 - clamp(abs(R.y) * 6.5, 0.0, 1.0);
  horiz *= horiz;
  float track = 0.35 + 0.65 * pow(max(dot(normalize(vec3(R.x, 0.0, R.z)),
                                          normalize(vec3(uSpecDir.x, 0.0, uSpecDir.z))) * 0.5 + 0.5, 0.0), 1.5);
  col += uHorizon * horiz * f * track * (0.22 + 2.3 * sp * fade) * uSpecGain * 0.55;

  // --- shoreline foam -----------------------------------------------------
  float d = vShore - 12.0;                        // metres seaward of waterline
  float env = 1.0 - smoothstep(0.0, 230.0, max(d, 0.0));
  float ph = uTime * 0.155 - d * 0.019 + vnoise(vWorld.xz * 0.0055) * 1.6;
  float w = fract(ph);
  float crest = smoothstep(0.72, 0.965, w) * (1.0 - smoothstep(0.965, 1.0, w));
  crest *= env * env;
  float crumble = vnoise(vWorld.xz * 0.13 + vec2(uTime * 0.20, 0.0)) * 0.55
                + vnoise(vWorld.xz * 0.48 - vec2(0.0, uTime * 0.34)) * 0.45;
  float foam = crest * (0.35 + crumble * 1.15);
  // second, broken crest line trailing each breaker
  float w2 = fract(ph + 0.42);
  foam += smoothstep(0.80, 0.98, w2) * env * env * crumble * 0.55;
  // the swash sheet right at the waterline
  float swash = 6.5 * sin(uTime * 0.55 + vWorld.x * 0.010)
              + 4.0 * sin(uTime * 0.83 - vWorld.z * 0.015);
  float e = d - swash;
  // fade the wash out at the ring's own inner edge so the water never ends on a
  // hard white line — the sand shader carries the swash from there inland
  float edgeFade = smoothstep(0.0, 16.0, vShore);
  foam += (1.0 - smoothstep(-4.0, 11.0, e)) * (0.40 + 0.55 * crumble) * edgeFade;
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamCol = mix(uHorizon, vec3(1.0), 0.62) * (0.34 + 0.70 * uSunI);
  foamCol = mix(foamCol, foamCol * 0.22 + uNeon * 0.10, uNight);
  col = mix(col, foamCol, foam * 0.94);

  // --- night: city neon bleeding onto the water (restrained) --------------
  float cityGlow = exp(-vShore * 0.022) * uNight;
  float streak = 0.30 + 0.70 * vnoise(vec2(vWorld.x * 0.22, vWorld.z * 0.020 + uTime * 0.12));
  col += uNeon * cityGlow * streak * 0.055;

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
  float e = vShore - 18.0;              // metres inland from the waterline

  // ---- surface texture ---------------------------------------------------
  float grain = vnoise(vWorld.xz * 2.6) * 0.34 + vnoise(vWorld.xz * 8.0) * 0.22
              + vnoise(vWorld.xz * 0.60) * 0.44;
  float dunes = vnoise(vWorld.xz * 0.030) * 0.50 + vnoise(vWorld.xz * 0.105) * 0.32
              + vnoise(vWorld.xz * 0.28) * 0.18;
  // wind ripples running parallel to the shore
  float ripple = sin(e * 1.35 + vnoise(vWorld.xz * 0.09) * 9.0) * 0.5 + 0.5;
  ripple *= smoothstep(6.0, 40.0, e);

  float wet = 1.0 - smoothstep(2.0, 30.0, e);        // saturated sand
  float damp = 1.0 - smoothstep(20.0, 76.0, e);      // last high-tide line

  vec3 base = mix(uSandDry, uSandWet, wet * 0.94);
  base = mix(base, base * 0.86, damp * 0.35);
  base *= 0.76 + 0.44 * grain;
  base *= 0.80 + 0.38 * dunes;
  base *= 0.90 + 0.19 * ripple;
  // dark tide-wrack line
  base *= 1.0 - 0.20 * (1.0 - smoothstep(0.0, 5.0, abs(e - 34.0 - dunes * 12.0)));

  // ---- lighting ----------------------------------------------------------
  float ndl = max(uSpecDir.y, 0.0);
  vec3 lit = base * (uAmb + uSunCol * ndl * uSunI * 0.82);

  // wet sand mirrors the sky at grazing angles
  vec3 V = normalize(uCamPos - vWorld);
  float f = pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
  lit = mix(lit, uHorizon * (0.35 + 0.75 * uSunI), f * wet * 0.55);
  // and takes a specular streak from the sun
  vec3 H = normalize(V + uSpecDir);
  lit += uSunCol * pow(max(H.y, 0.0), 90.0) * wet * uSunI * 0.55;

  // ---- swash: the sheet of foam sliding up the sand ----------------------
  float swash = 6.5 * sin(uTime * 0.55 + vWorld.x * 0.010)
              + 4.0 * sin(uTime * 0.83 - vWorld.z * 0.015);
  float ee = e - swash;
  float sheet = 1.0 - smoothstep(0.0, 26.0, ee);
  float crumble = vnoise(vWorld.xz * 0.22 + vec2(uTime * 0.20, 0.0)) * 0.6
                + vnoise(vWorld.xz * 0.7 - vec2(0.0, uTime * 0.34)) * 0.4;
  float foam = clamp(sheet * (crumble * 2.1 - 0.45), 0.0, 1.0);
  foam += (1.0 - smoothstep(-7.0, 6.0, ee)) * (0.55 + 0.45 * crumble);
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamCol = mix(uHorizon, vec3(1.0), 0.62) * (0.34 + 0.70 * uSunI);
  foamCol = mix(foamCol, foamCol * 0.22 + uNeon * 0.10, uNight);
  lit = mix(lit, foamCol, foam * 0.9);

  lit += uNeon * uNight * 0.02;

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
      160, 10,
      (th) => shoreR(th) - 30,
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
      1.35,
      (d, r, th) => sandProfile(d, th)
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
      uniforms: this.sandUniforms, fog: true, side: THREE.DoubleSide,
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

  // Ground height at a world position: the beach ramp between the city edge
  // and the waterline, 0 inland, sea level offshore. Used by vegetation.
  heightAt(x, z){
    const th = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    const inner = squareR(th, CITY_EDGE), outer = shoreR(th);
    if (r >= outer) return SEA_Y;
    if (r <= inner) return 0;
    return Math.max(sandProfile(outer - r, th), SEA_Y);
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
    const night = THREE.MathUtils.clamp((0.46 - sunI) / 0.34, 0, 1);
    ou.uNight.value = night;
    su.uNight.value = night;
    ou.uSunI.value = sunI;
    su.uSunI.value = sunI;

    // --- specular source: the sun, lifted just above the horizon so the
    // glitter track survives after sunset; swaps to a cool moon at night.
    const dayW = THREE.MathUtils.clamp((sunI - 0.13) / 0.30, 0, 1);
    const sx = sd.x, sz = sd.z;
    const inv = 1 / Math.max(Math.hypot(sx, sz), 1e-4);
    // sun-ish direction with a floor on elevation
    const sunElev = Math.max(sd.y, 0.055);
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
    ou.uSpecPow.value = THREE.MathUtils.lerp(140, 430, dayW);

    // body colour: deep teal by day, near-black indigo at night, tinted by sky
    const deep = this._c1.setHex(0x0f5f6b).multiplyScalar(0.16 + 0.55 * sunI);
    deep.lerp(this._c2.setHex(0x05070f), night * 0.86);
    deep.lerp(zen, 0.14);
    ou.uDeep.value.copy(deep);
    const shal = this._c1.setHex(0x1c8f92).multiplyScalar(0.22 + 0.70 * sunI);
    shal.lerp(this._c2.setHex(0x0b1024), night * 0.80);
    ou.uShallow.value.copy(shal);

    // sand ambient: lit by the sky, never neutral grey
    const ndl = ou.uSpecDir.value.y;
    const amb = this._c1.copy(zen).multiplyScalar(0.55).lerp(this._c2.copy(hor).multiplyScalar(0.62), 0.72);
    amb.multiplyScalar((0.45 + 0.85 * sunI) * (1.0 + 0.95 * (1.0 - Math.min(ndl, 1))));
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

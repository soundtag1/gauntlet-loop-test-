import * as THREE from 'three';

// Physically-flavoured gradient sky with sun disc, driven by time-of-day.
const VERT = `
varying vec3 vWorld;
void main(){
  vWorld = (modelMatrix * vec4(position,1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}`;

const FRAG = `
precision highp float;
varying vec3 vWorld;
uniform vec3 uSunDir;
uniform vec3 uZenith, uMid, uHorizon, uGround;
uniform float uSunIntensity, uHaze, uTime;

float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5;
  for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; }
  return v;
}

void main(){
  vec3 dir = normalize(vWorld);
  float h = dir.y;

  // Vertical atmosphere ramp, THREE stops. A two-stop horizon->zenith mix cannot
  // express a dusk sky (warm horizon -> magenta band -> indigo zenith); the mid
  // band is what makes sunset read as sunset rather than a flat orange wash.
  float t = pow(clamp(h*1.15+0.12, 0.0, 1.0), 0.62);
  vec3 sky = t < 0.5
    ? mix(uHorizon, uMid,    smoothstep(0.0, 1.0, t*2.0))
    : mix(uMid,     uZenith, smoothstep(0.0, 1.0, (t-0.5)*2.0));

  // ground/haze below horizon
  sky = mix(uGround, sky, smoothstep(-0.10, 0.045, h));

  // sun disc + wide glow (mie-ish)
  float sd = max(dot(dir, uSunDir), 0.0);
  float disc = smoothstep(0.9985, 0.99965, sd);
  float glow = pow(sd, 260.0)*0.55 + pow(sd, 14.0)*0.30 + pow(sd, 3.0)*0.10;
  vec3 sunCol = vec3(1.0, 0.80, 0.55);
  sky += sunCol * (glow*uSunIntensity) + sunCol*disc*uSunIntensity*7.0;

  // horizon haze thickening
  float haze = exp(-max(h,0.0)*7.0)*uHaze;
  sky = mix(sky, uHorizon*1.06, haze*0.5);

  // clouds: fbm slab, lit from sun side
  if(h > -0.02){
    vec2 uv = dir.xz / max(h+0.14, 0.06);
    float c = fbm(uv*0.85 + vec2(uTime*0.006, uTime*0.0035));
    float c2 = fbm(uv*1.9 - vec2(uTime*0.010, 0.0));
    float cov = smoothstep(0.52, 0.86, c*0.72 + c2*0.28);
    cov *= smoothstep(-0.02, 0.16, h);
    float lit = pow(clamp(dot(dir,uSunDir)*0.5+0.5,0.0,1.0), 2.2);
    vec3 cloudCol = mix(uHorizon*0.55, sunCol*1.5, lit);
    cloudCol = mix(cloudCol, vec3(1.0,0.97,0.94), lit*uSunIntensity*0.25);
    sky = mix(sky, cloudCol, cov*0.80);
  }
  gl_FragColor = vec4(sky, 1.0);
}`;

export class Sky {
  constructor(scene){
    this.uniforms = {
      uSunDir:{value:new THREE.Vector3(0,0.3,-1)},
      uZenith:{value:new THREE.Color(0x2b1e5c)},
      uMid:{value:new THREE.Color(0xa8447e)},
      uHorizon:{value:new THREE.Color(0xff9a56)},
      uGround:{value:new THREE.Color(0x241a33)},
      uSunIntensity:{value:1.0},
      uHaze:{value:0.55},
      uTime:{value:0},
    };
    const geo = new THREE.SphereGeometry(4000, 48, 32);
    const mat = new THREE.ShaderMaterial({
      vertexShader:VERT, fragmentShader:FRAG, uniforms:this.uniforms,
      side:THREE.BackSide, depthWrite:false, fog:false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);
  }
  update(dt){ this.uniforms.uTime.value += dt; }
}

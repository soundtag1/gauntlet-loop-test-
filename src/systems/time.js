import * as THREE from 'three';

// Time-of-day: drives sun direction, sky colors, light intensity/colour, fog.
const KEYS = [
  { h:0.0,  mid:0x0a1024, zen:0x060a1c, hor:0x101a38, gnd:0x05070f, sun:0x223055, amb:0x0d1330, si:0.05, haze:0.35, fog:0x0a0f22, fogD:0.00144 },
  { h:5.4,  mid:0x3f3a63, zen:0x1d2a52, hor:0x6b4a6a, gnd:0x161a2c, sun:0x8a6a7a, amb:0x2a2a48, si:0.22, haze:0.70, fog:0x3a3350, fogD:0.00180 },
  { h:6.6,  mid:0xd98a72, zen:0x4a7ba8, hor:0xffb07a, gnd:0x3a3040, sun:0xffb27a, amb:0x50506e, si:0.75, haze:0.85, fog:0xc79a86, fogD:0.00162 },
  { h:9.0,  mid:0x9fc4dc, zen:0x5fa8d6, hor:0xeae2cf, gnd:0x6a6a68, sun:0xfff0d8, amb:0x8098b0, si:1.00, haze:0.42, fog:0xc8dbe2, fogD:0.00094 },
  { h:13.0, mid:0x7fb8dd, zen:0x4f9fd8, hor:0xf4e2c4, gnd:0x74746e, sun:0xfff2d6, amb:0x8ea6bd, si:1.10, haze:0.34, fog:0xd6e4e6, fogD:0.00081 },
  { h:17.6, mid:0xd99a76, zen:0x4a86bc, hor:0xf2c48a, gnd:0x6a5a52, sun:0xffd9a0, amb:0x6d5f7a, si:0.92, haze:0.55, fog:0xe0bb96, fogD:0.00108 },
  { h:19.3, mid:0xa8447e, zen:0x2b1e5c, hor:0xff9a56, gnd:0x241a33, sun:0xffb066, amb:0x4a3a68, si:0.70, haze:0.78, fog:0xb56a5e, fogD:0.00144 },
  { h:20.4, mid:0x6a2a5e, zen:0x1a1440, hor:0xa8447e, gnd:0x140f24, sun:0xd0507a, amb:0x2e2450, si:0.32, haze:0.72, fog:0x5c2f52, fogD:0.00171 },
  { h:21.6, mid:0x1a1230, zen:0x0a0d1f, hor:0x2a1a3e, gnd:0x07080f, sun:0x3a2a50, amb:0x141a38, si:0.10, haze:0.48, fog:0x14122a, fogD:0.00162 },
  { h:24.0, mid:0x0a1024, zen:0x060a1c, hor:0x101a38, gnd:0x05070f, sun:0x223055, amb:0x0d1330, si:0.05, haze:0.35, fog:0x0a0f22, fogD:0.00144 },
];

const c1=new THREE.Color(), c2=new THREE.Color();
function lerpKeys(h){
  let a=KEYS[0], b=KEYS[KEYS.length-1];
  for(let i=0;i<KEYS.length-1;i++){
    if(h>=KEYS[i].h && h<=KEYS[i+1].h){ a=KEYS[i]; b=KEYS[i+1]; break; }
  }
  const t = (h-a.h)/Math.max(b.h-a.h, 1e-6);
  const mixC=(x,y)=>{ c1.setHex(x); c2.setHex(y); return c1.clone().lerp(c2,t); };
  return {
    zen:mixC(a.zen,b.zen), mid:mixC(a.mid,b.mid), hor:mixC(a.hor,b.hor), gnd:mixC(a.gnd,b.gnd),
    sun:mixC(a.sun,b.sun), amb:mixC(a.amb,b.amb), fog:mixC(a.fog,b.fog),
    si:a.si+(b.si-a.si)*t, haze:a.haze+(b.haze-a.haze)*t,
    fogD:a.fogD+(b.fogD-a.fogD)*t,
  };
}

export class TimeOfDay {
  constructor(scene, sky, lights, hour=19.3, speed=0){
    this.scene=scene; this.sky=sky; this.lights=lights;
    this.hour=hour; this.speed=speed;
    this.apply();
  }
  set(h){ this.hour=((h%24)+24)%24; this.apply(); }
  update(dt){ if(this.speed>0){ this.hour=(this.hour+dt*this.speed)%24; this.apply(); } }
  get nightFactor(){
    const h=this.hour;
    // 0 at midday, 1 deep night
    return THREE.MathUtils.clamp(1.0 - THREE.MathUtils.smoothstep(this._sunElev, -0.12, 0.18), 0, 1);
  }
  apply(){
    const k = lerpKeys(this.hour);
    // sun path: rises ~6.2, sets ~19.9
    const ang = ((this.hour-6.0)/12.0)*Math.PI;
    const elev = Math.sin(ang);
    this._sunElev = elev;
    const dir = new THREE.Vector3(Math.cos(ang)*0.88, elev*0.80, -0.58).normalize();

    this.sky.uniforms.uSunDir.value.copy(dir);
    this.sky.uniforms.uZenith.value.copy(k.zen);
    this.sky.uniforms.uMid.value.copy(k.mid);
    this.sky.uniforms.uHorizon.value.copy(k.hor);
    this.sky.uniforms.uGround.value.copy(k.gnd);
    this.sky.uniforms.uSunIntensity.value = Math.max(k.si, 0.03);
    this.sky.uniforms.uHaze.value = k.haze;

    const { sun, hemi } = this.lights;
    sun.position.copy(dir).multiplyScalar(420);
    sun.color.copy(k.sun);
    sun.intensity = Math.max(k.si*3.2, 0.0);
    sun.visible = elev > -0.10;

    hemi.color.copy(k.zen); hemi.groundColor.copy(k.gnd);
    hemi.intensity = 0.30 + k.si*0.85;

    this.scene.fog.color.copy(k.fog);
    this.scene.fog.density = k.fogD;
    this.skyKeys = k;
  }
}

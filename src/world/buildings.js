import * as THREE from 'three';
import { Rand } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Facade generator.
//
// Design rules (software rasteriser — draw calls are the budget):
//  * ONE shared facade material for every building body. Per-building colour,
//    window-brightness and pattern offset ride on custom instanced attributes,
//    so the whole city's massing is a handful of InstancedMesh draws.
//  * The albedo texture is a light neutral wall with windows as a MINORITY of
//    the surface (~25%). Alpha channel carries a wall/glass mask so the
//    per-building tint only colours the wall, never the glass.
//  * Windows are DARK GLASS in albedo; the warm interior light lives only in
//    the emissive map, whose intensity is driven by sun elevation. Daytime
//    therefore shows properly lit coloured stucco, night shows lit windows.
//  * Buildings are massed from several stacked/offset boxes (setbacks, podium +
//    tower, L and U plans, crowns) — all instances of the same unit box.
//  * A distinct ~4m ground floor band (own texture: piers, glazing, fascia
//    signs, stall risers) plus canopies and awnings gives street-level frontage.
// ---------------------------------------------------------------------------

const TILE = 27.0;   // one 8x8 window tile spans 27m  -> ~3.375m per window bay
const BAY  = 18.0;   // one 4-bay shopfront tile spans 18m -> 4.5m per shop bay

// ---- shader injection helpers ---------------------------------------------

const DECL_V = `
attribute vec3 aTint;
attribute float aLit;
attribute vec2 aUvOff;
varying vec3 vTint;
varying float vLit;
varying float vRoof;
`;
const DECL_F = `
varying vec3 vTint;
varying float vLit;
varying float vRoof;
`;

// Tint + roof handling shared by every building material.
function fragInject(mat, roofCol){
  return `
    float wallMask = diffuseColor.a;
    diffuseColor.rgb *= mix(vec3(1.0), vTint, wallMask);
    diffuseColor.rgb = mix(diffuseColor.rgb, ${roofCol} * (0.55 + 0.45*vTint), vRoof);
    diffuseColor.a = 1.0;
  `;
}

function facadeMaterial(map, emap, opts){
  const m = new THREE.MeshStandardMaterial({
    map, emissiveMap:emap, emissive:new THREE.Color(0xffffff),
    emissiveIntensity:0.7, roughness:opts.rough ?? 0.74, metalness:0.05,
  });
  m.onBeforeCompile = (sh)=>{
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL_V}\n${opts.uvFn}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vTint = aTint;
        vLit = aLit;
        vRoof = step(0.5, abs(normal.y));
        #ifdef USE_INSTANCING
          vec2 tiled = tileUv(uv, normal, instanceMatrix) + aUvOff;
          vMapUv = tiled;
          #ifdef USE_EMISSIVEMAP
            vEmissiveMapUv = tiled;
          #endif
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL_F}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${fragInject(m, opts.roofCol)}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vLit * (1.0 - vRoof);`);
  };
  m.customProgramCacheKey = ()=>opts.key;
  return m;
}

// Plain tinted material (rooftops, balconies, awnings) — no uv retiling.
function tintedMaterial(base){
  const m = new THREE.MeshStandardMaterial(base);
  m.onBeforeCompile = (sh)=>{
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL_V}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vTint = aTint; vLit = aLit; vRoof = step(0.5, abs(normal.y));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL_F}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= vTint;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vLit;`);
  };
  m.customProgramCacheKey = ()=>'tinted-v1';
  return m;
}

// ---- textures --------------------------------------------------------------

function noiseInto(g, W, H, rand, amp){
  const img=g.getImageData(0,0,W,H), d=img.data;
  for(let i=0;i<d.length;i+=4){
    const n=rand.f(-1,1)*amp;
    d[i]=Math.max(0,Math.min(255,d[i]+n));
    d[i+1]=Math.max(0,Math.min(255,d[i+1]+n));
    d[i+2]=Math.max(0,Math.min(255,d[i+2]+n));
  }
  g.putImageData(img,0,0);
}

// Body facade. 8x8 window grid; windows ~25% of surface, wall dominates.
function facadeTexture(rand){
  const W=256,H=256;
  const cw=document.createElement('canvas'); cw.width=W; cw.height=H;
  const g=cw.getContext('2d');
  const em=document.createElement('canvas'); em.width=W; em.height=H;
  const eg=em.getContext('2d'); eg.fillStyle='#000'; eg.fillRect(0,0,W,H);

  // wall: light neutral, tinted per-instance. alpha=255 => "this is wall".
  g.fillStyle='rgb(232,227,218)'; g.fillRect(0,0,W,H);
  noiseInto(g,W,H,rand,9);

  const cols=8, rows=8, cwd=W/cols, chd=H/rows;

  // floor slab / spandrel banding + pilasters (depth without extra geometry)
  for(let r=0;r<=rows;r++){
    const y=r*chd;
    g.fillStyle='rgba(0,0,0,0.13)'; g.fillRect(0,y-2,W,2);
    g.fillStyle='rgba(255,255,255,0.20)'; g.fillRect(0,y,W,1);
  }
  for(let c=0;c<=cols;c++){
    const x=c*cwd;
    g.fillStyle='rgba(0,0,0,0.07)'; g.fillRect(x-1,0,1,H);
    g.fillStyle='rgba(255,255,255,0.10)'; g.fillRect(x,0,1,H);
  }

  const ww=16, wh=18;            // 16x18 of a 32x32 cell => 28% coverage
  for(let r=0;r<rows;r++){
    // whole-floor lighting modes: some floors dark, some fully lit
    const roll=rand.f(0,1);
    const floorMode = roll<0.20 ? 0 : roll<0.34 ? 2 : 1;   // 0 dark, 1 mixed, 2 lit
    for(let c=0;c<cols;c++){
      const x=Math.round(c*cwd + (cwd-ww)/2);
      const y=Math.round(r*chd + (chd-wh)/2);
      // reveal / recess shadow (thin, so it does not eat the wall)
      g.fillStyle='rgba(0,0,0,0.30)'; g.fillRect(x-1,y-1,ww+2,wh+2);

      // dark tinted glass with a sky gradient — neutral, masked out of the tint
      const grd=g.createLinearGradient(x,y,x,y+wh);
      grd.addColorStop(0,'rgb(96,118,140)');
      grd.addColorStop(0.55,'rgb(58,74,96)');
      grd.addColorStop(1,'rgb(34,44,60)');
      g.fillStyle=grd; g.fillRect(x,y,ww,wh);
      if(rand.bool(0.22)){ // blinds / curtains
        g.fillStyle='rgba(215,210,196,0.55)';
        const n=rand.i(2,4);
        for(let b=0;b<n;b++) g.fillRect(x,y+b*3,ww,1.4);
      }
      // sill + head reveal
      g.fillStyle='rgba(255,255,255,0.35)'; g.fillRect(x-2,y+wh+1,ww+4,1.5);
      g.fillStyle='rgba(0,0,0,0.18)'; g.fillRect(x-2,y-2,ww+4,1.2);

      const lit = floorMode===2 ? rand.bool(0.88) : floorMode===1 ? rand.bool(0.42) : rand.bool(0.05);
      if(lit){
        const warm=rand.bool(0.78);
        const col = warm ? [255, 206+(rand.f(-18,18)|0), 148+(rand.f(-26,26)|0)]
                         : [156+(rand.f(-26,26)|0), 214, 246];
        const k = rand.f(0.45,1.0);
        eg.fillStyle=`rgb(${(col[0]*k)|0},${(col[1]*k)|0},${(col[2]*k)|0})`;
        eg.fillRect(x,y,ww,wh);
        // a warm smear of the interior spilling onto the albedo too
        g.fillStyle=`rgba(${col[0]},${col[1]},${col[2]},0.16)`; g.fillRect(x,y,ww,wh);
      }
    }
  }

  // weathering: grime streaks running down from sills, heavier low on the tile
  for(let i=0;i<70;i++){
    const x=rand.f(0,W), y=rand.f(0,H), h=rand.f(6,40), w=rand.f(1,3.5);
    g.fillStyle=`rgba(60,54,46,${rand.f(0.03,0.10)})`;
    g.fillRect(x,y,w,h);
  }
  const gg=g.createLinearGradient(0,H*0.6,0,H);
  gg.addColorStop(0,'rgba(56,50,42,0)'); gg.addColorStop(1,'rgba(56,50,42,0.14)');
  g.fillStyle=gg; g.fillRect(0,H*0.6,W,H*0.4);

  // ---- wall/glass mask into the alpha channel -----------------------------
  const img=g.getImageData(0,0,W,H), d=img.data;
  for(let i=0;i<d.length;i+=4) d[i+3]=255;
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const x=Math.round(c*cwd + (cwd-ww)/2), y=Math.round(r*chd + (chd-wh)/2);
    for(let j=y;j<y+wh;j++) for(let k=x;k<x+ww;k++){
      const idx=((j*W)+k)*4+3; if(idx<d.length) d[idx]=26;
    }
  }
  g.putImageData(img,0,0);

  return { map:mkTex(cw), emap:mkTex(em) };
}

// Ground floor band: piers, glazing, fascia sign, stall riser, some solid bays.
function shopTexture(rand){
  const W=256,H=256;
  const cw=document.createElement('canvas'); cw.width=W; cw.height=H;
  const g=cw.getContext('2d');
  const em=document.createElement('canvas'); em.width=W; em.height=H;
  const eg=em.getContext('2d'); eg.fillStyle='#000'; eg.fillRect(0,0,W,H);

  g.fillStyle='rgb(226,220,210)'; g.fillRect(0,0,W,H);
  noiseInto(g,W,H,rand,8);

  const bays=4, bw=W/bays;
  const FASCIA=44, HEAD=56, SILL=210;    // canvas Y: 0 = top of the 4.2m band
  // continuous fascia band across the whole frontage
  g.fillStyle='rgba(46,42,38,0.82)'; g.fillRect(0,0,W,FASCIA);
  g.fillStyle='rgba(255,255,255,0.13)'; g.fillRect(0,FASCIA-3,W,3);

  for(let b=0;b<bays;b++){
    const x0=b*bw;
    const pier=11;
    // pier (structural column) either side of the bay
    g.fillStyle='rgba(0,0,0,0.14)'; g.fillRect(x0,FASCIA,pier,H-FASCIA);
    g.fillStyle='rgba(255,255,255,0.16)'; g.fillRect(x0+pier-2,FASCIA,2,H-FASCIA);

    const gx=x0+pier, gw=bw-pier*2;
    const solid = rand.bool(0.26);
    if(solid){
      // blank/entrance bay: recessed doorway
      g.fillStyle='rgba(0,0,0,0.10)'; g.fillRect(gx,HEAD,gw,H-HEAD);
      const dw=gw*0.52, dx=gx+(gw-dw)/2;
      g.fillStyle='rgb(52,48,52)'; g.fillRect(dx,HEAD+14,dw,SILL+30-HEAD-14);
      g.fillStyle='rgba(0,0,0,0.45)'; g.fillRect(dx-3,HEAD+10,dw+6,5);
      if(rand.bool(0.5)){
        eg.fillStyle='rgb(120,96,60)'; eg.fillRect(dx+2,HEAD+16,dw-4,26);
        g.fillStyle='rgba(255,214,150,0.35)'; g.fillRect(dx+2,HEAD+16,dw-4,26);
      }
    } else {
      // glazed retail frontage: dark green-teal glass, mullions, stall riser
      const grd=g.createLinearGradient(gx,HEAD,gx,SILL);
      grd.addColorStop(0,'rgb(30,42,48)');
      grd.addColorStop(0.5,'rgb(46,62,68)');
      grd.addColorStop(1,'rgb(24,34,40)');
      g.fillStyle=grd; g.fillRect(gx,HEAD,gw,SILL-HEAD);
      g.fillStyle='rgba(0,0,0,0.35)'; g.fillRect(gx,HEAD-4,gw,4);
      // mullions
      const mn=rand.i(1,2);
      for(let m=1;m<=mn;m++){
        g.fillStyle='rgba(210,205,195,0.5)';
        g.fillRect(gx+gw*m/(mn+1)-1.5,HEAD,3,SILL-HEAD);
      }
      // stall riser below the glass
      g.fillStyle='rgb(120,112,102)'; g.fillRect(gx,SILL,gw,H-SILL);
      g.fillStyle='rgba(0,0,0,0.22)'; g.fillRect(gx,SILL,gw,3);
      // lit interior
      if(rand.bool(0.80)){
        const warm=rand.bool(0.7);
        const c = warm ? [255,196,126] : [150,224,240];
        const k = rand.f(0.5,1.0);
        eg.fillStyle=`rgb(${(c[0]*k)|0},${(c[1]*k)|0},${(c[2]*k)|0})`;
        eg.fillRect(gx+2,HEAD+2,gw-4,SILL-HEAD-4);
        g.fillStyle=`rgba(${c[0]},${c[1]},${c[2]},0.20)`; g.fillRect(gx+2,HEAD+2,gw-4,SILL-HEAD-4);
      }
    }
    // fascia sign panel
    if(rand.bool(0.62)){
      const sc=[[255,60,140],[40,224,214],[255,206,70],[255,140,80],[220,240,255]][rand.i(0,4)];
      const sx=x0+6, sw=bw-12, sy=8, sh=FASCIA-18;
      g.fillStyle=`rgba(${sc[0]},${sc[1]},${sc[2]},0.55)`; g.fillRect(sx,sy,sw,sh);
      eg.fillStyle=`rgb(${(sc[0]*0.7)|0},${(sc[1]*0.7)|0},${(sc[2]*0.7)|0})`;
      eg.fillRect(sx,sy,sw,sh);
      // sign lettering suggestion
      g.fillStyle='rgba(0,0,0,0.35)';
      for(let t=0;t<rand.i(3,6);t++) g.fillRect(sx+8+t*8, sy+sh*0.3, 5, sh*0.42);
    }
  }
  // pavement grime at the very base
  const gg=g.createLinearGradient(0,H-46,0,H);
  gg.addColorStop(0,'rgba(48,44,38,0)'); gg.addColorStop(1,'rgba(48,44,38,0.34)');
  g.fillStyle=gg; g.fillRect(0,H-46,W,46);

  // mask: only the wall/pier/fascia area takes the building tint
  const img=g.getImageData(0,0,W,H), d=img.data;
  for(let i=0;i<d.length;i+=4) d[i+3]=255;
  for(let b=0;b<bays;b++){
    const gx=Math.round(b*bw+11), gw=Math.round(bw-22);
    for(let j=0;j<H;j++){
      const inGlass = j>=HEAD-4 && j<SILL;
      if(!inGlass && j>=FASCIA) continue;
      for(let k=gx;k<gx+gw;k++){
        const idx=((j*W)+k)*4+3; if(idx<d.length) d[idx]=30;
      }
    }
    for(let j=0;j<FASCIA;j++) for(let k=Math.round(b*bw);k<Math.round((b+1)*bw);k++){
      const idx=((j*W)+k)*4+3; if(idx<d.length) d[idx]=40;
    }
  }
  g.putImageData(img,0,0);

  return { map:mkTex(cw), emap:mkTex(em) };
}

// small concrete grunge for rooftops / balconies
function grungeTexture(rand){
  const W=64,H=64, c=document.createElement('canvas'); c.width=W;c.height=H;
  const g=c.getContext('2d');
  g.fillStyle='rgb(214,208,198)'; g.fillRect(0,0,W,H);
  noiseInto(g,W,H,rand,20);
  for(let i=0;i<40;i++){
    g.fillStyle=`rgba(90,84,74,${rand.f(0.04,0.14)})`;
    g.fillRect(rand.f(0,W),rand.f(0,H),rand.f(2,12),rand.f(1,5));
  }
  const img=g.getImageData(0,0,W,H), d=img.data;
  for(let i=0;i<d.length;i+=4) d[i+3]=255;
  g.putImageData(img,0,0);
  const t=mkTex(c); t.repeat.set(2,2); return t;
}

function mkTex(canvas){
  const t=new THREE.CanvasTexture(canvas);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=4;
  return t;
}

// ---- instancing bucket -----------------------------------------------------

class Bucket {
  constructor(geo, mat){ this.geo=geo; this.mat=mat; this.items=[]; }
  add(x,y,z,w,h,d,tint,rot=0,lit=1,uo=0,vo=0){
    this.items.push([x,y,z,w,h,d,tint,rot,lit,uo,vo]);
  }
  finish(group, castShadow=true){
    const n=this.items.length; if(!n) return null;
    const geo=this.geo.clone();
    const tints=new Float32Array(n*3), lits=new Float32Array(n), uvo=new Float32Array(n*2);
    const mesh=new THREE.InstancedMesh(geo, this.mat, n);
    mesh.castShadow=castShadow; mesh.receiveShadow=true;
    const m4=new THREE.Matrix4(), q=new THREE.Quaternion(),
          pos=new THREE.Vector3(), scl=new THREE.Vector3(), up=new THREE.Vector3(0,1,0);
    this.items.forEach((it,i)=>{
      const [x,y,z,w,h,d,t,rot,lit,uo,vo]=it;
      q.setFromAxisAngle(up, rot);
      pos.set(x,y,z); scl.set(w,h,d);
      m4.compose(pos,q,scl);
      mesh.setMatrixAt(i,m4);
      tints[i*3]=t.r; tints[i*3+1]=t.g; tints[i*3+2]=t.b;
      lits[i]=lit; uvo[i*2]=uo; uvo[i*2+1]=vo;
    });
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints,3));
    geo.setAttribute('aLit',  new THREE.InstancedBufferAttribute(lits,1));
    geo.setAttribute('aUvOff',new THREE.InstancedBufferAttribute(uvo,2));
    mesh.instanceMatrix.needsUpdate=true;
    mesh.frustumCulled=false;
    group.add(mesh);
    return mesh;
  }
}

// ---- massing ---------------------------------------------------------------

// Returns a list of stacked/offset boxes: {x,z,w,d,y,h,rot}
function massing(b, R, gh){
  const parts=[];
  const top=b.h, base=gh, H=top-base;
  const push=(x,z,w,d,y0,y1,rot=0)=>{ if(y1-y0>0.5 && w>1 && d>1) parts.push({x,z,w,d,y:y0,h:y1-y0,rot}); };
  if(H<=0.6){ return parts; }

  const dn=b.district;
  const tall = b.landmark || b.h>52;

  if(tall){
    // podium + shaft + crown, stepping in as it rises
    const hp = base + Math.min(H*0.30, R.f(9,20));
    push(b.x,b.z,b.w,b.d, base, hp);
    let tw=b.w*R.f(0.58,0.76), td=b.d*R.f(0.58,0.76);
    const ox=R.f(-1,1)*(b.w-tw)*0.22, oz=R.f(-1,1)*(b.d-td)*0.22;
    const steps=R.i(2,4);
    let y=hp;
    for(let s=0;s<steps;s++){
      const y2 = hp + (top-hp)*((s+1)/steps);
      push(b.x+ox,b.z+oz,tw,td,y,y2);
      y=y2; tw*=R.f(0.74,0.88); td*=R.f(0.74,0.88);
    }
    if(b.landmark){
      // rotated crown block + tapered cap
      push(b.x+ox,b.z+oz,tw*1.06,td*1.06, top, top+R.f(4,9), Math.PI/4);
      push(b.x+ox,b.z+oz,tw*0.5,td*0.5, top+R.f(4,9), top+R.f(10,18));
    }
    b._topPart = parts[parts.length-1];
    return parts;
  }

  if(H>20 && R.bool(0.72)){
    // stepped setback tower
    let y=base, cw=b.w, cd=b.d, cx=b.x, cz=b.z;
    const steps=R.i(2,3);
    for(let s=0;s<steps;s++){
      const y2 = base + H*((s+1)/steps);
      push(cx,cz,cw,cd,y,y2);
      y=y2;
      const sx=R.f(0.74,0.90), sz=R.f(0.74,0.90);
      cx += (cw-cw*sx)*R.f(-0.35,0.35);
      cz += (cd-cd*sz)*R.f(-0.35,0.35);
      cw*=sx; cd*=sz;
    }
    b._topPart = parts[parts.length-1];
    return parts;
  }

  const form = R.f(0,1);
  if(form<0.24){
    // L plan
    const da=b.d*R.f(0.44,0.60);
    const zSign=R.bool()?1:-1;
    push(b.x, b.z+zSign*(b.d-da)/2, b.w, da, base, top);
    const wb=b.w*R.f(0.38,0.55);
    const xSign=R.bool()?1:-1;
    push(b.x+xSign*(b.w-wb)/2, b.z, wb, b.d, base, base+H*R.f(0.62,1.0));
  } else if(form<0.38){
    // U plan (courtyard opening to the street)
    const da=b.d*R.f(0.30,0.42);
    push(b.x, b.z-(b.d-da)/2, b.w, da, base, top);
    const wb=b.w*R.f(0.26,0.36);
    push(b.x-(b.w-wb)/2, b.z, wb, b.d, base, base+H*R.f(0.78,1.0));
    push(b.x+(b.w-wb)/2, b.z, wb, b.d, base, base+H*R.f(0.78,1.0));
  } else if(form<0.54){
    // slab + low wing
    const ww=b.w*R.f(0.48,0.64);
    push(b.x-(b.w-ww)/2, b.z, ww, b.d, base, top);
    push(b.x+ww/2, b.z, b.w-ww, b.d*R.f(0.72,1.0), base, base+H*R.f(0.34,0.62));
  } else if(form<0.70){
    // box with penthouse / plant room step
    push(b.x,b.z,b.w,b.d, base, top);
    const pw=b.w*R.f(0.42,0.66), pd=b.d*R.f(0.42,0.66);
    push(b.x+R.f(-1,1)*(b.w-pw)*0.3, b.z+R.f(-1,1)*(b.d-pd)*0.3, pw, pd, top, top+R.f(2.6,5.0));
  } else {
    push(b.x,b.z,b.w,b.d, base, top);
  }
  b._topPart = parts[parts.length-1];
  return parts;
}

// ---------------------------------------------------------------------------

export class Buildings {
  constructor(scene, city, seed=99){
    this.scene=scene; this.city=city; this.rand=new Rand(seed);
    this.group=new THREE.Group(); this.group.name='Buildings'; scene.add(this.group);
    this.matCache=new Map();
    this.emissiveMats=[];
  }

  // Small, fixed material set — 4 entries total, all shared by every building.
  materials(){
    if(this.matCache.size) return this.matCache;
    const R=this.rand;
    const fac=facadeTexture(R);
    const body=facadeMaterial(fac.map, fac.emap, {
      key:'facade-body-v2', roofCol:'vec3(0.34,0.32,0.29)', rough:0.72,
      uvFn:`
        const float TILE = ${TILE.toFixed(1)};
        vec2 tileUv(vec2 uvIn, vec3 nrm, mat4 im){
          vec3 sc = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
          vec2 dim;
          if(abs(nrm.x) > 0.5)      dim = vec2(sc.z, sc.y);
          else if(abs(nrm.y) > 0.5) dim = vec2(sc.x, sc.z);
          else                      dim = vec2(sc.x, sc.y);
          return uvIn * max(floor(dim / TILE), vec2(1.0));
        }`,
    });
    const shop=shopTexture(R);
    const ground=facadeMaterial(shop.map, shop.emap, {
      key:'facade-shop-v2', roofCol:'vec3(0.40,0.38,0.35)', rough:0.66,
      uvFn:`
        const float BAY = ${BAY.toFixed(1)};
        vec2 tileUv(vec2 uvIn, vec3 nrm, mat4 im){
          vec3 sc = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
          float wdt = (abs(nrm.x) > 0.5) ? sc.z : sc.x;
          return vec2(uvIn.x * max(floor(wdt / BAY + 0.5), 1.0), uvIn.y);
        }`,
    });
    const grunge=grungeTexture(R);
    const trim=tintedMaterial({ map:grunge, roughness:0.88, metalness:0.0 });
    const fabric=tintedMaterial({ map:grunge, roughness:0.94, metalness:0.0 });
    this.matCache.set('body',body); this.matCache.set('ground',ground);
    this.matCache.set('trim',trim); this.matCache.set('fabric',fabric);
    this.emissiveMats=[body,ground];
    return this.matCache;
  }

  build(){
    const R=this.rand;
    const M=this.materials();
    const box=new THREE.BoxGeometry(1,1,1);

    const bBody = new Bucket(box, M.get('body'));
    const bGround = new Bucket(box, M.get('ground'));
    const bTrim = new Bucket(box, M.get('trim'));
    const bFab  = new Bucket(box, M.get('fabric'));

    const col=new THREE.Color();
    const WHITE=new THREE.Color(1,1,1);

    for(const b of this.city.buildings){
      // --- per-building albedo tint: palette colour, small jitter, weathering
      col.setHex(b.colour);
      const jit = b.tint ?? 1.0;
      col.offsetHSL((R.f(-0.02,0.02)), R.f(-0.06,0.06), 0);
      col.multiplyScalar(jit * (1.0 - 0.14*(b.grime ?? 0.5)));
      const tint=col.clone();
      const trimTint=col.clone().multiplyScalar(0.62).lerp(new THREE.Color(0x6a6155), 0.55);

      // --- per-building window brightness: a third of the city stays dim
      const lit = R.bool(0.28) ? R.f(0.06,0.25) : R.f(0.55,1.25);
      b.litScale = lit;
      const uo = R.i(0,7)/8, vo = R.i(0,7)/8;

      // --- ground floor band -------------------------------------------------
      const gh = Math.min(4.4, b.h*0.5);
      const retail = b.district!=='industrial' || R.bool(0.35);
      const gOut = retail ? 0.35 : 0.0;   // shopfront plinth pushes to the pavement
      bGround.add(b.x, gh/2, b.z, b.w+gOut*2, gh, b.d+gOut*2, tint, 0,
                  retail ? Math.max(lit,0.75) : lit*0.5, R.i(0,3)/4, 0);

      // canopy / cornice line separating retail from the body above
      bTrim.add(b.x, gh+0.16, b.z, b.w+1.25, 0.32, b.d+1.25, trimTint, 0, 0);

      // --- massing ----------------------------------------------------------
      const parts = massing(b, R, gh);
      for(const p of parts){
        bBody.add(p.x, p.y+p.h/2, p.z, p.w, p.h, p.d, tint, p.rot, lit, uo, vo);
      }
      b.parts = parts;

      // --- awnings over the shopfront (street-level colour) ------------------
      if(retail && b.district!=='industrial' && R.bool(0.42)){
        const AW=[0xd9563f,0x2f8f86,0xe6b23c,0xefe4d2,0x8f3f64];
        const n=R.i(1,2);
        for(let i=0;i<n;i++){
          const front = R.bool();
          const aw = front ? b.w*R.f(0.30,0.55) : b.d*R.f(0.30,0.55);
          const off = R.f(-0.25,0.25);
          const c=new THREE.Color(AW[R.i(0,AW.length-1)]);
          if(front){
            const zs=R.bool()?1:-1;
            bFab.add(b.x+off*b.w, 3.05, b.z+zs*(b.d/2+gOut+0.65), aw, 0.16, 1.5, c, 0, 0);
            bFab.add(b.x+off*b.w, 3.32, b.z+zs*(b.d/2+gOut+0.05), aw, 0.5, 0.14, c, 0, 0);
          } else {
            const xs=R.bool()?1:-1;
            bFab.add(b.x+xs*(b.w/2+gOut+0.65), 3.05, b.z+off*b.d, 1.5, 0.16, aw, c, 0, 0);
            bFab.add(b.x+xs*(b.w/2+gOut+0.05), 3.32, b.z+off*b.d, 0.14, 0.5, aw, c, 0, 0);
          }
        }
      }

      // --- balconies on residential / beach ---------------------------------
      if((b.district==='residential'||b.district==='beach') && b.h>10 && R.bool(0.7)){
        const p=parts[0];
        if(p){
          const zs = R.bool()?1:-1;
          const bw = p.w*R.f(0.5,0.8);
          for(let y=gh+3.4; y<p.y+p.h-1.6; y+=3.4){
            if(R.bool(0.22)) continue;
            bTrim.add(p.x, y, p.z+zs*(p.d/2+0.55), bw, 0.16, 1.1, trimTint, 0, 0);
            bTrim.add(p.x, y+0.48, p.z+zs*(p.d/2+1.05), bw, 0.9, 0.10,
                      trimTint.clone().multiplyScalar(1.25), 0, 0);
          }
        }
      }

      // --- rooftops ---------------------------------------------------------
      this.roofFor(b, parts, bTrim, trimTint, R);
    }

    bBody.finish(this.group);
    bGround.finish(this.group);
    bTrim.finish(this.group);
    bFab.finish(this.group);

    this.hookSun();
    return this;
  }

  roofFor(b, parts, bucket, tint, R){
    // parapet around each setback level + plant/AC clutter on the top
    for(let i=0;i<parts.length;i++){
      const p=parts[i];
      if(p.w<4 || p.d<4) continue;
      if(i>0 && R.bool(0.5)) continue;         // not every level
      const ph=R.f(0.7,1.5), t=0.36, ty=p.y+p.h+ph/2;
      bucket.add(p.x, ty, p.z-p.d/2, p.w, ph, t, tint, p.rot, 0);
      bucket.add(p.x, ty, p.z+p.d/2, p.w, ph, t, tint, p.rot, 0);
      bucket.add(p.x-p.w/2, ty, p.z, t, ph, p.d, tint, p.rot, 0);
      bucket.add(p.x+p.w/2, ty, p.z, t, ph, p.d, tint, p.rot, 0);
    }
    const top=b._topPart || parts[parts.length-1];
    if(!top) return;
    const ty=top.y+top.h;
    const n = b.h>30 ? R.i(2,4) : R.i(1,2);
    for(let i=0;i<n;i++){
      const w=R.f(1.4,3.4), d=R.f(1.4,3.4), h=R.f(0.9,2.6);
      bucket.add(top.x+R.f(-0.32,0.32)*top.w, ty+h/2, top.z+R.f(-0.32,0.32)*top.d,
                 w,h,d, tint.clone().multiplyScalar(R.f(0.8,1.15)), 0, 0);
    }
    if(b.h>26 && R.bool(0.45)){
      const h=R.f(5,16);
      bucket.add(top.x, ty+h/2, top.z, 0.28, h, 0.28, tint, 0, 0);
      bucket.add(top.x, ty+h*0.55, top.z, 1.4, 0.2, 0.2, tint, 0, 0);
    }
    // water tank / stair head
    if(R.bool(0.3) && top.w>6){
      const w=R.f(2.0,3.2);
      bucket.add(top.x+R.f(-0.2,0.2)*top.w, ty+1.5, top.z+R.f(-0.2,0.2)*top.d, w, 3.0, w,
                 tint.clone().multiplyScalar(0.9), 0, 0);
    }
  }

  // Window emissive follows the sun: near-off at noon, full at night. Driven off
  // the scene's directional light so no per-frame module hook is required.
  hookSun(){
    let sun=null;
    this.scene.traverse(o=>{ if(!sun && o.isDirectionalLight) sun=o; });
    if(!sun) return;
    const first=this.group.children[0];
    if(!first) return;
    const mats=this.emissiveMats;
    const v=new THREE.Vector3();
    first.onBeforeRender = ()=>{
      v.copy(sun.position).sub(sun.target.position);
      const elev = v.lengthSq()>1e-6 ? v.y/v.length() : 0;
      const t = THREE.MathUtils.clamp((elev+0.12)/0.30, 0, 1);
      const night = 1.0 - (t*t*(3.0-2.0*t));
      const e = 0.05 + 1.30*Math.pow(night,0.75);
      for(const m of mats) m.emissiveIntensity = e;
    };
  }
}

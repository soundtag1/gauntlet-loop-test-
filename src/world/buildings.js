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
attribute vec3 aRoofCol;
varying vec3 vRoofCol;
varying vec3 vTint;
varying float vLit;
varying float vRoof;
varying float vWorldY;
`;
const DECL_F = `
uniform float uNight;
varying vec3 vRoofCol;
varying vec3 vTint;
varying float vLit;
varying float vRoof;
varying float vWorldY;
`;

// Fake environment response so no surface is ever pure black (rubric S1/S2):
//  * a warm street-lamp / shopfront bounce that falls off with height at night
//  * a faint cool sky-bounce so shaded daytime faces keep a colour cast
const AMBIENT_INJECT = `
  // glass barely picks up the bounce, so unlit windows stay dark against the wall
  float amb = mix(0.35, 1.0, wallMask);
  float sg = exp(-max(vWorldY - 1.5, 0.0) * 0.125) * (1.0 - vRoof);
  totalEmissiveRadiance += diffuseColor.rgb * amb * (
      uNight * (vec3(1.30, 0.90, 0.55) * sg * 0.58 + vec3(0.34, 0.38, 0.56) * 0.080)
    + (1.0 - uNight) * vec3(0.075, 0.086, 0.105) );
`;

// Tint + roof handling shared by every building material.
function fragInject(mat, roofCol){
  return `
    float wallMask = diffuseColor.a;
    diffuseColor.rgb *= mix(vec3(1.0), vTint, wallMask);
    diffuseColor.rgb = mix(diffuseColor.rgb, vRoofCol * ${roofCol}, vRoof);
    diffuseColor.a = 1.0;
  `;
}

function worldYInject(){
  return `
        #ifdef USE_INSTANCING
          vWorldY = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
        #else
          vWorldY = (modelMatrix * vec4(position, 1.0)).y;
        #endif`;
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
        vRoofCol = aRoofCol;
        vLit = aLit;
        vRoof = step(0.5, abs(normal.y));${worldYInject()}
        #ifdef USE_INSTANCING
          vec2 tiled = tileUv(uv, normal, instanceMatrix) + aUvOff;
          vMapUv = tiled;
          #ifdef USE_EMISSIVEMAP
            vEmissiveMapUv = tiled;
          #endif
        #endif`);
    sh.uniforms.uNight = opts.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL_F}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${fragInject(m, opts.roofCol)}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vLit * (1.0 - vRoof);
        ${AMBIENT_INJECT}`);
  };
  m.customProgramCacheKey = ()=>opts.key;
  return m;
}

// Plain tinted material (rooftops, balconies, awnings) — no uv retiling.
function tintedMaterial(base, uNight){
  const m = new THREE.MeshStandardMaterial(base);
  m.onBeforeCompile = (sh)=>{
    sh.uniforms.uNight = uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL_V}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vTint = aTint; vRoofCol = aRoofCol; vLit = aLit; vRoof = step(0.5, abs(normal.y));${worldYInject()}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL_F}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float wallMask = 1.0;
        diffuseColor.rgb *= vTint;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vLit;
        ${AMBIENT_INJECT}`);
  };
  m.customProgramCacheKey = ()=>'tinted-v3';
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

// Shared helper: stamp the wall/glass mask into the alpha channel.
// alpha 255 = wall (takes the per-building tint), low alpha = glass (stays neutral).
function stampMask(g, W, H, rects){
  const img=g.getImageData(0,0,W,H), d=img.data;
  for(let i=0;i<d.length;i+=4) d[i+3]=255;
  for(const [x0,y0,w,h,a] of rects){
    const xs=Math.max(0,Math.round(x0)), ys=Math.max(0,Math.round(y0));
    const xe=Math.min(W,Math.round(x0+w)), ye=Math.min(H,Math.round(y0+h));
    for(let j=ys;j<ye;j++) for(let k=xs;k<xe;k++) d[((j*W)+k)*4+3]=a;
  }
  g.putImageData(img,0,0);
}

// Punched-window facade for low/mid-rise stucco blocks.
// The wall is a bright warm plaster and windows cover ~22% of the surface, so a
// sunlit face reads as its district colour rather than as a grid of black holes.
function facadeTexture(rand){
  const W=256,H=256;
  const cw=document.createElement('canvas'); cw.width=W; cw.height=H;
  const g=cw.getContext('2d');
  const em=document.createElement('canvas'); em.width=W; em.height=H;
  const eg=em.getContext('2d'); eg.fillStyle='#000'; eg.fillRect(0,0,W,H);

  g.fillStyle='rgb(243,239,231)'; g.fillRect(0,0,W,H);
  noiseInto(g,W,H,rand,7);

  const cols=8, rows=8, cwd=W/cols, chd=H/rows;

  // floor-slab banding + pilasters: shallow, so they do not darken the wall
  for(let r=0;r<=rows;r++){
    const y=r*chd;
    g.fillStyle='rgba(120,108,92,0.16)'; g.fillRect(0,y-2,W,2);
    g.fillStyle='rgba(255,255,255,0.30)'; g.fillRect(0,y,W,1);
  }
  for(let c=0;c<=cols;c++){
    const x=c*cwd;
    g.fillStyle='rgba(120,108,92,0.07)'; g.fillRect(x-1,0,1,H);
    g.fillStyle='rgba(255,255,255,0.12)'; g.fillRect(x,0,1,H);
  }

  const ww=14, wh=16;                 // 224/1024 -> 22% glass coverage
  const mask=[];
  for(let r=0;r<rows;r++){
    const roll=rand.f(0,1);
    const floorMode = roll<0.20 ? 0 : roll<0.36 ? 2 : 1;   // dark / mixed / lit floor
    for(let c=0;c<cols;c++){
      const x=Math.round(c*cwd + (cwd-ww)/2);
      const y=Math.round(r*chd + (chd-wh)/2);

      // --- opening: reveal shadow on the head + left jamb only (an inset hole)
      g.fillStyle='rgba(96,84,68,0.55)'; g.fillRect(x-1.5,y-1.5,ww+3,2.0);
      g.fillStyle='rgba(96,84,68,0.35)'; g.fillRect(x-1.5,y-1.5,2.0,wh+3);

      // --- glass: sky-reflecting, mid-tone. Never near-black.
      const grd=g.createLinearGradient(x,y,x,y+wh);
      grd.addColorStop(0,'rgb(168,190,208)');
      grd.addColorStop(0.42,'rgb(120,142,166)');
      grd.addColorStop(1,'rgb(78,96,120)');
      g.fillStyle=grd; g.fillRect(x,y,ww,wh);
      if(rand.bool(0.24)){                       // blinds / net curtains
        g.fillStyle='rgba(228,222,206,0.60)';
        const n=rand.i(2,4);
        for(let bl=0;bl<n;bl++) g.fillRect(x,y+bl*3,ww,1.4);
      }

      // --- frame: mullion + transom so the window reads as joinery, not a decal
      g.fillStyle='rgba(246,242,234,0.85)';
      g.fillRect(x+ww/2-0.9, y, 1.8, wh);         // vertical mullion
      g.fillRect(x, y+wh*0.42-0.7, ww, 1.4);      // transom
      g.strokeStyle='rgba(250,246,238,0.75)'; g.lineWidth=1.2;
      g.strokeRect(x+0.6,y+0.6,ww-1.2,wh-1.2);    // frame

      // --- sill: bright nosing with its own drop shadow
      g.fillStyle='rgba(255,253,246,0.95)'; g.fillRect(x-2.5,y+wh,ww+5,2.2);
      g.fillStyle='rgba(110,96,78,0.42)';  g.fillRect(x-2.5,y+wh+2.2,ww+5,1.6);

      const lit = floorMode===2 ? rand.bool(0.88) : floorMode===1 ? rand.bool(0.44) : rand.bool(0.05);
      if(lit){
        const warm=rand.bool(0.78);
        const col = warm ? [255, 206+(rand.f(-18,18)|0), 148+(rand.f(-26,26)|0)]
                         : [156+(rand.f(-26,26)|0), 214, 246];
        const k = rand.f(0.5,1.0);
        // ceiling-bright interior falling off toward the sill
        const eGrd=eg.createLinearGradient(x,y,x,y+wh);
        eGrd.addColorStop(0,`rgb(${(col[0]*k)|0},${(col[1]*k)|0},${(col[2]*k)|0})`);
        eGrd.addColorStop(1,`rgb(${(col[0]*k*0.45)|0},${(col[1]*k*0.45)|0},${(col[2]*k*0.45)|0})`);
        eg.fillStyle=eGrd; eg.fillRect(x,y,ww,wh);
        // the joinery stays dark against the glow -> panes read separately
        eg.fillStyle='rgba(0,0,0,0.85)';
        eg.fillRect(x+ww/2-0.9, y, 1.8, wh);
        eg.fillRect(x, y+wh*0.42-0.7, ww, 1.4);
        eg.strokeStyle='rgba(0,0,0,0.8)'; eg.lineWidth=1.4; eg.strokeRect(x+0.7,y+0.7,ww-1.4,wh-1.4);
        g.fillStyle=`rgba(${col[0]},${col[1]},${col[2]},0.14)`; g.fillRect(x,y,ww,wh);
      }
      mask.push([x,y,ww,wh,24]);
    }
  }

  // weathering: light grime streaks below sills, a touch of soot at the base
  for(let i=0;i<48;i++){
    const x=rand.f(0,W), y=rand.f(0,H), h=rand.f(5,26), w=rand.f(1,3);
    g.fillStyle=`rgba(104,94,80,${rand.f(0.02,0.06)})`;
    g.fillRect(x,y,w,h);
  }
  const gg=g.createLinearGradient(0,H*0.72,0,H);
  gg.addColorStop(0,'rgba(96,86,72,0)'); gg.addColorStop(1,'rgba(96,86,72,0.09)');
  g.fillStyle=gg; g.fillRect(0,H*0.72,W,H*0.28);

  stampMask(g,W,H,mask);
  return { map:mkTex(cw), emap:mkTex(em) };
}

// Curtain-wall facade for downtown towers: horizontal glazing ribbons between
// tinted spandrel bands, split by vertical mullions. Reads as a commercial
// tower rather than a grid of punched holes, and gives the skyline two
// distinctly different facade languages for one extra draw call.
function curtainTexture(rand){
  const W=256,H=256;
  const cw=document.createElement('canvas'); cw.width=W; cw.height=H;
  const g=cw.getContext('2d');
  const em=document.createElement('canvas'); em.width=W; em.height=H;
  const eg=em.getContext('2d'); eg.fillStyle='#000'; eg.fillRect(0,0,W,H);

  g.fillStyle='rgb(236,232,224)'; g.fillRect(0,0,W,H);
  noiseInto(g,W,H,rand,6);

  const rows=8, rh=H/rows, panes=8, pw=W/panes;
  const gTop=4, gH=Math.round(rh*0.56);          // glazing ribbon inside each floor
  const mask=[];

  for(let r=0;r<rows;r++){
    const y0=Math.round(r*rh)+gTop;
    // spandrel band under the ribbon: solid, tinted, slightly darker than wall
    g.fillStyle='rgba(120,110,96,0.18)';
    g.fillRect(0, y0+gH, W, rh-gH-gTop);
    g.fillStyle='rgba(255,255,255,0.28)'; g.fillRect(0, y0+gH+1.5, W, 1.2);

    // the glazing ribbon
    const grd=g.createLinearGradient(0,y0,0,y0+gH);
    grd.addColorStop(0,'rgb(158,182,202)');
    grd.addColorStop(0.45,'rgb(104,128,152)');
    grd.addColorStop(1,'rgb(70,88,112)');
    g.fillStyle=grd; g.fillRect(0,y0,W,gH);
    g.fillStyle='rgba(92,80,66,0.55)'; g.fillRect(0,y0-1.6,W,1.6);   // head reveal
    g.fillStyle='rgba(255,253,246,0.85)'; g.fillRect(0,y0+gH,W,1.6); // sill nosing

    const roll=rand.f(0,1);
    const floorMode = roll<0.24 ? 0 : roll<0.38 ? 2 : 1;
    for(let c=0;c<panes;c++){
      const x=Math.round(c*pw);
      const lit = floorMode===2 ? rand.bool(0.85) : floorMode===1 ? rand.bool(0.40) : rand.bool(0.04);
      if(lit){
        const warm=rand.bool(0.62);
        const col = warm ? [255, 214+(rand.f(-16,16)|0), 162+(rand.f(-22,22)|0)]
                         : [172+(rand.f(-24,24)|0), 224, 250];
        const k=rand.f(0.5,1.0);
        const eGrd=eg.createLinearGradient(0,y0,0,y0+gH);
        eGrd.addColorStop(0,`rgb(${(col[0]*k)|0},${(col[1]*k)|0},${(col[2]*k)|0})`);
        eGrd.addColorStop(1,`rgb(${(col[0]*k*0.5)|0},${(col[1]*k*0.5)|0},${(col[2]*k*0.5)|0})`);
        eg.fillStyle=eGrd; eg.fillRect(x+2,y0+1,pw-4,gH-2);
        g.fillStyle=`rgba(${col[0]},${col[1]},${col[2]},0.13)`; g.fillRect(x+2,y0+1,pw-4,gH-2);
      }
      if(rand.bool(0.16)){ // blinds half-drawn
        g.fillStyle='rgba(226,220,204,0.45)'; g.fillRect(x+2,y0+1,pw-4,gH*rand.f(0.25,0.5));
      }
    }
    // vertical mullions over the whole ribbon
    for(let c=0;c<=panes;c++){
      const x=Math.round(c*pw);
      g.fillStyle='rgba(246,242,234,0.90)'; g.fillRect(x-1.1,y0-1,2.2,gH+2);
      eg.fillStyle='rgba(0,0,0,0.9)';       eg.fillRect(x-1.1,y0-1,2.2,gH+2);
    }
    mask.push([0,y0,W,gH,26]);
  }

  for(let i=0;i<40;i++){
    g.fillStyle=`rgba(104,94,80,${rand.f(0.02,0.05)})`;
    g.fillRect(rand.f(0,W),rand.f(0,H),rand.f(1,3),rand.f(6,30));
  }
  stampMask(g,W,H,mask);
  return { map:mkTex(cw), emap:mkTex(em) };
}

// Ground floor band: piers, glazing, fascia sign, stall riser, some solid bays.
function shopTexture(rand){
  const W=256,H=256;
  const cw=document.createElement('canvas'); cw.width=W; cw.height=H;
  const g=cw.getContext('2d');
  const em=document.createElement('canvas'); em.width=W; em.height=H;
  const eg=em.getContext('2d'); eg.fillStyle='#000'; eg.fillRect(0,0,W,H);

  g.fillStyle='rgb(240,235,226)'; g.fillRect(0,0,W,H);
  noiseInto(g,W,H,rand,7);

  const bays=4, bw=W/bays;
  const FASCIA=44, HEAD=56, SILL=210;    // canvas Y: 0 = top of the 4.2m band
  // continuous fascia band across the whole frontage
  g.fillStyle='rgba(58,52,46,0.62)'; g.fillRect(0,0,W,FASCIA);
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
  add(x,y,z,w,h,d,tint,rot=0,lit=1,uo=0,vo=0,roof=null){
    this.items.push([x,y,z,w,h,d,tint,rot,lit,uo,vo,roof||tint]);
  }
  finish(group, castShadow=true){
    const n=this.items.length; if(!n) return null;
    const geo=this.geo.clone();
    const tints=new Float32Array(n*3), lits=new Float32Array(n), uvo=new Float32Array(n*2);
    const roofs=new Float32Array(n*3);
    const mesh=new THREE.InstancedMesh(geo, this.mat, n);
    mesh.castShadow=castShadow; mesh.receiveShadow=true;
    const m4=new THREE.Matrix4(), q=new THREE.Quaternion(),
          pos=new THREE.Vector3(), scl=new THREE.Vector3(), up=new THREE.Vector3(0,1,0);
    this.items.forEach((it,i)=>{
      const [x,y,z,w,h,d,t,rot,lit,uo,vo,rc]=it;
      q.setFromAxisAngle(up, rot);
      pos.set(x,y,z); scl.set(w,h,d);
      m4.compose(pos,q,scl);
      mesh.setMatrixAt(i,m4);
      tints[i*3]=t.r; tints[i*3+1]=t.g; tints[i*3+2]=t.b;
      roofs[i*3]=rc.r; roofs[i*3+1]=rc.g; roofs[i*3+2]=rc.b;
      lits[i]=lit; uvo[i*2]=uo; uvo[i*2+1]=vo;
    });
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints,3));
    geo.setAttribute('aLit',  new THREE.InstancedBufferAttribute(lits,1));
    geo.setAttribute('aUvOff',new THREE.InstancedBufferAttribute(uvo,2));
    geo.setAttribute('aRoofCol', new THREE.InstancedBufferAttribute(roofs,3));
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
    // podium + shaft + crown, stepping in as it rises.
    // The shaft is sometimes turned 45deg on its podium, or run as a thin slab,
    // so downtown is not a field of identical extrusions.
    const noPodium = R.bool(0.22);
    const hp = noPodium ? base : base + Math.min(H*0.30, R.f(9,20));
    if(!noPodium) push(b.x,b.z,b.w,b.d, base, hp);
    const slab = R.bool(0.26);
    const yaw  = (!noPodium && R.bool(0.20)) ? Math.PI/4 : 0;
    const k = yaw ? 0.66 : 1.0;                       // a turned shaft must fit the plot
    let tw = b.w*(slab ? R.f(0.34,0.48) : R.f(0.58,0.78))*k;
    let td = b.d*(slab ? R.f(0.72,0.95) : R.f(0.58,0.78))*k;
    const ox = yaw ? 0 : R.f(-1,1)*(b.w-tw)*0.22;
    const oz = yaw ? 0 : R.f(-1,1)*(b.d-td)*0.22;
    const steps = slab ? R.i(1,2) : R.i(2,4);
    let y=hp;
    for(let s=0;s<steps;s++){
      const y2 = hp + (top-hp)*((s+1)/steps);
      push(b.x+ox,b.z+oz,tw,td,y,y2,yaw);
      y=y2; tw*=R.f(0.78,0.90); td*=R.f(0.78,0.90);
    }
    if(b.landmark){
      // rotated crown block + tapered cap
      push(b.x+ox,b.z+oz,tw*1.06,td*1.06, top, top+R.f(4,9), yaw ? 0 : Math.PI/4);
      push(b.x+ox,b.z+oz,tw*0.5,td*0.5, top+R.f(4,9), top+R.f(10,18), yaw);
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
    this.uNight={ value:1.0 };   // shared uniform: 0 = midday, 1 = deep night
  }

  // Small, fixed material set — 5 entries total, all shared by every building.
  materials(){
    if(this.matCache.size) return this.matCache;
    const R=this.rand;
    const TILE_UV = `
        const float TILE = ${TILE.toFixed(1)};
        vec2 tileUv(vec2 uvIn, vec3 nrm, mat4 im){
          vec3 sc = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
          vec2 dim;
          if(abs(nrm.x) > 0.5)      dim = vec2(sc.z, sc.y);
          else if(abs(nrm.y) > 0.5) dim = vec2(sc.x, sc.z);
          else                      dim = vec2(sc.x, sc.y);
          return uvIn * max(floor(dim / TILE), vec2(1.0));
        }`;
    const fac=facadeTexture(R);
    const body=facadeMaterial(fac.map, fac.emap, {
      key:'facade-body-v4', roofCol:'vec3(1.0,0.98,0.95)', rough:0.72,
      uvFn:TILE_UV, uNight:this.uNight,
    });
    const cur=curtainTexture(R);
    const glass=facadeMaterial(cur.map, cur.emap, {
      key:'facade-curtain-v4', roofCol:'vec3(0.94,0.95,0.98)', rough:0.46,
      uvFn:TILE_UV, uNight:this.uNight,
    });
    glass.metalness=0.16;
    const shop=shopTexture(R);
    const ground=facadeMaterial(shop.map, shop.emap, {
      key:'facade-shop-v4', roofCol:'vec3(1.0,0.98,0.95)', rough:0.66, uNight:this.uNight,
      uvFn:`
        const float BAY = ${BAY.toFixed(1)};
        vec2 tileUv(vec2 uvIn, vec3 nrm, mat4 im){
          vec3 sc = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
          float wdt = (abs(nrm.x) > 0.5) ? sc.z : sc.x;
          return vec2(uvIn.x * max(floor(wdt / BAY + 0.5), 1.0), uvIn.y);
        }`,
    });
    const grunge=grungeTexture(R);
    const trim=tintedMaterial({ map:grunge, roughness:0.88, metalness:0.0 }, this.uNight);
    const fabric=tintedMaterial({ map:grunge, roughness:0.94, metalness:0.0 }, this.uNight);
    this.matCache.set('body',body); this.matCache.set('glass',glass);
    this.matCache.set('ground',ground);
    this.matCache.set('trim',trim); this.matCache.set('fabric',fabric);
    this.emissiveMats=[body,glass,ground];
    return this.matCache;
  }

  build(){
    const R=this.rand;
    const M=this.materials();
    const box=new THREE.BoxGeometry(1,1,1);

    const bBody = new Bucket(box, M.get('body'));
    const bGlass = new Bucket(box, M.get('glass'));
    const bGround = new Bucket(box, M.get('ground'));
    const bTrim = new Bucket(box, M.get('trim'));
    const bFab  = new Bucket(box, M.get('fabric'));

    const col=new THREE.Color();
    const WHITE=new THREE.Color(1,1,1);

    for(const b of this.city.buildings){
      // --- per-building albedo tint: palette colour, small jitter, weathering
      col.setHex(b.colour);
      const jit = b.tint ?? 1.0;
      col.offsetHSL(R.f(-0.025,0.025), R.f(-0.03,0.12), R.f(-0.05,0.03));
      col.multiplyScalar(jit * (1.0 - 0.10*(b.grime ?? 0.5)));
      const tint=col.clone();
      const trimTint=col.clone().multiplyScalar(0.62).lerp(new THREE.Color(0x6a6155), 0.55);
      // roofs: tar, gravel, terracotta, white membrane, slate — read from the air
      const ROOFS=[0x35343a,0x6d675c,0x9e5238,0xb9b2a4,0x4a5158,0x585349,0x8a8172];
      const roofCol=new THREE.Color(ROOFS[R.i(0,ROOFS.length-1)])
        .multiplyScalar(R.f(0.85,1.15)).lerp(col, 0.18);

      // --- per-building window brightness: a third of the city stays dim
      const lit = R.bool(0.28) ? R.f(0.06,0.25) : R.f(0.55,1.25);
      b.litScale = lit;
      const uo = R.i(0,7)/8, vo = R.i(0,7)/8;

      // --- ground floor band -------------------------------------------------
      const gh = Math.min(4.4, b.h*0.5);
      const retail = b.district!=='industrial' || R.bool(0.35);
      const gOut = retail ? 0.35 : 0.0;   // shopfront plinth pushes to the pavement
      bGround.add(b.x, gh/2, b.z, b.w+gOut*2, gh, b.d+gOut*2, tint, 0,
                  retail ? Math.max(lit,0.75) : lit*0.5, R.i(0,3)/4, 0, roofCol);

      // canopy / cornice line separating retail from the body above
      bTrim.add(b.x, gh+0.16, b.z, b.w+1.25, 0.32, b.d+1.25, trimTint, 0, 0);

      // --- massing ----------------------------------------------------------
      const parts = massing(b, R, gh);
      // downtown towers get the curtain-wall language, everything else stucco
      const curtain = (b.district==='downtown' && b.h>26) || (b.h>44 && R.bool(0.6));
      const bMass = curtain ? bGlass : bBody;
      for(const p of parts){
        bMass.add(p.x, p.y+p.h/2, p.z, p.w, p.h, p.d, tint, p.rot, lit, uo, vo, roofCol);
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
      if((b.district==='residential'||b.district==='beach') && b.h>10 && R.bool(0.55)){
        const p=parts[0];
        if(p){
          const zs = R.bool()?1:-1;
          const bw = p.w*R.f(0.5,0.8);
          for(let y=gh+3.4; y<p.y+p.h-1.6; y+=4.5){
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

    bBody.finish(this.group, true);
    bGlass.finish(this.group, true);
    bGround.finish(this.group, false);
    bTrim.finish(this.group, false);
    bFab.finish(this.group, false);

    this.hookSun();
    return this;
  }

  roofFor(b, parts, bucket, tint, R){
    // parapet around each setback level + plant/AC clutter on the top
    for(let i=0;i<parts.length;i++){
      const p=parts[i];
      if(p.w<6 || p.d<6 || b.h<11) continue;
      if(i>0 && i<parts.length-1) continue;    // only the base and the top level
      const ph=R.f(0.7,1.5), t=0.36, ty=p.y+p.h+ph/2;
      bucket.add(p.x, ty, p.z-p.d/2, p.w, ph, t, tint, p.rot, 0);
      bucket.add(p.x, ty, p.z+p.d/2, p.w, ph, t, tint, p.rot, 0);
      bucket.add(p.x-p.w/2, ty, p.z, t, ph, p.d, tint, p.rot, 0);
      bucket.add(p.x+p.w/2, ty, p.z, t, ph, p.d, tint, p.rot, 0);
    }
    const top=b._topPart || parts[parts.length-1];
    if(!top) return;
    const ty=top.y+top.h;
    const n = b.h>30 ? R.i(1,3) : R.i(0,1);
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
    if(R.bool(0.22) && top.w>8){
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
    const mats=this.emissiveMats;
    const uN=this.uNight;
    const v=new THREE.Vector3();
    const tick=()=>{
      v.copy(sun.position).sub(sun.target.position);
      const elev = v.lengthSq()>1e-6 ? v.y/v.length() : 0;
      const t = THREE.MathUtils.clamp((elev+0.12)/0.30, 0, 1);
      const night = 1.0 - (t*t*(3.0-2.0*t));
      uN.value = night;
      const e = 0.05 + 1.30*Math.pow(night,0.75);
      for(const m of mats) m.emissiveIntensity = e;
    };
    for(const c of this.group.children) c.onBeforeRender = tick;
    tick();
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rand } from '../core/rng.js';

// ---------------------------------------------------------------------------
// INTERIORS — enterable, functional venues.
//
// Builds the five street-facing plots reserved in `ctx.city.venues`
// (bank / store / diner / pawnshop / clothing) as real shops: a recessed
// shopfront with see-through glazing, a fascia sign, a projecting neon blade,
// a walkable room behind the glass, kind-specific fit-out, and staff NPCs.
//
// ---------------------------------------------------------------------------
// PUBLIC CONTRACT — consumed by the PLAYER controller and the DIALOGUE system.
// This shape is stable; treat it as the API.
//
//   .colliders : [{minX,maxX,minZ,maxZ,minY,maxY}]   world-space AABBs of every
//                solid volume (walls, counters, shelving, fixtures). Axis-aligned,
//                already in world coordinates, never mutated after build().
//
//   .doorways  : [{x,z,r}]  world-space circles where movement must NOT be
//                blocked. Test these FIRST: if the player is inside any doorway
//                circle, skip the collider test entirely, otherwise the wall
//                segments either side of a door will seal the entrance.
//
//   .interact(playerPos) -> {label, npc, kind, id} | null
//                Nearest interactable within ~2.5 m of playerPos (a THREE.Vector3
//                or any {x,y,z}). `label` is a ready-to-draw prompt string
//                ("Talk to teller", "Use ATM"). `npc` is the NPC record for
//                kind==='npc' (pass it to ctx.dialogue.talkTo), else null.
//                Returns a freshly allocated object; safe to retain.
//
//   .npcs      : [{id,name,role,venue,sign,label,pos:Vector3,yaw,lines:[…]}]
//                Every worker. `pos` is their feet position, `lines` are fallback
//                greetings so dialogue has something to say without the LLM.
//
//   .venueInfo : [{kind,sign,centre:{x,z},door:{x,z},inside:{x,z},yaw}]
//                Entrance and a safe interior spawn point per venue.
//
// ---------------------------------------------------------------------------
// PERFORMANCE NOTES (software rasteriser, no GPU)
//  * All five venues are merged into 9 meshes: exterior shell, interior shell,
//    floors, metalwork, glazing, emissive light/neon, signage atlas, and two
//    InstancedMeshes for NPC bodies / upper bodies. Only the exterior shell
//    casts shadows, so the shadow pass costs one extra call.
//  * Transparency is used ONCE, for the shopfront glazing: a single layer of
//    quads, depthWrite off (so it never blacks out the room behind it) and a
//    fixed renderOrder so it always resolves after opaque geometry.
//  * NO real lights. Interior lighting is (a) a per-vertex "interior lift" that
//    self-illuminates inside faces only, and (b) emitters registered with the
//    shared forward rig, ctx.neon.add().
//  * IMPORTANT: every material here keeps material.emissive BLACK and pushes its
//    glow through an injected uniform instead. NeonRig.discover() harvests any
//    material with a bright `emissive`, and since these meshes are merged and
//    centred on the world origin it would otherwise plant a phantom light at
//    (0,0,0). Brightness lives in uK0/uK1, the emitters are registered by hand.
// ---------------------------------------------------------------------------

const t   = 0.35;   // wall thickness
const FY  = 0.17;   // finished floor level (matches the 0.1665 pavement)
const CH  = 4.55;   // interior ceiling underside
const GT  = 5.35;   // top of the ground-floor / fascia band
const SILL= 0.62;   // bottom of the shopfront glazing
const HEAD= 3.50;   // top of the shopfront glazing
const PIER= 1.05;   // corner pier width
const RW  = 3.90;   // entrance recess width
const RD  = 1.40;   // entrance recess depth
const RH  = 3.20;   // entrance recess soffit height
const DW  = 2.60;   // clear door opening width
const DH  = 2.90;   // clear door opening height

const KIND = {
  bank: {
    wall:0xe7dcc6, trim:0x27324e, band:0xcfc0a4,
    neon:0xff2f8e, neonText:'BANK', floorSlot:0, floorTint:0xd6d2c8,
    intWall:0xe4dfd0, light:0xffe6bc, lightI:1.35, lightR:16,
  },
  store: {
    wall:0xf2e6d8, trim:0xc7452f, band:0xe4d2ba,
    neon:0x23e0d5, neonText:'OPEN 24 HRS', floorSlot:1, floorTint:0xdcdad2,
    intWall:0xe9e6dc, light:0xfff0d2, lightI:1.45, lightR:15,
  },
  diner: {
    wall:0xf6e7d0, trim:0x0f6f7a, band:0xe2cfb4,
    neon:0xffcf3f, neonText:'EAT', floorSlot:1, floorTint:0xcdbfae,
    intWall:0xf0dcc0, light:0xffd39a, lightI:1.35, lightR:15,
  },
  pawnshop: {
    wall:0xd6c0a2, trim:0x3a2b2b, band:0xc0aa8c,
    neon:0xff2f8e, neonText:'CASH LOANS', floorSlot:2, floorTint:0xa8907a,
    intWall:0xd8c8ad, light:0xffc98a, lightI:1.05, lightR:13,
  },
  clothing: {
    wall:0xe9caa8, trim:0x7e3566, band:0xd6b895,
    neon:0x23e0d5, neonText:'SALE', floorSlot:3, floorTint:0xd8c2a8,
    intWall:0xefe4d6, light:0xfff2e0, lightI:1.35, lightR:15,
  },
};
KIND.pawnshop.floorTint = 0xa89680;

// ---------------------------------------------------------------------------
// textures
// ---------------------------------------------------------------------------

function mkTex(canvas, repeat=true){
  const tx = new THREE.CanvasTexture(canvas);
  tx.colorSpace = THREE.SRGBColorSpace;
  if(repeat){ tx.wrapS = tx.wrapT = THREE.RepeatWrapping; }
  tx.anisotropy = 1;
  return tx;
}

// Fine grain + faint trowel streaks. Rubric §5: no flat untextured surfaces.
function wallTexture(){
  const S=256, c=document.createElement('canvas'); c.width=c.height=S;
  const g=c.getContext('2d');
  g.fillStyle='#ffffff'; g.fillRect(0,0,S,S);
  const img=g.getImageData(0,0,S,S), d=img.data;
  const R=new Rand(9110);
  for(let i=0;i<d.length;i+=4){
    const n = 232 + R.f(0,23);
    d[i]=n; d[i+1]=n; d[i+2]=n;
  }
  g.putImageData(img,0,0);
  g.globalAlpha=0.09;
  for(let i=0;i<70;i++){
    g.strokeStyle = R.bool() ? '#ffffff' : '#8d8478';
    g.lineWidth = R.f(0.6, 2.6);
    const y=R.f(0,S);
    g.beginPath(); g.moveTo(0, y); g.lineTo(S, y + R.f(-9,9)); g.stroke();
  }
  g.globalAlpha=1;
  return mkTex(c);
}

// 2x2 atlas of floor patterns: 0 terrazzo, 1 chequer vinyl, 2 scuffed boards,
// 3 warm parquet. Each quadrant is tiled by remapping quad UVs, never wrapped.
function floorAtlas(){
  const S=512, H=S/2, c=document.createElement('canvas'); c.width=c.height=S;
  const g=c.getContext('2d');
  const R=new Rand(4471);
  // 0: terrazzo (top-left)
  g.fillStyle='#e7e3d8'; g.fillRect(0,0,H,H);
  for(let i=0;i<900;i++){
    g.fillStyle=['#b7ae9c','#8f8878','#cfc7b4','#6d6a63','#d8cfb8'][R.i(0,4)];
    const x=R.f(2,H-4), y=R.f(2,H-4), w=R.f(1.5,5.5);
    g.beginPath(); g.ellipse(x,y,w,w*R.f(0.5,1),R.f(0,3.14),0,6.29); g.fill();
  }
  g.strokeStyle='rgba(120,114,100,0.55)'; g.lineWidth=1.6;
  for(let i=0;i<=2;i++){ const p=i*H/2; g.beginPath(); g.moveTo(p,0); g.lineTo(p,H); g.moveTo(0,p); g.lineTo(H,p); g.stroke(); }
  // 1: chequer vinyl (top-right)
  for(let i=0;i<4;i++) for(let j=0;j<4;j++){
    g.fillStyle = ((i+j)&1) ? '#efece2' : '#3a3a3e';
    g.fillRect(H+i*H/4, j*H/4, H/4, H/4);
  }
  g.globalAlpha=0.12;
  for(let i=0;i<400;i++){ g.fillStyle= R.bool()?'#fff':'#000'; g.fillRect(H+R.f(0,H), R.f(0,H), R.f(1,7), R.f(1,4)); }
  g.globalAlpha=1;
  // 2: scuffed boards (bottom-left)
  g.fillStyle='#7d6650'; g.fillRect(0,H,H,H);
  for(let b=0;b<8;b++){
    const y=H+b*H/8;
    g.fillStyle=`rgb(${(108+R.f(-22,22))|0},${(86+R.f(-18,18))|0},${(64+R.f(-14,14))|0})`;
    g.fillRect(0,y,H,H/8-1.5);
    g.globalAlpha=0.16;
    for(let s=0;s<26;s++){ g.fillStyle='#000'; g.fillRect(R.f(0,H), y+R.f(0,H/8), R.f(4,26), 1); }
    g.globalAlpha=1;
  }
  // 3: warm parquet / carpet (bottom-right)
  g.fillStyle='#b09070'; g.fillRect(H,H,H,H);
  for(let i=0;i<8;i++) for(let j=0;j<8;j++){
    const k=R.f(-16,16);
    g.fillStyle=`rgb(${(186+k)|0},${(154+k)|0},${(122+k)|0})`;
    const x=H+i*H/8, y=H+j*H/8;
    g.fillRect(x+0.8,y+0.8,H/8-1.6,H/8-1.6);
    if(((i+j)&1)===0){ g.globalAlpha=0.10; g.fillStyle='#000'; g.fillRect(x,y,H/8,H/8); g.globalAlpha=1; }
  }
  return mkTex(c, false);
}

// One 1024x1024 signage atlas, 16 slots of 512x128. Every sign in the project
// is a quad into this atlas, so all lettering costs a single draw call.
function signAtlas(list){
  const S=1024, SW=512, SH=128;
  const c=document.createElement('canvas'); c.width=c.height=S;
  const g=c.getContext('2d');
  g.fillStyle='#000'; g.fillRect(0,0,S,S);
  const uv={};
  list.slice(0,16).forEach((e,i)=>{
    const col=i%2, row=(i/2)|0, x0=col*SW, y0=row*SH;
    g.save();
    g.beginPath(); g.rect(x0,y0,SW,SH); g.clip();
    drawSign(g, e, x0, y0, SW, SH);
    g.restore();
    uv[e.key] = { ox: col*0.5, oy: 1-(row+1)*0.125, sw:0.5, sh:0.125 };
  });
  return { tex: mkTex(c,false), uv };
}

function fitFont(g, text, maxW, px, family){
  let p=px;
  for(;p>10;p-=2){ g.font=`bold ${p}px ${family}`; if(g.measureText(text).width<=maxW) break; }
  return p;
}

function drawSign(g, e, x0, y0, W, H){
  const cx=x0+W/2, cy=y0+H/2;
  if(e.style==='fascia'){
    g.fillStyle=e.bg||'#171a24'; g.fillRect(x0,y0,W,H);
    // brushed panel
    g.globalAlpha=0.10;
    for(let i=0;i<40;i++){ g.fillStyle='#fff'; g.fillRect(x0, y0+Math.random()*0, 0,0); }
    g.globalAlpha=1;
    g.fillStyle=e.fg||'#f4e6c8';
    g.fillRect(x0+16, y0+H-20, W-32, 4);
    g.fillRect(x0+16, y0+14, W-32, 3);
    fitFont(g, e.text, W-70, 74, '"Helvetica Neue",Helvetica,Arial,sans-serif');
    g.textAlign='center'; g.textBaseline='middle';
    g.fillStyle=e.fg||'#f4e6c8';
    g.fillText(e.text, cx, cy+2);
  } else if(e.style==='neon'){
    g.fillStyle='#07070c'; g.fillRect(x0,y0,W,H);
    g.strokeStyle=e.fg; g.lineWidth=5; g.strokeRect(x0+9,y0+9,W-18,H-18);
    fitFont(g, e.text, W-80, 86, '"Helvetica Neue",Helvetica,Arial,sans-serif');
    g.textAlign='center'; g.textBaseline='middle';
    g.shadowColor=e.fg; g.shadowBlur=26;
    g.fillStyle='#ffffff';
    g.fillText(e.text, cx, cy+2);
    g.shadowBlur=14; g.fillStyle=e.fg; g.globalAlpha=0.55;
    g.fillText(e.text, cx, cy+2);
    g.globalAlpha=1; g.shadowBlur=0;
  } else if(e.style==='menu'){
    g.fillStyle='#141519'; g.fillRect(x0,y0,W,H);
    g.strokeStyle='#4a4636'; g.lineWidth=3; g.strokeRect(x0+5,y0+5,W-10,H-10);
    const lines=e.lines||[];
    g.textBaseline='middle';
    lines.forEach((ln,i)=>{
      const y=y0+24+i*((H-38)/Math.max(lines.length,1));
      g.font='bold 21px "Helvetica Neue",Helvetica,Arial,sans-serif';
      g.textAlign='left';  g.fillStyle='#ffd98e'; g.fillText(ln[0], x0+22, y);
      g.textAlign='right'; g.fillStyle='#e8e2cf'; g.fillText(ln[1], x0+W-22, y);
    });
  } else { // 'plate'
    g.fillStyle=e.bg||'#20242e'; g.fillRect(x0,y0,W,H);
    g.strokeStyle=e.fg||'#dfe6ee'; g.lineWidth=4; g.strokeRect(x0+8,y0+8,W-16,H-16);
    fitFont(g, e.text, W-60, 70, '"Helvetica Neue",Helvetica,Arial,sans-serif');
    g.textAlign='center'; g.textBaseline='middle';
    g.fillStyle=e.fg||'#dfe6ee';
    g.fillText(e.text, cx, cy+2);
  }
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

const _c = new THREE.Color();

// rgb = albedo, a = "interior lift" flag consumed by the shader injection.
function paint(g, hex, lift, shade, mul){
  _c.set(hex);
  const pos=g.attributes.position, n=pos.count;
  const arr=new Float32Array(n*4);
  let lo=Infinity, hi=-Infinity;
  if(shade){ for(let i=0;i<n;i++){ const y=pos.getY(i); if(y<lo)lo=y; if(y>hi)hi=y; } }
  const span=Math.max(hi-lo, 1e-3);
  const m = mul===undefined ? 1 : mul;
  for(let i=0;i<n;i++){
    let k=m;
    if(shade){ const u=(pos.getY(i)-lo)/span; k = m * (1 - shade*(1-u)); }
    arr[i*4]=_c.r*k; arr[i*4+1]=_c.g*k; arr[i*4+2]=_c.b*k; arr[i*4+3]=lift;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr,4));
  return g;
}

// BoxGeometry UVs are per-face 0..1; rescale each face by its own world size so
// the grain texture keeps a constant density whatever the box dimensions.
function scaleBoxUV(g, sx, sy, sz, tile){
  const uv=g.attributes.uv;
  const S=[[sz,sy],[sz,sy],[sx,sz],[sx,sz],[sx,sy],[sx,sy]];
  for(let f=0;f<6;f++){
    const a=S[f][0]/tile, b=S[f][1]/tile;
    for(let i=0;i<4;i++){ const k=f*4+i; uv.setXY(k, uv.getX(k)*a, uv.getY(k)*b); }
  }
  uv.needsUpdate=true;
}

function remapUV(g, r){
  const uv=g.attributes.uv;
  for(let i=0;i<uv.count;i++) uv.setXY(i, r.ox + uv.getX(i)*r.sw, r.oy + uv.getY(i)*r.sh);
  uv.needsUpdate=true;
}

// ---------------------------------------------------------------------------

export class Interiors {
  constructor(scene, ctx){
    this.scene=scene; this.ctx=ctx;
    this.group=new THREE.Group(); this.group.name='Interiors';
    scene.add(this.group);

    this.colliders=[];      // [{minX,maxX,minZ,maxZ,minY,maxY}]  see contract above
    this.doorways=[];       // [{x,z,r}]
    this.npcs=[];
    this.interactables=[];  // [{x,y,z,r2,label,kind,id,npc}]
    this.venueInfo=[];

    this.M=new THREE.Matrix4();
    this.L=1;               // current interior-lift flag for paint()
    this.bags={ ext:[], inn:[], floor:[], metal:[], glass:[], emis:[], sign:[] };

    // shared shader uniforms — one object, mutated in update(), no allocation
    this.uLift={ value:0.20 };   // interior self-illumination
    this.uK0  ={ value:1.00 };   // emissive channel A (always on: shop lighting)
    this.uK1  ={ value:0.60 };   // emissive channel B (night only: upper windows)

    this._lights=[];        // registered neon-rig emitters we own
    this._flick=[];
    this._t=0; this._reg=false;

    // scratch — update() must not allocate
    this._m4=new THREE.Matrix4();
    this._q =new THREE.Quaternion();
    this._e =new THREE.Euler();
    this._v3=new THREE.Vector3();
    this._s3=new THREE.Vector3(1,1,1);
  }

  // ---------------------------------------------------------------- materials
  makeMaterials(){
    const lift=this.uLift, K0=this.uK0, K1=this.uK1;
    // Lit surfaces. vColor.a==1 marks an inward-facing surface, which gets a
    // constant warm lift so the room reads as artificially lit even though no
    // real light source exists inside it.
    const litInject = (m, warm)=>{
      const prev=m.onBeforeCompile;
      m.onBeforeCompile=(sh,r)=>{
        if(prev) prev(sh,r);
        sh.uniforms.uLift=lift;
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uLift;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            totalEmissiveRadiance += diffuseColor.rgb * vec3(${warm}) * uLift * diffuseColor.a;
            diffuseColor.a = 1.0;`);
      };
      return m;
    };
    // Unlit emissive surfaces. vColor.a selects the modulation channel:
    // 0 -> always on (shop lighting, neon), 1 -> night only (upper windows).
    const emisInject = (m)=>{
      const prev=m.onBeforeCompile;
      m.onBeforeCompile=(sh,r)=>{
        if(prev) prev(sh,r);
        sh.uniforms.uK0=K0; sh.uniforms.uK1=K1;
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uK0;\nuniform float uK1;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            diffuseColor.rgb *= mix(uK0, uK1, step(0.5, diffuseColor.a));
            diffuseColor.a = 1.0;`);
      };
      return m;
    };

    const shell = litInject(new THREE.MeshStandardMaterial({
      map:this.tex.wall, vertexColors:true, roughness:0.86, metalness:0.02,
    }), '1.10, 0.94, 0.78');
    const floor = litInject(new THREE.MeshStandardMaterial({
      map:this.tex.floor, vertexColors:true, roughness:0.62, metalness:0.03,
    }), '1.08, 0.96, 0.84');
    const metal = litInject(new THREE.MeshStandardMaterial({
      map:this.tex.wall, vertexColors:true, roughness:0.34, metalness:0.72,
    }), '1.06, 0.96, 0.86');
    // Single-layer shopfront glazing. depthWrite:false so it can never black out
    // the interior behind it; renderOrder keeps it after opaque geometry and
    // after the world's other transparent layers.
    const glass = new THREE.MeshStandardMaterial({
      color:0x8fb9bd, roughness:0.09, metalness:0.10,
      transparent:true, opacity:0.22, depthWrite:false,
      side:THREE.DoubleSide,
    });
    const emis = emisInject(new THREE.MeshBasicMaterial({ vertexColors:true, fog:true }));
    const sign = emisInject(new THREE.MeshBasicMaterial({ map:this.tex.sign, vertexColors:true, fog:true }));
    this.mat={ shell, floor, metal, glass, emis, sign };
  }

  // ------------------------------------------------------------------ helpers
  frame(v){
    const th=Math.atan2(v.facing.fx, v.facing.fz);
    this.M.makeRotationY(th);
    this.M.setPosition(v.x, 0, v.z);
    this.theta=th;
    this.cx=v.x; this.cz=v.z;
  }

  addCollider(g){
    g.computeBoundingBox();
    const b=g.boundingBox;
    this.colliders.push({ minX:b.min.x, maxX:b.max.x, minZ:b.min.z, maxZ:b.max.z,
                          minY:b.min.y, maxY:b.max.y });
  }

  // centre-based box in venue-local space (x = along frontage, z = depth)
  box(bag, u,y,v, sx,sy,sz, hex, o){
    o=o||{};
    const g=new THREE.BoxGeometry(sx,sy,sz);
    scaleBoxUV(g, sx,sy,sz, o.tile||2.4);
    paint(g, hex, o.lift===undefined?this.L:o.lift, o.shade===undefined?0.20:o.shade, o.mul);
    g.translate(u,y,v);
    g.applyMatrix4(this.M);
    this.bags[bag].push(g);
    if(o.solid) this.addCollider(g);
    return g;
  }

  // quad; default normal is +v (out toward the street)
  quad(bag, u,y,v, w,h, hex, o){
    o=o||{};
    const g=new THREE.PlaneGeometry(w,h);
    if(o.uv) remapUV(g, o.uv);
    else if(o.tile!==false) { const uv=g.attributes.uv; for(let i=0;i<uv.count;i++) uv.setXY(i, uv.getX(i)*w/2.4, uv.getY(i)*h/2.4); }
    paint(g, hex, o.lift===undefined?this.L:o.lift, o.shade||0, o.mul);
    if(o.rx) g.rotateX(o.rx);
    if(o.ry) g.rotateY(o.ry);
    g.translate(u,y,v);
    g.applyMatrix4(this.M);
    this.bags[bag].push(g);
    return g;
  }

  cyl(bag, u,y,v, rTop,rBot,h, hex, o){
    o=o||{};
    const g=new THREE.CylinderGeometry(rTop,rBot,h, o.seg||10, 1, false);
    paint(g, hex, o.lift===undefined?this.L:o.lift, o.shade===undefined?0.22:o.shade, o.mul);
    if(o.rx) g.rotateX(o.rx);
    if(o.rz) g.rotateZ(o.rz);
    g.translate(u,y,v);
    g.applyMatrix4(this.M);
    this.bags[bag].push(g);
    if(o.solid) this.addCollider(g);
    return g;
  }

  // world position of a local point
  world(u,v, out){
    out=out||new THREE.Vector3();
    return out.set(u,0,v).applyMatrix4(this.M);
  }

  addNPC(u,v,yaw, rec){
    const p=this.world(u,v);
    const n={
      id:'npc'+this.npcs.length, pos:p, yaw:this.theta+yaw,
      shirt:rec.shirt, skin:rec.skin, hair:rec.hair, height:rec.height||1.0,
      name:rec.name, role:rec.role, venue:rec.venue, sign:rec.sign,
      label:rec.label, lines:rec.lines||[],
      phase:rec.phase||0,
    };
    this.npcs.push(n);
    this.interactables.push({ x:p.x, y:1.2, z:p.z, label:rec.label, kind:'npc', id:n.id, npc:n });
    return n;
  }

  addFixture(u,v,y, label, kind, id){
    const p=this.world(u,v);
    this.interactables.push({ x:p.x, y:y, z:p.z, label, kind, id, npc:null });
  }

  // ------------------------------------------------------------------- build
  build(){
    const ctx=this.ctx;
    const venues=(ctx && ctx.city && ctx.city.venues) || [];
    if(!venues.length){ console.warn('[interiors] ctx.city.venues empty — nothing to build'); return this; }

    this.tex={ wall:wallTexture(), floor:floorAtlas() };

    // signage atlas: 5 fascias + 5 neon blades + 6 fixed plates = 16 slots
    const list=[];
    for(const v of venues){
      const K=KIND[v.kind]||KIND.store;
      list.push({ key:'fascia_'+v.kind, style:'fascia', text:v.sign,
                  bg:'#12151f', fg: v.kind==='diner' ? '#ffd98e' : '#f3e7cd' });
    }
    for(const v of venues){
      const K=KIND[v.kind]||KIND.store;
      list.push({ key:'neon_'+v.kind, style:'neon', text:K.neonText,
                  fg:'#'+new THREE.Color(K.neon).getHexString() });
    }
    list.push({ key:'p_tellers',  style:'plate', text:'TELLERS',       bg:'#1b2436', fg:'#cfe6ff' });
    list.push({ key:'p_atm',      style:'plate', text:'ATM',           bg:'#132033', fg:'#7ff0e2' });
    list.push({ key:'p_menu',     style:'menu',  lines:[['PATTY MELT','7.50'],['SHRIMP PO BOY','9.00'],['KEY LIME PIE','4.25'],['COFFEE','1.75']] });
    list.push({ key:'p_fitting',  style:'plate', text:'FITTING ROOMS', bg:'#2a1830', fg:'#ffc9ec' });
    list.push({ key:'p_checkout', style:'plate', text:'CHECKOUT',      bg:'#1d2418', fg:'#dff0c0' });
    list.push({ key:'p_open',     style:'neon',  text:'OPEN',          fg:'#ff4fa0' });
    const atlas=signAtlas(list);
    this.tex.sign=atlas.tex; this.SU=atlas.uv;

    this.makeMaterials();

    for(const v of venues){
      try{ this.buildVenue(v); }
      catch(e){ console.error('[interiors] venue failed', v.kind, e.message, e.stack); }
    }

    this.commit();
    this.buildNPCMeshes();
    console.log('[interiors] venues:',venues.length,'npcs:',this.npcs.length,
                'colliders:',this.colliders.length,'interactables:',this.interactables.length);
    return this;
  }

  buildVenue(v){
    const K=KIND[v.kind]||KIND.store;
    const R=new Rand((v.seed|0) + 733);
    this.frame(v);
    const flat = v.facing.fz!==0;
    const W = flat ? v.w : v.d;          // frontage width  (local x)
    const D = flat ? v.d : v.w;          // depth           (local z)
    const H = Math.max(v.h, GT+2.4);

    // entrance offset, kept clear of the corner piers
    const lim=Math.max(0, W/2 - PIER - RW/2 - 0.9);
    const doorU = Math.max(-lim, Math.min(lim, (v.kind==='bank'?0:R.f(-0.20,0.20)*W)));

    this.buildShell(v,K,R,W,D,H,doorU);
    this.buildFront(v,K,R,W,D,doorU);
    this.buildUpper(v,K,R,W,D,H);
    this.buildSignage(v,K,R,W,D,doorU,H);

    this.L=1;
    if(v.kind==='bank')      this.fitBank(K,R,W,D,doorU);
    else if(v.kind==='store')this.fitStore(K,R,W,D,doorU);
    else if(v.kind==='diner')this.fitDiner(K,R,W,D,doorU);
    else if(v.kind==='pawnshop') this.fitPawn(K,R,W,D,doorU);
    else                     this.fitClothes(K,R,W,D,doorU);

    // entrance corridor: three overlapping circles from the pavement to inside
    const dv=[D/2+0.9, D/2-RD*0.5, D/2-RD-1.1];
    for(const vv of dv){
      const p=this.world(doorU, vv);
      this.doorways.push({ x:p.x, z:p.z, r:1.55 });
    }
    const din=this.world(doorU, D/2-RD-2.6);
    const dpp=this.world(doorU, D/2+1.6);
    this.venueInfo.push({
      kind:v.kind, sign:v.sign,
      centre:{x:v.x, z:v.z},
      door:{x:dpp.x, z:dpp.z},
      inside:{x:din.x, z:din.z},
      yaw:this.theta,
    });
    this.addFixture(doorU, D/2+1.2, 1.2, 'Enter '+v.sign, 'door', v.kind);
  }

  // ---- structure -----------------------------------------------------------
  buildShell(v,K,R,W,D,H,doorU){
    this.L=0;
    const hw=W/2, hd=D/2;
    // plinth: a slab that meets the pavement so nothing floats (rubric §2)
    this.box('ext', 0, FY/2, 0, W+0.6, FY, D+0.6, 0x8a8478, { shade:0.10, tile:3.0 });

    // side + back walls (exterior faces, no interior lift)
    this.box('ext', -hw+t/2, GT/2, 0, t, GT, D, K.wall, { solid:1, shade:0.26 });
    this.box('ext',  hw-t/2, GT/2, 0, t, GT, D, K.wall, { solid:1, shade:0.26 });
    this.box('ext', 0, GT/2, -hd+t/2, W, GT, t, K.wall, { solid:1, shade:0.26 });
    // ceiling slab
    this.box('ext', 0, CH+0.20, 0, W, 0.40, D, K.band, { shade:0.0 });

    // interior lining — single-sided planes, so only the inside glows
    this.L=1;
    const iu=hw-t, iv=hd-t;
    this.quad('inn', -iu+0.02, (FY+CH)/2, 0, D-t*2, CH-FY, K.intWall, { ry:Math.PI/2, shade:0.16 });
    this.quad('inn',  iu-0.02, (FY+CH)/2, 0, D-t*2, CH-FY, K.intWall, { ry:-Math.PI/2, shade:0.16 });
    this.quad('inn', 0, (FY+CH)/2, -iv+0.02, W-t*2, CH-FY, K.intWall, { shade:0.16 });
    this.quad('inn', 0, CH-0.03, 0, W-t*2, D-t*2, 0xf0eadc, { rx:Math.PI/2 });

    // floor: grid of quads so the atlas quadrant tiles without wrapping
    const step=3.4, nx=Math.max(2,Math.round((W-t*2)/step)), nz=Math.max(2,Math.round((D-t*2)/step));
    const sx=(W-t*2)/nx, sz=(D-t*2)/nz;
    const slot=K.floorSlot, ox=(slot%2)*0.5, oy=(slot<2?0.5:0.0);
    for(let i=0;i<nx;i++) for(let j=0;j<nz;j++){
      this.quad('floor', -iu+sx*(i+0.5), FY+0.005, -iv+sz*(j+0.5), sx, sz, K.floorTint,
        { rx:-Math.PI/2, uv:{ox, oy, sw:0.5, sh:0.5} });
    }
    // skirting
    this.box('inn', 0, FY+0.09, -iv+0.06, W-t*2, 0.18, 0.10, K.trim, { shade:0 });
  }

  // ---- shopfront -----------------------------------------------------------
  buildFront(v,K,R,W,D,doorU){
    const hw=W/2, hd=D/2, fv=hd-t/2;
    this.L=0;
    // corner piers
    this.box('ext', -hw+PIER/2, GT/2, fv, PIER, GT, t, K.wall, { solid:1, shade:0.24 });
    this.box('ext',  hw-PIER/2, GT/2, fv, PIER, GT, t, K.wall, { solid:1, shade:0.24 });

    const segs=[[-hw+PIER, doorU-RW/2],[doorU+RW/2, hw-PIER]];
    for(const [a,b] of segs){
      const w=b-a; if(w<0.4) continue;
      const c=(a+b)/2;
      // stall riser under the glass
      this.box('ext', c, FY+(SILL-FY)/2, fv, w, SILL-FY, t, K.trim, { solid:1, shade:0.30 });
      // transom + fascia band above the glass
      this.box('ext', c, (HEAD+GT)/2, fv, w, GT-HEAD, t, K.band, { shade:0.16 });
      // glazing — ONE layer, set just inside the frame line
      this.quad('glass', c, (SILL+HEAD)/2, hd-0.10, w-0.10, HEAD-SILL, 0xffffff, { lift:0, tile:false });
      // mullions
      const nm=Math.max(1, Math.round(w/2.6)-1);
      for(let i=1;i<=nm;i++){
        this.box('ext', a + w*i/(nm+1), (SILL+HEAD)/2, hd-0.11, 0.10, HEAD-SILL, 0.16, K.trim, { shade:0 });
      }
      // head + sill rails
      this.box('ext', c, HEAD+0.05, hd-0.11, w, 0.12, 0.18, K.trim, { shade:0 });
      this.box('ext', c, SILL+0.03, hd-0.10, w, 0.09, 0.24, K.trim, { shade:0 });
    }

    // entrance recess: side returns, soffit and the recessed head wall
    const rl=doorU-RW/2, rr=doorU+RW/2;
    this.box('ext', rl+0.10, (FY+RH)/2, hd-RD/2, 0.20, RH-FY, RD, K.trim, { solid:1, shade:0.30 });
    this.box('ext', rr-0.10, (FY+RH)/2, hd-RD/2, 0.20, RH-FY, RD, K.trim, { solid:1, shade:0.30 });
    this.box('ext', doorU, (RH+GT)/2, hd-RD/2, RW, GT-RH, RD, K.band, { shade:0.12 });
    // recess floor mat + threshold
    this.L=1;
    this.box('inn', doorU, FY+0.012, hd-RD/2, RW-0.5, 0.03, RD-0.15, 0x2a2c30, { shade:0 });
    this.L=0;
    // head wall each side of the door
    const jamb=(RW-DW)/2;
    if(jamb>0.12){
      this.box('ext', rl+jamb/2, (FY+RH)/2, hd-RD, jamb, RH-FY, t, K.wall, { solid:1, shade:0.28 });
      this.box('ext', rr-jamb/2, (FY+RH)/2, hd-RD, jamb, RH-FY, t, K.wall, { solid:1, shade:0.28 });
    }
    this.box('ext', doorU, (DH+RH)/2, hd-RD, DW, RH-DH, t, K.wall, { shade:0.20 });
    // door leaves folded flat against the jambs — the opening itself stays clear
    this.box('ext', rl+jamb/2+0.06, FY+(DH-FY)/2, hd-RD+0.30, 0.10, DH-FY-0.10, 0.62, K.trim, { shade:0.10 });
    this.box('ext', rr-jamb/2-0.06, FY+(DH-FY)/2, hd-RD+0.30, 0.10, DH-FY-0.10, 0.62, K.trim, { shade:0.10 });
    // OPEN decal beside the door
    this.quad('sign', rr-0.22, 2.20, hd-RD+0.02, 0.62, 0.30, 0xffffff,
      { uv:this.SU.p_open, lift:0, mul:1.5 });

    // shopfront underglow: a neon tube tucked under the fascia, the thing that
    // actually makes a shopfront read at night
    this.box('emis', doorU, HEAD+0.16, hd-0.30, W-PIER*2-0.4, 0.08, 0.10,
      K.neon, { lift:0, shade:0, mul:2.2 });
  }

  // ---- storeys above the shop ---------------------------------------------
  buildUpper(v,K,R,W,D,H){
    this.L=0;
    if(H <= GT+1.2) return;
    const hUp=H-GT;
    this.box('ext', 0, GT+hUp/2, 0, W-0.10, hUp, D-0.10, K.wall, { solid:0, shade:0.22, tile:3.2 });
    // cornice + parapet so the roofline is not a bare cut
    this.box('ext', 0, GT+0.16, 0, W+0.45, 0.32, D+0.45, K.band, { shade:0.0 });
    this.box('ext', 0, H+0.26, 0, W+0.30, 0.52, D+0.30, K.band, { shade:0.10 });
    this.box('ext', 0, H+0.56, 0, W-0.10, 0.10, D-0.10, K.trim, { shade:0 });

    // window bands on the street face and both flanks
    const storeys=Math.max(1, Math.floor(hUp/3.3));
    const wh=1.55, bays=Math.max(3, Math.round((W-2)/3.2));
    const R2=new Rand((v.seed|0)+91);
    for(let s=0;s<storeys;s++){
      const y=GT+0.9+ s*(hUp/storeys) + (hUp/storeys)*0.20;
      if(y+wh > H-0.5) continue;
      for(let b=0;b<bays;b++){
        const u=-W/2+1.2 + (W-2.4)*(b+0.5)/bays;
        const lit=R2.bool(0.55);
        // recessed reveal + glass
        this.box('ext', u, y+wh/2, D/2-0.16, 1.35, wh+0.24, 0.14, K.band, { shade:0 });
        this.quad('emis', u, y+wh/2, D/2-0.06, 1.14, wh, lit?0xffd9a2:0x24303c,
          { lift:1, tile:false, mul: lit? 1.35 : 0.30 });
        this.box('ext', u, y-0.08, D/2-0.13, 1.5, 0.12, 0.22, K.band, { shade:0 });
      }
      const dbays=Math.max(2, Math.round((D-2)/3.4));
      for(let sgn=-1; sgn<=1; sgn+=2){
        for(let b=0;b<dbays;b++){
          const vv=-D/2+1.2 + (D-2.4)*(b+0.5)/dbays;
          const lit=R2.bool(0.42);
          this.quad('emis', sgn*(W/2-0.06), y+wh/2, vv, 1.10, wh, lit?0xffd0a0:0x222c38,
            { ry: sgn*Math.PI/2, lift:1, tile:false, mul: lit? 1.2 : 0.28 });
        }
      }
    }
    // roof-top clutter so the silhouette is not a clean box
    this.box('ext', W*0.22, H+0.9, -D*0.18, 2.0, 1.1, 1.6, 0x9a9384, { shade:0.2 });
    this.box('ext', -W*0.26, H+0.75, D*0.10, 1.3, 0.8, 1.1, 0x8f8878, { shade:0.2 });
  }

  // ---- signage -------------------------------------------------------------
  buildSignage(v,K,R,W,D,doorU,H){
    this.L=0;
    const hd=D/2;
    const fw=Math.min(W-PIER*2-1.0, 10.5), fh=1.18;
    const fy=(HEAD+GT)/2 + 0.16;
    // fascia box + lettering panel
    this.box('ext', 0, fy, hd+0.10, fw+0.5, fh+0.34, 0.22, K.trim, { shade:0.10 });
    this.quad('sign', 0, fy, hd+0.225, fw, fh, 0xffffff,
      { uv:this.SU['fascia_'+v.kind], lift:0, mul:1.15 });
    // two goosenecks washing the fascia
    for(const s of [-1,1]){
      this.box('ext', s*fw*0.32, fy+fh*0.62+0.22, hd+0.34, 0.06, 0.34, 0.06, 0x2a2a2c, { shade:0 });
      this.box('emis', s*fw*0.32, fy+fh*0.62+0.06, hd+0.40, 0.30, 0.10, 0.30, 0xffe2b0, { lift:0, shade:0, mul:1.5 });
    }

    // projecting neon blade — visible down the street, not just head-on
    const bu=(doorU>0? -1: 1) * (W/2 - PIER - 0.6);
    const by=Math.min(H-1.6, GT+1.9);
    const bw=3.0, bh=1.15;
    this.box('ext', bu, by, hd+0.16, 0.16, bh+0.5, 0.30, 0x27272b, { shade:0 });
    for(const s of [-1,1]){
      this.quad('sign', bu + s*0.09, by, hd+0.16+bw/2*0+0.0, bw, bh, 0xffffff,
        { uv:this.SU['neon_'+v.kind], lift:0, mul:2.0, ry:s*Math.PI/2, tile:false });
    }
    // the blade needs a body; two quads back to back at the same place would
    // z-fight, so they straddle a thin plate
    this.box('ext', bu, by, hd+0.16, 0.16, bh, bw, 0x101014, { shade:0 });
    this._blade={ u:bu, v:hd+0.16, y:by, col:K.neon };

    // awning over the glazing (colour + shadow line at street level)
    this.L=0;
    const aw=W-PIER*2-0.6;
    this.box('ext', 0, HEAD-0.30, hd+0.55, aw, 0.10, 1.10, K.trim, { shade:0 });
    this.box('ext', 0, HEAD-0.62, hd+1.06, aw, 0.42, 0.10, K.neon, { shade:0.25 });
  }

  // =========================== fit-outs =====================================

  counterRun(u,v,len,dep,hgt, topHex, baseHex, opt){
    opt=opt||{};
    this.box('inn', u, FY+(hgt-FY)/2, v, len, hgt-FY, dep, baseHex, { solid:1, shade:0.28 });
    this.box('inn', u, hgt+0.045, v, len+0.14, 0.09, dep+0.14, topHex, { shade:0.10 });
    if(opt.kick) this.box('inn', u, FY+0.07, v+dep/2-0.02, len, 0.14, 0.06, 0x1a1a1c, { shade:0 });
  }

  shelfGoods(u0,u1,y,v,dep,R,pal,step){
    for(let x=u0; x<u1-0.1; x+=step){
      const w=step*R.f(0.55,0.85), h=R.f(0.20,0.34);
      this.box('inn', x+step/2, y+h/2, v, w, h, dep*R.f(0.55,0.8), pal[R.i(0,pal.length-1)], { shade:0.25, tile:1.0 });
    }
  }

  ceilingLights(list, K){
    for(const [u,v,w] of list){
      this.box('emis', u, CH-0.10, v, w, 0.07, 0.42, K.light, { lift:0, shade:0, mul:1.7 });
      this.box('inn',  u, CH-0.04, v, w+0.16, 0.06, 0.56, 0xdedad0, { shade:0 });
    }
  }

  // ---- BANK ----------------------------------------------------------------
  fitBank(K,R,W,D,doorU){
    const hw=W/2-t, hd=D/2-t;
    const cv=-hd+4.6;                       // counter line
    const cu0=-hw+1.4, cu1=Math.min(hw-7.5, cu0+16);
    const cLen=cu1-cu0, cMid=(cu0+cu1)/2;

    this.counterRun(cMid, cv, cLen, 0.95, 1.08, 0xd8cdb4, 0x3d2f26, { kick:1 });
    // security grille above the counter, with three teller windows cut into it
    const gaps=[[cu0+1.2,cu0+2.5],[cMid-0.65,cMid+0.65],[cu1-2.5,cu1-1.2]];
    for(let x=cu0+0.15; x<cu1; x+=0.30){
      let inGap=false;
      for(const g of gaps) if(x>g[0]&&x<g[1]) inGap=true;
      if(inGap) continue;
      this.box('metal', x, 1.85, cv+0.36, 0.045, 1.42, 0.045, 0xb9c2c9, { shade:0.15 });
    }
    this.box('metal', cMid, 2.58, cv+0.36, cLen, 0.09, 0.10, 0xb9c2c9, { shade:0 });
    this.box('metal', cMid, 1.16, cv+0.36, cLen, 0.07, 0.10, 0xb9c2c9, { shade:0 });
    for(const g of gaps){
      const c=(g[0]+g[1])/2;
      this.box('metal', c, 1.30, cv+0.30, 0.85, 0.05, 0.34, 0xcfd6da, { shade:0 });  // pass tray
      this.box('metal', c, 1.62, cv+0.365, 0.22, 0.22, 0.05, 0x8f9aa2, { shade:0 }); // speaker
      this.box('emis',  c, 2.28, cv+0.34, 0.5, 0.06, 0.05, 0x9fe8ff, { lift:0, shade:0, mul:1.3 });
    }
    // TELLERS plate
    this.quad('sign', cMid, 3.05, cv+0.40, 2.2, 0.55, 0xffffff, { uv:this.SU.p_tellers, mul:1.25 });

    // back-of-house partition + vault chamber, right hand side
    const vu=hw-4.2;
    this.box('inn', vu-2.6, (FY+3.3)/2+FY/2, -hd+3.4, 5.6, 3.3, 0.22, 0xcdc6b4, { solid:1, shade:0.2 });
    // round vault door
    const vy=1.95;
    this.cyl('metal', vu, vy, -hd+3.26, 1.55,1.55,0.30, 0x9aa3ab, { rx:Math.PI/2, seg:22, shade:0.18, solid:1 });
    this.cyl('metal', vu, vy, -hd+3.10, 1.72,1.72,0.22, 0x6f767d, { rx:Math.PI/2, seg:22, shade:0.18 });
    this.cyl('metal', vu, vy, -hd+3.42, 0.32,0.32,0.22, 0xd8dee2, { rx:Math.PI/2, seg:12, shade:0.1 });
    for(let i=0;i<3;i++){
      const g=new THREE.BoxGeometry(1.9,0.10,0.10);
      paint(g, 0xd8dee2, 1, 0.1);
      g.rotateZ(i*Math.PI/3);
      g.translate(vu, vy, -hd+3.46);
      g.applyMatrix4(this.M);
      this.bags.metal.push(g);
    }
    for(let i=0;i<8;i++){
      const a=i/8*Math.PI*2;
      this.box('metal', vu+Math.cos(a)*1.66, vy+Math.sin(a)*1.66, -hd+3.16, 0.14,0.14,0.16, 0x59606a, { shade:0 });
    }
    this.addFixture(vu, -hd+3.9, 1.9, 'Inspect vault door', 'vault', 'bank_vault');

    // ATM on the right wall
    const au=hw-0.30, av=hd-6.2;
    this.box('inn', au, FY+1.05, av, 0.55, 2.10, 1.15, 0x2c3340, { solid:1, shade:0.2 });
    this.quad('emis', au-0.29, 1.62, av, 0.62, 0.44, 0x8fe8ff, { lift:0, ry:-Math.PI/2, tile:false, mul:1.5 });
    this.box('inn', au-0.30, 1.28, av, 0.06, 0.28, 0.40, 0x161a21, { shade:0 });
    this.quad('sign', au-0.29, 2.28, av, 0.70, 0.34, 0xffffff, { uv:this.SU.p_atm, ry:-Math.PI/2, mul:1.4 });
    this.addFixture(au-1.2, av, 1.4, 'Use ATM', 'atm', 'bank_atm');

    // queue barriers
    const qv=cv+3.4;
    for(let i=0;i<4;i++){
      const u=cMid-4.2+i*2.8;
      for(const vv of [qv, qv+2.4]){
        this.cyl('metal', u, FY+0.48, vv, 0.05,0.05,0.92, 0xc2c8cc, { seg:8, shade:0.2 });
        this.cyl('metal', u, FY+0.03, vv, 0.20,0.22,0.06, 0x8f969c, { seg:10, shade:0 });
        if(i<3) this.box('inn', u+1.4, FY+0.82, vv, 2.6, 0.06, 0.03, 0x7a2230, { shade:0 });
      }
    }
    // desks in the left front corner
    for(let i=0;i<2;i++){
      const du=-hw+3.2, dv=hd-5.0-i*3.6;
      this.box('inn', du, 0.80, dv, 2.0, 0.08, 1.0, 0x6b4f38, { solid:1, shade:0.1 });
      for(const s of [-0.85,0.85]) for(const s2 of [-0.4,0.4])
        this.box('inn', du+s, FY+0.31, dv+s2, 0.08, 0.66, 0.08, 0x3a2c22, { shade:0 });
      this.box('inn', du+1.5, FY+0.22, dv, 0.5, 0.10, 0.5, 0x25282e, { shade:0 });
      this.box('inn', du+1.5, FY+0.62, dv-0.24, 0.5, 0.70, 0.08, 0x25282e, { shade:0 });
      this.box('inn', du-0.5, 0.98, dv, 0.42, 0.30, 0.30, 0x1e2228, { shade:0 });
      this.quad('emis', du-0.5, 0.98, dv+0.16, 0.36, 0.24, 0xa8d8ff, { lift:0, tile:false, mul:0.9 });
    }
    // planters break up the floor
    this.box('inn', hw-1.6, FY+0.30, hd-2.4, 0.7, 0.6, 0.7, 0x4a4238, { shade:0.2 });
    this.box('inn', hw-1.6, FY+1.10, hd-2.4, 0.55, 1.1, 0.55, 0x3d6b3a, { shade:0.3, tile:0.8 });

    this.ceilingLights([[cMid-4,cv+2.2,3.2],[cMid+2,cv+2.2,3.2],[-hw+4,hd-4.0,3.0],[hw-5,hd-4.0,3.0]], K);
    this._lightPts=[[cMid, cv+1.6],[0, 0],[doorU, hd-2.5]];

    this.addNPC(cu0+1.85, cv-0.85, 0, {
      name:'Alma', role:'bank teller', venue:'bank', sign:'PACIFIC MUTUAL',
      label:'Talk to teller', shirt:0x2c3f6b, skin:0xc98b62, hair:0x2a1a14, phase:0.2,
      lines:['Welcome to Pacific Mutual. Deposit or withdrawal?',
             'Your balance is available at the window, sir.',
             'We close at six. The ATM is by the door.'],
    });
    this.addNPC(cMid+0.1, cv-0.85, 0, {
      name:'Reggie', role:'bank teller', venue:'bank', sign:'PACIFIC MUTUAL',
      label:'Talk to teller', shirt:0x3c4d78, skin:0x8a5c3c, hair:0x140f0c, phase:2.1,
      lines:['Next in line, please.','Cash only at this window.'],
    });
    this.addNPC(doorU+3.0, hd-3.2, Math.PI*0.92, {
      name:'Vance', role:'security guard', venue:'bank', sign:'PACIFIC MUTUAL',
      label:'Talk to the guard', shirt:0x22262c, skin:0xd8a077, hair:0x35302a, phase:4.4,
      lines:['Keep it moving, friend.','No hats, no hoods. House rules.'],
    });
  }

  // ---- STORE ---------------------------------------------------------------
  fitStore(K,R,W,D,doorU){
    const hw=W/2-t, hd=D/2-t;
    // checkout, left of the door, facing the street
    const ku=-hw+3.0, kv=hd-4.6;
    this.counterRun(ku, kv, 4.2, 0.95, 1.02, 0xcfc9bc, 0x8e3b2e, { kick:1 });
    this.box('inn', ku+1.2, 1.20, kv, 0.55, 0.30, 0.45, 0x24272e, { shade:0.1 });
    this.quad('emis', ku+1.2, 1.30, kv+0.24, 0.42, 0.22, 0x9fe6c8, { lift:0, tile:false, mul:1.4 });
    this.quad('sign', ku, 2.55, kv-0.10, 1.7, 0.42, 0xffffff, { uv:this.SU.p_checkout, mul:1.2 });
    // impulse-buy rack at the till
    this.box('inn', ku-2.4, FY+0.55, kv-0.05, 0.5, 1.1, 0.35, 0x3a3f45, { shade:0.2 });
    this.shelfGoods(ku-2.6, ku-2.2, 0.95, kv-0.05, 0.30, R, [0xe04a3a,0xf0c23a,0x3ab0e0], 0.18);

    // gondola aisles running back from the window
    const pal=[0xd94f3a,0xf2c24a,0x3f8fd0,0x59b45a,0xe4e0d4,0xb85fa8,0xef8a3c];
    const aisles=3;
    for(let a=0;a<aisles;a++){
      const u=-hw+6.6 + a*4.3;
      if(u>hw-2.0) continue;
      const v0=-hd+1.4, v1=hd-6.2, len=v1-v0, cv=(v0+v1)/2;
      this.box('inn', u, FY+0.20, cv, 1.15, 0.40, len, 0x4a4f56, { solid:1, shade:0.25 });
      this.box('inn', u, FY+1.86, cv, 1.10, 0.10, len, 0xd8d4c8, { shade:0.1 });
      for(const s of [-0.5,0.5]) this.box('inn', u+s*0.56, FY+0.95, cv, 0.06, 1.9, len, 0xb9b4a8, { shade:0.2 });
      for(let sh=0;sh<3;sh++){
        const y=FY+0.42+sh*0.50;
        this.box('inn', u, y, cv, 1.10, 0.05, len, 0xc9c4b8, { shade:0.1 });
        for(let x=v0+0.2; x<v1-0.2; x+=0.42){
          const h=R.f(0.20,0.34), w=R.f(0.22,0.34);
          this.box('inn', u+R.f(-0.34,0.34), y+0.03+h/2, x+0.21, w, h, R.f(0.22,0.34),
                   pal[R.i(0,pal.length-1)], { shade:0.24, tile:0.9 });
        }
      }
      this.box('emis', u, FY+2.02, cv, 0.9, 0.05, 0.05, 0xffe8c0, { lift:0, shade:0, mul:1.1 });
    }

    // chiller wall at the back
    const chu=0, chv=-hd+0.55;
    this.box('inn', chu, FY+1.20, chv, 8.4, 2.3, 1.0, 0x9aa4ac, { solid:1, shade:0.2 });
    this.box('inn', chu, FY+1.24, chv+0.34, 7.6, 1.9, 0.35, 0x101418, { shade:0 });
    for(let sh=0;sh<3;sh++){
      const y=FY+0.55+sh*0.62;
      this.box('emis', chu, y+0.30, chv+0.26, 7.2, 0.04, 0.04, 0x7fe8ff, { lift:0, shade:0, mul:1.8 });
      for(let x=-3.4; x<3.4; x+=0.30){
        this.box('inn', x, y+0.20, chv+0.30, 0.16, 0.40, 0.16,
                 [0x2f7a4a,0xd0402a,0xe0c040,0x3060b0][R.i(0,3)], { shade:0.2, tile:0.6 });
      }
      this.box('inn', chu, y, chv+0.30, 7.4, 0.05, 0.42, 0xb8bec4, { shade:0 });
    }
    this.addFixture(chu, chv+1.6, 1.3, 'Take a cold drink', 'fridge', 'store_chiller');

    this.ceilingLights([[-hw+4,hd-4,3.4],[0,0,4.2],[0,-hd+4,4.2],[hw-4,hd-4,3.4]], K);
    this._lightPts=[[ku+1.0, kv],[0,-1.0],[doorU, hd-2.6]];

    this.addNPC(ku, kv-1.15, 0, {
      name:'Marisol', role:'shop clerk', venue:'store', sign:'24/7 MARKET',
      label:'Talk to the clerk', shirt:0x2f7a52, skin:0xb87a4e, hair:0x191110, phase:1.1,
      lines:['Twenty-four hours, seven days. What do you need?',
             'Cold drinks are at the back.','Cash or card, honey?'],
    });
    this.addNPC(-hw+7.4, -1.5, Math.PI*0.5, {
      name:'Dov', role:'shopper', venue:'store', sign:'24/7 MARKET',
      label:'Talk to the shopper', shirt:0xb8483a, skin:0xe0b48c, hair:0x6a4a2a, phase:3.3,
      lines:['They moved the coffee again.','You know if the ATM at the bank works?'],
    });
  }

  // ---- DINER ---------------------------------------------------------------
  fitDiner(K,R,W,D,doorU){
    const hw=W/2-t, hd=D/2-t;
    // booths against the window
    const spots=[];
    for(let u=-hw+1.9; u<hw-2.4; u+=3.05){
      if(Math.abs(u-doorU)<2.6) continue;
      spots.push(u);
    }
    for(const u of spots.slice(0,6)){
      const v0=hd-1.35;
      this.box('inn', u, FY+0.80, v0, 2.5, 1.26, 0.34, 0x8f2f3a, { solid:1, shade:0.25 });
      this.box('inn', u, FY+0.29, v0-0.42, 2.5, 0.16, 0.62, 0xa63a44, { shade:0.2 });
      this.box('inn', u, FY+0.80, v0-3.20, 2.5, 1.26, 0.34, 0x8f2f3a, { solid:1, shade:0.25 });
      this.box('inn', u, FY+0.29, v0-2.78, 2.5, 0.16, 0.62, 0xa63a44, { shade:0.2 });
      this.box('inn', u, 0.79, v0-1.62, 2.1, 0.07, 1.15, 0xe4dccb, { shade:0.1 });
      this.box('inn', u, FY+0.30, v0-1.62, 0.16, 0.60, 0.16, 0x7f858c, { shade:0 });
      // condiments
      this.box('inn', u+0.7, 0.90, v0-1.62, 0.09, 0.16, 0.09, 0xd03a2a, { shade:0 });
      this.box('inn', u+0.85, 0.88, v0-1.62, 0.07, 0.13, 0.07, 0xe8e2d0, { shade:0 });
    }
    // counter + stools
    const cv=-hd+4.3;
    const cu0=-hw+1.6, cu1=Math.min(hw-6.0, cu0+15), cMid=(cu0+cu1)/2, cLen=cu1-cu0;
    this.counterRun(cMid, cv, cLen, 1.0, 1.06, 0xdcd6c6, 0x1f4f52, { kick:1 });
    this.box('metal', cMid, 1.11, cv+0.56, cLen+0.14, 0.06, 0.10, 0xc8ced2, { shade:0 });
    for(let i=0;i<7;i++){
      const u=cu0+1.1+i*((cLen-2.2)/6);
      this.cyl('metal', u, FY+0.34, cv+1.35, 0.055,0.055,0.66, 0xb9c0c6, { seg:8, shade:0.2 });
      this.cyl('inn',   u, FY+0.72, cv+1.35, 0.30,0.30,0.12, 0xc23a44, { seg:12, shade:0.1 });
      this.cyl('metal', u, FY+0.03, cv+1.35, 0.24,0.26,0.05, 0x8f969c, { seg:10, shade:0 });
    }
    // back bar: pass hatch, shelving, coffee machine
    this.box('inn', 0, FY+1.55, -hd+0.6, W-t*2-1.0, 0.16, 0.5, 0x2a2e34, { shade:0.1 });
    const pu=cMid+1.0;
    this.box('inn', pu, 1.90, -hd+0.42, 5.0, 1.10, 0.30, 0x101215, { shade:0 });
    this.box('emis', pu, 1.90, -hd+0.56, 4.7, 0.95, 0.06, 0xffb45a, { lift:0, shade:0, mul:1.15 });
    this.box('emis', pu, 2.50, -hd+0.80, 4.6, 0.07, 0.14, 0xff8a2a, { lift:0, shade:0, mul:2.0 });  // heat lamps
    this.box('inn', pu, 1.34, -hd+0.75, 4.9, 0.10, 0.50, 0xb9bfc4, { shade:0 });
    for(let i=0;i<4;i++) this.box('inn', pu-1.7+i*1.1, 1.46, -hd+0.75, 0.34, 0.14, 0.34, 0xd8d2c2, { shade:0.1 });
    this.quad('sign', pu, 3.05, -hd+0.60, 2.6, 0.62, 0xffffff, { uv:this.SU.p_menu, mul:1.15 });
    this.addFixture(pu, cv+1.4, 1.6, 'Read the menu', 'menu', 'diner_menu');
    // coffee machine + pie case
    this.box('metal', cu0+1.2, 1.42, cv-0.55, 0.7, 0.62, 0.5, 0xc8ced2, { shade:0.15 });
    this.box('emis',  cu0+1.2, 1.20, cv-0.30, 0.5, 0.10, 0.05, 0xff7a3a, { lift:0, shade:0, mul:1.3 });
    this.box('inn', cu1-1.6, 1.42, cv-0.10, 0.8, 0.62, 0.7, 0xd8d2c2, { shade:0.1 });
    this.box('emis', cu1-1.6, 1.42, cv-0.10, 0.72, 0.5, 0.62, 0xffd9a0, { lift:0, shade:0, mul:0.9 });

    // free-standing tables
    for(let i=0;i<3;i++){
      const u=-hw+4.0+i*4.6, v=-1.2;
      if(u>hw-2.5) continue;
      this.cyl('inn', u, 0.76, v, 0.66,0.66,0.07, 0xe4dccb, { seg:14, shade:0.1 });
      this.cyl('inn', u, FY+0.28, v, 0.09,0.09,0.60, 0x7f858c, { seg:8, shade:0.2 });
      this.cyl('inn', u, FY+0.02, v, 0.36,0.38,0.05, 0x6f757c, { seg:12, shade:0 });
      for(const s of [-1,1]){
        this.cyl('inn', u+s*1.05, FY+0.44, v, 0.24,0.24,0.10, 0xc23a44, { seg:10, shade:0.1 });
        this.cyl('metal', u+s*1.05, FY+0.22, v, 0.05,0.05,0.44, 0xb9c0c6, { seg:8, shade:0 });
      }
    }
    // neon inside on the back wall
    this.quad('sign', cu0+2.6, 3.15, -hd+0.20, 2.2, 0.55, 0xffffff, { uv:this.SU['neon_diner'], mul:2.0 });

    this.ceilingLights([[-hw+4,hd-3.0,3.2],[0,hd-3.0,3.2],[hw-4,hd-3.0,3.2],[cMid,cv+0.6,4.0]], K);
    this._lightPts=[[cMid, cv+0.8],[0, hd-3.0],[doorU, hd-2.4]];

    this.addNPC(cMid-2.4, cv-0.95, 0, {
      name:'Dot', role:'diner server', venue:'diner', sign:'THE SANDBAR',
      label:'Talk to the server', shirt:0x2fa2a8, skin:0xe0b48c, hair:0x8a5a24, phase:0.7,
      lines:['Sit anywhere, sugar. Coffee?',
             'Patty melt is the thing to get.','Kitchen closes at eleven.'],
    });
    this.addNPC(pu-0.4, cv-1.35, 0.25, {
      name:'Hector', role:'line cook', venue:'diner', sign:'THE SANDBAR',
      label:'Talk to the cook', shirt:0xe8e4d8, skin:0x9a6238, hair:0x120d0a, phase:2.6,
      lines:['Order up!','Two melts working.'],
    });
  }

  // ---- PAWNSHOP ------------------------------------------------------------
  fitPawn(K,R,W,D,doorU){
    const hw=W/2-t, hd=D/2-t;
    const cv=-hd+5.4;
    const cu0=-hw+1.4, cu1=hw-1.4, cMid=(cu0+cu1)/2, cLen=cu1-cu0;
    // display counter with a lit case
    this.box('inn', cMid, FY+0.42, cv, cLen, 0.50, 1.0, 0x2e2622, { solid:1, shade:0.3 });
    this.box('inn', cMid, FY+0.86, cv, cLen, 0.38, 1.0, 0x14100e, { shade:0 });
    this.box('emis', cMid, FY+1.00, cv, cLen-0.3, 0.03, 0.80, 0xffe2a0, { lift:0, shade:0, mul:1.3 });
    for(let x=cu0+0.5; x<cu1-0.4; x+=0.55){
      this.box('metal', x, FY+0.80, cv+R.f(-0.2,0.2), R.f(0.10,0.20), R.f(0.05,0.14), R.f(0.08,0.16),
               R.bool(0.6)?0xd8b455:0xc9ccd2, { shade:0.1 });
    }
    this.box('inn', cMid, FY+1.12, cv, cLen+0.10, 0.07, 1.06, 0x4a3b32, { shade:0.1 });
    // bars above the counter, one service gap
    for(let x=cu0+0.2; x<cu1; x+=0.26){
      if(Math.abs(x-(cMid-0.6))<0.72) continue;
      this.box('metal', x, 2.0, cv+0.40, 0.05, 1.62, 0.05, 0x8f959b, { shade:0.2 });
    }
    this.box('metal', cMid, 2.84, cv+0.40, cLen, 0.09, 0.09, 0x8f959b, { shade:0 });
    this.box('metal', cMid-0.6, 1.28, cv+0.34, 1.5, 0.05, 0.36, 0xb0b6bc, { shade:0 });
    this.addFixture(cMid+2.0, cv+1.6, 1.2, 'Browse the display case', 'case', 'pawn_case');

    // wall of goods, left flank: pegboard + guitars + tools
    this.box('inn', -hw+0.16, FY+1.55, 0.5, 0.10, 2.7, 8.0, 0x3f3a34, { shade:0.2 });
    for(let i=0;i<3;i++){
      const v=-2.4+i*2.4;
      this.box('inn', -hw+0.42, 1.75, v, 0.10, 0.62, 0.42, [0xc4562c,0xd8b455,0x8f2f3a][i], { shade:0.15 });
      this.box('inn', -hw+0.40, 2.45, v, 0.07, 0.85, 0.09, 0x3a2a1e, { shade:0.1 });
    }
    for(let i=0;i<8;i++){
      this.box('inn', -hw+0.38, 1.05, -3.4+i*0.9, 0.09, R.f(0.2,0.45), R.f(0.1,0.3),
               [0x6a6f76,0x2a3a4a,0x8a5a2a][R.i(0,2)], { shade:0.2 });
    }
    // shelving, right flank: TVs, cases, amps
    for(let sh=0; sh<3; sh++){
      const y=FY+0.75+sh*0.85;
      this.box('inn', hw-0.55, y, 0.5, 0.85, 0.07, 8.0, 0x5a4a3c, { shade:0.15 });
      for(let x=-3.4; x<3.6; x+=0.95){
        this.box('inn', hw-0.55, y+0.28, x, 0.6, 0.5, 0.62, [0x24282e,0x3a3f45,0x1c2026][R.i(0,2)], { shade:0.2 });
        if(R.bool(0.4)) this.quad('emis', hw-0.86, y+0.30, x, 0.42, 0.34, 0x6fd8e8, { lift:0, ry:-Math.PI/2, tile:false, mul:0.8 });
      }
    }
    // barred window on the back wall + safe
    this.box('inn', cMid+3.0, FY+0.55, -hd+0.7, 1.2, 1.1, 1.0, 0x2a2e33, { solid:1, shade:0.25 });
    this.box('metal', cMid+3.0, FY+0.65, -hd+1.22, 0.55, 0.55, 0.06, 0x9aa0a6, { shade:0 });

    this.ceilingLights([[-3.0,cv+2.6,2.6],[3.0,cv+2.6,2.6],[0,hd-3.4,3.0]], K);
    this._lightPts=[[cMid-0.6, cv+0.6],[0, hd-3.2],[doorU, hd-2.4]];

    this.addNPC(cMid-0.6, cv-1.15, 0, {
      name:'Sol', role:'pawnbroker', venue:'pawnshop', sign:'GOLD & GUN',
      label:'Talk to the pawnbroker', shirt:0x6a5a3a, skin:0xc08a5a, hair:0x8a8478, phase:1.7,
      lines:['Everything in here has a story. Most of them are sad.',
             'I pay cash. I do not pay much.','No receipts, no questions.'],
    });
  }

  // ---- CLOTHING ------------------------------------------------------------
  fitClothes(K,R,W,D,doorU){
    const hw=W/2-t, hd=D/2-t;
    const pal=[0xe8547a,0x38c6c0,0xf2c04a,0xf0eee6,0x5a6ad0,0xef8a3c,0x2e2f36,0xc86ad0];
    // rails
    const rails=[[-hw+3.6, hd-5.0],[-hw+3.6, hd-8.6],[-hw+8.4, hd-5.0],[-hw+8.4, hd-8.6]];
    for(const [u,v] of rails){
      if(u>hw-2.0) continue;
      this.box('inn', u, FY+0.03, v, 0.7, 0.06, 1.5, 0x8f959b, { shade:0 });
      for(const s of [-1,1]) this.cyl('metal', u, FY+0.80, v+s*0.62, 0.04,0.04,1.55, 0xc2c8cc, { seg:8, shade:0.2 });
      this.box('metal', u, FY+1.56, v, 0.05, 0.05, 1.30, 0xd2d8dc, { shade:0 });
      for(let i=0;i<9;i++){
        const g=v-0.58+i*0.145;
        this.box('inn', u, FY+1.06, g, 0.40, 0.86, 0.10, pal[R.i(0,pal.length-1)], { shade:0.28, tile:0.7 });
        this.box('inn', u, FY+1.52, g, 0.05, 0.14, 0.05, 0xb0b6bc, { shade:0 });
      }
      this.colliders.push(this.aabbLocal(u, v, 0.9, 1.7, FY, 1.7));
    }
    // folding tables with stacks
    for(let i=0;i<2;i++){
      const u=hw-4.2, v=hd-4.6-i*4.0;
      this.box('inn', u, 0.78, v, 1.7, 0.09, 1.1, 0xb08a62, { solid:1, shade:0.15 });
      this.box('inn', u, FY+0.32, v, 1.5, 0.62, 0.9, 0x8a6a4a, { shade:0.25 });
      for(let s=0;s<3;s++){
        const su=u-0.55+s*0.55;
        for(let k=0;k<3;k++)
          this.box('inn', su, 0.86+k*0.09, v+R.f(-0.1,0.1), 0.42, 0.08, 0.34, pal[R.i(0,pal.length-1)], { shade:0.2, tile:0.6 });
      }
    }
    // mirrors on the left wall
    for(let i=0;i<2;i++){
      const v=-1.0+i*3.0;
      this.box('inn', -hw+0.20, FY+1.20, v, 0.10, 2.10, 1.05, 0x6a5a4a, { shade:0.1 });
      this.quad('metal', -hw+0.27, FY+1.20, v, 0.92, 1.95, 0xf0f4f8, { ry:Math.PI/2, tile:false });
    }
    // fitting rooms across the back
    const fu0=hw-1.2;
    for(let i=0;i<3;i++){
      const u=fu0-i*1.55;
      this.box('inn', u+0.78, FY+1.15, -hd+0.9, 0.10, 2.30, 1.7, 0xd8cfc0, { solid:1, shade:0.2 });
      this.box('inn', u, FY+1.15, -hd+0.18, 1.5, 2.30, 0.14, 0xd8cfc0, { shade:0.2 });
      this.box('inn', u, FY+1.05, -hd+1.72, 1.42, 2.05, 0.08, [0x8e2f5a,0x2f5a8e,0x2f8e5a][i], { shade:0.25, tile:0.8 });
      this.box('inn', u, FY+2.28, -hd+1.72, 1.6, 0.06, 0.14, 0xb9bfc4, { shade:0 });
    }
    this.box('inn', fu0-2.35, FY+1.15, -hd+0.9, 0.10, 2.30, 1.7, 0xd8cfc0, { solid:1, shade:0.2 });
    this.quad('sign', fu0-0.8, 2.75, -hd+1.80, 2.0, 0.46, 0xffffff, { uv:this.SU.p_fitting, mul:1.3 });
    this.addFixture(fu0-0.8, -hd+2.8, 1.4, 'Try on clothes', 'fitting', 'clothing_fitting');

    // counter
    const ku=-hw+2.6, kv=-hd+3.2;
    this.counterRun(ku, kv, 3.2, 0.9, 1.04, 0xe0d6c4, 0x6a3560, { kick:1 });
    this.box('inn', ku+0.9, 1.22, kv, 0.5, 0.28, 0.4, 0x24272e, { shade:0.1 });
    this.quad('emis', ku+0.9, 1.30, kv+0.21, 0.38, 0.20, 0xffb0d8, { lift:0, tile:false, mul:1.4 });

    // mannequins in the window
    for(let i=0;i<2;i++){
      const u=doorU+(i?3.4:-3.4), v=hd-1.5;
      if(Math.abs(u)>hw-1.0) continue;
      this.cyl('inn', u, FY+0.05, v, 0.30,0.32,0.10, 0x9a938a, { seg:12, shade:0 });
      this.cyl('inn', u, FY+0.52, v, 0.06,0.06,0.85, 0xb9b2a8, { seg:8, shade:0 });
      this.box('inn', u, FY+1.20, v, 0.42, 0.66, 0.26, pal[i*2], { shade:0.25, tile:0.7 });
      this.box('inn', u, FY+1.62, v, 0.18, 0.24, 0.20, 0xd8c8b4, { shade:0.1 });
      this.box('emis', u, FY+2.05, v, 0.5, 0.05, 0.3, 0xfff0e0, { lift:0, shade:0, mul:1.4 });
    }

    this.ceilingLights([[-hw+4,hd-4,3.2],[hw-4,hd-4,3.2],[-hw+4,-hd+4,3.2],[hw-5,-hd+4,3.2]], K);
    this._lightPts=[[0, hd-4.0],[0, -hd+4.0],[doorU, hd-2.4]];

    this.addNPC(ku, kv-1.05, 0.1, {
      name:'Ines', role:'shop assistant', venue:'clothing', sign:'SUNSET THREADS',
      label:'Talk to the assistant', shirt:0xc0407a, skin:0xd8a077, hair:0x2a1a14, phase:0.9,
      lines:['Everything on the front rails is new in.',
             'Fitting rooms are at the back.','That colour would suit you.'],
    });
    this.addNPC(-hw+6.0, hd-6.8, Math.PI*0.5, {
      name:'Tam', role:'shopper', venue:'clothing', sign:'SUNSET THREADS',
      label:'Talk to the shopper', shirt:0x38c6c0, skin:0x8a5c3c, hair:0x141010, phase:5.0,
      lines:['Does this come in black?','I already own three of these.'],
    });
  }

  // local AABB -> world collider (for things built from many small parts)
  aabbLocal(u,v,su,sv,y0,y1){
    const p=this.world(u,v);
    const ax=Math.abs(Math.cos(this.theta)), az=Math.abs(Math.sin(this.theta));
    const ex=su/2*ax + sv/2*az, ez=su/2*az + sv/2*ax;
    return { minX:p.x-ex, maxX:p.x+ex, minZ:p.z-ez, maxZ:p.z+ez, minY:y0, maxY:y1 };
  }

  // =========================== commit =======================================
  commit(){
    const mk=(bagName, mat, cast)=>{
      const list=this.bags[bagName];
      if(!list.length) return null;
      const g=mergeGeometries(list, false);
      list.length=0;
      if(!g) { console.warn('[interiors] merge failed for', bagName); return null; }
      const m=new THREE.Mesh(g, mat);
      m.name='Interiors_'+bagName;
      m.castShadow=!!cast; m.receiveShadow=true;
      m.matrixAutoUpdate=false;
      this.group.add(m);
      return m;
    };
    this.meshes={
      ext:  mk('ext',   this.mat.shell, true),
      inn:  mk('inn',   this.mat.shell, false),
      floor:mk('floor', this.mat.floor, false),
      metal:mk('metal', this.mat.metal, false),
      emis: mk('emis',  this.mat.emis,  false),
      sign: mk('sign',  this.mat.sign,  false),
      glass:mk('glass', this.mat.glass, false),
    };
    if(this.meshes.glass){
      this.meshes.glass.renderOrder=6;     // after opaque, after the world haze
      this.meshes.glass.receiveShadow=false;
    }
    if(this.meshes.emis) this.meshes.emis.renderOrder=1;
    if(this.meshes.sign) this.meshes.sign.renderOrder=2;
  }

  // ---- NPCs ----------------------------------------------------------------
  // Two InstancedMeshes: legs+torso, and a head/arms cluster pivoted at the
  // sternum so it can sway and breathe independently of the body.
  buildNPCMeshes(){
    if(!this.npcs.length) return;
    const N=this.npcs.length;

    const body=[], upper=[];
    const P=(g,hex,shade)=>paint(g,hex,1,shade===undefined?0.22:shade);
    const B=(w,h,d,x,y,z,hex,shade)=>{ const g=new THREE.BoxGeometry(w,h,d); P(g,hex,shade); g.translate(x,y,z); return g; };

    // ---- body: feet at y=0, colour comes mostly from instanceColor
    body.push(B(0.17,0.90,0.21, -0.115,0.45,0, 0x3a3d4a));
    body.push(B(0.17,0.90,0.21,  0.115,0.45,0, 0x3a3d4a));
    body.push(B(0.22,0.09,0.30, -0.115,0.045,0.04, 0x1a1a1e, 0));
    body.push(B(0.22,0.09,0.30,  0.115,0.045,0.04, 0x1a1a1e, 0));
    body.push(B(0.38,0.18,0.25,  0,0.97,0, 0x53576a));
    body.push(B(0.42,0.44,0.26,  0,1.24,0, 0xffffff));   // torso -> instanceColor
    const bodyGeo=mergeGeometries(body,false);

    // ---- upper: pivot at y=1.30
    const py=1.30;
    upper.push(B(0.50,0.15,0.27, 0,1.42-py,0, 0xffffff));      // shoulders
    upper.push(B(0.11,0.08,0.11, 0,1.50-py,0, 0xe8b48a));      // neck
    upper.push(B(0.21,0.23,0.22, 0,1.635-py,0.01, 0xffffff));  // head -> skin
    upper.push(B(0.225,0.09,0.235, 0,1.745-py,0.005, 0x2a1c14));// hair
    upper.push(B(0.055,0.05,0.03, -0.055,1.655-py,0.115, 0x120c08));
    upper.push(B(0.055,0.05,0.03,  0.055,1.655-py,0.115, 0x120c08));
    for(const s of [-1,1]){
      upper.push(B(0.115,0.30,0.14, s*0.285,1.27-py,0, 0xf0f0f0));   // sleeve
      upper.push(B(0.10,0.30,0.12,  s*0.285,0.99-py,0.02, 0xe8b48a)); // forearm
    }
    const upperGeo=mergeGeometries(upper,false);

    const npcMat=(hex)=>{
      const m=new THREE.MeshStandardMaterial({ color:hex, vertexColors:true, roughness:0.82, metalness:0.0 });
      const lift=this.uLift;
      m.onBeforeCompile=(sh)=>{
        sh.uniforms.uLift=lift;
        sh.fragmentShader=sh.fragmentShader
          .replace('#include <common>','#include <common>\nuniform float uLift;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            totalEmissiveRadiance += diffuseColor.rgb * vec3(1.10,0.96,0.82) * uLift * 0.85;
            diffuseColor.a = 1.0;`);
      };
      return m;
    };
    this.mat.npcBody =npcMat(0xffffff);
    this.mat.npcUpper=npcMat(0xffffff);

    const mB=new THREE.InstancedMesh(bodyGeo, this.mat.npcBody, N);
    const mU=new THREE.InstancedMesh(upperGeo, this.mat.npcUpper, N);
    mB.name='Interiors_npcBody'; mU.name='Interiors_npcUpper';
    mB.castShadow=false; mU.castShadow=false;
    mB.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mU.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const c=new THREE.Color();
    this.npcs.forEach((n,i)=>{
      c.set(n.shirt); mB.setColorAt(i,c);
      c.set(n.skin);  mU.setColorAt(i,c);
    });
    if(mB.instanceColor) mB.instanceColor.needsUpdate=true;
    if(mU.instanceColor) mU.instanceColor.needsUpdate=true;

    this.group.add(mB); this.group.add(mU);
    this.npcBody=mB; this.npcUpper=mU;
    this.animateNPCs(0);
    mB.computeBoundingSphere(); mU.computeBoundingSphere();
  }

  animateNPCs(time){
    const mB=this.npcBody, mU=this.npcUpper;
    if(!mB) return;
    const m4=this._m4, q=this._q, e=this._e, v3=this._v3, s3=this._s3;
    for(let i=0;i<this.npcs.length;i++){
      const n=this.npcs[i];
      const ph=n.phase;
      const breathe=Math.sin(time*1.7+ph);
      const sway  =Math.sin(time*0.63+ph*1.7);
      const shift =Math.sin(time*0.41+ph*2.3);
      // body: weight shifts from foot to foot
      e.set(0, n.yaw + sway*0.035, 0);
      q.setFromEuler(e);
      v3.set(n.pos.x, FY + breathe*0.004, n.pos.z);
      m4.compose(v3,q,s3);
      mB.setMatrixAt(i, m4);
      // upper body: pivot at the sternum, nods and turns slightly
      e.set(breathe*0.022 + shift*0.014, n.yaw + sway*0.075 + shift*0.05, shift*0.02);
      q.setFromEuler(e);
      v3.set(n.pos.x, FY + 1.30 + breathe*0.010, n.pos.z);
      m4.compose(v3,q,s3);
      mU.setMatrixAt(i, m4);
    }
    mB.instanceMatrix.needsUpdate=true;
    mU.instanceMatrix.needsUpdate=true;
  }

  // ---- forward light rig registration --------------------------------------
  // Called on the first update, when ctx.neon exists (main.js builds the rig
  // after every module). Every interior lamp and every neon sign becomes an
  // emitter in the shared rig: coloured light on the walls, the floor, the NPCs
  // and the pavement outside, at zero extra draw calls.
  registerLights(ctx){
    const V=(ctx.city&&ctx.city.venues)||[];
    const p=new THREE.Vector3();
    for(let i=0;i<V.length;i++){
      const v=V[i], K=KIND[v.kind]||KIND.store;
      const flat=v.facing.fz!==0;
      const W=flat?v.w:v.d, D=flat?v.d:v.w;
      this.frame(v);
      const pts=[[0, -D/2+D*0.32],[0, 0],[0, D/2-3.2]];
      for(const [u,vv] of pts){
        this.world(u,vv,p); p.y=3.6;
        ctx.neon.add(p, K.light, K.lightI, K.lightR);
        this._lights.push(ctx.neon.emitters[ctx.neon.emitters.length-1]);
      }
      // light spilling out of the shopfront onto the pavement
      this.world(0, D/2+1.2, p); p.y=2.2;
      ctx.neon.add(p, K.light, 0.85, 12);
      // fascia + blade neon
      this.world(0, D/2+0.6, p); p.y=(HEAD+GT)/2+0.2;
      ctx.neon.add(p, K.neon, 1.15, 15);
      const fl=ctx.neon.emitters[ctx.neon.emitters.length-1];
      this._flick.push({ e:fl, base:1.15, ph:(v.seed%97)/97*6.28, sp:2.1+(v.seed%13)*0.21 });
      this.world(0, D/2+0.35, p); p.y=HEAD+0.16;
      ctx.neon.add(p, K.neon, 0.9, 11);
    }
  }

  // ---- interaction ---------------------------------------------------------
  // Nearest interactable within ~2.5m of playerPos. Returns a new object.
  interact(playerPos){
    if(!playerPos) return null;
    const px=playerPos.x, py=(playerPos.y!==undefined?playerPos.y:1.0), pz=playerPos.z;
    let best=null, bestD=6.25;   // 2.5^2
    const list=this.interactables;
    for(let i=0;i<list.length;i++){
      const it=list[i];
      const dx=it.x-px, dz=it.z-pz;
      const d=dx*dx+dz*dz;
      if(d<bestD && Math.abs(it.y-py)<2.6){ bestD=d; best=it; }
    }
    if(!best) return null;
    return { label:best.label, npc:best.npc, kind:best.kind, id:best.id,
             distance:Math.sqrt(bestD) };
  }

  // convenience for the player controller: is this point inside a doorway?
  inDoorway(x,z){
    for(let i=0;i<this.doorways.length;i++){
      const d=this.doorways[i], dx=x-d.x, dz=z-d.z;
      if(dx*dx+dz*dz < d.r*d.r) return true;
    }
    return false;
  }

  // ---- frame ---------------------------------------------------------------
  update(dt, ctx){
    if(!this.meshes) return;
    if(!this._reg && ctx && ctx.neon){ this._reg=true; try{ this.registerLights(ctx); }catch(e){ console.error('[interiors] light rig',e.message); } }
    this._t += dt;
    const night = ctx ? ctx.nightFactor : 1;
    // shop lighting stays on around the clock but reads brighter after dark;
    // upper-storey windows only light up at night
    this.uLift.value = 0.13 + 0.24*night;
    this.uK0.value   = 0.62 + 0.55*night;
    this.uK1.value   = 0.05 + 1.05*night;
    if(this.mat.glass) this.mat.glass.opacity = 0.26 - 0.09*night;
    // neon flicker on the fascia emitters (rubric §7: signs flicker)
    for(let i=0;i<this._flick.length;i++){
      const f=this._flick[i];
      const s=Math.sin(this._t*f.sp + f.ph);
      f.e.intensity = f.base * (0.88 + 0.12*s + (s>0.93?0.25:0));
    }
    this.animateNPCs(this._t);
  }
}

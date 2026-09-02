import * as THREE from 'three';
import { Rand } from '../core/rng.js';
import { CONFIG } from '../core/config.js';

// City = grid of blocks separated by roads. Districts vary height/palette so the
// skyline is never a uniform box field (rubric §4).
const DISTRICTS = {
  downtown:  { hMin:30, hMax:96, density:0.90, neon:0.55,
               palette:[0xdcd4c4,0xeadfc9,0xc9bda8,0xb3bcc4,0xd8bd96,0xc4b199] },
  strip:     { hMin:8,  hMax:24, density:0.86, neon:1.00,
               palette:[0xf2e6d8,0xe8c9a8,0xd97f6a,0xe9b98c,0xd4936f,0xf0dcc2] },
  residential:{hMin:7,  hMax:18, density:0.74, neon:0.18,
               palette:[0xe8c9a8,0xd9b48e,0xe6d2b4,0xd97f6a,0xcfa07e,0xf2e6d8] },
  industrial:{ hMin:6,  hMax:15, density:0.68, neon:0.25,
               palette:[0xb5a794,0x9c8f7c,0xc3b8a4,0x8e8474,0xc7b294,0xa89880] },
  beach:     { hMin:11, hMax:34, density:0.56, neon:0.62,
               palette:[0xffffff,0xfdf2e2,0xf7e0c8,0xffeed8,0xf3e4ce,0xfff8ec] },
};
export function districtAt(bx, bz, n){
  const cx=(bx-n/2)/n*2, cz=(bz-n/2)/n*2;      // -1..1
  const r = Math.hypot(cx, cz);
  if (cz > 0.62) return 'beach';
  if (r < 0.30) return 'downtown';
  if (Math.abs(cx) < 0.22 && cz > -0.35) return 'strip';
  if (cx < -0.55) return 'industrial';
  return 'residential';
}

export class City {
  constructor(scene, seed=CONFIG.seed){
    this.scene=scene; this.rand=new Rand(seed);
    this.group=new THREE.Group(); this.group.name='City';
    scene.add(this.group);
    this.n=CONFIG.city.blocks; this.bs=CONFIG.city.blockSize; this.rw=CONFIG.city.roadWidth;
    this.span=this.n*(this.bs+this.rw);
    this.roadY=0.02;
    this.buildings=[];   // procedural filler buildings
    this.venues=[];      // reserved street-facing plots for enterable, functional buildings
    this.emissives=[];
  }

  get stride(){ return this.bs + this.rw; }
  // world position of block (bx,bz) centre
  blockCentre(bx,bz){
    const s=this.stride;
    return new THREE.Vector3((bx-this.n/2+0.5)*s, 0, (bz-this.n/2+0.5)*s);
  }
  // true if world pos is on a road (used by traffic + collision)
  isRoad(x,z){
    const s=this.stride, half=this.span/2;
    const o=this.rw*0.5;
    const fx=((x+half+o)%s+s)%s, fz=((z+half+o)%s+s)%s;
    return fx < this.rw || fz < this.rw;
  }

  build(){
    this.buildGround();
    this.buildRoads();
    this.buildBlocks();
    this.reserveVenues();
    return this;
  }

  buildGround(){
    const g=new THREE.PlaneGeometry(this.span*2.6, this.span*2.6);
    const m=new THREE.MeshStandardMaterial({ color:0x2a2b2e, roughness:0.96, metalness:0.0 });
    const mesh=new THREE.Mesh(g,m); mesh.rotation.x=-Math.PI/2; mesh.position.y=-0.05;
    mesh.receiveShadow=true; this.group.add(mesh); this.ground=mesh;
  }

  buildRoads(){
    const s=this.stride, half=this.span/2, len=this.span;
    const roadMat=new THREE.MeshStandardMaterial({ color:0x191a1d, roughness:0.72, metalness:0.02 });
    const walkMat=new THREE.MeshStandardMaterial({ color:0x8e8b84, roughness:0.90 });
    const roads=new THREE.Group(); this.group.add(roads); this.roads=roads;

    for(let i=0;i<=this.n;i++){
      const off = -half + i*s;   // road centred on the block boundary
      // N-S road
      const a=new THREE.Mesh(new THREE.PlaneGeometry(this.rw, len+this.rw), roadMat);
      a.rotation.x=-Math.PI/2; a.position.set(off, this.roadY, 0); a.receiveShadow=true; roads.add(a);
      // E-W road
      const b=new THREE.Mesh(new THREE.PlaneGeometry(len+this.rw, this.rw), roadMat);
      b.rotation.x=-Math.PI/2; b.position.set(0, this.roadY, off); b.receiveShadow=true; roads.add(b);
    }
    // sidewalks as raised kerbs around each block
    const kerbH=0.16;
    const kerbGeo=new THREE.BoxGeometry(1,1,1);
    const inst=new THREE.InstancedMesh(kerbGeo, walkMat, this.n*this.n*4);
    inst.receiveShadow=true; inst.castShadow=true;
    const m4=new THREE.Matrix4(); let k=0;
    const sw=CONFIG.city.sidewalk, bs=this.bs;
    for(let bx=0;bx<this.n;bx++) for(let bz=0;bz<this.n;bz++){
      const c=this.blockCentre(bx,bz);
      const defs=[[0,-(bs/2+sw/2),bs+sw*2,sw],[0,(bs/2+sw/2),bs+sw*2,sw],
                  [-(bs/2+sw/2),0,sw,bs],[(bs/2+sw/2),0,sw,bs]];
      for(const [dx,dz,w,d] of defs){
        m4.makeScale(w,kerbH,d);
        m4.setPosition(c.x+dx, kerbH/2, c.z+dz);
        inst.setMatrixAt(k++, m4);
      }
    }
    inst.count=k; inst.instanceMatrix.needsUpdate=true; roads.add(inst);
  }

  buildBlocks(){
    const R=this.rand;
    const mid=(this.n-1)/2;
    for(let bx=0;bx<this.n;bx++) for(let bz=0;bz<this.n;bz++){
      const dName=districtAt(bx,bz,this.n);
      const D=DISTRICTS[dName];
      const c=this.blockCentre(bx,bz);
      if(dName==='beach' && R.bool(0.45)) continue; // open sand
      // distance from city core, 0 at centre -> 1 at edge. Drives landmark odds.
      const core = Math.hypot(bx-mid, bz-mid)/mid;
      this.buildLots(c, D, dName, R, core);
    }
  }

  // Reserve a handful of street-facing plots for hand-built, enterable venues.
  // These are REMOVED from this.buildings so the procedural generator does not
  // drop an opaque box on top of them; src/world/interiors.js builds them instead.
  reserveVenues(){
    const KINDS = [
      { kind:'bank',      sign:'PACIFIC MUTUAL', minW:22, minD:18 },
      { kind:'store',     sign:'24/7 MARKET',    minW:16, minD:14 },
      { kind:'diner',     sign:'THE SANDBAR',    minW:16, minD:14 },
      { kind:'pawnshop',  sign:'GOLD & GUN',     minW:14, minD:12 },
      { kind:'clothing',  sign:'SUNSET THREADS', minW:16, minD:14 },
    ];
    const sw = CONFIG.city.sidewalk;
    // A plot is usable only if a point just past one face lands on a road, so the
    // door has a pavement to open onto.
    const streetFacing = (b)=>{
      const probes = [
        [b.x, b.z - b.d/2 - sw - 2.5, 0, -1],
        [b.x, b.z + b.d/2 + sw + 2.5, 0,  1],
        [b.x - b.w/2 - sw - 2.5, b.z, -1, 0],
        [b.x + b.w/2 + sw + 2.5, b.z,  1, 0],
      ];
      for(const [px,pz,fx,fz] of probes){
        if(this.isRoad(px,pz)) return { fx, fz };
      }
      return null;
    };

    const taken = new Set();
    for(const K of KINDS){
      let bestI = -1, bestScore = -Infinity, bestFace = null;
      for(let i=0;i<this.buildings.length;i++){
        if(taken.has(i)) continue;
        const b = this.buildings[i];
        if(b.w < K.minW || b.d < K.minD) continue;
        if(b.district === 'industrial') continue;
        const face = streetFacing(b);
        if(!face) continue;
        // prefer plots near the core so venues are easy to stumble across
        const score = -(Math.hypot(b.x, b.z)) + (b.district==='strip' ? 220 : 0);
        if(score > bestScore){ bestScore = score; bestI = i; bestFace = face; }
      }
      if(bestI < 0) continue;
      const b = this.buildings[bestI];
      taken.add(bestI);
      this.venues.push({
        kind:K.kind, sign:K.sign,
        x:b.x, z:b.z, w:b.w, d:b.d,
        h: Math.max(9, Math.min(b.h, 16)),   // venues stay low so the interior reads
        facing: bestFace,                     // outward normal of the street face
        district:b.district, seed:b.seed,
      });
    }
    // drop reserved plots from the procedural set, highest index first
    [...taken].sort((a,b)=>b-a).forEach(i=>this.buildings.splice(i,1));
    return this.venues;
  }

  // Subdivide a block into lots and place a building per lot. Lot COUNT varies so
  // footprints are not a uniform grid: occasionally one building takes the whole
  // block (a landmark plate), usually 2x2..3x3 with jittered splits.
  buildLots(centre, D, dName, R, core){
    const bs=this.bs;
    const big = (dName==='downtown' && R.bool(0.22)) || (dName!=='downtown' && R.bool(0.06));
    let cols, rows;
    if(big){ cols=1; rows=1; }
    else { cols=R.i(2,3); rows=R.i(2,3); }

    // jittered split lines so lots differ in size within the block
    const splits=(k)=>{
      const cut=[0]; for(let i=1;i<k;i++) cut.push(i/k + R.f(-0.10,0.10));
      cut.push(1); return cut;
    };
    const cx0=splits(cols), cz0=splits(rows);

    for(let i=0;i<cols;i++) for(let j=0;j<rows;j++){
      if(!R.bool(D.density)) continue;
      const u0=cx0[i], u1=cx0[i+1], v0=cz0[j], v1=cz0[j+1];
      const lw=(u1-u0)*bs, ld=(v1-v0)*bs;
      const cx=centre.x - bs/2 + (u0+u1)*0.5*bs;
      const cz=centre.z - bs/2 + (v0+v1)*0.5*bs;
      const w=lw*R.f(0.80,0.95), d=ld*R.f(0.80,0.95);

      // Height: skewed low so a few towers really stand out (rubric S4).
      const u=R.f(0,1);
      let h = D.hMin + (D.hMax-D.hMin)*Math.pow(u, dName==='downtown'?1.5:1.9);
      // landmark: rare, tall, and only where the lot can carry it
      const lmChance = dName==='downtown' ? 0.16*(1.0-core*0.7) : 0.02;
      const landmark = Math.min(w,d) > 16 && R.bool(Math.max(lmChance,0));
      if(landmark) h *= R.f(1.45, 2.15);
      if(dName==='downtown') h = Math.max(h, 18);

      this.buildings.push({
        x:cx, z:cz, w, d, h,
        district:dName, colour:R.pick(D.palette), neon:D.neon, seed:R.i(0,1e6),
        landmark,                       // used by Buildings for massing + crowns
        tint:R.f(0.86,1.12),            // per-building albedo variation
        grime:R.f(0.0,1.0),             // per-building weathering amount
      });
    }
  }
}

import * as THREE from 'three';
import { Rand } from '../core/rng.js';
import { CONFIG } from '../core/config.js';

// City = grid of blocks separated by roads. Districts vary height/palette so the
// skyline is never a uniform box field (rubric §4).
const DISTRICTS = {
  downtown:  { hMin:26, hMax:88, density:0.92, palette:[0x8d94a8,0x6f7788,0xa9b0bd,0x5d6472], neon:0.55 },
  strip:     { hMin:8,  hMax:22, density:0.85, palette:[0xf2e6d8,0xe8c9a8,0xd97f6a,0xf0d2b0], neon:1.00 },
  residential:{hMin:6,  hMax:16, density:0.72, palette:[0xf4ddc4,0xe3b894,0xd8c2a8,0xefe0cc], neon:0.18 },
  industrial:{ hMin:5,  hMax:14, density:0.66, palette:[0x9a8f80,0x7d7466,0xa8a091,0x6d675c], neon:0.25 },
  beach:     { hMin:10, hMax:30, density:0.55, palette:[0xffffff,0xfdf2e2,0xf7e0c8,0xffeed8], neon:0.62 },
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
    this.buildings=[];   // {box} for collision
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
    for(let bx=0;bx<this.n;bx++) for(let bz=0;bz<this.n;bz++){
      const dName=districtAt(bx,bz,this.n);
      const D=DISTRICTS[dName];
      const c=this.blockCentre(bx,bz);
      if(dName==='beach' && R.bool(0.45)) continue; // open sand
      this.buildLots(c, D, dName, R);
    }
  }

  // Subdivide a block into lots and place a building per lot.
  buildLots(centre, D, dName, R){
    const bs=this.bs;
    const cols=R.i(2,3), rows=R.i(2,3);
    const lw=bs/cols, ld=bs/rows;
    for(let i=0;i<cols;i++) for(let j=0;j<rows;j++){
      if(!R.bool(D.density)) continue;
      const cx=centre.x - bs/2 + lw*(i+0.5);
      const cz=centre.z - bs/2 + ld*(j+0.5);
      const w=lw*R.f(0.78,0.94), d=ld*R.f(0.78,0.94);
      const h=R.f(D.hMin, D.hMax) * (dName==='downtown' ? R.f(0.7,1.35) : 1.0);
      this.buildings.push({ x:cx, z:cz, w, d, h, district:dName, colour:R.pick(D.palette), neon:D.neon, seed:R.i(0,1e6) });
    }
  }
}

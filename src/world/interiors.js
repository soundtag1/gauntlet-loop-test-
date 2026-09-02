import * as THREE from 'three';
// STUB — owned by the INTERIORS specialist.
// Builds the enterable, functional venues reserved in ctx.city.venues:
// real exteriors with see-through glazing, walkable interiors, fixtures and NPCs.
// Contract: constructor(scene, ctx), .build() returns this, .update(dt, ctx).
// Must expose:
//   .colliders  -> array of {minX,maxX,minZ,maxZ,minY,maxY} solid volumes (walls, counters)
//   .doorways   -> array of {x,z,r} openings where movement is NOT blocked
//   .interact(playerPos) -> {label, npc} | null   prompt for the nearest NPC/fixture
export class Interiors {
  constructor(scene, ctx){ this.scene=scene; this.ctx=ctx; this.colliders=[]; this.doorways=[];
    this.group=new THREE.Group(); this.group.name='Interiors'; scene.add(this.group); }
  build(){ return this; }
  update(dt, ctx){}
  interact(){ return null; }
}

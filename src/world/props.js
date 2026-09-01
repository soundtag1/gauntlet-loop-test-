import * as THREE from 'three';
// STUB — owned by a specialist agent. Contract: constructor(scene, ctx),
// .build() returns this, .update(dt, ctx) each frame.
export class Props {
  constructor(scene, ctx){ this.scene=scene; this.ctx=ctx; this.group=new THREE.Group(); this.group.name='Props'; scene.add(this.group); }
  build(){ return this; }
  update(dt, ctx){}
}

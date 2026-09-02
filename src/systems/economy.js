import * as THREE from 'three';
// STUB — owned by the ECONOMY & DRIVING specialist.
// Money, bank balance, vehicle ownership, dealership purchase, and player driving.
// Contract: constructor(scene, ctx), .build() returns this, .update(dt, ctx).
// Must expose: .balance, .deposit(n), .withdraw(n), .canAfford(n),
//              .ownedVehicles[], .buyVehicle(spec), .enterVehicle(v), .exitVehicle()
export class Economy {
  constructor(scene, ctx){ this.scene=scene; this.ctx=ctx; this.balance=0; this.ownedVehicles=[];
    this.group=new THREE.Group(); this.group.name='Economy'; scene.add(this.group); }
  build(){ return this; }
  update(dt, ctx){}
}

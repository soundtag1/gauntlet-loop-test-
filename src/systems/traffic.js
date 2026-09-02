import * as THREE from 'three';
import { Rand } from '../core/rng.js';

// ============================================================================
// TRAFFIC — grid-following AI for the fleet built by src/entities/vehicle.js
//
// The city is a lattice of roads centred on block boundaries at
// world = -span/2 + i*stride, so a car's whole state is (target node, heading).
// It drives the RIGHT-HAND lane of its segment toward a stop-line waypoint, waits
// for its axis of the intersection signal, then arcs onto the next segment. Lane
// offset 4.2m inside a 16m road keeps every wheel on asphalt and every body clear
// of the kerbs, so nothing can ever clip a building.
//
// Motion has weight: limited acceleration and braking, a yaw-rate cap that falls
// with speed (so turns are arcs, not pivots), sprung body roll into the turn,
// nose-dive under braking and a small heave that reacts to the road.
//
// Density beats coverage: 32km of road would swallow 96 cars, so traffic is
// confined to the central district lattice, which is where every street-level
// camera stands and where a real city's traffic actually is.
// ============================================================================

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // +x, +z, -x, -z
const LANE = 4.2;          // lane centre offset from road centreline
const CYCLE = 13.0;        // full signal cycle, seconds
const A_MAX = 4.0;         // accel  m/s^2
const B_MAX = 7.6;         // brake  m/s^2

function hash32(a){
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
function wrapPi(a){
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class Traffic {
  constructor(scene, ctx){
    this.scene = scene; this.ctx = ctx;
    this.group = new THREE.Group(); this.group.name = 'Traffic';
    scene.add(this.group);
    this.t = 0;
    this.cars = [];
  }

  nodeC(i){ return -this.HALF + i * this.S; }

  build(){
    const ctx = this.ctx, city = ctx.city;
    if (!city || !ctx.vehicles) return this;
    this.city = city;
    this.veh = ctx.vehicles;
    this.cars = this.veh.cars;
    this.S = city.stride;
    this.HALF = city.span / 2;
    this.N = city.n;
    this.RW = city.rw;
    const mid = Math.round(this.N / 2);
    this.iMin = Math.max(0, mid - 3);
    this.iMax = Math.min(this.N, mid + 4);

    this.place();
    for (let k = 0; k < 40; k++) this.step(1 / 30);   // settle springs + queues
    return this;
  }

  // Spread the fleet over the central lattice, biased onto the arterials that run
  // through downtown so the hero streets are never bare.
  place(){
    const R = new Rand((this.ctx.seed | 0) + 7717);
    const lines = [];
    for (let i = this.iMin; i <= this.iMax; i++){
      const d = Math.abs(i - (this.iMin + this.iMax) / 2);
      const w = Math.max(1, 5 - d * 1.15);            // arterials through the core
      for (let k = 0; k < Math.round(w * 2); k++) lines.push(i);
    }
    const cars = this.cars;
    for (let k = 0; k < cars.length; k++){
      const c = cars[k];
      c.id = k;
      c.turns = k * 3 + 1;
      c.cruise = R.f(9.0, 13.4) * c.spd;
      c.gap = 200; c.brake = 0; c.dist = R.f(0, 40);
      c.phase = 0; c.ndir = 0; c.turning = false;

      let ok = false;
      for (let attempt = 0; attempt < 24 && !ok; attempt++){
        const axis = (k + (attempt & 1)) & 1;
        const li = lines[R.i(0, lines.length - 1)];
        const sj = R.i(this.iMin, this.iMax - 1);
        const u = R.f(0.10, 0.90);
        const back = this.nodeC(sj), fwd = this.nodeC(sj + 1);
        const along = back + (fwd - back) * u;
        const fwdDir = R.bool();
        if (axis === 0){                                  // north-south road
          c.dir = fwdDir ? 1 : 3;
          c.x = this.nodeC(li) + (c.dir === 1 ? -LANE : LANE);
          c.z = along;
          c.ti = li; c.tj = c.dir === 1 ? sj + 1 : sj;
        } else {                                          // east-west road
          c.dir = fwdDir ? 0 : 2;
          c.z = this.nodeC(li) + (c.dir === 0 ? LANE : -LANE);
          c.x = along;
          c.tj = li; c.ti = c.dir === 0 ? sj + 1 : sj;
        }
        ok = true;
        for (let j = 0; j < k; j++){
          const o = cars[j];
          if (Math.abs(o.x - c.x) < 15 && Math.abs(o.z - c.z) < 15){ ok = false; break; }
        }
      }
      const f = DIRS[c.dir];
      c.yaw = Math.atan2(-f[1], f[0]);
      c.speed = c.cruise * R.f(0.55, 1.0);
      this.setApproach(c);
    }
  }

  // waypoint: stop-line of the target intersection, in our own lane
  setApproach(c){
    const f = DIRS[c.dir], rx = -f[1], rz = f[0];
    const NX = this.nodeC(c.ti), NZ = this.nodeC(c.tj);
    const back = this.RW * 0.5 + 1.4;
    c.tx = NX - f[0] * back + rx * LANE;
    c.tz = NZ - f[1] * back + rz * LANE;
  }

  // waypoint: exit of the intersection on the chosen outgoing lane
  setCross(c, nd){
    const g = DIRS[nd], rx = -g[1], rz = g[0];
    const NX = this.nodeC(c.ti), NZ = this.nodeC(c.tj);
    const out = this.RW * 0.5 + 2.6;
    c.tx = NX + g[0] * out + rx * LANE;
    c.tz = NZ + g[1] * out + rz * LANE;
  }

  // 0 = red, 1 = green, 2 = amber. Neighbouring junctions run out of phase so the
  // grid never blinks in unison.
  signal(ti, tj, dir){
    const off = (((ti * 5 + tj * 3) % 4) + 4) % 4 * 0.25;
    let ph = ((this.t / CYCLE) + off) % 1;
    if (ph < 0) ph += 1;
    const greenAxis = ph < 0.5 ? 0 : 1;
    if ((dir & 1) !== greenAxis) return 0;
    return (ph % 0.5) > 0.435 ? 2 : 1;
  }

  chooseDir(c){
    const rev = (c.dir + 2) & 3;
    let total = 0;
    const w = this._w || (this._w = [0, 0, 0, 0]);
    for (let d = 0; d < 4; d++){
      w[d] = 0;
      if (d === rev) continue;
      const ni = c.ti + (d === 0 ? 1 : d === 2 ? -1 : 0);
      const nj = c.tj + (d === 1 ? 1 : d === 3 ? -1 : 0);
      if (ni < this.iMin || ni > this.iMax || nj < this.iMin || nj > this.iMax) continue;
      w[d] = d === c.dir ? 3.6 : (d === ((c.dir + 1) & 3) ? 1.25 : 0.55);  // straight / right / left
      total += w[d];
    }
    if (total <= 0) return rev;
    let r = hash32(Math.imul(c.id + 1, 2654435761) ^ Math.imul(c.ti * 31 + c.tj, 40503) ^ Math.imul(c.turns, 97)) * total;
    c.turns++;
    for (let d = 0; d < 4; d++){ r -= w[d]; if (r <= 0 && w[d] > 0) return d; }
    return c.dir;
  }

  step(dt){
    const cars = this.cars, nc = cars.length;
    if (!nc) return;
    this.t += dt;

    // --- car-following: nearest vehicle ahead in the same lane
    for (let i = 0; i < nc; i++){
      const a = cars[i];
      const fx = Math.cos(a.yaw), fz = -Math.sin(a.yaw);
      let gap = 200;
      for (let j = 0; j < nc; j++){
        if (j === i) continue;
        const b = cars[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const ahead = dx * fx + dz * fz;
        if (ahead <= 0 || ahead > 30) continue;
        const lat = dx * -fz + dz * fx;
        if (lat > 2.6 || lat < -2.6) continue;
        const g = ahead - (a.len + b.len) * 0.5;
        if (g < gap) gap = g;
      }
      a.gap = gap;
    }

    for (let i = 0; i < nc; i++){
      const c = cars[i];
      const fx = Math.cos(c.yaw), fz = -Math.sin(c.yaw);
      let vLim = c.cruise;

      // ---- waypoint progress
      const dx = c.tx - c.x, dz = c.tz - c.z;
      const along = dx * fx + dz * fz;

      if (c.phase === 0){
        const sig = this.signal(c.ti, c.tj, c.dir);
        const canStop = along > 3.0 + c.speed * c.speed / (2 * B_MAX) * 0.55;
        const mustStop = sig === 0 || (sig === 2 && canStop);
        if (mustStop){
          const d = Math.max(0, along - 0.6);
          vLim = Math.min(vLim, Math.sqrt(2 * 3.1 * d));
        }
        if (along < 14) vLim = Math.min(vLim, 8.4);          // ease off into the junction
        if (along < 1.4 && !mustStop){
          const nd = this.chooseDir(c);
          c.ndir = nd; c.turning = nd !== c.dir; c.phase = 1;
          this.setCross(c, nd);
        }
      } else {
        if (c.turning) vLim = Math.min(vLim, 5.6);
        else vLim = Math.min(vLim, 9.5);
        if (along < 0.8){
          c.dir = c.ndir;
          c.ti += (c.dir === 0 ? 1 : c.dir === 2 ? -1 : 0);
          c.tj += (c.dir === 1 ? 1 : c.dir === 3 ? -1 : 0);
          c.phase = 0; c.turning = false;
          this.setApproach(c);
        }
      }

      // ---- following distance
      if (c.gap < 200) vLim = Math.min(vLim, Math.max(0, (c.gap - 3.4) * 1.15));

      // ---- steering: yaw rate falls off with speed, so fast cars track straight
      const tdx = c.tx - c.x, tdz = c.tz - c.z;
      const want = Math.atan2(-tdz, tdx);
      const delta = wrapPi(want - c.yaw);
      const maxRate = Math.min(2.0, 6.0 / Math.max(c.speed, 1.2));
      const rate = clamp(delta * 2.8, -maxRate, maxRate);
      c.yaw += rate * dt;
      if (Math.abs(delta) > 0.35) vLim = Math.min(vLim, 6.0);

      // ---- longitudinal
      const err = vLim - c.speed;
      const accel = clamp(err * (err < 0 ? 3.4 : 1.5), -B_MAX, A_MAX);
      c.accel = accel;
      c.speed = Math.max(0, c.speed + accel * dt);
      const ds = c.speed * dt;
      c.x += fx * ds; c.z += fz * ds;
      c.dist += ds;

      // ---- body: sprung roll into the turn, dive under braking, road heave
      const rollT = clamp(rate * c.speed * 0.020, -0.11, 0.11);
      c.rollV += ((rollT - c.roll) * 96 - c.rollV * 13) * dt;
      c.roll += c.rollV * dt;

      const pitchT = clamp(accel * 0.0125, -0.05, 0.05);
      c.pitchV += ((pitchT - c.pitch) * 84 - c.pitchV * 12) * dt;
      c.pitch += c.pitchV * dt;

      const heaveT = Math.sin(c.dist * 0.55 + c.id) * 0.013 * Math.min(1, c.speed / 7)
                   + clamp(accel, -B_MAX, A_MAX) * 0.0035;
      c.bodyV += ((heaveT - c.bodyY) * 150 - c.bodyV * 15) * dt;
      c.bodyY += c.bodyV * dt;

      c.steer = clamp(rate * 0.62, -0.55, 0.55);
      c.spin = (c.spin - ds / (c.len > 8 ? 0.46 : 0.34)) % (Math.PI * 2);
      const braking = accel < -1.4 ? 1 : 0;
      c.brake += (braking - c.brake) * Math.min(1, dt * 9);
    }
  }

  update(dt, ctx){
    if (!this.cars.length) return;
    this.step(Math.min(dt, 0.05));
    if (this.veh) this.veh.sync(ctx.nightFactor);
  }
}

// Deterministic PRNG so every critic screenshot is reproducible.
export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export class Rand {
  constructor(seed=1337){ this.r = mulberry32(seed); }
  f(a=0,b=1){ return a + this.r()*(b-a); }
  i(a,b){ return Math.floor(this.f(a,b+1)); }
  pick(arr){ return arr[this.i(0,arr.length-1)]; }
  bool(p=0.5){ return this.r() < p; }
}

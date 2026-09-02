import * as THREE from 'three';

// NEON LIGHT RIG
// The world is lit by exactly one directional + one hemisphere light. Every neon
// sign, streetlight and window is an emissive texel that illuminates NOTHING, so
// palms render as black cutouts, night facades have no falloff, and there is no
// coloured bounce anywhere. Rubric §2 requires emissives to "cast colored light
// onto nearby geometry".
//
// Real PointLights are too expensive here (software rasterisation, no GPU), so
// this is a small forward light loop injected into every standard material:
// the N nearest emitters are uploaded each frame as view-space positions, and
// materials accumulate a cheap wrap-diffuse term from them. One uniform block is
// shared by every patched material, so adding it costs no extra draw calls.

export const NEON_MAX = 16;

export class NeonRig {
  constructor(){
    this.emitters = [];               // {pos:Vector3, color:Color, intensity, radius}
    this.uniforms = {
      uNeonPos:{ value: Array.from({length:NEON_MAX}, ()=>new THREE.Vector4(0,0,0,0)) },
      uNeonCol:{ value: Array.from({length:NEON_MAX}, ()=>new THREE.Vector4(0,0,0,0)) },
      uNeonBoost:{ value: 1.0 },
    };
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._patched = new WeakSet();
  }

  add(pos, color, intensity=1.0, radius=26){
    this.emitters.push({ pos:pos.clone(), color:new THREE.Color(color), intensity, radius });
  }

  // Walk the scene and treat sufficiently-emissive meshes as light sources.
  // InstancedMesh is sampled per instance so a street of signs becomes a street
  // of emitters rather than one at the origin.
  discover(scene, { maxPerMesh = 120 } = {}){
    const m4 = new THREE.Matrix4(), pos = new THREE.Vector3();
    scene.traverse(obj=>{
      const mat = obj.material;
      if(!obj.isMesh || !mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      for(const mm of mats){
        const e = mm.emissive;
        if(!e) continue;
        const lum = e.r*0.2126 + e.g*0.7152 + e.b*0.0722;
        const str = lum * (mm.emissiveIntensity ?? 1);
        if(str < 0.12) continue;                    // not bright enough to light anything
        // approximate a radius from the object's footprint
        if(!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
        const bs = obj.geometry.boundingSphere;
        if(obj.isInstancedMesh){
          const n = Math.min(obj.count, maxPerMesh);
          const step = Math.max(1, Math.floor(obj.count / n));
          for(let i=0;i<obj.count;i+=step){
            obj.getMatrixAt(i, m4);
            m4.premultiply(obj.matrixWorld);
            pos.setFromMatrixPosition(m4);
            const sc = Math.max(m4.elements[0], m4.elements[5], m4.elements[10]) || 1;
            this.add(pos, e, str, Math.max(12, bs.radius*sc*3.2));
          }
        } else {
          obj.getWorldPosition(pos);
          const sc = obj.getWorldScale(this._v).length() || 1;
          this.add(pos, e, str, Math.max(12, bs.radius*sc*2.4));
        }
      }
    });
    return this;
  }

  // Inject the accumulation loop into a MeshStandardMaterial.
  patch(material){
    if(!material || this._patched.has(material)) return material;
    if(!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) return material;
    this._patched.add(material);
    const U = this.uniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer)=>{
      if(prev) prev(shader, renderer);
      shader.uniforms.uNeonPos = U.uNeonPos;
      shader.uniforms.uNeonCol = U.uNeonCol;
      shader.uniforms.uNeonBoost = U.uNeonBoost;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          #define NEON_MAX ${NEON_MAX}
          uniform vec4 uNeonPos[NEON_MAX];   // xyz = view-space position, w = radius
          uniform vec4 uNeonCol[NEON_MAX];   // rgb = colour, a = intensity
          uniform float uNeonBoost;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            vec3 P = -vViewPosition;
            vec3 N = normalize(normal);
            vec3 acc = vec3(0.0);
            for(int i=0;i<NEON_MAX;i++){
              float r = uNeonPos[i].w;
              if(r <= 0.0) continue;
              vec3  d    = uNeonPos[i].xyz - P;
              float dist = length(d);
              if(dist > r) continue;
              float att = 1.0 - dist / r;
              att *= att;
              // wrap diffuse: signage spills onto faces turned away from it too,
              // which is what makes neon read as ambient city light rather than a lamp
              float ndl = dot(N, d / max(dist, 1e-4));
              float wrap = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
              acc += uNeonCol[i].rgb * uNeonCol[i].a * att * (0.28 + 0.72 * wrap);
            }
            reflectedLight.directDiffuse += acc * diffuseColor.rgb * uNeonBoost;
          }`);
    };
    material.needsUpdate = true;
    return material;
  }

  patchScene(scene){
    scene.traverse(o=>{
      if(!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m=>this.patch(m));
    });
    return this;
  }

  // Upload the nearest emitters, in view space, weighted by strength.
  update(camera, nightFactor=1.0){
    const view = camera.matrixWorldInverse;
    const cam = camera.position;
    const list = this.emitters;
    // cheap partial selection: score by strength/distance, keep best NEON_MAX
    const best = [];
    for(let i=0;i<list.length;i++){
      const e = list[i];
      const dx=e.pos.x-cam.x, dy=e.pos.y-cam.y, dz=e.pos.z-cam.z;
      const d2 = dx*dx+dy*dy+dz*dz;
      if(d2 > (e.radius+90)*(e.radius+90)) continue;
      const score = e.intensity / (d2 + 1.0);
      if(best.length < NEON_MAX){ best.push({e, score}); if(best.length===NEON_MAX) best.sort((a,b)=>a.score-b.score); }
      else if(score > best[0].score){ best[0]={e,score}; best.sort((a,b)=>a.score-b.score); }
    }
    const P=this.uniforms.uNeonPos.value, C=this.uniforms.uNeonCol.value;
    for(let i=0;i<NEON_MAX;i++){
      if(i < best.length){
        const e = best[i].e;
        this._v.copy(e.pos).applyMatrix4(view);
        P[i].set(this._v.x, this._v.y, this._v.z, e.radius);
        C[i].set(e.color.r, e.color.g, e.color.b, e.intensity * nightFactor);
      } else {
        P[i].set(0,0,0,0); C[i].set(0,0,0,0);
      }
    }
    this.activeCount = best.length;
  }
}

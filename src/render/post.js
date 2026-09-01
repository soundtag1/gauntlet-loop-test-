import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

// Final grade: ACES is applied by OutputPass; this adds the film layer
// (grain, vignette, chromatic aberration, split-tone) per rubric §6.
const GradeShader = {
  uniforms: {
    tDiffuse:{value:null}, uTime:{value:0}, uGrain:{value:0.055},
    uVignette:{value:0.62}, uAberration:{value:0.0022},
    uLift:{value:new THREE.Vector3(0.010, 0.020, 0.034)},   // shadows -> teal
    uGain:{value:new THREE.Vector3(1.045, 1.005, 0.960)},   // highlights -> warm
    uSaturation:{value:1.12}, uContrast:{value:1.06},
  },
  vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader:`
    precision highp float;
    varying vec2 vUv; uniform sampler2D tDiffuse;
    uniform float uTime,uGrain,uVignette,uAberration,uSaturation,uContrast;
    uniform vec3 uLift,uGain;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    void main(){
      vec2 uv=vUv; vec2 d=uv-0.5; float r2=dot(d,d);
      // chromatic aberration grows toward frame edge
      float a=uAberration*r2*4.0;
      vec3 col;
      col.r=texture2D(tDiffuse, uv + d*a).r;
      col.g=texture2D(tDiffuse, uv).g;
      col.b=texture2D(tDiffuse, uv - d*a).b;

      // split-tone grade
      col = col*uGain + uLift*(1.0-col);
      // contrast around 0.5
      col = (col-0.5)*uContrast + 0.5;
      // saturation
      float l=dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(vec3(l), col, uSaturation);

      // vignette
      col *= 1.0 - uVignette*smoothstep(0.18, 0.95, r2*1.9);
      // fine grain, animated
      float g=hash(uv*vec2(1920.0,1080.0)+fract(uTime)*97.0)-0.5;
      col += g*uGrain*(1.0-l*0.65);

      gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
    }`,
};

export function buildComposer(renderer, scene, camera, w, h){
  const composer=new EffectComposer(renderer);
  composer.setSize(w,h);
  composer.addPass(new RenderPass(scene,camera));

  const bloom=new UnrealBloomPass(new THREE.Vector2(w,h), 0.62, 0.72, 0.72);
  composer.addPass(bloom);

  const output=new OutputPass();               // ACES filmic + sRGB
  composer.addPass(output);

  const grade=new ShaderPass(GradeShader);
  composer.addPass(grade);

  const smaa=new SMAAPass(w,h);
  composer.addPass(smaa);

  return { composer, bloom, grade, smaa };
}

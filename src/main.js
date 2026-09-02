import * as THREE from 'three';
import { CONFIG } from './core/config.js';
import { Sky } from './render/sky.js';
import { TimeOfDay } from './systems/time.js';
import { City } from './world/city.js';
import { Buildings } from './world/buildings.js';
import { buildComposer } from './render/post.js';
import { NeonRig } from './render/lightrig.js';
import { Streets } from './world/streets.js';
import { Props } from './world/props.js';
import { Water } from './world/water.js';
import { Vegetation } from './world/vegetation.js';
import { Vehicles } from './entities/vehicle.js';
import { Player } from './entities/player.js';
import { Traffic } from './systems/traffic.js';
import { Peds } from './systems/peds.js';
import { GameCamera } from './systems/gamecamera.js';

export class Game {
  constructor(canvas){
    this.canvas=canvas;
    this.clock=new THREE.Clock();
    this.initRenderer();
    this.initScene();
    this.initWorld();
    this.initPost();
    this.exposeHarness();
    this.running=true;
    this.frame=0;
  }

  initRenderer(){
    const r=new THREE.WebGLRenderer({ canvas:this.canvas, antialias:false, powerPreference:'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
    r.setSize(window.innerWidth, window.innerHeight);
    r.shadowMap.enabled=true;
    r.shadowMap.type=THREE.PCFSoftShadowMap;
    r.toneMapping=THREE.NoToneMapping;  // OutputPass owns tonemapping
    this.renderer=r;
  }

  initScene(){
    this.scene=new THREE.Scene();
    this.scene.fog=new THREE.FogExp2(0xb56a5e, 0.0032);
    this.camera=new THREE.PerspectiveCamera(58, window.innerWidth/window.innerHeight, 0.35, 9000);
    this.camera.position.set(60, 34, 140);
    this.camera.lookAt(0, 18, 0);

    const sun=new THREE.DirectionalLight(0xffb066, 2.4);
    sun.castShadow=true;
    sun.shadow.mapSize.set(CONFIG.render.shadowMap, CONFIG.render.shadowMap);
    const S=320;
    sun.shadow.camera.left=-S; sun.shadow.camera.right=S;
    sun.shadow.camera.top=S; sun.shadow.camera.bottom=-S;
    sun.shadow.camera.near=1; sun.shadow.camera.far=1200;
    sun.shadow.bias=-0.0006; sun.shadow.normalBias=0.045;
    this.scene.add(sun); this.scene.add(sun.target);

    const hemi=new THREE.HemisphereLight(0x2b1e5c, 0x241a33, 0.9);
    this.scene.add(hemi);
    this.lights={ sun, hemi };
  }

  initWorld(){
    this.sky=new Sky(this.scene);
    this.time=new TimeOfDay(this.scene, this.sky, this.lights, CONFIG.time.start, CONFIG.time.speed);
    this.city=new City(this.scene, CONFIG.seed).build();
    this.buildings=new Buildings(this.scene, this.city, CONFIG.seed+7).build();

    // Shared context handed to every subsystem. Modules must not reach past this.
    const ctx=this.ctx={
      city:this.city, time:this.time, sky:this.sky, lights:this.lights,
      camera:this.camera, renderer:this.renderer, scene:this.scene,
      seed:CONFIG.seed, THREE,
      get hour(){ return this.time.hour; },
      get nightFactor(){ return this.time.nightFactor; },
    };
    this.modules=[];
    const add=(M,key)=>{ const m=new M(this.scene, ctx).build(); this[key]=m; ctx[key]=m; this.modules.push(m); return m; };
    add(Streets,'streets');
    add(Water,'water');
    add(Vegetation,'vegetation');
    add(Props,'props');
    add(Vehicles,'vehicles');
    add(Traffic,'traffic');
    add(Peds,'peds');
    add(Player,'player');
    add(GameCamera,'gamecamera');

    // Emissive geometry must actually light the world around it, or neon reads as
    // stickers on a dark wall and unlit props (palms) render as black cutouts.
    this.neon = new NeonRig().discover(this.scene);
    this.neon.patchScene(this.scene);
    ctx.neon = this.neon;
    console.log('[neon rig] emitters discovered:', this.neon.emitters.length);
  }

  initPost(){
    const w=window.innerWidth, h=window.innerHeight;
    const p=buildComposer(this.renderer, this.scene, this.camera, w, h);
    this.composer=p.composer; this.bloom=p.bloom; this.grade=p.grade;
  }

  resize(){
    const w=window.innerWidth,h=window.innerHeight;
    this.camera.aspect=w/h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w,h); this.composer.setSize(w,h);
  }

  // Deterministic API used by the screenshot harness / critic agents.
  exposeHarness(){
    window.GAME=this;
    window.HARNESS={
      setTime:(h)=>{ this.time.set(h); },
      setCamera:(px,py,pz, tx,ty,tz, fov)=>{
        this.camera.position.set(px,py,pz);
        this.camera.lookAt(tx,ty,tz);
        if(fov){ this.camera.fov=fov; this.camera.updateProjectionMatrix(); }
      },
      // render N frames synchronously so canvas is guaranteed settled
      settle:(n=3)=>{ for(let i=0;i<n;i++) this.renderOnce(0.016); },
      stats:()=>({
        frame:this.frame,
        calls:this.renderer.info.render.calls,
        tris:this.renderer.info.render.triangles,
        hour:this.time.hour,
        buildings:this.city.buildings.length,
        neonEmitters:this.neon?this.neon.emitters.length:0,
        neonActive:this.neon?this.neon.activeCount:0,
      }),
      ready:true,
    };
  }

  renderOnce(dt){
    this.sky.update(dt);
    this.time.update(dt);
    // keep sun shadow frustum centred on camera
    const c=this.camera.position;
    this.lights.sun.target.position.set(c.x, 0, c.z);
    this.lights.sun.target.updateMatrixWorld();
    this.lights.sun.position.copy(this.lights.sun.target.position)
      .add(this.sky.uniforms.uSunDir.value.clone().multiplyScalar(420));
    if(this.neon){
      this.camera.updateMatrixWorld();
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      this.neon.update(this.camera, 0.55 + 0.45*this.time.nightFactor);
    }
    for(const m of this.modules){ try{ m.update(dt, this.ctx); }catch(e){ if(!m.__err){ m.__err=1; console.error('module update failed:', m.constructor.name, e.message); } } }
    if(this.grade) this.grade.uniforms.uTime.value += dt;
    this.composer.render();
    this.frame++;
  }

  start(){
    const loop=()=>{
      if(!this.running) return;
      requestAnimationFrame(loop);
      this.renderOnce(Math.min(this.clock.getDelta(), 0.05));
    };
    loop();
  }
}

const canvas=document.getElementById('c');
const game=new Game(canvas);
game.start();
window.addEventListener('resize', ()=>game.resize());
document.title='ready';

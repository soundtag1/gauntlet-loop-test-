import * as THREE from 'three';
// STUB — owned by the LOCAL AI DIALOGUE specialist. See docs/LOCAL_AI_SETUP.md.
// Voice conversation with NPCs via local Whisper + local LLM + fish.audio TTS,
// with a constrained tool surface so NPCs can act on the game.
// Contract: constructor(scene, ctx), .build() returns this, .update(dt, ctx).
// Must expose: .configured (bool), .talkTo(npc), .isTalking, .settingsOpen
export class Dialogue {
  constructor(scene, ctx){ this.scene=scene; this.ctx=ctx; this.configured=false; this.isTalking=false; }
  build(){ return this; }
  update(dt, ctx){}
}

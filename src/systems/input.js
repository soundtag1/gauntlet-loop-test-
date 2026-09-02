// src/systems/input.js
// Unified input: keyboard + mouse (pointer lock) AND Gamepad API.
// Everything downstream reads ONE normalised state object and never asks which
// device produced it. No per-frame allocation: every vector here is reused.

const DEAD = 0.22;          // radial stick deadzone
const TRIGGER_ON = 0.45;    // analog trigger threshold for sprint

// Buttons (standard mapping): 0=A/cross 1=B/circle 2=X/square 3=Y/triangle
// 4=LB 5=RB 6=LT 7=RT 8=back 9=start 10=L3 11=R3 12..15=dpad
const PAD = { jump:0, interact:2, sprintAlt:10, menu:9, run:7, runAlt:5,
              up:12, down:13, left:14, right:15 };

export class Input {
  constructor(opts = {}){
    this.canvas = opts.canvas || document.getElementById('c') || document.body;
    this.sensitivity = opts.sensitivity ?? 1.0;

    // ---- the one normalised state object ----------------------------------
    this.state = {
      move:      { x:0, y:0 },   // x = strafe right, y = forward. |v| <= 1
      moveMag:   0,
      lookDelta: { x:0, y:0 },   // mouse pixels since last consumeLook()
      lookRate:  { x:0, y:0 },   // stick units -1..1, apply * dt yourself
      sprint:    false,
      jumpHeld:  false,
      device:    'keyboard',     // 'keyboard' | 'gamepad' — last one that moved
      padConnected: false,
      padId:     '',
      pointerLocked: false,
      enabled:   true,           // false while a menu owns input
    };
    // one-frame edges, refreshed by poll()
    this.pressed = { jump:false, interact:false, menu:false };

    this._keys = Object.create(null);
    this._queue = { jump:0, interact:0, menu:0 };
    this._padPrev = new Uint8Array(20);
    this._padIndex = -1;
    this._dragLook = false;
    this._lastPollFrame = -1;
    this._padPollFail = 0;

    this._bind();
  }

  // ---------------------------------------------------------------- binding
  _bind(){
    const typing = (e)=>{
      const a = document.activeElement;
      return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    };

    this._onKeyDown = (e)=>{
      if(typing(e)){
        if(e.code === 'Escape') this._queue.menu++;
        return;
      }
      if(this._keys[e.code]) { if(e.code==='Space') e.preventDefault(); return; }
      this._keys[e.code] = 1;
      this.state.device = 'keyboard';
      switch(e.code){
        case 'Space':   this._queue.jump++;     e.preventDefault(); break;
        case 'KeyE':    this._queue.interact++; break;
        case 'Escape':  this._queue.menu++;     break;
        case 'Tab':     e.preventDefault();     break;
      }
    };
    this._onKeyUp   = (e)=>{ this._keys[e.code] = 0; };
    this._onBlur    = ()=>{ for(const k in this._keys) this._keys[k] = 0; this._dragLook = false; };

    this._onMouseMove = (e)=>{
      if(!this.state.enabled) return;
      if(!this.state.pointerLocked && !this._dragLook) return;
      const dx = e.movementX || 0, dy = e.movementY || 0;
      this.state.lookDelta.x += dx;
      this.state.lookDelta.y += dy;
      if(dx || dy) this.state.device = 'keyboard';
    };
    this._onMouseDown = (e)=>{ if(e.button === 0 && !this.state.pointerLocked) this._dragLook = true; };
    this._onMouseUp   = (e)=>{ if(e.button === 0) this._dragLook = false; };
    this._onLockChange= ()=>{ this.state.pointerLocked = (document.pointerLockElement === this.canvas); };
    this._onLockError = ()=>{ this.state.pointerLocked = false; };

    this._onPadConnect = (e)=>{
      this._padIndex = e.gamepad.index;
      this.state.padConnected = true;
      this.state.padId = e.gamepad.id || 'gamepad';
      this._padPrev.fill(0);
      console.log('[input] gamepad connected:', this.state.padId);
    };
    this._onPadDisconnect = (e)=>{
      if(e.gamepad && e.gamepad.index === this._padIndex){
        this._padIndex = -1;
        this.state.padConnected = false;
        this.state.padId = '';
        this.state.lookRate.x = this.state.lookRate.y = 0;
        this.state.device = 'keyboard';
        console.log('[input] gamepad disconnected');
      }
    };

    addEventListener('keydown', this._onKeyDown, { passive:false });
    addEventListener('keyup', this._onKeyUp);
    addEventListener('blur', this._onBlur);
    addEventListener('mousemove', this._onMouseMove);
    addEventListener('mousedown', this._onMouseDown);
    addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('pointerlockerror', this._onLockError);
    addEventListener('gamepadconnected', this._onPadConnect);
    addEventListener('gamepaddisconnected', this._onPadDisconnect);
  }

  dispose(){
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    removeEventListener('blur', this._onBlur);
    removeEventListener('mousemove', this._onMouseMove);
    removeEventListener('mousedown', this._onMouseDown);
    removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('pointerlockerror', this._onLockError);
    removeEventListener('gamepadconnected', this._onPadConnect);
    removeEventListener('gamepaddisconnected', this._onPadDisconnect);
  }

  // ----------------------------------------------------------------- helpers
  requestPointerLock(){
    if(!this.canvas || !this.canvas.requestPointerLock) return;
    try { this.canvas.requestPointerLock(); } catch(e){ /* user gesture missing */ }
  }
  exitPointerLock(){ try { document.exitPointerLock && document.exitPointerLock(); } catch(e){} }

  // Consume accumulated mouse movement. Returns the same object every call.
  consumeLook(out){
    const d = this.state.lookDelta;
    out.x = d.x; out.y = d.y;
    d.x = 0; d.y = 0;
    return out;
  }

  key(code){ return !!this._keys[code]; }

  // ------------------------------------------------------------------- poll
  // Call once per frame, before anything reads .state. Safe to call twice:
  // a repeat call with the same frame id is ignored so edges survive the frame.
  poll(dt, frame){
    if(frame !== undefined && frame === this._lastPollFrame) return this.state;
    this._lastPollFrame = frame ?? (this._lastPollFrame + 1);

    const s = this.state;
    let mx = 0, my = 0, sprint = false, jumpHeld = false;

    if(s.enabled){
      // keyboard
      if(this.key('KeyW') || this.key('ArrowUp'))    my += 1;
      if(this.key('KeyS') || this.key('ArrowDown'))  my -= 1;
      if(this.key('KeyD') || this.key('ArrowRight')) mx += 1;
      if(this.key('KeyA') || this.key('ArrowLeft'))  mx -= 1;
      const km = Math.hypot(mx, my);
      if(km > 1){ mx /= km; my /= km; }
      sprint   = this.key('ShiftLeft') || this.key('ShiftRight');
      jumpHeld = this.key('Space');
    }

    // gamepad
    s.lookRate.x = 0; s.lookRate.y = 0;
    const gp = this._readPad();
    if(gp){
      const ax = gp.axes;
      const [lx, ly] = deadzone(ax[0] || 0, ax[1] || 0);
      const [rx, ry] = deadzone(ax[2] || 0, ax[3] || 0);
      if(lx || ly){
        // stick wins over keyboard when actually pushed
        if(Math.hypot(lx, ly) > Math.hypot(mx, my)){ mx = lx; my = -ly; s.device = 'gamepad'; }
      }
      if(rx || ry){
        // squared response curve: precise near centre, fast at the edge
        s.lookRate.x = rx * Math.abs(rx);
        s.lookRate.y = ry * Math.abs(ry);
        s.device = 'gamepad';
      }
      const b = gp.buttons;
      const val = (i)=> b[i] ? (b[i].value !== undefined ? b[i].value : (b[i].pressed ? 1 : 0)) : 0;
      const down = (i)=> b[i] ? (b[i].pressed || val(i) > TRIGGER_ON) : false;
      if(val(PAD.run) > TRIGGER_ON || down(PAD.runAlt) || down(PAD.sprintAlt)) sprint = true;
      if(down(PAD.jump)) jumpHeld = true;
      // dpad also drives movement so a stickless pad still walks
      if(!mx && !my){
        if(down(PAD.up)) my = 1; else if(down(PAD.down)) my = -1;
        if(down(PAD.left)) mx = -1; else if(down(PAD.right)) mx = 1;
      }
      // rising edges
      this._edge(b, PAD.jump,     'jump');
      this._edge(b, PAD.interact, 'interact');
      this._edge(b, PAD.menu,     'menu');
    }

    if(!s.enabled){ mx = 0; my = 0; sprint = false; jumpHeld = false; s.lookRate.x = s.lookRate.y = 0; }

    s.move.x = mx; s.move.y = my;
    s.moveMag = Math.min(1, Math.hypot(mx, my));
    s.sprint = sprint;
    s.jumpHeld = jumpHeld;

    this.pressed.jump     = this._queue.jump > 0;
    this.pressed.interact = this._queue.interact > 0;
    this.pressed.menu     = this._queue.menu > 0;
    this._queue.jump = this._queue.interact = this._queue.menu = 0;
    return s;
  }

  _edge(buttons, index, name){
    const b = buttons[index];
    const now = b && (b.pressed || (b.value || 0) > TRIGGER_ON) ? 1 : 0;
    if(now && !this._padPrev[index]) this._queue[name]++;
    this._padPrev[index] = now;
  }

  _readPad(){
    if(this._padPollFail > 4) return null;
    let pads;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; }
    catch(e){ this._padPollFail++; return null; }
    if(!pads) { this._padPollFail++; return null; }
    let gp = this._padIndex >= 0 ? pads[this._padIndex] : null;
    if(!gp || !gp.connected){
      gp = null;
      for(let i = 0; i < pads.length; i++){
        if(pads[i] && pads[i].connected){ gp = pads[i]; this._padIndex = i; break; }
      }
      if(!gp){
        if(this.state.padConnected){
          this.state.padConnected = false; this.state.padId = ''; this._padIndex = -1;
        }
        return null;
      }
    }
    if(!this.state.padConnected){
      this.state.padConnected = true;
      this.state.padId = gp.id || 'gamepad';
      this._padPrev.fill(0);
    }
    return gp;
  }
}

function deadzone(x, y){
  const m = Math.hypot(x, y);
  if(m < DEAD) return ZERO2;
  const clamped = Math.min(m, 1);
  const s = ((clamped - DEAD) / (1 - DEAD)) / m;
  OUT2[0] = x * s; OUT2[1] = y * s;
  return OUT2;
}
const ZERO2 = [0, 0];
const OUT2 = [0, 0];

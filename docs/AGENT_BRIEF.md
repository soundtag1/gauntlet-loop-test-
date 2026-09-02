# Builder brief — NEON COAST

Repo: /home/user/gauntlet-loop-test-   Branch: claude/gta-vi-open-world-game-2n21fe
Engine: three.js 0.180 (WebGL2), plain ES modules, no bundler. Import via importmap:
  `import * as THREE from 'three'` and `three/addons/...` both work.

## Non-negotiables
- Read `docs/ART_DIRECTION.md` FIRST. It is the grading rubric. Hit it literally.
- EDIT ONLY THE FILES YOU ARE ASSIGNED. Others are owned by parallel agents.
  Do NOT edit src/main.js — module slots are already wired for you.
- Your module contract: `export class X { constructor(scene, ctx){} build(){return this} update(dt,ctx){} }`
  `ctx` gives you: city, time, sky, lights, camera, renderer, scene, seed, THREE,
  ctx.hour, ctx.nightFactor, plus sibling modules by name once built.
- `ctx.city` API: `.blockCentre(bx,bz)`, `.isRoad(x,z)`, `.stride`, `.span`, `.n`,
  `.bs` (block size 60), `.rw` (road width 16), `.buildings` (array of
  `{x,z,w,d,h,district,colour,neon,seed}`), `.blockCentre` returns Vector3.
  Roads are centred on block boundaries at world coords `-span/2 + i*stride`.
- Determinism: use `Rand` from `src/core/rng.js` seeded off `ctx.seed`. No Math.random().

## Performance budget — THIS IS SOFTWARE RENDERING (SwiftShader, no GPU, 4 cores)
- Draw calls are the scarce resource. USE InstancedMesh / merged geometry.
- Hard budget for your module: <= 40 draw calls, <= 250k triangles.
- No per-frame allocation in update(). Reuse vectors/matrices.
- Real lights are expensive: at most 2-3 additional shadow-casting lights TOTAL
  across the project. Fake light pools with emissive geometry + baked gradients.

## How to see your work (MANDATORY — never trust reasoning over pixels)
A static server must be running on 5177:
    (setsid python3 -m http.server 5177 --bind 127.0.0.1 >/tmp/hs.log 2>&1 </dev/null &)
Then:
    node tools/capture.mjs <yourlabel>
Writes PNGs to `shots/<yourlabel>/`. READ THEM with the Read tool and look at them.
`shots/<label>/manifest.json` lists any page errors — a blank/black frame usually
means a JS exception, check it.

Iterate: build -> capture -> LOOK -> fix. Do not stop after one pass. Do not
report success without having looked at a screenshot showing your feature.

## Definition of done
Your feature is visibly present and correct in at least 3 of the 8 standard shots,
adds no page errors, and does not regress framerate past the budget above.

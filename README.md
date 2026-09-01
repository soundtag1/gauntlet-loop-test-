# NEON COAST
A browser-based 3D open-world crime-action game (three.js / WebGL2).

Runs entirely in the browser. Built and visually verified headlessly via
Playwright + SwiftShader, so every change is judged on real rendered frames.

## Run
    npm install
    python3 -m http.server 5177     # or any static server
    # open http://127.0.0.1:5177/index.html

## Visual verification
    node tools/capture.mjs <label>   # renders shots/<label>/*.png

`docs/ART_DIRECTION.md` is the art-direction rubric all visual work is graded against.

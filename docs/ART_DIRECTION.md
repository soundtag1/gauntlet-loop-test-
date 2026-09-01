# Art Direction Rubric — "NEON COAST"
Ground truth for all critic agents. Grade against THIS, concretely, per-axis, 0-10.
Target register: sun-bleached neo-Miami crime drama. Humid, saturated, cinematic.

## 1. Palette
- Day: bleached cyan sky (#7ec8e3 zenith -> #f4e2c4 horizon), sand/coral/stucco
  buildings (#e8c9a8, #d97f6a, #f2e6d8), deep teal ocean (#0f5f6b).
- Dusk (hero hour): sky #ff9a56 -> #a8447e -> #2b1e5c vertical ramp. Sun disc warm
  #ffd9a0. Long shadows, rim-lit silhouettes.
- Night: near-black indigo #0a0d1f base, lit ONLY by neon (#ff2f8e magenta,
  #23e0d5 cyan, #ffcf3f amber) + headlights + windows. Never flat grey.
- Rule: no unlit surface may be pure grey. Everything takes a color cast from
  sky or nearest emissive.

## 2. Lighting
- One dominant warm key (sun), cool sky fill (hemisphere), NOT ambient-flat.
- Neon signs must be emissive AND cast colored light onto nearby geometry/road.
- Wet asphalt: vertical streaked reflections of neon, not mirror-sharp.
- Contact darkening (AO) where geometry meets ground. No floating objects.
- Night streetlights: warm pools with visible falloff and light cones in haze.

## 3. Atmosphere
- Exponential height fog, color-matched to sky, denser at horizon.
- Visible aerial perspective: far buildings desaturate + shift toward sky color.
- Dusk/night: volumetric-feeling god rays or haze around strong lights.
- Humidity haze near ground at dawn/dusk.

## 4. Composition & Silhouette
- Skyline must have varied heights — no uniform box grid. Landmark towers.
- Foreground/midground/background separation clearly readable.
- Palms breaking up straight architectural lines.

## 5. Materials
- No flat untextured surfaces. Every material needs roughness variation.
- Glass: reflective, tinted, varying per-window (some lit, some dark, some blinds).
- Road: cracks, lane paint wear, puddles, tire polish in wheel tracks.
- Building facades: window grids, balconies, AC units, ledges, signage — depth.

## 6. Post-processing
- Bloom on emissives ONLY (thresholded), soft and wide, not a global haze.
- Filmic tonemap (ACES), never Linear/clipped.
- Subtle chromatic aberration at frame edges. Vignette. Fine film grain.
- Color grade: lifted shadows toward teal, highlights toward warm.

## 7. Motion & Life
- Nothing static: cars move, peds walk, palms sway, water animates, signs flicker.
- Vehicle has visible suspension/body roll. Camera has weight and lag.

## AUTO-FAIL conditions (critic must reject outright)
- Flat grey untextured boxes; uniform building heights; visible hard fog cutoff;
  clipped white blowouts; z-fighting; objects floating above ground; empty
  streets with zero motion; ambient-only lighting with no directional shadow.

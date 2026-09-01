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

---

# ADDENDUM — general rendering & cinematography criteria
Derived from general real-time-rendering and cinematography principles (model
knowledge, not fetched sources — this machine has no web egress).
These are gradeable REQUIREMENTS, not aspirations. Critics: score each.

## A1. Low sun is the hero condition
The look is at its WEAKEST with a high midday sun and at its strongest when the
sun is low and raking. Consequence for us:
- Dusk/dawn/golden-hour shots carry the art direction; they must be the best frames.
- A high-sun frame must still avoid flat, shadowless lighting — keep long-ish
  shadows, contact darkening and colour separation between sky-fill and sun-key.

## A2. Light must be SHAPED, not just emitted
Raking light through and around geometry is the signature. Required:
- Long directional shadows that describe the geometry casting them.
- Patterned/broken light: shadow grids from railings, louvres, palm fronds and
  building edges falling across roads, walls and vehicles. Flat unbroken pools of
  light are a fail.
- Light filtering through cloud; shafts and haze around strong sources at dusk/night.
- Lens flare / veiling glare when the sun is near frame — restrained, anamorphic-ish,
  never a stock starburst sprite.

## A3. Global illumination behaviour (fake it, but fake it correctly)
We cannot ray-trace. We MUST still satisfy the observable consequences:
- Surfaces in shadow are lit by BOUNCED colour from nearby lit surfaces and the sky,
  never by flat grey ambient.
- Warm sunlit ground should throw warmth onto the undersides and lower storeys of
  nearby geometry; neon should tint the walls, road and objects around it.
- Ambient occlusion in every crevice, under every vehicle, at every ground contact.

## A4. Wet-surface and reflection behaviour
- Puddles and wet asphalt carry vertical, stretched, broken reflections of lights
  above them. Sharp mirror reflections are wrong; so is no reflection at all.
- Reflection intensity must rise at night and after rain.

## A5. Volumetric atmosphere
- Visible fog/haze with depth: not a flat colour wash but density that reveals
  light shafts and separates depth planes.
- Aerial perspective: distant geometry desaturates and shifts to sky colour.

## A6. Density and life
- The frame should feel POPULATED: crowds, traffic, signage, clutter, wear.
- Emptiness reads as unfinished regardless of lighting quality.

## A7. Materials
- Skin/soft materials need subsurface-like softness, not plastic shading.
- Every surface needs microvariation; uniform albedo is a fail.

## GRADING NOTE FOR CRITICS
Our hard ceiling: software rasterisation, no GPU. Do NOT grade on raw polygon
count, texture resolution, or effects we cannot afford. DO grade without mercy on
art direction, colour, composition, light shaping, atmosphere and density — these
are free of hardware and are where the frame is won or lost.

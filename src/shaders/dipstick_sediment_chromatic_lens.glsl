#version 300 es
/*
 * NEPHRO-SPECTRA — dipstick sediment chromatic lens
 * WebGL2 fragment shader rendered inside the Chrono Dipstick Scanner viewport.
 *
 * Models the optical path of a bench-top reflectance reader over a wetted
 * reagent pad: a chlorophyll/methylene-blue style chromatic dispersion lens
 * (per-channel refractive index offsets), suspended sediment that settles with
 * a Stokes-law velocity, and a ΔE00-driven tint that shifts the pad's rendered
 * colour toward the nearest calibrated swatch.
 *
 * Uniform contract (set from dipstickScanner composable):
 *   u_time             seconds
 *   u_resolution       drawing buffer
 *   u_padTint          linear RGB of the matched swatch (0..1)
 *   u_deltaE           CIEDE2000 ΔE00 of the best match, 0..25
 *   u_sedimentDensity  0..1 turbidity / cast load
 *   u_dispersion       lens dispersion strength 0..1
 *   u_speckle          0..1 intact-RBC speckle amount
 *   u_readProgress     chrono window progress 0..1
 *   u_lensCenter       normalised lens centre (0..1)
 *   u_lensRadius       lens radius in normalised units
 *   u_theme            0 obsidian, 1 daylight, 2 colorimeter, 3 eco-glass
 */

precision highp float;

out vec4 fragColor;

uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_padTint;
uniform float u_deltaE;
uniform float u_sedimentDensity;
uniform float u_dispersion;
uniform float u_speckle;
uniform float u_readProgress;
uniform vec2 u_lensCenter;
uniform float u_lensRadius;
uniform int u_theme;

/* ------------------------------------------------------------------ noise */

float hash21(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * valueNoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

/* ------------------------------------------------------- chromatic dispersion */

// Sample the pad field with a per-channel radial offset — the classic
// meniscus-lens chromatic aberration seen when a wet pad is photographed.
vec3 dispersedSample(vec2 uv, float strength) {
  vec2 d = uv - u_lensCenter;
  float r = length(d);
  vec2 dir = r > 1e-4 ? d / r : vec2(0.0);

  vec3 acc;
  // Red bends least, blue most — index offsets 0.55 / 0.78 / 1.0
  acc.r = fbm(uv * 5.0 + dir * strength * 0.55 * r * 6.0 + u_time * 0.01);
  acc.g = fbm(uv * 5.0 + dir * strength * 0.78 * r * 6.0 + u_time * 0.012);
  acc.b = fbm(uv * 5.0 + dir * strength * 1.00 * r * 6.0 + u_time * 0.015);
  return acc;
}

/* ------------------------------------------------------------- sediment */

// Stokes settling: fine particles fall slowly, coarse ones fast. We simulate
// two populations with different y-drift rates and sizes.
float sediment(vec2 uv, float density) {
  if (density < 0.001) return 0.0;
  float acc = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float scale = 26.0 + fl * 17.0;                 // particle count per axis
    float drift = 0.035 + fl * 0.045;               // Stokes velocity, coarse faster
    vec2 p = uv * scale;
    p.y += u_time * drift * scale * 0.02;
    p.x += sin(u_time * 0.35 + fl * 2.1) * 0.6;
    vec2 cell = fract(p) - 0.5;
    float speck = smoothstep(0.42, 0.06, length(cell));
    float presence = step(1.0 - density * (0.85 - fl * 0.16), hash21(floor(p) + fl * 7.7));
    acc += speck * presence * (1.0 - fl * 0.22);
  }
  return clamp(acc, 0.0, 1.4);
}

/* --------------------------------------------------------------- dE00 tint */

// Higher ΔE = stronger deviation from the calibration plate. We concentrate the
// deviation at the pad rim (where reagent wicking is uneven) and leave the
// optical centre faithful to the matched swatch.
vec3 deltaEShift(vec3 tint, float dE, float rim) {
  float k = clamp(dE / 12.0, 0.0, 1.6);
  vec3 shift = vec3(0.28, -0.06, 0.10) * k * rim;   // toward magenta/yellow
  return clamp(tint + shift, 0.0, 1.0);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_resolution;
  vec2 centered = (frag - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  /* ---- probe card backdrop ------------------------------------------- */
  vec3 backdrop;
  if (u_theme == 1) {
    backdrop = vec3(0.925, 0.937, 0.949);
  } else if (u_theme == 2) {
    backdrop = vec3(0.024, 0.027, 0.043);
  } else if (u_theme == 3) {
    backdrop = vec3(0.039, 0.071, 0.063);
  } else {
    backdrop = vec3(0.024, 0.047, 0.071);
  }
  float bench = fbm(uv * 3.4 + vec2(0.0, u_time * 0.008));
  backdrop = mix(backdrop, backdrop * 1.9 + 0.02, bench * 0.4);

  /* ---- refraction lens ------------------------------------------------ */
  float r = length(uv - u_lensCenter);
  float lensMask = smoothstep(u_lensRadius, u_lensRadius * 0.55, r);
  float dispersion = clamp(u_dispersion, 0.0, 1.0) * 0.055;

  vec3 tex = dispersedSample(uv, dispersion + 0.02);
  // Meniscus: slight magnification toward the centre of the lens
  vec2 bend = (uv - u_lensCenter) * 0.10 * lensMask;
  vec3 lensed = dispersedSample(uv - bend, dispersion);

  /* ---- reagent pad hatch --------------------------------------------- */
  // 10 discrete pad wells across the lens, matching the physical strip geometry.
  float pads = 10.0;
  float slot = floor((uv.y - (u_lensCenter.y - u_lensRadius)) / (2.0 * u_lensRadius) * pads);
  float inStrip = step(0.0, slot) * step(slot, pads - 1.0);
  float gap = smoothstep(0.0, 0.06, fract((uv.y - (u_lensCenter.y - u_lensRadius)) / (2.0 * u_lensRadius) * pads));
  float padMask = lensMask * inStrip * gap;

  // Native swatch colour, rim-deviated by ΔE00
  float rim = smoothstep(u_lensRadius * 0.35, u_lensRadius, r);
  vec3 padCol = deltaEShift(u_padTint, u_deltaE, rim);
  padCol *= 0.86 + 0.28 * lensed.g;

  /* ---- sediment on the wet pad --------------------------------------- */
  float sed = sediment(uv, u_sedimentDensity);
  vec3 sedCol = mix(vec3(0.62, 0.52, 0.34), vec3(0.83, 0.79, 0.62), tex.r);
  padCol = mix(padCol, sedCol, clamp(sed * u_sedimentDensity * 0.65, 0.0, 0.82));

  /* ---- intact-RBC speckle ------------------------------------------- */
  if (u_speckle > 0.01) {
    vec2 sp = uv * 86.0;
    vec2 sc = fract(sp) - 0.5;
    float dot0 = smoothstep(0.19, 0.02, length(sc));
    float gate = step(1.0 - u_speckle * 0.72, hash21(floor(sp)));
    float shimmer = 0.75 + 0.25 * sin(u_time * 3.1 + hash21(floor(sp)) * 6.28);
    padCol = mix(padCol, vec3(0.52, 0.14, 0.18), dot0 * gate * shimmer * 0.85);
  }

  /* ---- read-window scan bar ----------------------------------------- */
  float scanY = mix(u_lensCenter.y - u_lensRadius, u_lensCenter.y + u_lensRadius, u_readProgress);
  float scan = smoothstep(0.012, 0.0, abs(uv.y - scanY)) * lensMask;
  float scanGlow = smoothstep(0.055, 0.0, abs(uv.y - scanY)) * lensMask * 0.35;

  /* ---- compose -------------------------------------------------------- */
  vec3 col = backdrop;
  col = mix(col, padCol, padMask);

  // Lens ring + specular arc (glass over the wet pad)
  float ring = smoothstep(u_lensRadius, u_lensRadius - 0.006, r) - smoothstep(u_lensRadius - 0.006, u_lensRadius - 0.014, r);
  float spec = smoothstep(0.55, 0.0, abs(centered.x - centered.y * 0.8 - 0.12)) * lensMask;
  col += vec3(0.42, 0.72, 0.82) * ring * 0.22;
  col += vec3(0.86, 0.94, 1.0) * spec * 0.16;

  // Chromatic fringe at the lens boundary — the signature aberration
  float fringe = smoothstep(u_lensRadius, u_lensRadius - 0.02, r) * (1.0 - smoothstep(u_lensRadius - 0.02, u_lensRadius - 0.05, r));
  col.r += fringe * dispersion * 34.0;
  col.b += fringe * dispersion * 20.0;

  col += vec3(0.48, 0.92, 0.98) * scan * 0.55;
  col += vec3(0.24, 0.62, 0.82) * scanGlow;

  // Environmental vignette + dither
  float vig = smoothstep(1.35, 0.25, length(centered));
  col *= mix(0.74, 1.0, vig);
  col += (hash21(frag + fract(u_time)) - 0.5) / 255.0;

  fragColor = vec4(max(col, 0.0), 1.0);
}

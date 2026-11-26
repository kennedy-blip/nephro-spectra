#version 300 es
/*
 * NEPHRO-SPECTRA — renal fluid underlay
 * WebGL2 full-screen fragment shader driving the ambient laboratory backdrop.
 *
 * Physics motif: a laminar uroflow jet entering a settling basin. Domain-warped
 * fBm displaces a set of concentric pressure rings whose spacing is set by the
 * live flow rate; the supersaturation index injects crystalline caustic sparkle;
 * hydration (urine specific gravity) controls turbidity and refractive index.
 *
 * Uniform contract (all set from RenalFluidUnderlay.vue):
 *   u_time                seconds since mount
 *   u_flowRateMlSec       instantaneous Q(t), 0..40
 *   u_supersaturationIndex AP(CaOx) or dominant index, 0..8
 *   u_hydrationUsg        urine specific gravity, 1.000..1.030
 *   u_pointer             normalised pointer, -1..1
 *   u_gyroTilt            device tilt in radians
 *   u_resolution          drawing buffer size in px
 *   u_theme               0 obsidian, 1 daylight, 2 colorimeter, 3 eco-glass
 *   u_intensity           master amplitude 0..1
 *   u_seed                per-session decorrelation
 */

precision highp float;

out vec4 fragColor;

uniform float u_time;
uniform float u_flowRateMlSec;
uniform float u_supersaturationIndex;
uniform float u_hydrationUsg;
uniform vec2 u_pointer;
uniform vec2 u_gyroTilt;
uniform vec2 u_resolution;
uniform int u_theme;
uniform float u_intensity;
uniform float u_seed;

/* ---------------------------------------------------------------- palette */

struct Palette {
  vec3 base;
  vec3 mid;
  vec3 accent;
  vec3 highlight;
};

Palette palette(int theme) {
  if (theme == 1) {
    // Daylight Clinical Frost — cool porcelain with a mint clinical accent
    return Palette(vec3(0.945, 0.962, 0.980), vec3(0.863, 0.902, 0.941), vec3(0.369, 0.706, 0.639), vec3(0.129, 0.353, 0.529));
  }
  if (theme == 2) {
    // Chromatic D65 Colorimeter Darkroom — near-black with chromatic fringing
    return Palette(vec3(0.031, 0.035, 0.055), vec3(0.078, 0.086, 0.125), vec3(0.478, 0.373, 0.910), vec3(0.922, 0.443, 0.396));
  }
  if (theme == 3) {
    // Eco-Glass — desaturated mineral green with warm glass glare
    return Palette(vec3(0.043, 0.078, 0.070), vec3(0.086, 0.149, 0.129), vec3(0.478, 0.784, 0.616), vec3(0.902, 0.808, 0.545));
  }
  // Obsidian Renal Lab (default)
  return Palette(vec3(0.016, 0.035, 0.055), vec3(0.043, 0.086, 0.125), vec3(0.290, 0.663, 0.851), vec3(0.545, 0.949, 0.855));
}

/* ------------------------------------------------------------------ noise */

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    v += amp * valueNoise(p);
    p = rot * p * 2.02;
    amp *= 0.5;
  }
  return v;
}

/* --------------------------------------------------------- flow advection */

// Stream-function style advection: velocity field from the curl of an fBm
// potential, magnitude scaled by the live flow rate.
vec2 flowField(vec2 uv, float t, float rate) {
  float warp = fbm(uv * 2.4 + vec2(t * 0.06, -t * 0.045));
  vec2 potential = vec2(
    fbm(uv * 1.9 + vec2(0.0, t * 0.09) + warp),
    fbm(uv * 1.9 + vec2(3.7, -t * 0.07) + warp)
  );
  vec2 curl = vec2(
    potential.y - potential.x,
    potential.x - potential.y
  );
  vec2 jet = vec2(0.0, -1.0) * smoothstep(0.0, 18.0, rate);
  return (curl * 0.55 + jet * 0.65) * (0.35 + min(rate, 30.0) / 30.0);
}

/* ------------------------------------------------------------ pressure rings */

// Concentric streamwise rings whose spatial frequency encodes Q. Higher flow
// compresses the ring spacing, exactly as a real jet's vortex shedding does.
float pressureRings(vec2 uv, float rate, float t) {
  vec2 p = uv - vec2(0.5, 0.86);      // virtual jet origin above frame
  float r = length(p * vec2(1.0, 1.35));
  float spacing = mix(26.0, 9.0, clamp(rate / 32.0, 0.0, 1.0));
  float phase = r * spacing - t * (1.1 + rate * 0.09);
  float rings = sin(phase) * 0.5 + 0.5;
  rings = pow(rings, 3.2);
  float decay = exp(-r * 2.1);
  return rings * decay;
}

/* -------------------------------------------------------- crystalline caustic */

// Supersaturation drives faceted caustics — read as suspended crystal nuclei.
float crystalCaustic(vec2 uv, float ss, float t) {
  if (ss < 0.001) return 0.0;
  vec2 g = fract(uv * vec2(14.0, 9.0) + vec2(t * 0.03, t * 0.02)) - 0.5;
  float hex = abs(g.x) + abs(g.y) * 0.86;
  float facet = smoothstep(0.46, 0.18, hex);
  float twinkle = 0.55 + 0.45 * sin(t * 2.4 + hash21(floor(uv * vec2(14.0, 9.0))) * 6.283);
  return facet * twinkle * clamp(ss / 3.0, 0.0, 1.6);
}

/* ------------------------------------------------------------- main */

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / u_resolution;
  vec2 centered = (fragCoord - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  float t = u_time + u_seed * 37.0;
  float rate = max(u_flowRateMlSec, 0.0);
  float ss = max(u_supersaturationIndex, 0.0);

  // Turbidity rises with specific gravity; hydration ~1.000 → crystal clear.
  float turbidity = clamp((u_hydrationUsg - 1.000) / 0.030, 0.0, 1.0);

  // Pointer parallax + gyro tilt, both normalised and clamped.
  vec2 par = u_pointer * 0.045 + clamp(u_gyroTilt, vec2(-0.9), vec2(0.9)) * 0.075;

  Palette pal = palette(u_theme);

  // Domain warp
  vec2 wuv = uv + par;
  vec2 vel = flowField(wuv * 1.4, t, rate);
  vec2 warped = wuv + vel * 0.12;

  float base = fbm(warped * 3.1 + vec2(t * 0.02, -t * 0.015));
  float detail = fbm(warped * 7.5 - vel * 0.6 + vec2(0.0, t * 0.05));
  float field = mix(base, detail, 0.42);

  // Radial vignette keeps text legible over the centre of each panel.
  float vig = smoothstep(1.25, 0.12, length(centered * vec2(0.92, 0.78)));
  vec3 col = mix(pal.base, pal.mid, field * 0.85);

  // Jet column: a vertical soft beam, width modulated by flow
  float beamWidth = mix(0.055, 0.135, clamp(rate / 30.0, 0.0, 1.0));
  float beam = smoothstep(beamWidth, 0.0, abs(centered.x + par.x * 0.6));
  beam *= smoothstep(-0.95, 0.35, centered.y) * (0.25 + clamp(rate / 26.0, 0.0, 0.9));
  col += pal.accent * beam * 0.36;

  // Pressure rings ride the jet
  float rings = pressureRings(wuv, rate, t);
  col += pal.highlight * rings * (0.16 + 0.30 * clamp(rate / 22.0, 0.0, 1.0));

  // Crystalline caustics from supersaturation
  float caustic = crystalCaustic(warped, ss, t);
  col += pal.highlight * caustic * 0.22;

  // Turbidity wash — sediment suspension scatters toward the mid tone
  col = mix(col, pal.mid * 1.18, turbidity * 0.34);
  float sediment = fbm(warped * 22.0 + vec2(t * 0.11, 0.0));
  col += pal.mid * smoothstep(0.62, 0.95, sediment) * turbidity * 0.35;

  // Glare sweep driven by the pointer x — glass reflection across the basin
  float sweep = smoothstep(0.42, 0.0, abs(centered.x - par.x * 2.6 - 0.12));
  col += pal.highlight * sweep * 0.045 * (0.4 + 0.6 * vig);

  // Film-grain-free subtle dither to stop banding on large gradients
  float dither = (hash21(fragCoord + fract(t)) - 0.5) / 255.0;
  col += dither;

  col *= mix(0.72, 1.0, vig);
  col = pow(max(col, 0.0), vec3(0.95));
  col *= u_intensity;

  fragColor = vec4(col, 1.0);
}

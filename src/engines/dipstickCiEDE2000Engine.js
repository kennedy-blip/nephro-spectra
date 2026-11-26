/**
 * NEPHRO-SPECTRA — Module 2 engine
 * Pure ES2024 chrono-gated 10-pad urine dipstick colorimetry:
 *   sRGB → linear → Bradford D65 adaptation → CIELAB (D65)
 *   CIEDE2000 ΔE00 nearest-pad classification against calibrated reagent swatches
 *   Chrono read-window gating (30/40/45/60/120 s per analyte)
 *   Specific-gravity +0.005 alkaline correction and blood speckle variance test
 *
 * No TypeScript. Pure functions, fully deterministic.
 */

export const D65 = { X: 95.047, Y: 100.0, Z: 108.883 }

/* --------------------------------------------------------------------------
 * 1. Colour space conversions
 * ------------------------------------------------------------------------ */

export function sRGBToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function linearToSRGB(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

export function rgbToXyz({ r, g, b }, primaries = 'sRGB') {
  const R = sRGBToLinear(r)
  const G = sRGBToLinear(g)
  const B = sRGBToLinear(b)
  let X, Y, Z
  if (primaries === 'display-p3') {
    X = 0.4866 * R + 0.2657 * G + 0.1982 * B
    Y = 0.229 * R + 0.6917 * G + 0.0793 * B
    Z = 0.0 * R + 0.0451 * G + 1.0439 * B
  } else {
    X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B
    Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B
    Z = 0.0193339 * R + 0.119192 * G + 0.9503041 * B
  }
  return { X: X * 100, Y: Y * 100, Z: Z * 100 }
}

export function xyzToRgb({ X, Y, Z }) {
  const x = X / 100
  const y = Y / 100
  const z = Z / 100
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z
  return { r: linearToSRGB(R), g: linearToSRGB(G), b: linearToSRGB(B) }
}

const LAB_F = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)

export function xyzToLab({ X, Y, Z }, white = D65) {
  const fx = LAB_F(X / white.X)
  const fy = LAB_F(Y / white.Y)
  const fz = LAB_F(Z / white.Z)
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  }
}

export function labToXyz({ L, a, b }, white = D65) {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const inv = (f) => {
    const f3 = f ** 3
    return f3 > 216 / 24389 ? f3 : (108 / 841) * (f - 4 / 29)
  }
  return { X: inv(fx) * white.X, Y: inv(fy) * white.Y, Z: inv(fz) * white.Z }
}

export function rgbToLab(rgb, primaries = 'sRGB') {
  return xyzToLab(rgbToXyz(rgb, primaries))
}

export function labToHex(lab) {
  const { r, g, b } = xyzToRgb(labToXyz(lab))
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/* --------------------------------------------------------------------------
 * 2. Bradford chromatic adaptation
 * ------------------------------------------------------------------------ */

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296]
]
const BRADFORD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867]
]

function mul3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
  ]
}

/** Common illuminant white points (XYZ, Y=100). */
export const ILLUMINANTS = {
  D65: [95.047, 100.0, 108.883],
  D50: [96.422, 100.0, 82.521],
  A: [109.85, 100.0, 35.585],
  F2: [99.187, 100.0, 67.395],
  F11: [103.863, 100.0, 65.607],
  TL84: [103.0, 100.0, 67.0]
}

/** Bradford-adapt XYZ from a source illuminant to the D65 reference. */
export function bradfordAdaptToD65(xyz, sourceKey = 'A') {
  const src = ILLUMINANTS[sourceKey] || ILLUMINANTS.A
  if (sourceKey === 'D65') return { ...xyz }
  const srcCone = mul3(BRADFORD, src)
  const dstCone = mul3(BRADFORD, ILLUMINANTS.D65)
  const scale = [dstCone[0] / srcCone[0], dstCone[1] / srcCone[1], dstCone[2] / srcCone[2]]
  const v = [xyz.X, xyz.Y, xyz.Z]
  const cone = mul3(BRADFORD, v)
  const adapted = [cone[0] * scale[0], cone[1] * scale[1], cone[2] * scale[2]]
  const out = mul3(BRADFORD_INV, adapted)
  return { X: out[0], Y: out[1], Z: out[2] }
}

/** Full capture pipeline: raw sRGB sample + illuminant + exposure → D65 Lab. */
export function captureToLab(rgb, { illuminant = 'D65', exposureGain = 1, whiteBalance = [1, 1, 1], primaries = 'sRGB' } = {}) {
  const balanced = {
    r: Math.min(255, rgb.r * whiteBalance[0] * exposureGain),
    g: Math.min(255, rgb.g * whiteBalance[1] * exposureGain),
    b: Math.min(255, rgb.b * whiteBalance[2] * exposureGain)
  }
  const xyz = rgbToXyz(balanced, primaries)
  const adapted = bradfordAdaptToD65(xyz, illuminant)
  return { lab: xyzToLab(adapted), balanced }
}

/* --------------------------------------------------------------------------
 * 3. CIEDE2000
 * ------------------------------------------------------------------------ */

const DEG = Math.PI / 180

export function ciede2000(lab1, lab2, kL = 1, kC = 1, kH = 1) {
  const { L: L1, a: a1, b: b1 } = lab1
  const { L: L2, a: a2, b: b2 } = lab2

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const Cbar7 = Cbar ** 7
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h1p = hueAngle(b1, a1p)
  const h2p = hueAngle(b2, a2p)

  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * DEG) / 2)

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2
  let hbarp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2
    else hbarp = (h1p + h2p - 360) / 2
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG)

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const Cbarp7 = Cbarp ** 7
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7))
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2)
  const SC = 1 + 0.045 * Cbarp
  const SH = 1 + 0.015 * Cbarp * T
  const RT = -Math.sin(2 * dTheta * DEG) * RC

  const termL = dLp / (kL * SL)
  const termC = dCp / (kC * SC)
  const termH = dHp / (kH * SH)
  const dE = Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + RT * termC * termH)
  return {
    dE: Math.round(dE * 1000) / 1000,
    dL: Math.round(dLp * 1000) / 1000,
    dC: Math.round(dCp * 1000) / 1000,
    dH: Math.round(dHp * 1000) / 1000,
    RT: Math.round(RT * 1000) / 1000
  }
}

function hueAngle(b, ap) {
  if (b === 0 && ap === 0) return 0
  const h = (Math.atan2(b, ap) / DEG + 360) % 360
  return h
}

/** ΔE00 perceptibility verdict bands (ASTM D2244 / clinical reagent convention). */
export function deltaVerdict(dE) {
  if (dE < 1.0) return { band: 'imperceptible', text: 'Imperceptible — matches calibration plate' }
  if (dE < 2.3) return { band: 'subtle', text: 'Just-noticeable difference (JND 2.3)' }
  if (dE < 5.0) return { band: 'perceptible', text: 'Perceptible but acceptable reagent drift' }
  if (dE < 12.0) return { band: 'readable', text: 'Clearly different — clinically readable colour shift' }
  return { band: 'saturated', text: 'Large shift — strong analyte reaction' }
}

/* --------------------------------------------------------------------------
 * 4. 10-pad reagent calibration (Roche Combur-10 / Siemens Multistix analogue)
 * ------------------------------------------------------------------------ */

const swatch = (hex, label, quant) => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return { hex, label, quant, lab: rgbToLab({ r, g, b }) }
}

export const DIPSTICK_PADS = [
  {
    key: 'leukocytes',
    name: 'Leukocytes',
    analyte: 'Leukocyte esterase',
    unit: 'WBC/µL',
    windowSec: 120,
    kineticDrift: 0.00035,
    swatches: [
      swatch('#fbf7ef', 'Negative', 0),
      swatch('#f4e6da', 'Trace (~15)', 15),
      swatch('#ecd0cf', 'Small (~70)', 70),
      swatch('#dfb3c4', 'Moderate (~125)', 125),
      swatch('#a86a9b', 'Large (~500)', 500)
    ],
    range: [0, 500]
  },
  {
    key: 'nitrite',
    name: 'Nitrite',
    analyte: 'Nitrite (Griess)',
    unit: 'µmol/L',
    windowSec: 60,
    kineticDrift: 0.00022,
    swatches: [
      swatch('#fdf8f1', 'Negative', 0),
      swatch('#f6e7e2', 'Trace', 5),
      swatch('#eec9cf', 'Positive (~13)', 13),
      swatch('#dda4b6', 'Positive (~33)', 33)
    ],
    range: [0, 33]
  },
  {
    key: 'urobilinogen',
    name: 'Urobilinogen',
    analyte: 'Urobilinogen',
    unit: 'µmol/L',
    windowSec: 60,
    kineticDrift: 0.00018,
    swatches: [
      swatch('#f8f0dc', 'Normal (3.2)', 3.2),
      swatch('#f4dfb3', '16', 16),
      swatch('#efc886', '33', 33),
      swatch('#e5a95c', '66', 66),
      swatch('#c98337', '131', 131)
    ],
    range: [3.2, 131]
  },
  {
    key: 'protein',
    name: 'Protein',
    analyte: 'Albumin (protein error of indicators)',
    unit: 'mg/dL',
    windowSec: 60,
    kineticDrift: 0.00048,
    swatches: [
      swatch('#f8f7c6', 'Negative', 0),
      swatch('#f0eeb0', 'Trace (15)', 15),
      swatch('#dfe59b', '30', 30),
      swatch('#b6d18a', '100', 100),
      swatch('#85ab6b', '300', 300),
      swatch('#5e8a55', '2000', 2000)
    ],
    range: [0, 2000]
  },
  {
    key: 'ph',
    name: 'pH',
    analyte: 'pH (dual-indicator)',
    unit: 'pH units',
    windowSec: 45,
    kineticDrift: 0.00012,
    swatches: [
      swatch('#f2c46a', '5.0', 5.0),
      swatch('#efc077', '6.0', 6.0),
      swatch('#ebbb84', '6.5', 6.5),
      swatch('#e5b992', '7.0', 7.0),
      swatch('#c9c79a', '7.5', 7.5),
      swatch('#9cc0b5', '8.0', 8.0),
      swatch('#7db2c6', '9.0', 9.0)
    ],
    range: [5, 9]
  },
  {
    key: 'blood',
    name: 'Blood',
    analyte: 'Haemoglobin peroxidase (pseudoperoxidase)',
    unit: 'RBC/µL',
    windowSec: 60,
    kineticDrift: 0.0006,
    swatches: [
      swatch('#f7ef8f', 'Negative', 0),
      swatch('#f0dd7a', 'Trace (~5)', 5),
      swatch('#dfc063', 'Small (~25)', 25),
      swatch('#b79a4f', 'Moderate (~80)', 80),
      swatch('#6f7a45', 'Large (~200)', 200)
    ],
    range: [0, 200]
  },
  {
    key: 'specificGravity',
    name: 'Specific Gravity',
    analyte: 'SG (polyelectrolyte pKa shift)',
    unit: '',
    windowSec: 45,
    kineticDrift: 0.00008,
    swatches: [
      swatch('#8fbf72', '1.000', 1.0),
      swatch('#a3c47a', '1.005', 1.005),
      swatch('#b3c07f', '1.010', 1.01),
      swatch('#c0b97f', '1.015', 1.015),
      swatch('#b9a473', '1.020', 1.02),
      swatch('#a68f60', '1.025', 1.025),
      swatch('#8d7a50', '1.030', 1.03)
    ],
    range: [1.0, 1.03]
  },
  {
    key: 'ketones',
    name: 'Ketones',
    analyte: 'Acetoacetate (Legal nitroprusside)',
    unit: 'mmol/L',
    windowSec: 40,
    kineticDrift: 0.0003,
    swatches: [
      swatch('#f6f1e1', 'Negative', 0),
      swatch('#efd9d2', 'Trace (0.5)', 0.5),
      swatch('#dcb6ba', '1.5', 1.5),
      swatch('#b7879b', '4.0', 4.0),
      swatch('#7f5577', '8.0+', 8)
    ],
    range: [0, 8]
  },
  {
    key: 'bilirubin',
    name: 'Bilirubin',
    analyte: 'Bilirubin (diazo coupling)',
    unit: 'mg/dL',
    windowSec: 30,
    kineticDrift: 0.00072,
    swatches: [
      swatch('#f9edc5', 'Negative', 0),
      swatch('#f2dfae', 'Small (1)', 1),
      swatch('#e6cb96', 'Moderate (2)', 2),
      swatch('#d5b07d', 'Large (4)', 4),
      swatch('#bd9068', 'Large+ (8)', 8)
    ],
    range: [0, 8]
  },
  {
    key: 'glucose',
    name: 'Glucose',
    analyte: 'Glucose (glucose oxidase peroxidase)',
    unit: 'mg/dL',
    windowSec: 30,
    kineticDrift: 0.00042,
    swatches: [
      swatch('#7fb6a6', 'Negative', 0),
      swatch('#94bda4', 'Trace (100)', 100),
      swatch('#a8c39c', '250', 250),
      swatch('#b8c58a', '500', 500),
      swatch('#c9bf6f', '1000', 1000),
      swatch('#d5b256', '2000+', 2000)
    ],
    range: [0, 2000]
  }
]

/* --------------------------------------------------------------------------
 * 5. Classification
 * ------------------------------------------------------------------------ */

/** Nearest-swatch match by CIEDE2000 for a single pad. */
export function classifyPad(pad, sampleLab) {
  let best = null
  for (const sw of pad.swatches) {
    const { dE, dL, dC, dH, RT } = ciede2000(sampleLab, sw.lab)
    if (!best || dE < best.dE) best = { dE, dL, dC, dH, RT, swatch: sw }
  }
  // Linear interpolation between the two nearest swatches for a continuous read.
  const ordered = pad.swatches
    .map((sw) => ({ sw, dE: ciede2000(sampleLab, sw.lab).dE }))
    .sort((a, b) => a.dE - b.dE)
  const s1 = ordered[0]
  const s2 = ordered[1] || ordered[0]
  const w1 = 1 / Math.max(0.05, s1.dE)
  const w2 = 1 / Math.max(0.05, s2.dE)
  const interpolated = (s1.sw.quant * w1 + s2.sw.quant * w2) / (w1 + w2)
  return {
    key: pad.key,
    name: pad.name,
    analyte: pad.analyte,
    unit: pad.unit,
    matched: best.swatch.label,
    quant: pad.key === 'specificGravity' ? round(interpolated, 4) : round(interpolated, pad.key === 'ph' ? 2 : 1),
    quantExact: interpolated,
    dE: best.dE,
    dE00: best.dE,
    dL: best.dL,
    dC: best.dC,
    dH: best.dH,
    RT: best.RT,
    verdict: deltaVerdict(best.dE),
    confidence: round(Math.max(0.05, Math.min(0.995, 1 - best.dE / 22)), 3),
    swatchHex: best.swatch.hex,
    severity: padSeverity(pad.key, interpolated)
  }
}

function padSeverity(key, q) {
  switch (key) {
    case 'leukocytes': return q >= 125 ? 'high' : q >= 15 ? 'moderate' : 'normal'
    case 'nitrite': return q >= 5 ? 'high' : 'normal'
    case 'protein': return q >= 300 ? 'high' : q >= 30 ? 'moderate' : 'normal'
    case 'blood': return q >= 80 ? 'high' : q >= 5 ? 'moderate' : 'normal'
    case 'glucose': return q >= 250 ? 'high' : q >= 100 ? 'moderate' : 'normal'
    case 'ketones': return q >= 4 ? 'high' : q >= 0.5 ? 'moderate' : 'normal'
    case 'bilirubin': return q >= 2 ? 'high' : q >= 1 ? 'moderate' : 'normal'
    case 'urobilinogen': return q >= 33 ? 'high' : q >= 16 ? 'moderate' : 'normal'
    case 'ph': return q >= 7.5 || q <= 5.2 ? 'moderate' : 'normal'
    case 'specificGravity': return q >= 1.025 ? 'moderate' : q <= 1.003 ? 'moderate' : 'normal'
    default: return 'normal'
  }
}

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round((v + Number.EPSILON) * f) / f
}

/* --------------------------------------------------------------------------
 * 6. Chrono read-window gate
 * ------------------------------------------------------------------------ */

/**
 * Kinetic reagent development model: reflectance saturates as t → ∞ but most
 * pads over-develop after their window (false positives). We model the
 * observed ΔE as a saturating exponential plus a linear over-development term.
 */
export function kineticDeltaE(pad, elapsedSec) {
  const t = Math.max(0, elapsedSec)
  const tau = pad.windowSec / 2.4
  const rise = 1 - Math.exp(-t / tau)
  const over = Math.max(0, t - pad.windowSec) * pad.kineticDrift * 60
  return Math.min(1.6, rise + over)
}

/**
 * Gate a reading: only values inside ±12% of the declared window are accepted.
 * Returns a status the UI renders as a countdown ring.
 */
export function chronoGate(pad, elapsedSec) {
  const w = pad.windowSec
  const lo = w * 0.88
  const hi = w * 1.12
  let state = 'developing'
  if (elapsedSec >= lo && elapsedSec <= hi) state = 'optimal'
  else if (elapsedSec > hi) state = 'overdeveloped'
  else if (elapsedSec < lo * 0.45) state = 'too-early'
  const progress = Math.max(0, Math.min(1, elapsedSec / w))
  const remaining = Math.max(0, w - elapsedSec)
  return {
    state,
    progress: round(progress, 3),
    remaining: round(remaining, 1),
    elapsed: round(elapsedSec, 1),
    windowSec: w,
    kineticFactor: round(kineticDeltaE(pad, elapsedSec), 3),
    message:
      state === 'optimal'
        ? `Optimal read window (${w}s ±12%) — reflectance plateau reached.`
        : state === 'developing'
          ? `Developing — hold ${remaining.toFixed(0)}s before the optical read.`
          : state === 'too-early'
            ? 'Read far too early — colour has not developed; result is invalid.'
            : `Over-developed by ${(elapsedSec - w).toFixed(1)}s — false-positive risk on this pad.`
  }
}

/**
 * Apply the chrono factor to a raw ΔE-inferred quantity: early reads are
 * proportionally suppressed toward the negative swatch.
 */
export function applyChronoCorrection(pad, quant, elapsedSec) {
  const gate = chronoGate(pad, elapsedSec)
  const k = gate.kineticFactor
  if (gate.state === 'optimal') return { quant, gate, corrected: false }
  const negative = pad.swatches[0].quant
  const corrected = negative + (quant - negative) * Math.max(0.15, Math.min(1.4, k))
  return {
    quant: pad.key === 'specificGravity' ? round(corrected, 4) : round(corrected, pad.key === 'ph' ? 2 : 1),
    gate,
    corrected: true
  }
}

/* --------------------------------------------------------------------------
 * 7. Specific-gravity + alkaline correction
 * ------------------------------------------------------------------------ */

/**
 * SG pad is a polyelectrolyte whose pKa shifts with pH. Above pH 7.0 the
 * apparent SG reads low; the published correction adds +0.005 per pH unit
 * above 7.0 (capped at +0.015), with an interference flag at pH ≥ 8.0.
 */
export function correctSpecificGravity(rawSg, ph) {
  const excess = Math.max(0, ph - 7.0)
  const correction = Math.min(0.015, excess * 0.005)
  const corrected = rawSg + correction
  return {
    raw: round(rawSg, 4),
    corrected: round(corrected, 4),
    correction: round(correction, 4),
    ph: round(ph, 2),
    alkalineInterference: ph >= 8.0,
    note:
      ph >= 8.0
        ? 'pH ≥ 8.0 — SG pad reads falsely low (polyelectrolyte pKa shift); +0.005/ΔpH correction applied, result still qualified.'
        : correction > 0
          ? `Alkaline correction applied: +${correction.toFixed(3)} for pH ${ph.toFixed(1)}.`
          : 'Neutral/acidic urine — no SG correction required.'
  }
}

/** Estimated osmolality from corrected SG (Dorizzi / linear approximation). */
export function osmolalityFromSg(sg) {
  return round((sg - 1.0) * 36000 + 40, 1)
}

/* --------------------------------------------------------------------------
 * 8. Blood pad: speckle vs homogeneous
 * ------------------------------------------------------------------------ */

/**
 * Intact RBCs produce heterogeneous ("speckled") reflectance with high spatial
 * variance; lysed haemoglobin gives a homogeneous wash. We compute the
 * coefficient of variation across the pad's sampled pixels.
 */
export function bloodSpeckleAnalysis(pixels, pad, sampleLab) {
  if (!pixels || pixels.length < 4) {
    return { cv: 0, classification: 'insufficient-data', intactRbc: false, note: 'Pad sampling failed — cannot discriminate intact vs lysed haemoglobin.' }
  }
  const labs = pixels.map((p) => captureToLab(p).lab)
  const Ls = labs.map((l) => l.L)
  const meanL = Ls.reduce((a, b) => a + b, 0) / Ls.length
  const variance = Ls.reduce((a, b) => a + (b - meanL) ** 2, 0) / Ls.length
  const cv = meanL > 0 ? Math.sqrt(variance) / meanL : 0
  const dEs = labs.map((l) => ciede2000(l, sampleLab).dE)
  const meanDE = dEs.reduce((a, b) => a + b, 0) / dEs.length
  const spatialDE = Math.sqrt(dEs.reduce((a, b) => a + (b - meanDE) ** 2, 0) / dEs.length)

  let classification = 'homogeneous-lysed'
  if (cv > 0.045 || spatialDE > 2.2) classification = 'speckled-intact-rbc'
  if (cv > 0.11) classification = 'gross-speckled-haematuria'

  return {
    cv: round(cv, 4),
    spatialDeltaE: round(spatialDE, 3),
    classification,
    intactRbc: classification !== 'homogeneous-lysed',
    note:
      classification === 'homogeneous-lysed'
        ? 'Homogeneous colour wash (CV < 4.5%) — lysed haemoglobin / haemoglobinuria pattern; no discrete erythrocytes.'
        : classification === 'speckled-intact-rbc'
          ? 'Speckled reflectance (CV ≥ 4.5%) — intact erythrocytes, consistent with glomerular or urological haematuria.'
          : 'Gross speckling (CV > 11%) — dense intact haematuria; correlate with phase-contrast microscopy for dysmorphic RBCs.'
  }
}

/* --------------------------------------------------------------------------
 * 9. Strip presets
 * ------------------------------------------------------------------------ */

export const STRIP_PRESETS = [
  {
    id: 'combina10',
    name: '10-Pad Standard Urinalysis',
    pads: ['leukocytes', 'nitrite', 'urobilinogen', 'protein', 'ph', 'blood', 'specificGravity', 'ketones', 'bilirubin', 'glucose'],
    tint: '#7fb6a6'
  },
  {
    id: 'nephrouro',
    name: 'Nephro-Urology Focused Panel',
    pads: ['protein', 'blood', 'leukocytes', 'nitrite', 'specificGravity', 'ph', 'glucose', 'ketones'],
    tint: '#a86a9b'
  },
  {
    id: 'stone-metabolic',
    name: 'Stone Metabolic Screen',
    pads: ['ph', 'specificGravity', 'blood', 'protein', 'nitrite', 'leukocytes', 'ketones'],
    tint: '#c98337'
  },
  {
    id: 'diabetic-renal',
    name: 'Diabetic Renal Surveillance',
    pads: ['glucose', 'ketones', 'protein', 'specificGravity', 'ph', 'leukocytes', 'blood'],
    tint: '#b6d18a'
  },
  {
    id: 'hepatobiliary',
    name: 'Hepatobiliary / Pre-Renal',
    pads: ['bilirubin', 'urobilinogen', 'protein', 'specificGravity', 'ph', 'blood'],
    tint: '#e6cb96'
  }
]

/** Reproducible 1-Tap synthetic pad reflectance for a named clinical scenario. */
export const DIPSTICK_SCENARIOS = [
  {
    id: 'uti',
    name: 'Acute Uncomplicated UTI',
    description: 'Leucocyte esterase large, nitrite positive, pH 8.0 alkaline, SG falsely low.',
    values: { leukocytes: 500, nitrite: 13, urobilinogen: 3.2, protein: 30, ph: 8.0, blood: 25, specificGravity: 1.012, ketones: 0, bilirubin: 0, glucose: 0 }
  },
  {
    id: 'nephrotic',
    name: 'Nephrotic-Range Proteinuria',
    description: 'Protein 300–2000 mg/dL, hyaline casts, SG 1.028 concentrated.',
    values: { leukocytes: 15, nitrite: 0, urobilinogen: 3.2, protein: 2000, ph: 6.0, blood: 5, specificGravity: 1.028, ketones: 0, bilirubin: 0, glucose: 0 }
  },
  {
    id: 'haematuria',
    name: 'Macroscopic Haematuria (Intact RBC)',
    description: 'Blood large with speckled reflectance, protein trace, otherwise bland.',
    values: { leukocytes: 15, nitrite: 0, urobilinogen: 3.2, protein: 15, ph: 6.0, blood: 200, specificGravity: 1.018, ketones: 0, bilirubin: 0, glucose: 0 }
  },
  {
    id: 'dka',
    name: 'Diabetic Ketoacidosis',
    description: 'Glucose 2000+, ketones 8+, pH 5.0 acidic, SG 1.030 — classic DKA triad.',
    values: { leukocytes: 0, nitrite: 0, urobilinogen: 3.2, protein: 30, ph: 5.0, blood: 0, specificGravity: 1.030, ketones: 8, bilirubin: 0, glucose: 2000 }
  },
  {
    id: 'cholestasis',
    name: 'Obstructive Cholestasis',
    description: 'Bilirubin 8 mg/dL, urobilinogen absent, dark amber urine.',
    values: { leukocytes: 0, nitrite: 0, urobilinogen: 3.2, protein: 0, ph: 6.5, blood: 0, specificGravity: 1.022, ketones: 0, bilirubin: 8, glucose: 0 }
  },
  {
    id: 'clean',
    name: 'Normal Clean-Catch Specimen',
    description: 'All pads negative, SG 1.018, pH 6.0 — reference calibration scenario.',
    values: { leukocytes: 0, nitrite: 0, urobilinogen: 3.2, protein: 0, ph: 6.0, blood: 0, specificGravity: 1.018, ketones: 0, bilirubin: 0, glucose: 0 }
  }
]

/** Map a scenario value to an sRGB pixel by inverse-interpolating its swatch ladder. */
export function scenarioValueToRgb(key, value, seed = 1) {
  const pad = DIPSTICK_PADS.find((p) => p.key === key)
  if (!pad) return { r: 250, g: 250, b: 250 }
  const sw = pad.swatches
  let lo = sw[0]
  let hi = sw[sw.length - 1]
  for (let i = 0; i < sw.length - 1; i++) {
    if (value >= sw[i].quant && value <= sw[i + 1].quant) {
      lo = sw[i]
      hi = sw[i + 1]
      break
    }
  }
  const span = hi.quant - lo.quant || 1
  const t = Math.max(0, Math.min(1, (value - lo.quant) / span))
  const mix = (a, b) => Math.round(a + (b - a) * t)
  const l1 = lo.lab
  const l2 = hi.lab
  const lab = { L: l1.L + (l2.L - l1.L) * t, a: l1.a + (l2.a - l1.a) * t, b: l1.b + (l2.b - l1.b) * t }
  const rgb = xyzToRgb(labToXyz(lab))
  // deterministic per-pad noise so the speckle analyser has real variance
  const j = ((seed * 9301 + 49297) % 233280) / 233280 - 0.5
  return {
    r: Math.max(0, Math.min(255, rgb.r + j * 3.2)),
    g: Math.max(0, Math.min(255, rgb.g + j * 3.0)),
    b: Math.max(0, Math.min(255, rgb.b + j * 2.8))
  }
}

/** Render a scenario into a complete pad-read set at a given elapsed time. */
export function readScenario(scenario, elapsedSec, stripId = 'combina10') {
  const preset = STRIP_PRESETS.find((s) => s.id === stripId) || STRIP_PRESETS[0]
  const reads = {}
  preset.pads.forEach((key, i) => {
    const pad = DIPSTICK_PADS.find((p) => p.key === key)
    const target = scenario.values[key] ?? pad.swatches[0].quant
    const rgb = scenarioValueToRgb(key, target, i + 1)
    const { lab } = captureToLab(rgb)
    const classified = classifyPad(pad, lab)
    const chrono = applyChronoCorrection(pad, classified.quant, elapsedSec)
    reads[key] = { ...classified, quant: chrono.quant, gate: chrono.gate, chronoCorrected: chrono.corrected, rgb }
  })

  const sg = reads.specificGravity
  const ph = reads.ph
  const sgCorrected = sg ? correctSpecificGravity(sg.quantExact, ph ? ph.quant : 7) : null

  // Blood speckle: generate a 12-pixel patch across the pad
  let bloodSpeckle = null
  if (reads.blood) {
    const intensity = scenario.values.blood || 0
    const speckled = intensity >= 80
    const base = scenarioValueToRgb('blood', intensity, 7)
    const pixels = []
    for (let i = 0; i < 14; i++) {
      const s = speckled ? (((i * 37) % 11) / 11 - 0.5) * 26 : (((i * 13) % 5) / 5 - 0.5) * 4
      pixels.push({
        r: Math.max(0, Math.min(255, base.r + s)),
        g: Math.max(0, Math.min(255, base.g + s * 0.9)),
        b: Math.max(0, Math.min(255, base.b + s * 0.7))
      })
    }
    bloodSpeckle = bloodSpeckleAnalysis(pixels, reads.blood, reads.blood.rgb ? captureToLab(reads.blood.rgb).lab : reads.blood.lab)
  }

  const abnormal = Object.values(reads).filter((r) => r.severity !== 'normal')
  return {
    scenario,
    strip: preset,
    elapsed: round(elapsedSec, 1),
    reads,
    sgCorrection: sgCorrected,
    bloodSpeckle,
    abnormalCount: abnormal.length,
    overallSeverity: abnormal.some((a) => a.severity === 'high') ? 'high' : abnormal.length ? 'moderate' : 'normal',
    synthesis: synthesiseUrinalysis(reads, sgCorrected, bloodSpeckle)
  }
}

/** Rule-based clinical synthesis for the report exporter. */
export function synthesiseUrinalysis(reads, sgCorrection, bloodSpeckle) {
  const findings = []
  const push = (text, level = 'info') => findings.push({ text, level })
  if (reads.leukocytes?.quant >= 125 && reads.nitrite?.quant >= 5) push('Leucocyte esterase and nitrite both positive — bacterial urinary tract infection (likelihood ratio ≈ 12).', 'danger')
  else if (reads.leukocytes?.quant >= 15) push('Leucocyte esterase positive without nitrite — sterile pyuria, consider chlamydia, TB or interstitial nephritis.', 'warn')
  if (reads.protein?.quant >= 300) push('Protein ≥300 mg/dL — nephrotic-range proteinuria; quantify with spot protein:creatinine ratio.', 'danger')
  else if (reads.protein?.quant >= 30) push('Protein 30–100 mg/dL — tubular or early glomerular proteinuria; repeat on a first-morning specimen.', 'warn')
  if (reads.blood?.quant >= 80) push('Blood large — macroscopic haematuria; exclude urological malignancy and glomerulonephritis.', 'danger')
  else if (reads.blood?.quant >= 5) push('Blood trace/small — microscopic haematuria; send urine microscopy for RBC morphology.', 'warn')
  if (bloodSpeckle?.intactRbc) push('Speckled blood pad reflectance supports intact erythrocytes rather than haemoglobinuria.', 'info')
  if (reads.glucose?.quant >= 250 && reads.ketones?.quant >= 4) push('Glucose and ketones both strongly positive — ketoacidosis screen warranted (serum β-hydroxybutyrate, VBG).', 'danger')
  else if (reads.glucose?.quant >= 100) push('Glycosuria present without ketosis — correlate with serum glucose and renal threshold (≈180 mg/dL).', 'warn')
  if (reads.bilirubin?.quant >= 2) push('Bilirubin positive with urobilinogen absent — cholestatic pattern; order fractionated bilirubin and hepatobiliary ultrasound.', 'warn')
  if (reads.ph?.quant >= 7.5) push('Alkaline urine (pH ≥7.5) — urease-splitting organisms or distal RTA; struvite stone risk.', 'warn')
  if (reads.ph?.quant <= 5.2) push('Persistently acidic urine — uric acid / cystine stone risk and metabolic acidosis screen.', 'warn')
  if (sgCorrection && sgCorrection.corrected >= 1.025) push(`Concentrated urine (SG ${sgCorrection.corrected.toFixed(3)}) — volume depletion; free-water deficit likely.`, 'warn')
  if (sgCorrection?.alkalineInterference) push('SG pad alkaline interference flagged — do not report the uncorrected SG.', 'info')
  if (!findings.length) push('All ten pads within reference range — no biochemical abnormality detected on this specimen.', 'normal')
  return {
    findings,
    osmolalityEstimate: sgCorrection ? osmolalityFromSg(sgCorrection.corrected) : null,
    summary: findings[0].text
  }
}

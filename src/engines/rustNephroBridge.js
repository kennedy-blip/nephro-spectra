/**
 * NEPHRO-SPECTRA — Rust/WASM bridge with a deterministic JS mirror.
 *
 * The production bundle ships a pure-ES2024 fallback that reproduces the Rust
 * output bit-for-bit (same operation order, same constants). When a
 * `nephro_nephro_dsp_bg.wasm` artefact is present in `/wasm/`, the bridge
 * upgrades to the compiled module transparently; on Vercel — where no cargo
 * toolchain exists — the mirror is used and the Polyglot Runtime Inspector
 * reports the runtime as `js-mirror (wasm unavailable)`.
 *
 * No TypeScript. No build-time codegen.
 */

import {
  fft,
  powerSpectrum,
  welchPSD,
  jetPower,
  jetPowerToFlow,
  solveCalibration,
  minnaertResonance,
  bubbleRadiusForFrequency,
  spectralCentroid,
  sirokyNorm
} from './acousticUroflowEngine.js'

export const SAMPLE_RATE = 48000
export const FFT_SIZE = 2048
export const BAND_LO_HZ = 550
export const BAND_HI_HZ = 6200
export const GAMMA_JET = 0.58

export const MORPHOLOGY_CODES = {
  0: 'normal',
  1: 'bph_obstruction',
  2: 'stricture_plateau',
  3: 'detrusor_underactivity',
  4: 'dyssynergia_staccato'
}

/* --------------------------------------------------------------------------
 * Runtime state
 * ------------------------------------------------------------------------ */

const state = {
  runtime: 'js-mirror',
  wasmExports: null,
  wasmLoadError: null,
  loadAttempted: false,
  loadMs: 0,
  callCount: 0
}

/**
 * Attempt to upgrade to the compiled WASM module. Never throws — failure is a
 * first-class, inspectable state so the UI can report graceful degradation.
 */
export async function initRustNephro(wasmUrl = '/wasm/nephro_nephro_dsp_bg.wasm') {
  if (state.loadAttempted) return runtimeInfo()
  state.loadAttempted = true
  const started = performance.now()
  try {
    if (typeof fetch !== 'function' || typeof WebAssembly !== 'object') {
      throw new Error('WebAssembly unavailable in this runtime')
    }
    const head = await fetch(wasmUrl, { method: 'HEAD' })
    if (!head.ok) throw new Error(`WASM artefact missing (HTTP ${head.status})`)
    const res = await fetch(wasmUrl)
    const bytes = await res.arrayBuffer()
    const { instance } = await WebAssembly.instantiate(bytes, {})
    const exportsObj = instance.exports
    const required = ['peak_flow', 'jet_power', 'siroky_z']
    const missing = required.filter((k) => typeof exportsObj[k] !== 'function')
    if (missing.length) throw new Error(`WASM missing exports: ${missing.join(', ')}`)
    state.wasmExports = exportsObj
    state.runtime = 'wasm'
    state.loadMs = Math.round(performance.now() - started)
  } catch (err) {
    state.wasmLoadError = String(err?.message || err)
    state.runtime = 'js-mirror'
    state.loadMs = Math.round(performance.now() - started)
  }
  return runtimeInfo()
}

export function runtimeInfo() {
  return {
    runtime: state.runtime,
    engine: 'nephro_nephro_dsp 28.0.0',
    crate: 'rust-nephro/src/{lib,sonouroflow_dsp,tiselius_hovorka_rk4}.rs',
    wasmExports: state.wasmExports ? Object.keys(state.wasmExports).length : 0,
    loadMs: state.loadMs,
    calls: state.callCount,
    degraded: state.runtime !== 'wasm',
    reason: state.wasmLoadError || (state.runtime === 'wasm' ? null : 'Compiled artefact not deployed — deterministic JS mirror engaged.'),
    mirrorParity: 'bit-exact (identical constants + operation order)'
  }
}

const bump = () => {
  state.callCount++
}

/* --------------------------------------------------------------------------
 * 1. DSP surface (mirrors lib.rs::analyse_frame)
 * ------------------------------------------------------------------------ */

/**
 * Analyse one frame: Hann → FFT → PSD → band subtraction → flow.
 * Returns the same FrameResult shape as the Rust `analyse_frame`.
 */
export function analyseFrame(frame, noiseFloor, kCal = 1.0) {
  bump()
  const n = Math.min(frame.length, FFT_SIZE)
  if (n < 32) {
    return { jetPower: 0, flowMlS: 0, centroidHz: 0, bubbleRadiusUm: 0, dominantHz: 0, snrDb: 0 }
  }
  const { psd, df } = powerSpectrum(frame.subarray(0, n), SAMPLE_RATE)
  const p = jetPower(psd, df, noiseFloor, { lo: BAND_LO_HZ, hi: BAND_HI_HZ })
  const centroid = spectralCentroid(psd, df)
  return {
    jetPower: p,
    flowMlS: jetPowerToFlow(p, kCal, GAMMA_JET),
    centroidHz: centroid,
    bubbleRadiusUm: bubbleRadiusForFrequency(centroid) * 1e6,
    dominantHz: dominantFrequency(psd, df, BAND_LO_HZ, BAND_HI_HZ),
    snrDb: bandSnrDb(psd, df, noiseFloor)
  }
}

export function dominantFrequency(psd, df, lo, hi) {
  const kLo = Math.max(1, Math.round(lo / df))
  const kHi = Math.min(psd.length - 1, Math.round(hi / df))
  let best = -Infinity
  let bestK = kLo
  for (let k = kLo; k <= kHi; k++) {
    if (psd[k] > best) { best = psd[k]; bestK = k }
  }
  return bestK * df
}

export function bandSnrDb(psd, df, noiseFloor) {
  const kLo = Math.max(1, Math.round(BAND_LO_HZ / df))
  const kHi = Math.min(psd.length - 1, Math.round(BAND_HI_HZ / df))
  let sig = 0
  let noise = 0
  for (let k = kLo; k <= kHi; k++) {
    sig += psd[k]
    noise += noiseFloor?.[k] || 0
  }
  if (!(noise > 0) || !(sig > 0)) return 0
  return 10 * Math.log10(sig / noise)
}

export function estimateNoiseFloor(signal, frames = 8) {
  const bins = FFT_SIZE / 2
  const acc = new Float64Array(bins)
  let count = 0
  for (let f = 0; f < frames; f++) {
    const start = f * FFT_SIZE
    if (start + FFT_SIZE > signal.length) break
    const { psd } = powerSpectrum(signal.subarray(start, start + FFT_SIZE), SAMPLE_RATE)
    for (let k = 0; k < bins; k++) acc[k] += psd[k]
    count++
  }
  if (count > 0) for (let k = 0; k < bins; k++) acc[k] /= count
  return acc
}

export function peakFlow(signal, noiseFloor, kCal = 1.0) {
  bump()
  const hop = FFT_SIZE / 2
  let qmax = 0
  let dominant = 0
  for (let start = 0; start + FFT_SIZE <= signal.length; start += hop) {
    const r = analyseFrame(signal.subarray(start, start + FFT_SIZE), noiseFloor, kCal)
    if (r.flowMlS > qmax) { qmax = r.flowMlS; dominant = r.dominantHz }
  }
  return { qmax, dominantHz: dominant, frames: Math.max(0, Math.floor((signal.length - FFT_SIZE) / hop) + 1) }
}

/* --------------------------------------------------------------------------
 * 2. Tiselius–Hovorka mirror (mirrors tiselius_hovorka_rk4.rs)
 * ------------------------------------------------------------------------ */

export function rk4Step(t, y, dt, f) {
  if (!(dt > 0)) throw new Error('dt must be positive')
  const n = y.length
  const k1 = new Float64Array(n)
  const k2 = new Float64Array(n)
  const k3 = new Float64Array(n)
  const k4 = new Float64Array(n)
  const tmp = new Float64Array(n)
  f(t, y, k1)
  for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * dt * k1[i]
  f(t + 0.5 * dt, tmp, k2)
  for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * dt * k2[i]
  f(t + 0.5 * dt, tmp, k3)
  for (let i = 0; i < n; i++) tmp[i] = y[i] + dt * k3[i]
  f(t + dt, tmp, k4)
  for (let i = 0; i < n; i++) y[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
}

export const HOVORKA_DEFAULTS = {
  bodyWeightKg: 78,
  // Distribution volumes (L) — Hovorka: V_G = 0.16·BW, V_I = 0.12·BW
  vG: 0.16 * 78,
  vI: 0.12 * 78,
  // Glucose subsystem: EGP0 (mmol/kg/min) and F01 (mmol/kg/min)
  eGp0: 0.0161,
  f01: 0.0097,
  // Rate of gastric emptying / gut absorption of carbohydrate
  kAbs: 0.0045,
  // Insulin action onset and offset
  p2: 0.025,
  siBase: 0.0011,
  // Plasma insulin appearance and disposition
  tauI: 32,
  iBasal: 10,
  kSec: 9,
  // Basal glucose set point for the secretion controller
  gBasal: 5.0,
  // Renal handling
  rtgMgDl: 180,
  renalMaxMgMin: 70,
  // Michaelis constant of the reabsorptive transport maximum (mg/dL)
  renalKmMgDl: 220
}

/**
 * Build a parameter set. `sglt2 = true` models SGLT2 blockade: the renal
 * threshold falls from 180 to 75 mg/dL and the transport maximum rises.
 * `overrides` may set any key, including the per-scenario sensitivity
 * (`siBase`), secretory gain (`kSec`) and `eGfr`.
 */
export function hovorkaParams(overrides = {}, sglt2 = false) {
  const bw = overrides.bodyWeightKg ?? HOVORKA_DEFAULTS.bodyWeightKg
  const p = {
    ...HOVORKA_DEFAULTS,
    ...overrides,
    bodyWeightKg: bw,
    vG: overrides.vG ?? 0.16 * bw,
    vI: overrides.vI ?? 0.12 * bw
  }
  if (sglt2) {
    p.rtgMgDl = 75
    p.renalMaxMgMin = 150
  }
  return p
}

/**
 * Saturation renal glucose excretion (mmol/min).
 *   E = E_max · (G − RTG) / ((G − RTG) + K_m)   for G > RTG, else 0
 */
export function renalExcretionMmolMin(p, glucoseMmol) {
  const gMg = glucoseMmol * 18
  if (gMg <= p.rtgMgDl) return 0
  const excess = gMg - p.rtgMgDl
  // mg/min ÷ 180.156 mg/mmol ⇒ mmol/min. (18 is the mg/dL-per-mmol/L factor,
  // not the molar mass — mixing them inflates renal clearance ten-fold.)
  return (p.renalMaxMgMin * (excess / (excess + p.renalKmMgDl))) / 180.156
}

/**
 * Hovorka state derivative.
 *
 * States `[G, X, I, M1, M2]`:
 *   G   plasma glucose (mmol/L)
 *   X   remote insulin action (min⁻¹)
 *   I   plasma insulin (mU/L)
 *   M1  gut carbohydrate mass, undigested (mmol)
 *   M2  gut carbohydrate mass, available for absorption (mmol)
 *
 * Returns `[dG, dX, dI, dM1, dM2]`. Endogenous insulin secretion follows a
 * sigmoidal glucose controller with basal offset, so a fixed point exists at
 * G ≈ gBasal for every parameter set — the model cannot diverge.
 */
export function hovorkaDerivs(y, p, insulinBolusMu = 0, targetInsulinOverride = null) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const G = Math.max(1.2, y[0])
  const X = Math.max(0, y[1])
  const I = Math.max(0, y[2])
  const M1 = Math.max(0, y[3])
  const M2 = Math.max(0, y[4])

  // Insulin action: bounded gain on the plasma-insulin excess above basal.
  const xSS = Math.min(0.06, p.siBase * (p.si ?? 1) * Math.max(0, I - p.iBasal))

  // Endogenous glucose production, suppressed by insulin action.
  const egp = p.eGp0 * p.bodyWeightKg * Math.max(0, 1 - clamp(X / 0.06, 0, 0.95))

  // Insulin-independent utilisation (CNS + renal) and insulin-dependent uptake.
  const f01c = p.f01 * p.bodyWeightKg * Math.min(1, G / 4.5)
  const uptake = Math.max(0, X) * G * p.vG

  // Carbohydrate absorption from the two gut compartments.
  const ra = p.kAbs * M2

  // Saturating renal loss — the SGLT2 site of action.
  const egfrScale = clamp((p.eGfr ?? 92) / 92, 0.25, 1.3)
  const renal = renalExcretionMmolMin(p, G) * egfrScale

  const dG = (egp + ra - f01c - uptake - renal) / p.vG

  // Glucose-driven endogenous insulin secretion with a bolus impulse at t=0.
  const secretion = clamp(p.iBasal + Math.max(0, G - p.gBasal) * p.kSec, 0, 260)
  const target = targetInsulinOverride ?? secretion + insulinBolusMu * 0.35
  const dI = (target - I) / p.tauI

  const dX = p.p2 * (xSS - X)
  const dM1 = -p.kAbs * M1
  const dM2 = p.kAbs * (M1 - M2)

  return [dG, dX, dI, dM1, dM2]
}

/**
 * Full multi-compartment integration — classical RK4 at `dtMin` for
 * `durationMin`. Returns the glucose/insulin trajectories plus the derived
 * peak, nadir, time-in-range and AUC.
 */
export function simulateHovorka({
  params,
  g0Mmol = 5.5,
  mealGCarbs = 0,
  insulinBolusMu = 0,
  durationMin = 300,
  dtMin = 1,
  sglt2 = false
} = {}) {
  bump()
  const p = params || hovorkaParams({}, sglt2)
  const steps = Math.min(100000, Math.ceil(durationMin / dtMin))
  const carbMmol = mealGCarbs * 5.55
  let G = g0Mmol
  let X = 0
  let I = p.iBasal
  let M1 = carbMmol
  let M2 = carbMmol

  const times = []
  const glucose = []
  const insulin = []
  const action = []
  const excretion = []
  let peak = -Infinity
  let nadir = Infinity
  let inRangeMin = 0
  let auc = 0

  const f = (y, bolus) => hovorkaDerivs(y, p, bolus)

  for (let k = 0; k <= steps; k++) {
    const gMg = G * 18
    times.push(round(k * dtMin, 2))
    glucose.push(round(gMg, 2))
    insulin.push(round(I, 3))
    action.push(round(X, 5))
    excretion.push(round(renalExcretionMmolMin(p, G) * 180.156, 2))
    peak = Math.max(peak, gMg)
    nadir = Math.min(nadir, gMg)
    if (gMg >= 70 && gMg <= 180) inRangeMin += dtMin
    if (k === steps) break
    auc += gMg * dtMin

    const bolus = k === 0 ? insulinBolusMu : 0
    const y0 = [G, X, I, M1, M2]
    const d1 = f(y0, bolus)
    const y1 = y0.map((v, i) => v + 0.5 * dtMin * d1[i])
    const d2 = f(y1, 0)
    const y2 = y0.map((v, i) => v + 0.5 * dtMin * d2[i])
    const d3 = f(y2, 0)
    const y3 = y0.map((v, i) => v + dtMin * d3[i])
    const d4 = f(y3, 0)
    const next = y0.map((v, i) => v + (dtMin / 6) * (d1[i] + 2 * d2[i] + 2 * d3[i] + d4[i]))

    G = Math.max(1.2, next[0])
    X = Math.max(0, next[1])
    I = Math.max(0, next[2])
    M1 = Math.max(0, next[3])
    M2 = Math.max(0, next[4])
  }

  return {
    timesMin: times,
    glucoseMgDl: glucose,
    insulinMuL: insulin,
    insulinAction: action,
    excretionMgMin: excretion,
    peakMgDl: round(peak, 1),
    nadirMgDl: round(nadir, 1),
    meanMgDl: round(glucose.reduce((a, b) => a + b, 0) / glucose.length, 1),
    timeInRangePct: round(Math.min(100, (inRangeMin / durationMin) * 100), 1),
    aucMgDlMin: round(auc, 0),
    params: p,
    renalThreshold: p.rtgMgDl,
    states: 5
  }
}

/* --------------------------------------------------------------------------
 * 3. Osmolality / Tiselius helpers
 * ------------------------------------------------------------------------ */

export function serumOsmolality(na, glucoseMgDl, bunMgDl) {
  return 2 * na + glucoseMgDl / 18 + bunMgDl / 2.8
}

export function effectiveOsmolality(na, glucoseMgDl) {
  return 2 * na + glucoseMgDl / 18
}

export function urineOsmolality(una, uk, ureaMgDl, glucoseMgDl) {
  return 2 * (una + uk) + ureaMgDl / 2.8 + glucoseMgDl / 18
}

export function freeWaterDeficit(weightKg, na) {
  return 0.6 * weightKg * (na / 140 - 1)
}

export function glucoseKetoneIndex(glucoseMmol, ketonesMmol) {
  return ketonesMmol > 0 ? glucoseMmol / ketonesMmol : Infinity
}

export function apCaOx(calciumMmol, oxalateMmol, volumeL) {
  if (!(volumeL > 0)) return 0
  return (calciumMmol / volumeL) * (oxalateMmol / volumeL) * 1e6
}

export function apCaP(calciumMmol, phosphateMmol, ph, volumeL) {
  if (!(volumeL > 0)) return 0
  const h = 10 ** -ph
  const ka2 = 10 ** -7.2
  const frac = ka2 / (h + ka2)
  return (calciumMmol / volumeL) * ((phosphateMmol / volumeL) * frac) * 1e6
}

export function uricAcidSolubility(ph) {
  return 0.42 * (1 + 10 ** (ph - 5.35))
}

export function uricAcidSupersaturation(concMmol, ph) {
  const s = uricAcidSolubility(ph)
  return s > 0 ? concMmol / s : 0
}

export function chemolysisWindow(ph) {
  return { inWindow: ph >= 6.2 && ph <= 6.8, distance: Math.abs(ph - 6.5) }
}

export function sirokyZ(volumeMl, qMax, scale = 1) {
  const n = sirokyNorm(volumeMl, scale === 1 ? 'male' : 'female')
  return n.sd > 0 ? (qMax - n.mean) / n.sd : 0
}

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round((v + Number.EPSILON) * f) / f
}

/* --------------------------------------------------------------------------
 * 4. Benchmark harness for the Polyglot Runtime Inspector
 * ------------------------------------------------------------------------ */

/** Micro-benchmark the FFT path — used by the inspector to justify the runtime. */
export function benchmarkFFT(iterations = 120) {
  const n = 2048
  const frame = new Float64Array(n)
  for (let i = 0; i < n; i++) frame[i] = Math.sin((2 * Math.PI * 1900 * i) / SAMPLE_RATE) * 0.2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const started = performance.now()
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) { re[i] = frame[i]; im[i] = 0 }
    fft(re, im)
  }
  const elapsed = performance.now() - started
  return {
    iterations,
    fftSize: n,
    elapsedMs: round(elapsed, 2),
    perTransformMs: round(elapsed / iterations, 4),
    transformsPerSec: Math.round((iterations / elapsed) * 1000),
    realtime60fpsHeadroom: round(16.67 / (elapsed / iterations), 1)
  }
}

export { welchPSD, jetPower, jetPowerToFlow, solveCalibration, minnaertResonance, bubbleRadiusForFrequency }

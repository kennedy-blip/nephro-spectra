/**
 * NEPHRO-SPECTRA — Module 1 engine
 * Pure ES2024 acoustic sonouroflowmetry DSP: radix-2 FFT, Welch PSD, spectral
 * subtraction of the pre-void ambient noise floor, band-limited jet power
 * integration (550–6200 Hz), non-linear acoustic→volumetric transfer function,
 * Siroky / Liverpool nomograms, 5-pattern morphology classifier and IPSS.
 *
 * No TypeScript. No external dependencies. Mirrors rust-nephro/src/sonouroflow_dsp.rs.
 */

export const FLOW_BAND = { lo: 550, hi: 6200 }
export const GAMMA_JET = 0.58 // non-linear kinetic-to-acoustic power scaling
/**
 * Default calibration constant for Q = k · P^γ when P is measured in Pa²/Hz·Hz
 * from a Hann/Welch PSD. Calibrated so the built-in jet synthesiser reproduces
 * its declared Qmax (see `calibrateFromRecording`); a real capture re-derives it
 * against a known voided volume.
 */
export const DEFAULT_K_CAL = 1350

/* --------------------------------------------------------------------------
 * 1. FFT / PSD primitives
 * ------------------------------------------------------------------------ */

/** In-place iterative radix-2 Cooley–Tukey FFT on Float64Array (re/im). */
export function fft(re, im) {
  const n = re.length
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two')

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** Hann window of length n. */
export function hann(n) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** One-sided power spectral density of a real frame (Hann-windowed, normalised). */
export function powerSpectrum(frame, sampleRate) {
  const n = frame.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const w = hann(n)
  let sumW2 = 0
  for (let i = 0; i < n; i++) {
    re[i] = frame[i] * w[i]
    sumW2 += w[i] * w[i]
  }
  fft(re, im)
  const bins = n / 2
  const psd = new Float64Array(bins)
  const df = sampleRate / n
  for (let k = 0; k < bins; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) / (sampleRate * sumW2)
    psd[k] = k === 0 ? p : p * 2
  }
  return { psd, df, bins }
}

/** Welch-averaged PSD over a signal chunk. */
export function welchPSD(signal, sampleRate, frameSize = 1024, overlap = 0.5) {
  const hop = Math.max(1, Math.floor(frameSize * (1 - overlap)))
  const acc = new Float64Array(frameSize / 2)
  let count = 0
  for (let start = 0; start + frameSize <= signal.length; start += hop) {
    const { psd } = powerSpectrum(signal.subarray(start, start + frameSize), sampleRate)
    for (let k = 0; k < acc.length; k++) acc[k] += psd[k]
    count++
  }
  if (count === 0) return { psd: acc, df: sampleRate / frameSize }
  for (let k = 0; k < acc.length; k++) acc[k] /= count
  return { psd: acc, df: sampleRate / frameSize }
}

/* --------------------------------------------------------------------------
 * 2. Minnaert bubble resonance & band integration
 * ------------------------------------------------------------------------ */

/** Minnaert natural frequency (Hz) of an entrained bubble of radius r (metres). */
export function minnaertResonance(r, { gamma = 1.4, P0 = 101325, rho = 1000 } = {}) {
  if (r <= 0) return 0
  return (1 / (2 * Math.PI * r)) * Math.sqrt((3 * gamma * P0) / rho)
}

/** Inverse: bubble radius (m) whose Minnaert tone equals f (Hz). */
export function bubbleRadiusForFrequency(f, opts = {}) {
  const { gamma = 1.4, P0 = 101325, rho = 1000 } = opts
  if (f <= 0) return 0
  return (1 / (2 * Math.PI * f)) * Math.sqrt((3 * gamma * P0) / rho)
}

/**
 * Band-limited jet power with spectral subtraction:
 *   P_jet(t) = ∫[lo,hi] max(0, S(f,t) − N(f)) df
 */
export function jetPower(psd, df, noiseFloor, band = FLOW_BAND) {
  const kLo = Math.max(1, Math.round(band.lo / df))
  const kHi = Math.min(psd.length - 1, Math.round(band.hi / df))
  let sum = 0
  for (let k = kLo; k <= kHi; k++) {
    const floor = noiseFloor ? (noiseFloor[k] || 0) : 0
    const v = psd[k] - floor
    if (v > 0) sum += v
  }
  return sum * df
}

/** Non-linear acoustic → volumetric transfer function Q(t) = k·P^γ (mL/s). */
export function jetPowerToFlow(P, kCal = DEFAULT_K_CAL, gamma = GAMMA_JET) {
  if (!(P > 0)) return 0
  return kCal * Math.pow(P, gamma)
}

/**
 * Least-squares-free two-point calibration from a real recording: given the
 * measured jet-power trace and the true peak flow from a gravimetric uroflowmeter,
 * k = Qmax_ref / P_max^γ.
 */
export function calibrateFromRecording(powerTrace, qMaxReference, gamma = GAMMA_JET) {
  const pMax = Math.max(...powerTrace.filter((p) => Number.isFinite(p) && p > 0))
  return solveCalibration(pMax, qMaxReference, gamma)
}

/** Calibration factor that maps a reference jet power to a target Qmax. */
export function solveCalibration(referencePower, targetQmax, gamma = GAMMA_JET) {
  if (!(referencePower > 0) || !(targetQmax > 0)) return DEFAULT_K_CAL
  return targetQmax / Math.pow(referencePower, gamma)
}

/* --------------------------------------------------------------------------
 * 3. Acoustic analyser (streaming, one frame at a time)
 * ------------------------------------------------------------------------ */

export class AcousticUroflowAnalyzer {
  constructor({
    sampleRate = 48000,
    fftSize = 2048,
    kCal = DEFAULT_K_CAL,
    gamma = GAMMA_JET,
    posture = 'seated',
    smoothing = 0.35
  } = {}) {
    this.sampleRate = sampleRate
    this.fftSize = fftSize
    this.gamma = gamma
    this.smoothing = smoothing
    this.noiseFloor = null
    this.calibrationFrames = 0
    this.calibrationAcc = new Float64Array(fftSize / 2)
    // k_cal adjusts for seated (25 cm) vs standing (65 cm) stream distance.
    this.kCal = kCal * (posture === 'standing' ? 0.62 : 1.0)
    this.smoothedQs = 0
    this.qMax = 0
    this.trace = []
    this.startedAt = null
    this.lastAt = null
    this.stopped = false
  }

  /** Feed one 1.5 s pre-void baseline frame (Float32Array / Float64Array). */
  accumulateNoise(frame) {
    const { psd } = powerSpectrum(frame.subarray(0, this.fftSize), this.sampleRate)
    for (let k = 0; k < psd.length; k++) this.calibrationAcc[k] += psd[k]
    this.calibrationFrames++
    return {
      cpm: this.calibrationFrames,
      target: 8,
      ready: this.calibrationFrames >= 8,
      spectralTiltDb: spectralCentroid(psd, this.sampleRate / this.fftSize) > 0
    }
  }

  finaliseNoiseFloor() {
    const n = this.calibrationFrames || 1
    this.noiseFloor = this.calibrationAcc.map((v) => v / n)
    return this.noiseFloor
  }

  /** Push one acoustic frame; returns instantaneous flow + volume. */
  push(frame, timestampMs = performance.now()) {
    if (this.stopped) return null
    if (!this.noiseFloor) this.finaliseNoiseFloor()
    const { psd, df } = powerSpectrum(frame.subarray(0, this.fftSize), this.sampleRate)
    const P = jetPower(psd, df, this.noiseFloor)
    const qRaw = jetPowerToFlow(P, this.kCal, this.gamma)
    this.smoothedQs = this.smoothedQs + this.smoothing * (qRaw - this.smoothedQs)
    const q = Math.max(0, this.smoothedQs)
    if (this.startedAt === null) this.startedAt = timestampMs
    const dt = this.lastAt === null ? 0 : (timestampMs - this.lastAt) / 1000
    this.lastAt = timestampMs
    const t = (timestampMs - this.startedAt) / 1000
    const prevVol = this.trace.length ? this.trace[this.trace.length - 1].v : 0
    const v = prevVol + q * Math.max(0, Math.min(dt, 0.5))
    this.qMax = Math.max(this.qMax, q)
    const point = { t: round(t, 2), q: round(q, 2), v: round(v, 1), p: round(P, 6) }
    this.trace.push(point)
    return { ...point, psd, df, centroid: spectralCentroid(psd, df), minnaertRadius: bubbleRadiusForFrequency(Math.max(1, spectralCentroid(psd, df))) }
  }

  stop() {
    this.stopped = true
    return this.trace
  }
}

/* --------------------------------------------------------------------------
 * 4. Spectral descriptors
 * ------------------------------------------------------------------------ */

export function spectralCentroid(psd, df) {
  let num = 0
  let den = 0
  for (let k = 1; k < psd.length; k++) {
    num += k * df * psd[k]
    den += psd[k]
  }
  return den > 0 ? num / den : 0
}

/* --------------------------------------------------------------------------
 * 5. Siroky & Liverpool nomograms
 * ------------------------------------------------------------------------ */

/**
 * Siroky nomogram: normal peak flow as a function of voided volume.
 * qmaxMean(v) = 30·(1 − e^(−v/230)) ; sd(v) = 2.2 + 0.008·v  (mL/s)
 *
 * The SD slope is 0.008 mL/s per mL voided (Haylen/Siroky): the earlier 0.02
 * inflated the reference band so far that a genuine obstruction (Qmax 8.5 on a
 * 420 mL void) sat at only −1.6 SD and read as "normal".
 */
export function sirokyNorm(volumeMl, sex = 'male') {
  const v = Math.max(0, Math.min(800, volumeMl))
  const scale = sex === 'female' ? 1.18 : 1.0
  const mean = 30 * (1 - Math.exp(-v / 230)) * scale
  const sd = 2.2 + 0.008 * v
  return {
    mean: round(mean, 2),
    sd: round(sd, 2),
    lower2sd: round(Math.max(0, mean - 2 * sd), 2),
    upper2sd: round(mean + 2 * sd, 2),
    zScore: null
  }
}

/** Liverpool nomogram (Haylen) — near-linear peak flow expectation, 90th-centile family. */
export function liverpoolNorm(volumeMl, sex = 'male') {
  const v = Math.max(0, Math.min(800, volumeMl))
  const scale = sex === 'female' ? 1.15 : 1.0
  const mean = (v <= 250 ? 0.075 * v : 18.75 + 0.035 * (v - 250)) * scale
  return {
    mean: round(mean, 2),
    lower: round(mean * 0.62, 2),
    upper: round(mean * 1.38, 2)
  }
}

/** Place a (volume, qmax) pair on the Siroky nomogram. */
export function sirokyPosition(volumeMl, qMax, sex = 'male') {
  const norm = sirokyNorm(volumeMl, sex)
  const z = norm.sd > 0 ? (qMax - norm.mean) / norm.sd : 0
  let verdict = 'NORMAL (within ±2 SD)'
  if (z < -2) verdict = 'OBSTRUCTED (< −2 SD)'
  else if (z > 2) verdict = 'HIGH FLOW (> +2 SD)'
  return { ...norm, zScore: round(z, 2), verdict, volume: volumeMl, qMax }
}

/* --------------------------------------------------------------------------
 * 6. Biometrics + morphology classification
 * ------------------------------------------------------------------------ */

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function stdev(xs) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

export function skewness(xs) {
  const n = xs.length
  if (n < 3) return 0
  const m = mean(xs)
  const s = stdev(xs)
  if (s === 0) return 0
  return (n / ((n - 1) * (n - 2))) * xs.reduce((a, b) => a + ((b - m) / s) ** 3, 0)
}

/** Excess kurtosis (Fisher). */
export function kurtosis(xs) {
  const n = xs.length
  if (n < 4) return 0
  const m = mean(xs)
  const s = stdev(xs)
  if (s === 0) return 0
  const g2 = xs.reduce((a, b) => a + ((b - m) / s) ** 4, 0) / n - 3
  return g2
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return 0
  const f = 10 ** d
  return Math.round((v + Number.EPSILON) * f) / f
}

/**
 * Count genuine flow interruptions. A trough only qualifies when it is followed
 * by a recovery of at least 8% of Qmax — this rejects the low-amplitude ripple
 * of an otherwise smooth bell curve while still capturing the silent troughs of
 * a staccato (dyssynergic) or straining trace.
 */
export function countInterruptions(qs, qMax) {
  const prominence = Math.max(0.35, 0.08 * qMax)
  let count = 0
  let i = 1
  while (i < qs.length - 1) {
    // walk to a local trough
    if (qs[i] <= qs[i - 1] && qs[i] <= qs[i + 1]) {
      const trough = qs[i]
      const leftPeak = Math.max(...qs.slice(Math.max(0, i - 12), i + 1))
      let j = i
      let rightPeak = 0
      while (j < Math.min(qs.length, i + 120) && qs[j] < leftPeak) {
        rightPeak = Math.max(rightPeak, qs[j])
        j++
      }
      if (rightPeak - trough >= prominence && leftPeak - trough >= prominence) {
        count++
        i = j
        continue
      }
    }
    i++
  }
  return count
}

/**
 * Compute the full clinical biometric panel from a Q(t) trace.
 * trace: [{ t, q, v }]
 */
export function computeBiometrics(trace, { sex = 'male', age = 45 } = {}) {
  if (!trace || trace.length < 3) return null
  const qs = trace.map((p) => Math.max(0, p.q))
  const times = trace.map((p) => p.t)
  let peakIdx = 0
  for (let i = 1; i < qs.length; i++) if (qs[i] > qs[peakIdx]) peakIdx = i
  const qMax = qs[peakIdx]
  const tQmax = times[peakIdx]

  // Flow time: span from the first to the last sample above 5% of Qmax. A span
  // (rather than a contiguous run around the peak) is required because staccato
  // and dyssynergic traces legitimately contain silent troughs.
  const floor = Math.max(0.25, 0.05 * qMax)
  let start = 0
  while (start < qs.length && qs[start] <= floor) start++
  let end = qs.length - 1
  while (end > 0 && qs[end] <= floor) end--
  if (end <= start) { start = peakIdx; end = Math.min(qs.length - 1, peakIdx + 1) }
  const tFlow = Math.max(0.2, times[end] - times[start])
  const vVoided = Math.max(0, trace[trace.length - 1].v)
  const qAvg = vVoided > 0 && tFlow > 0 ? vVoided / tFlow : 0
  const active = qs.slice(start, end + 1)
  const plateauRatio = qMax > 0 ? qAvg / qMax : 0

  const interruptionCount = countInterruptions(qs, qMax)

  const q10 = percentile(qs, 0.1)
  const q50 = percentile(qs, 0.5)
  const q90 = percentile(qs, 0.9)
  const acceleration = tQmax > 0 ? qMax / tQmax : 0
  const skew = skewness(active.length > 4 ? active : qs)
  const kurt = kurtosis(active.length > 4 ? active : qs)
  const decayRatio = (() => {
    const afterPeak = qs.slice(peakIdx)
    if (afterPeak.length < 2) return 1
    return afterPeak[afterPeak.length - 1] / qMax
  })()

  const morphology = classifyMorphology({
    qMax,
    qAvg,
    tQmax,
    tFlow,
    plateauRatio,
    skewness: skew,
    kurtosis: kurt,
    interruptionCount,
    acceleration,
    decayRatio,
    sex
  })

  const nomogram = sirokyPosition(vVoided, qMax, sex)
  const liverpool = liverpoolNorm(vVoided, sex)
  const lowVolumeFlag = vVoided < 150
  const lowFlowFlag = qMax < (sex === 'female' ? 20 : 15)

  return {
    qMax: round(qMax, 2),
    qAvg: round(qAvg, 2),
    vVoided: round(vVoided, 1),
    tQmax: round(tQmax, 2),
    tFlow: round(tFlow, 2),
    tVoid: round(times[times.length - 1], 2),
    acceleration: round(acceleration, 2),
    plateauRatio: round(plateauRatio, 3),
    skewness: round(skew, 3),
    kurtosis: round(kurt, 3),
    interruptionCount,
    q10: round(q10, 2),
    q50: round(q50, 2),
    q90: round(q90, 2),
    decayRatio: round(decayRatio, 3),
    morphology,
    nomogram,
    liverpool,
    lowVolumeFlag,
    lowFlowFlag,
    flags: buildFlags({ qMax, qAvg, vVoided, tQmax, tFlow, plateauRatio, interruptionCount, lowFlowFlag, lowVolumeFlag, age })
  }
}

function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))
  return s[idx]
}

function buildFlags(m) {
  const flags = []
  if (m.lowVolumeFlag) flags.push({ level: 'warn', text: 'Voided volume < 150 mL — low-volume studies correlate poorly; repeat with a fuller bladder.' })
  if (m.lowFlowFlag) flags.push({ level: 'danger', text: 'Qmax below sex-specific threshold — obstruction or detrusor underactivity likely; correlate with IPSS and PVR.' })
  if (m.qAvg > 0 && m.qMax > 0 && m.qAvg / m.qMax > 0.78) flags.push({ level: 'warn', text: 'Plateau geometry (Qavg/Qmax > 0.78) — fixed lumen narrowing (urethral stricture) pattern.' })
  if (m.interruptionCount >= 3) flags.push({ level: 'warn', text: 'Staccato trace with ≥3 interruptions — abdominal straining / detrusor-sphincter dyssynergia pattern.' })
  if (m.tQmax > 0 && m.tFlow > 0 && m.tQmax > m.tFlow / 3) flags.push({ level: 'warn', text: 'Time-to-Qmax > ⅓ of flow time — obstructive morphology.' })
  return flags
}

/**
 * 5-pattern morphological classifier.
 *
 * Rules are expressed on *scale-free* geometry so the same thresholds hold for a
 * 180 mL void and a 600 mL void:
 *   qMax            absolute peak flow (sex-specific normal threshold)
 *   tRatio          Time-to-Qmax / flow time — early peak ⇒ obstruction
 *   plateauRatio    Qavg / Qmax — flat top ⇒ fixed lumen narrowing
 *   skewness        skew of the active flow samples
 *   kurtosis        excess kurtosis of the active flow samples
 *   interruptions   troughs with ≥8% Qmax recovery either side
 *
 * Scores are weighted evidence, normalised into a posterior for the inspector.
 */
export function classifyMorphology(m) {
  const {
    qMax,
    tQmax,
    tFlow,
    plateauRatio,
    interruptionCount = 0,
    sex = 'male'
  } = m
  // A missing or non-finite shape moment must degrade to "no evidence", never to
  // NaN: `Math.abs(NaN) < 0.9` is false, which would silently disable the rule.
  const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)
  const skew = finite(m.skewness)
  const kurt = finite(m.kurtosis)
  const normalThreshold = sex === 'female' ? 20 : 15
  const tRatio = tFlow > 0 ? tQmax / tFlow : 0.5
  const scores = {
    normal: 0,
    bph_obstruction: 0,
    stricture_plateau: 0,
    detrusor_underactivity: 0,
    dyssynergia_staccato: 0
  }

  // ---- Physiological bell -------------------------------------------------
  if (qMax >= normalThreshold) scores.normal += 2.5
  if (tRatio >= 0.2 && tRatio <= 0.45) scores.normal += 1.5
  if (Math.abs(skew) < 0.9) scores.normal += 1.2
  if (interruptionCount === 0) scores.normal += 1.0
  if (plateauRatio >= 0.4 && plateauRatio <= 0.72) scores.normal += 1.0

  // ---- Compensated / decompensated prostatic obstruction -------------------
  if (qMax < 12) scores.bph_obstruction += 3.0
  if (qMax < 8) scores.bph_obstruction += 1.2
  if (tRatio < 0.3) scores.bph_obstruction += 2.2
  if (tFlow > 40) scores.bph_obstruction += 0.8

  // ---- Constrictive stricture (flat-topped box) ---------------------------
  // Qavg/Qmax > 0.80 is close to pathognomonic for a fixed narrowing.
  if (plateauRatio > 0.8) scores.stricture_plateau += 4.0
  if (plateauRatio > 0.86) scores.stricture_plateau += 2.0
  if (interruptionCount === 0) scores.stricture_plateau += 0.6
  if (skew < -1.4) scores.stricture_plateau += 1.0

  // ---- Detrusor underactivity --------------------------------------------
  if (tRatio > 0.42) scores.detrusor_underactivity += 3.0
  if (qMax < 10.5) scores.detrusor_underactivity += 2.5
  if (tFlow > 30) scores.detrusor_underactivity += 1.5
  if (Math.abs(skew) < 1.2) scores.detrusor_underactivity += 1.0

  // ---- Detrusor-sphincter dyssynergia (staccato) -------------------------
  // Three or more genuine interruptions is decisive on its own.
  if (interruptionCount >= 3) scores.dyssynergia_staccato += 6.0
  if (interruptionCount >= 5) scores.dyssynergia_staccato += 2.0
  if (interruptionCount >= 2) scores.dyssynergia_staccato += 0.8

  const order = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [pattern, top] = order[0]
  const total = order.reduce((a, [, v]) => a + v, 0) || 1
  return {
    pattern,
    label: MORPHOLOGY_LABELS[pattern],
    confidence: round(Math.min(0.97, top / total + 0.12), 3),
    scores: Object.fromEntries(order.map(([k, v]) => [k, round(v / total, 3)])),
    evidence: {
      qMax: round(qMax, 2),
      timeToQmaxRatio: round(tRatio, 3),
      plateauRatio: round(plateauRatio, 3),
      skewness: round(skew, 3),
      excessKurtosis: round(kurt, 3),
      interruptions: interruptionCount
    },
    description: MORPHOLOGY_DESCRIPTIONS[pattern]
  }
}

export const MORPHOLOGY_LABELS = {
  normal: 'Normal Bell-Shaped Curve',
  bph_obstruction: 'Compensated / Decompensated Prostatic Obstruction (BPH)',
  stricture_plateau: 'Constrictive Urethral Stricture ("Box / Plateau")',
  detrusor_underactivity: 'Detrusor Underactivity / Neurogenic Hypocontractility',
  dyssynergia_staccato: 'Detrusor-Sphincter Dyssynergia ("Staccato / Interrupted")'
}

export const MORPHOLOGY_DESCRIPTIONS = {
  normal: 'Symmetric bell contour with an early Qmax (≈20–28% of flow time), a smooth concavity-free decay and no plateau — a physiological detrusor contraction through a compliant outlet.',
  bph_obstruction: 'Low amplitude with a proportionally early peak (Time-to-Qmax < 30% of flow time) followed by a prolonged, high-volume terminal tail — a decompensating detrusor working against a fixed prostatic obstruction.',
  stricture_plateau: 'Flat-topped constant-velocity plateau with Qavg/Qmax > 0.80, a sharply truncated tail and no interruptions — a fixed mechanical lumen narrowing such as a urethral stricture.',
  detrusor_underactivity: 'Low-amplitude, broad and symmetric dome peaking at or after mid-flow (Time-to-Qmax > 42% of flow time) with no plateau — a weak, slowly recruited detrusor contraction.',
  dyssynergia_staccato: 'Three or more sharp flow interruptions separated by silent troughs, from involuntary external-sphincter contractions or abdominal straining against a closed outlet.'
}

/**
 * Bayesian-style posterior over the 5 morphotypes using the score vector —
 * exposed for the Polyglot Runtime Inspector benchmark panel.
 */
export function morphologyPosterior(scores) {
  const e = Object.entries(scores)
  const total = e.reduce((a, [, v]) => a + Math.exp(v * 6), 0)
  return Object.fromEntries(e.map(([k, v]) => [k, round(Math.exp(v * 6) / total, 4)]))
}

/* --------------------------------------------------------------------------
 * 7. IPSS / AUA-SI + quality of life
 * ------------------------------------------------------------------------ */

export const IPSS_QUESTIONS = [
  { id: 'emptying', label: 'Incomplete emptying', prompt: 'Over the past month, how often have you had a sensation of not emptying your bladder completely after you finish urinating?' },
  { id: 'frequency', label: 'Frequency', prompt: 'How often have you had to urinate again less than two hours after you finished urinating?' },
  { id: 'intermittency', label: 'Intermittency', prompt: 'How often have you found you stopped and started again several times when you urinated?' },
  { id: 'urgency', label: 'Urgency', prompt: 'How often have you found it difficult to postpone urination?' },
  { id: 'weakStream', label: 'Weak stream', prompt: 'How often have you had a weak urinary stream?' },
  { id: 'straining', label: 'Straining', prompt: 'How often have you had to push or strain to begin urination?' },
  { id: 'nocturia', label: 'Nocturia', prompt: 'How many times did you most typically get up to urinate from the time you went to bed until the time you got up in the morning?' }
]

export const IPSS_OPTIONS = [
  { value: 0, label: 'Not at all' },
  { value: 1, label: 'Less than 1 time in 5' },
  { value: 2, label: 'Less than half the time' },
  { value: 3, label: 'About half the time' },
  { value: 4, label: 'More than half the time' },
  { value: 5, label: 'Almost always' }
]

export const IPSS_NOCTURIA_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: '1 time' },
  { value: 2, label: '2 times' },
  { value: 3, label: '3 times' },
  { value: 4, label: '4 times' },
  { value: 5, label: '5 or more times' }
]

export const QOL_OPTIONS = [
  'Delighted', 'Pleased', 'Mostly satisfied', 'Mixed — about equally satisfied and dissatisfied',
  'Mostly dissatisfied', 'Unhappy', 'Terrible'
]

export function scoreIpss(answers) {
  const total = IPSS_QUESTIONS.reduce((a, q) => a + (Number(answers?.[q.id]) || 0), 0)
  const severity = total <= 7 ? 'Mild' : total <= 19 ? 'Moderate' : 'Severe'
  const qol = Number(answers?.qol ?? 3)
  const bother = qol <= 1 ? 'Low bother' : qol <= 3 ? 'Moderate bother' : 'High bother'
  const riskBand = total <= 7 ? 'low' : total <= 19 ? 'moderate' : 'high'
  return {
    total,
    severity,
    qol,
    bother,
    riskBand,
    interpretation: `IPSS ${total}/35 — ${severity} lower urinary tract symptoms. ${bother} (QoL ${qol}/6).`,
    recommendation:
      total <= 7
        ? 'Watchful waiting, fluid/caffeine optimization and annual review.'
        : total <= 19
          ? 'Behavioural therapy ± alpha-blocker; consider uroflowmetry and PVR confirmation.'
          : 'Urology referral for pressure-flow study and consideration of surgical outlet relief.'
  }
}

/* --------------------------------------------------------------------------
 * 8. Voiding simulation presets + acoustic synthesis
 * ------------------------------------------------------------------------ */

/**
 * Analytic Q(t) generators used by the 1-Tap clinical simulators.
 *
 * Each preset is a *shape family* (normalised) plus a Qmax/volume, so the
 * numeric features the classifier consumes — skewness, excess kurtosis,
 * Qavg/Qmax and interruption count — are a direct consequence of the
 * physiological form rather than being hand-set.
 *
 * `kind` → shape family:
 *   bell        symmetric beta curve, peak at 16% of flow time  (normal)
 *   obstructive beta curve, very early peak, long terminal tail (BPH)
 *   plateau     flat-topped box with fast ramp and abrupt cut-off (stricture)
 *   underactive symmetric broad dome, peak at mid-flow, low Qmax (DU)
 *   staccato    four discrete straining bursts with silent troughs (DSD)
 */
export const VOIDING_PRESETS = [
  {
    id: 'normal-male',
    name: 'Normal Bell-Shaped Void (Male)',
    description: 'Qmax 22 mL/s, voided volume 420 mL, early symmetric peak, physiological decay.',
    sex: 'male',
    age: 34,
    shape: { volume: 420, qMax: 22, tQmax: 6.4, kind: 'bell', uPeak: 0.16, kappa: 6 }
  },
  {
    id: 'bph-obstruction',
    name: 'BPH Prostatic Obstruction',
    description: 'Qmax 8.6 mL/s with an early peak and a long low-amplitude terminal dribble tail.',
    sex: 'male',
    age: 68,
    shape: { volume: 265, qMax: 8.6, tQmax: 4.6, kind: 'obstructive', uPeak: 0.13, kappa: 2.3 }
  },
  {
    id: 'stricture-plateau',
    name: 'Urethral Stricture Plateau',
    description: 'Flat-topped box curve, Qavg/Qmax 0.86, negative kurtosis — fixed lumen narrowing.',
    sex: 'male',
    age: 41,
    shape: { volume: 210, qMax: 11.4, tQmax: 5.0, kind: 'plateau', uPeak: 0.14, kappa: 2 }
  },
  {
    id: 'detrusor-underactivity',
    name: 'Detrusor Underactivity',
    description: 'Low-amplitude symmetric prolonged curve, slow acceleration, Qmax 7.2 mL/s.',
    sex: 'male',
    age: 74,
    shape: { volume: 180, qMax: 7.2, tQmax: 13.5, kind: 'underactive', uPeak: 0.5, kappa: 2.2 }
  },
  {
    id: 'dyssynergia-staccato',
    name: 'Detrusor-Sphincter Dyssynergia',
    description: 'Staccato trace: four sharp straining bursts with silent troughs between them.',
    sex: 'female',
    age: 29,
    shape: { volume: 240, qMax: 15.2, tQmax: 9.0, kind: 'staccato', uPeak: 0.5, kappa: 2, bursts: 4 }
  }
]

/**
 * Normalised shape families. `u` is the normalised flow-phase abscissa [0,1];
 * every family is scaled later so that the integral matches the target volume.
 */
export function shapingFunction(kind, u, cfg = {}) {
  const t = Math.min(1, Math.max(0, u))
  if (t <= 0 || t >= 1) return 0
  const uPeak = Math.min(0.9, Math.max(0.06, cfg.uPeak ?? 0.16))
  const kappa = cfg.kappa ?? 6

  switch (kind) {
    case 'bell':
    case 'obstructive':
    case 'underactive': {
      // Beta density — peak exactly at uPeak, analytic and smooth.
      const a = uPeak * kappa
      const b = (1 - uPeak) * kappa
      const num = Math.pow(t, a) * Math.pow(1 - t, b)
      const den = Math.pow(uPeak, a) * Math.pow(1 - uPeak, b)
      return den > 0 ? num / den : 0
    }
    case 'plateau': {
      // Trapezoidal constant-velocity profile: 9% ramp, flat top, 14% cut-off.
      const rise = Math.min(1, t / 0.09)
      const fall = Math.min(1, (1 - t) / 0.14)
      return Math.max(0, Math.min(rise, fall))
    }
    case 'staccato': {
      // Discrete straining bursts separated by silent troughs.
      const n = Math.max(2, cfg.bursts ?? 4)
      const gap = 0.06
      const seg = 1 / n
      let best = 0
      for (let i = 0; i < n; i++) {
        const a = i * seg + gap / 2
        const b = (i + 1) * seg - gap / 2
        if (t >= a && t <= b) {
          best = Math.max(best, Math.pow(Math.sin((Math.PI * (t - a)) / (b - a)), 0.6))
        }
      }
      return best
    }
    default:
      return Math.sin(Math.PI * t)
  }
}

/** Numerically integrate a shape family over [0,1] (Simpson-style midpoint sum). */
export function shapeIntegral(kind, cfg = {}, n = 2000) {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n
    acc += shapingFunction(kind, u, cfg)
  }
  return acc / n
}

/**
 * Build a Q(t) trace from a shape descriptor at `hz` samples per second.
 *
 * The flow time is solved from the volume constraint
 *   V = Qmax · I · t_flow        ⇒   t_flow = V / (Qmax · I)
 * where I is the unit-area integral of the shape, so the *declared* Qmax and
 * voided volume are both reproduced exactly.
 */
export function synthesiseVoidingTrace(shape, hz = 25) {
  const { volume, qMax, kind } = shape
  const cfg = { uPeak: shape.uPeak, kappa: shape.kappa, bursts: shape.bursts }
  const I = shapeIntegral(kind, cfg)
  const tFlow = volume / (qMax * I)

  const pre = 1.8
  const post = 2.4
  const dt = 1 / hz
  const n = Math.round((pre + tFlow + post) * hz)
  const trace = []
  let accumulated = 0
  for (let i = 0; i < n; i++) {
    const t = i * dt
    let q = 0
    if (t >= pre && t <= pre + tFlow) {
      const u = (t - pre) / tFlow
      q = qMax * shapingFunction(kind, u, cfg) + jitter(qMax, i)
    }
    q = Math.max(0, q)
    accumulated += q * dt
    trace.push({ t: round(t, 2), q: round(q, 2), v: round(accumulated, 1) })
  }
  return trace
}

function jitter(scale, i) {
  // deterministic pseudo-noise (xorshift) so renders are reproducible
  let x = (i * 2654435761) >>> 0
  x ^= x << 13; x >>>= 0
  x ^= x >> 17
  x ^= x << 5; x >>>= 0
  return ((x / 4294967295) - 0.5) * scale * 0.035
}

/** Build a preset's complete trace + biometrics in one call. */
export function buildPreset(preset) {
  const trace = synthesiseVoidingTrace(preset.shape)
  const metrics = computeBiometrics(trace, { sex: preset.sex, age: preset.age })
  return { ...preset, trace, metrics }
}

/**
 * Synthesise an AudioBuffer whose band-limited bubbling energy tracks Q(t) —
 * the physically-motivated counterpart of the acoustic→flow transfer function.
 * Used by the "1-Tap Voiding Synthesizer" so every browser can audition the
 * spectrogram + Q(t) pipeline without a microphone.
 */
export function synthesiseVoidingAudio(ctx, preset, { gain = 0.34 } = {}) {
  const trace = preset.trace || synthesiseVoidingTrace(preset.shape)
  const sr = ctx.sampleRate || 48000
  const dur = trace[trace.length - 1].t + 0.2
  const len = Math.floor(dur * sr)
  const buffer = ctx.createBuffer(1, len, sr)
  const out = buffer.getChannelData(0)
  const traceHz = trace.length / Math.max(0.01, dur)

  // 26 deterministic bubble resonators spread across the 550–6200 Hz band
  const bubbles = []
  let seed = 987654321
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0
    seed ^= seed >> 17
    seed ^= seed << 5; seed >>>= 0
    return seed / 4294967295
  }
  for (let i = 0; i < 26; i++) {
    const f = FLOW_BAND.lo + rnd() * (FLOW_BAND.hi - FLOW_BAND.lo)
    bubbles.push({ f, phase: rnd() * Math.PI * 2, q: 4 + rnd() * 26, amp: 0.25 + rnd() * 0.75 })
  }

  const qAt = (t) => {
    const idx = Math.min(trace.length - 1, Math.max(0, Math.round(t * traceHz)))
    return trace[idx].q
  }

  for (let i = 0; i < len; i++) {
    const t = i / sr
    const q = qAt(t)
    // Acoustic power tracks the jet with the same γ exponent used to invert it.
    const drive = Math.pow(Math.max(0, q) / 22, GAMMA_JET)
    let acc = 0
    for (let b = 0; b < bubbles.length; b++) {
      const bb = bubbles[b]
      const env = 0.45 + 0.55 * Math.sin(bb.phase + t * bb.q * (0.6 + drive))
      acc += bb.amp * env * Math.sin(2 * Math.PI * bb.f * t + bb.phase)
    }
    const splash = t > 0 && t < 0.35 ? Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 14) * 0.5 : 0
    out[i] = gain * drive * (acc / bubbles.length + splash) + (rnd() - 0.5) * 0.006 * drive
  }
  // first-order DC blocker
  let prev = 0
  let prevOut = 0
  for (let i = 0; i < len; i++) {
    const x = out[i]
    const y = x - prev + 0.995 * prevOut
    prev = x
    prevOut = y
    out[i] = y
  }
  return buffer
}

/* --------------------------------------------------------------------------
 * 9. AUA / BPH risk helper used by the report exporter
 * ------------------------------------------------------------------------ */

export function bphRiskSummary(metrics, ipss) {
  if (!metrics || !ipss) return null
  const obstruction = metrics.qMax < 10 || metrics.morphology.pattern === 'bph_obstruction'
  const severeSymptoms = ipss.total >= 20
  const risk = obstruction && severeSymptoms ? 'high' : obstruction || severeSymptoms ? 'moderate' : 'low'
  return {
    risk,
    advice:
      risk === 'high'
        ? 'Combined obstructive uroflowmetry and severe IPSS — refer for pressure-flow study and surgical counselling.'
        : risk === 'moderate'
          ? 'Borderline uroflowmetry/symptom burden — repeat study, check PVR and start alpha-blocker trial.'
          : 'Reassuring uroflowmetry and symptom score — maintain behavioural measures and annual review.'
  }
}

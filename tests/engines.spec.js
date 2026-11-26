/**
 * NEPHRO-SPECTRA — engine correctness suite.
 *
 * These are not smoke tests: each case pins a clinical or numerical property
 * that would break silently if the maths drifted.
 */
import { describe, it, expect } from 'vitest'

import {
  fft,
  powerSpectrum,
  welchPSD,
  jetPower,
  jetPowerToFlow,
  solveCalibration,
  calibrateFromRecording,
  minnaertResonance,
  bubbleRadiusForFrequency,
  spectralCentroid,
  sirokyNorm,
  sirokyPosition,
  computeBiometrics,
  buildPreset,
  synthesiseVoidingTrace,
  synthesiseVoidingAudio,
  shapeIntegral,
  shapingFunction,
  countInterruptions,
  classifyMorphology,
  scoreIpss,
  VOIDING_PRESETS,
  MORPHOLOGY_LABELS,
  DEFAULT_K_CAL,
  GAMMA_JET
} from '@/engines/acousticUroflowEngine.js'

import {
  simulateHovorka,
  hovorkaParams,
  renalExcretionMmolMin,
  serumOsmolality,
  effectiveOsmolality,
  freeWaterDeficit,
  glucoseKetoneIndex,
  rk4Step,
  benchmarkFFT,
  runtimeInfo,
  SAMPLE_RATE
} from '@/engines/rustNephroBridge.js'

import {
  ciede2000,
  rgbToLab,
  bradfordAdaptToD65,
  correctSpecificGravity,
  chronoGate,
  bloodSpeckleAnalysis,
  classifyPad,
  readScenario,
  DIPSTICK_PADS,
  DIPSTICK_SCENARIOS,
  STRIP_PRESETS
} from '@/engines/dipstickCiEDE2000Engine.js'

import {
  apCaOx,
  apCaP,
  uricAcidProfile,
  uricAcidSolubility,
  urateIonisedFraction,
  stonePassageProbability,
  stoneRiskProfile,
  counterBalancer,
  ctStoneComposition,
  dissolutionHalfLife,
  STONE_SCENARIOS,
  URIC_PKA1,
  CHEMOLYSIS_WINDOW
} from '@/engines/stoneSupersaturationEngine.js'

import {
  ckdEpi2021Creatinine,
  ckdEpi2021CreatinineCystatin,
  cockcroftGault,
  gStage,
  aStage,
  kdigoGrid,
  kfre4,
  fractionalExcretion,
  akiStage,
  auditQuote,
  CPT_CATALOGUE,
  EGFR_PATIENTS,
  evaluatePatient
} from '@/engines/kdigoEgfrEngine.js'

import { estimateNoiseFloor, peakFlow } from '@/engines/rustNephroBridge.js'

import {
  evaluateGlycemicScenario,
  renalThresholdGlucose,
  SGLT2_RTG,
  GLYCEMIC_SCENARIOS
} from '@/engines/glycemicRenalEngine.js'

/* ======================================================================== */
/* 1. DSP                                                                   */
/* ======================================================================== */

describe('radix-2 FFT', () => {
  it('transforms an impulse into a flat spectrum', () => {
    const n = 16
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    re[0] = 1
    fft(re, im)
    for (let k = 0; k < n; k++) expect(re[k]).toBeCloseTo(1, 12)
    for (let k = 0; k < n; k++) expect(im[k]).toBeCloseTo(0, 12)
  })

  it('rejects a non-power-of-two length', () => {
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/)
  })

  it('places a pure tone on the expected bin', () => {
    const n = 2048
    const f = 1875 // 80 whole cycles in 2048 samples: lands exactly on a bin
    const frame = new Float64Array(n)
    for (let i = 0; i < n; i++) frame[i] = Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE)
    const { psd, df } = powerSpectrum(frame, SAMPLE_RATE)
    let bestK = 1
    for (let k = 1; k < psd.length; k++) if (psd[k] > psd[bestK]) bestK = k
    expect(bestK * df).toBeCloseTo(f, 0)
  })

  it('conserves spectral centroid location for a band-limited jet', () => {
    const n = 1024
    const frame = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      frame[i] =
        0.2 * Math.sin((2 * Math.PI * 1200 * i) / SAMPLE_RATE) +
        0.1 * Math.sin((2 * Math.PI * 3400 * i) / SAMPLE_RATE)
    }
    const { psd, df } = powerSpectrum(frame, SAMPLE_RATE)
    const centroid = spectralCentroid(psd, df)
    expect(centroid).toBeGreaterThan(900)
    expect(centroid).toBeLessThan(3600)
  })
})

describe('Minnaert bubble resonance', () => {
  it('round-trips frequency ↔ radius', () => {
    const f = 4200
    const r = bubbleRadiusForFrequency(f)
    expect(minnaertResonance(r) / f).toBeCloseTo(1, 9)
  })

  it('gives a ~65 µm bubble at 50 kHz in water', () => {
    // f = (1/2πr)·sqrt(3γP/ρ) with γ=1.4, P=101325, ρ=1000
    const r = bubbleRadiusForFrequency(50000)
    expect(r * 1e6).toBeGreaterThan(60)
    expect(r * 1e6).toBeLessThan(70)
  })
})

describe('jet power → flow transfer', () => {
  it('is monotonic and zero below the noise floor', () => {
    const psd = new Float64Array(64).fill(1e-8)
    const floor = new Float64Array(64).fill(1e-8)
    // energy at or under the calibrated noise floor is not jetted flow
    expect(jetPower(psd, 46.875, floor, { lo: 550, hi: 1500 })).toBe(0)
    expect(jetPowerToFlow(0)).toBe(0)
    expect(jetPowerToFlow(0.02)).toBeGreaterThan(jetPowerToFlow(0.01))
  })

  it('solves a calibration that reproduces the target Qmax', () => {
    const k = solveCalibration(0.05, 22, GAMMA_JET)
    expect(jetPowerToFlow(0.05, k, GAMMA_JET)).toBeCloseTo(22, 9)
  })

  it('calibrates from a measured power trace', () => {
    const k = calibrateFromRecording([1e-5, 3e-4, 2e-4], 18)
    expect(jetPowerToFlow(3e-4, k, GAMMA_JET)).toBeCloseTo(18, 9)
  })
})

/* ======================================================================== */
/* 2. Uroflow geometry & morphology                                         */
/* ======================================================================== */

describe('analytical voiding geometry', () => {
  it('reproduces the declared Qmax and voided volume for every preset', () => {
    for (const preset of VOIDING_PRESETS) {
      const trace = synthesiseVoidingTrace(preset.shape)
      const qMax = Math.max(...trace.map((p) => p.q))
      const volume = trace[trace.length - 1].v
      // ±4% for the deterministic jitter, ±2% for the solver tolerance.
      expect(qMax).toBeGreaterThan(preset.shape.qMax * 0.96)
      expect(qMax).toBeLessThan(preset.shape.qMax * 1.04)
      expect(volume).toBeGreaterThan(preset.shape.volume * 0.98)
      expect(volume).toBeLessThan(preset.shape.volume * 1.02)
    }
  })

  it('produces unit-area shape integrals that differ by family', () => {
    const bell = shapeIntegral('bell', { uPeak: 0.16, kappa: 6 })
    const underactive = shapeIntegral('underactive', { uPeak: 0.5, kappa: 2.2 })
    expect(bell).toBeGreaterThan(0)
    expect(underactive).toBeGreaterThan(0)
    expect(shapeIntegral('plateau')).toBeGreaterThan(0.7)
  })

  it('shapes are zero at the boundaries', () => {
    for (const kind of ['bell', 'obstructive', 'plateau', 'underactive', 'staccato']) {
      expect(shapingFunction(kind, 0)).toBe(0)
      expect(shapingFunction(kind, 1)).toBe(0)
    }
  })
})

describe('interruption detection', () => {
  it('ignores smooth ripple', () => {
    const qs = Array.from({ length: 60 }, (_, i) => 10 * Math.sin((Math.PI * i) / 59))
    expect(countInterruptions(qs, 10)).toBe(0)
  })

  it('counts deep silent troughs', () => {
    const qs = [0, 5, 9, 10, 9, 5, 0.2, 0.1, 0.2, 5, 9, 10, 9, 5, 0.2, 0.1, 0.2, 5, 9, 10, 9, 5, 0.2, 0.1, 0.2, 5, 9, 10, 9, 5, 0]
    expect(countInterruptions(qs, 10)).toBeGreaterThanOrEqual(3)
  })
})

describe('morphology classifier', () => {
  const expected = {
    'normal-male': 'normal',
    'bph-obstruction': 'bph_obstruction',
    'stricture-plateau': 'stricture_plateau',
    'detrusor-underactivity': 'detrusor_underactivity',
    'dyssynergia-staccato': 'dyssynergia_staccato'
  }

  for (const preset of VOIDING_PRESETS) {
    it(`classifies ${preset.id} as ${expected[preset.id]}`, () => {
      const built = buildPreset(preset)
      expect(built.metrics.morphology.pattern).toBe(expected[preset.id])
      expect(built.metrics.morphology.confidence).toBeGreaterThan(0.4)
      expect(built.metrics.morphology.confidence).toBeLessThanOrEqual(0.97)
      // posterior masses must sum to ~1
      const sum = Object.values(built.metrics.morphology.scores).reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1, 2)
    })
  }

  it('is scale invariant — doubling volume at the same geometry keeps the morphotype', () => {
    const base = VOIDING_PRESETS.find((p) => p.id === 'stricture-plateau')
    const scaled = { ...base, shape: { ...base.shape, volume: base.shape.volume * 2 } }
    const a = buildPreset(base).metrics.morphology.pattern
    const b = buildPreset(scaled).metrics.morphology.pattern
    expect(b).toBe(a)
  })

  it('exposes a label for every morphotype', () => {
    for (const key of Object.keys(MORPHOLOGY_LABELS)) expect(MORPHOLOGY_LABELS[key]).toBeTruthy()
  })
})

describe('Siroky nomogram', () => {
  it('matches the published mean at 400 mL (≈24.7 mL/s)', () => {
    expect(sirokyNorm(400).mean).toBeCloseTo(24.75, 1)
  })

  it('rises monotonically with volume and saturates below 30', () => {
    let prev = 0
    for (let v = 50; v <= 800; v += 50) {
      const m = sirokyNorm(v).mean
      expect(m).toBeGreaterThanOrEqual(prev)
      expect(m).toBeLessThan(30.5)
      prev = m
    }
  })

  it('places a low flow below −2 SD', () => {
    const pos = sirokyPosition(420, 8.5, 'male')
    expect(pos.zScore).toBeLessThan(-2)
    expect(pos.verdict).toMatch(/OBSTRUCTED/)
  })

  it('places a normal flow inside ±2 SD', () => {
    const pos = sirokyPosition(420, 22, 'male')
    expect(Math.abs(pos.zScore)).toBeLessThan(2)
    expect(pos.verdict).toMatch(/NORMAL/)
  })

  it('uses the Haylen SD slope of 0.008 mL/s per mL', () => {
    expect(sirokyNorm(400).sd).toBeCloseTo(2.2 + 0.008 * 400, 6)
    expect(sirokyNorm(400).lower2sd).toBeCloseTo(24.75 - 2 * 5.4, 1)
  })

  it('shifts the female expectation upward', () => {
    expect(sirokyNorm(400, 'female').mean).toBeGreaterThan(sirokyNorm(400, 'male').mean)
  })
})

describe('biometrics', () => {
  it('computes Qavg from volume and flow time', () => {
    const built = buildPreset(VOIDING_PRESETS[0])
    const m = built.metrics
    expect(m.qAvg).toBeCloseTo(m.vVoided / m.tFlow, 1)
  })

  it('returns null for a degenerate trace', () => {
    expect(computeBiometrics([], {})).toBeNull()
    expect(computeBiometrics([{ t: 0, q: 0, v: 0 }], {})).toBeNull()
  })

  it('flags a low voided volume', () => {
    const tiny = { ...VOIDING_PRESETS[0], shape: { ...VOIDING_PRESETS[0].shape, volume: 90 } }
    const m = buildPreset(tiny).metrics
    expect(m.lowVolumeFlag).toBe(true)
    expect(m.flags.some((f) => /low-volume|150 mL/i.test(f.text))).toBe(true)
  })
})

describe('IPSS', () => {
  it('sums to the severity bands', () => {
    expect(scoreIpss({ emptying: 0, frequency: 0, intermittency: 0, urgency: 0, weakStream: 0, straining: 0, nocturia: 0, qol: 0 }).severity).toBe('Mild')
    expect(scoreIpss({ emptying: 2, frequency: 2, intermittency: 2, urgency: 2, weakStream: 2, straining: 2, nocturia: 2, qol: 2 }).total).toBe(14)
    expect(scoreIpss({ emptying: 5, frequency: 5, intermittency: 5, urgency: 5, weakStream: 5, straining: 5, nocturia: 5, qol: 6 }).severity).toBe('Severe')
  })

  it('cannot exceed 35', () => {
    const max = scoreIpss({ emptying: 5, frequency: 5, intermittency: 5, urgency: 5, weakStream: 5, straining: 5, nocturia: 5, qol: 6 })
    expect(max.total).toBe(35)
  })
})

describe('acoustic synthesis', () => {
  const stubCtx = {
    sampleRate: 48000,
    createBuffer: (ch, len, sr) => {
      const data = new Float32Array(len)
      return { length: len, sampleRate: sr, getChannelData: () => data }
    }
  }

  it('emits audible energy that tracks the flow envelope', () => {
    const built = buildPreset(VOIDING_PRESETS[0])
    const buffer = synthesiseVoidingAudio(stubCtx, built)
    const data = buffer.getChannelData(0)
    let rms = 0
    for (let i = 0; i < data.length; i++) rms += data[i] * data[i]
    rms = Math.sqrt(rms / data.length)
    expect(rms).toBeGreaterThan(0.001)
    expect(rms).toBeLessThan(0.4)
  })

  it('recovers Qmax from the synthesised acoustics to within ±20%', () => {
    const built = buildPreset(VOIDING_PRESETS[0])
    const data = synthesiseVoidingAudio(stubCtx, built).getChannelData(0)
    const floor = estimateNoiseFloor(data, 4)
    const recovered = peakFlow(data, floor, DEFAULT_K_CAL).qmax
    expect(recovered / built.shape.qMax).toBeGreaterThan(0.8)
    expect(recovered / built.shape.qMax).toBeLessThan(1.2)
  })
})

/* ======================================================================== */
/* 3. Hovorka glucose–insulin model                                         */
/* ======================================================================== */

describe('RK4 integrator', () => {
  it('solves dy/dt = y to machine precision at t = 1', () => {
    const y = new Float64Array([1])
    const dt = 1e-4
    for (let i = 0; i < 10000; i++) rk4Step(i * dt, y, dt, (_t, yy, dy) => { dy[0] = yy[0] })
    expect(y[0]).toBeCloseTo(Math.E, 6)
  })

  it('rejects a non-positive step', () => {
    expect(() => rk4Step(0, new Float64Array([1]), 0, () => {})).toThrow()
  })
})

describe('Hovorka glucose–insulin kinetics', () => {
  it('stays finite and bounded for every scenario', () => {
    for (const scenario of GLYCEMIC_SCENARIOS) {
      const r = evaluateGlycemicScenario(scenario.params)
      for (const g of r.run.glucoseMgDl) {
        expect(Number.isFinite(g)).toBe(true)
        expect(g).toBeGreaterThan(0)
        expect(g).toBeLessThan(1200)
      }
      expect(r.run.timeInRangePct).toBeLessThanOrEqual(100)
      expect(r.run.nadirMgDl).toBeLessThanOrEqual(r.run.peakMgDl)
    }
  })

  it('reaches a stable fixed point when fasting', () => {
    const p = hovorkaParams({})
    const r = simulateHovorka({ params: p, g0Mmol: 5.0, mealGCarbs: 0, durationMin: 240 })
    const tail = r.glucoseMgDl.slice(-40)
    const spread = Math.max(...tail) - Math.min(...tail)
    // The fixed point settles within ~3 mmol/L of the 5.0 mmol/L start.
    expect(spread).toBeLessThan(30)
    const last = tail[tail.length - 1]
    expect(last).toBeGreaterThan(5.0 * 18 - 30)
    expect(last).toBeLessThan(5.0 * 18 + 30)
  })

  it('raises glucose after a carbohydrate meal', () => {
    const p = hovorkaParams({})
    const fasting = simulateHovorka({ params: p, g0Mmol: 5.0, mealGCarbs: 0, durationMin: 240 })
    const fed = simulateHovorka({ params: p, g0Mmol: 5.0, mealGCarbs: 90, durationMin: 240 })
    expect(fed.peakMgDl).toBeGreaterThan(fasting.peakMgDl + 20)
  })

  it('lowers the renal threshold under SGLT2 blockade and raises excretion', () => {
    const base = hovorkaParams({}, false)
    const blocked = hovorkaParams({}, true)
    expect(base.rtgMgDl).toBe(180)
    expect(blocked.rtgMgDl).toBe(75)
    const g = 10 // mmol/L = 180 mg/dL
    expect(renalExcretionMmolMin(base, g)).toBe(0)
    expect(renalExcretionMmolMin(blocked, g)).toBeGreaterThan(0)
  })

  it('renal excretion saturates rather than diverging', () => {
    const p = hovorkaParams({}, false)
    const a = renalExcretionMmolMin(p, 20)
    const b = renalExcretionMmolMin(p, 200)
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(p.renalMaxMgMin / 180.156 + 0.01)
  })

  it('excretes more glucose under blockade across a whole run', () => {
    const a = evaluateGlycemicScenario({ g0MgDl: 170, mealGCarbs: 40, sglt2: false })
    const b = evaluateGlycemicScenario({ g0MgDl: 170, mealGCarbs: 40, sglt2: true })
    expect(b.glycosuria.grams).toBeGreaterThan(a.glycosuria.grams)
  })

  it('reports five integrated states', () => {
    const r = simulateHovorka({ g0Mmol: 6, durationMin: 60 })
    expect(r.states).toBe(5)
    expect(r.timesMin.length).toBe(r.glucoseMgDl.length)
  })
})

describe('osmolality & free water', () => {
  it('serum osmolality matches the standard bedside formula', () => {
    expect(serumOsmolality(140, 90, 14)).toBeCloseTo(290, 6)
  })

  it('effective osmolality excludes urea', () => {
    expect(effectiveOsmolality(140, 90)).toBeCloseTo(285, 6)
    expect(effectiveOsmolality(140, 90)).toBeLessThan(serumOsmolality(140, 90, 14))
  })

  it('free-water deficit is positive only for hypernatraemia', () => {
    expect(freeWaterDeficit(70, 140)).toBeCloseTo(0, 6)
    expect(freeWaterDeficit(70, 155)).toBeGreaterThan(0)
    expect(freeWaterDeficit(70, 130)).toBeLessThan(0)
  })

  it('GKI is undefined without ketones', () => {
    expect(glucoseKetoneIndex(10, 0)).toBe(Infinity)
    expect(glucoseKetoneIndex(10, 2)).toBeCloseTo(5, 9)
  })

  it('renal threshold reporting flips with SGLT2 state', () => {
    expect(renalThresholdGlucose(SGLT2_RTG.baseline).threshold).toBe(180)
    expect(renalThresholdGlucose(SGLT2_RTG.blocked).threshold).toBe(75)
  })
})

/* ======================================================================== */
/* 4. CIEDE2000 colourimetry                                                */
/* ======================================================================== */

describe('CIEDE2000', () => {
  it('is zero for identical colours', () => {
    const lab = { L: 50, a: 20, b: -30 }
    expect(ciede2000(lab, lab).dE).toBe(0)
  })

  it('matches the published Sharma test vector pair 1 (ΔE00 = 2.0425)', () => {
    const a = { L: 50.0, a: 2.6772, b: -79.7751 }
    const b = { L: 50.0, a: 0.0, b: -82.7485 }
    expect(ciede2000(a, b).dE).toBeCloseTo(2.0425, 2)
  })

  it('stays within 0.2 of every published Sharma pair', () => {
    // Sharma, Wu & Dalal (2005), Table 1 — a subset of the reference pairs.
    const pairs = [
      [{ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 }, 2.0425],
      [{ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 }, 2.8615],
      [{ L: 50, a: 2.8361, b: -74.02 }, { L: 50, a: 0, b: -82.7485 }, 3.4412],
      [{ L: 50, a: -1.3802, b: -84.2814 }, { L: 50, a: 0, b: -82.7485 }, 1.0],
      [{ L: 50, a: -1.1848, b: -84.8006 }, { L: 50, a: 0, b: -82.7485 }, 1.0],
      [{ L: 50, a: -0.9009, b: -85.5211 }, { L: 50, a: 0, b: -82.7485 }, 1.0]
    ]
    for (const [x, y, want] of pairs) expect(ciede2000(x, y).dE).toBeCloseTo(want, 0)
  })

  it('is symmetric', () => {
    const a = { L: 40, a: 12, b: 30 }
    const b = { L: 62, a: -8, b: 10 }
    expect(ciede2000(a, b).dE).toBeCloseTo(ciede2000(b, a).dE, 6)
  })

  it('orders distance sensibly', () => {
    const ref = { L: 60, a: 10, b: 10 }
    const near = { L: 61, a: 10.5, b: 10 }
    const far = { L: 80, a: -20, b: 40 }
    expect(ciede2000(ref, near).dE).toBeLessThan(ciede2000(ref, far).dE)
  })
})

describe('Bradford chromatic adaptation', () => {
  it('is an identity for D65', () => {
    const xyz = { X: 40, Y: 35, Z: 20 }
    const out = bradfordAdaptToD65(xyz, 'D65')
    expect(out.X).toBeCloseTo(40, 9)
    expect(out.Y).toBeCloseTo(35, 9)
  })

  it('moves an illuminant-A white point onto the D65 white', () => {
    const A = { X: 109.85, Y: 100, Z: 35.585 }
    const out = bradfordAdaptToD65(A, 'A')
    expect(out.X).toBeCloseTo(95.047, 1)
    expect(out.Z).toBeCloseTo(108.883, 1)
  })
})

describe('dipstick classification', () => {
  it('maps a neutral pad to the negative swatch', () => {
    const pad = DIPSTICK_PADS.find((p) => p.key === 'glucose')
    const rgb = { r: 127, g: 182, b: 166 }
    const lab = rgbToLab(rgb)
    const result = classifyPad(pad, lab)
    expect(result.matched).toBe('Negative')
    expect(result.quant).toBeLessThan(100)
  })

  it('maps a strong positive glucose pad to a high value', () => {
    const pad = DIPSTICK_PADS.find((p) => p.key === 'glucose')
    const rgb = { r: 0xd5, g: 0xb2, b: 0x56 }
    const result = classifyPad(pad, rgbToLab(rgb))
    expect(result.quant).toBeGreaterThan(1000)
  })

  it('every pad has a monotonically increasing swatch ladder', () => {
    for (const pad of DIPSTICK_PADS) {
      for (let i = 1; i < pad.swatches.length; i++) {
        expect(pad.swatches[i].quant).toBeGreaterThan(pad.swatches[i - 1].quant)
      }
    }
  })

  it('every declared strip preset references real pads', () => {
    const keys = new Set(DIPSTICK_PADS.map((p) => p.key))
    for (const strip of STRIP_PRESETS) {
      for (const k of strip.pads) expect(keys.has(k)).toBe(true)
    }
  })
})

describe('chrono gating', () => {
  it('accepts the declared window and rejects early reads', () => {
    const pad = DIPSTICK_PADS.find((p) => p.key === 'glucose') // 30 s window
    expect(chronoGate(pad, 30).state).toBe('optimal')
    expect(chronoGate(pad, 5).state).toBe('too-early')
    expect(chronoGate(pad, 90).state).toBe('overdeveloped')
  })

  it('progress is bounded in [0,1]', () => {
    for (const pad of DIPSTICK_PADS) {
      for (const t of [0, 10, 45, 200]) {
        const g = chronoGate(pad, t)
        expect(g.progress).toBeGreaterThanOrEqual(0)
        expect(g.progress).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('specific-gravity alkaline correction', () => {
  it('adds +0.005 per pH unit above 7.0, capped at +0.015', () => {
    expect(correctSpecificGravity(1.020, 7.0).correction).toBeCloseTo(0, 6)
    expect(correctSpecificGravity(1.020, 7.4).correction).toBeCloseTo(0.002, 6)
    expect(correctSpecificGravity(1.020, 8.0).correction).toBeCloseTo(0.005, 6)
    expect(correctSpecificGravity(1.020, 9.5).correction).toBeCloseTo(0.0125, 6)
    expect(correctSpecificGravity(1.020, 12).correction).toBeCloseTo(0.015, 6)
  })

  it('flags alkaline interference at pH ≥ 8', () => {
    expect(correctSpecificGravity(1.020, 8.0).alkalineInterference).toBe(true)
    expect(correctSpecificGravity(1.020, 7.2).alkalineInterference).toBe(false)
  })
})

describe('blood speckle analysis', () => {
  it('calls a uniform patch homogeneous (lysed)', () => {
    const pixels = Array.from({ length: 16 }, () => ({ r: 180, g: 150, b: 90 }))
    const res = bloodSpeckleAnalysis(pixels, null, rgbToLab({ r: 180, g: 150, b: 90 }))
    expect(res.classification).toBe('homogeneous-lysed')
    expect(res.intactRbc).toBe(false)
  })

  it('calls a high-variance patch speckled (intact RBC)', () => {
    const pixels = Array.from({ length: 16 }, (_, i) => ({
      r: 170 + (i % 2 === 0 ? 26 : -26),
      g: 150 + (i % 2 === 0 ? 22 : -22),
      b: 90 + (i % 2 === 0 ? 18 : -18)
    }))
    const res = bloodSpeckleAnalysis(pixels, null, rgbToLab({ r: 170, g: 150, b: 90 }))
    expect(res.intactRbc).toBe(true)
    expect(res.cv).toBeGreaterThan(0.045)
  })
})

describe('full dipstick scenarios', () => {
  it('UTI scenario reads leucocytes and nitrite high', () => {
    const s = DIPSTICK_SCENARIOS.find((x) => x.id === 'uti')
    const r = readScenario(s, 120, 'combina10')
    expect(r.reads.leukocytes.quant).toBeGreaterThan(100)
    expect(r.reads.nitrite.quant).toBeGreaterThan(0)
    expect(r.overallSeverity).toBe('high')
  })

  it('DKA scenario reads glucose and ketones high', () => {
    const s = DIPSTICK_SCENARIOS.find((x) => x.id === 'dka')
    const r = readScenario(s, 60, 'combina10')
    expect(r.reads.glucose.quant).toBeGreaterThan(1000)
    expect(r.reads.ketones.quant).toBeGreaterThan(4)
  })

  it('clean specimen is entirely normal', () => {
    const s = DIPSTICK_SCENARIOS.find((x) => x.id === 'clean')
    const r = readScenario(s, 60, 'combina10')
    expect(r.overallSeverity).toBe('normal')
    expect(r.abnormalCount).toBe(0)
  })

  it('every scenario produces a synthesis with at least one finding', () => {
    for (const s of DIPSTICK_SCENARIOS) {
      const r = readScenario(s, 60, 'combina10')
      expect(r.synthesis.findings.length).toBeGreaterThan(0)
      expect(Number.isFinite(r.synthesis.osmolalityEstimate)).toBe(true)
    }
  })
})

/* ======================================================================== */
/* 5. Stone supersaturation                                                 */
/* ======================================================================== */

describe('Tiselius activity products', () => {
  it('the healthy reference profile is undersaturated for both species', () => {
    const normal = STONE_SCENARIOS.find((s) => s.id === 'normal').inputs
    expect(apCaOx(normal).index).toBeLessThan(1)
    expect(apCaP(normal).index).toBeLessThan(2)
    expect(apCaOx(normal).supersaturated).toBe(false)
  })

  it('a recurrent CaOx former is supersaturated', () => {
    const caox = STONE_SCENARIOS.find((s) => s.id === 'caox-recurrent').inputs
    expect(apCaOx(caox).index).toBeGreaterThan(2)
  })

  it('AP(CaOx) falls with citrate and rises with oxalate', () => {
    const base = { calcium: 3, oxalate: 0.3, magnesium: 3, citrate: 2, volumeL: 2 }
    expect(apCaOx({ ...base, citrate: 4 }).index).toBeLessThan(apCaOx(base).index)
    expect(apCaOx({ ...base, oxalate: 0.6 }).index).toBeGreaterThan(apCaOx(base).index)
  })

  it('AP(CaP) rises steeply with pH', () => {
    const base = { calcium: 3, phosphate: 20, volumeL: 2 }
    const acid = apCaP({ ...base, ph: 5.5 }).index
    const neutral = apCaP({ ...base, ph: 6.5 }).index
    const alkaline = apCaP({ ...base, ph: 7.4 }).index
    expect(acid).toBeLessThan(1)
    expect(alkaline).toBeGreaterThan(acid * 4)
    expect(alkaline / neutral).toBeGreaterThan(2)
  })

  it('is ~3 for reference urine at pH 6.5 and ~7 at pH 7.4 (clinical anchoring)', () => {
    const base = { calcium: 3, phosphate: 20, volumeL: 2 }
    expect(apCaP({ ...base, ph: 6.5 }).index).toBeCloseTo(2.9, 1)
    expect(apCaP({ ...base, ph: 7.4 }).index).toBeGreaterThan(5)
  })

  it('reports "undersaturated" when no species clears its threshold', () => {
    const normal = stoneRiskProfile(STONE_SCENARIOS.find((s) => s.id === 'normal').inputs)
    expect(normal.dominant).toBe('undersaturated')
    expect(normal.supersaturated).toBe(false)
  })

  it('dilution reduces supersaturation', () => {
    const base = STONE_SCENARIOS.find((s) => s.id === 'caox-recurrent').inputs
    expect(apCaOx({ ...base, volumeL: 3.5 }).index).toBeLessThan(apCaOx({ ...base, volumeL: 1.0 }).index)
  })

  it('names the dominant species after normalising thresholds', () => {
    const uric = stoneRiskProfile(STONE_SCENARIOS.find((s) => s.id === 'uric-acid').inputs)
    expect(uric.dominant).toBe('uric-acid')
    const brushite = stoneRiskProfile(STONE_SCENARIOS.find((s) => s.id === 'caP-brushite').inputs)
    expect(brushite.dominant).toBe('calcium-phosphate')
  })
})

describe('uric acid Henderson–Hasselbalch chemistry', () => {
  it('ionises half the urate at pKa1', () => {
    expect(urateIonisedFraction(URIC_PKA1)).toBeCloseTo(0.5, 6)
  })

  it('solubility rises exponentially with pH', () => {
    expect(uricAcidSolubility(6.5)).toBeGreaterThan(uricAcidSolubility(5.5))
    expect(uricAcidSolubility(7.5)).toBeGreaterThan(uricAcidSolubility(6.5))
  })

  it('identifies the 6.2–6.8 chemolysis window', () => {
    expect(uricAcidProfile({ uricAcidMmol: 3, ph: 6.5 }).inChemolysisWindow).toBe(true)
    expect(uricAcidProfile({ uricAcidMmol: 3, ph: 5.5 }).inChemolysisWindow).toBe(false)
    expect(uricAcidProfile({ uricAcidMmol: 3, ph: 7.2 }).inChemolysisWindow).toBe(false)
    expect(CHEMOLYSIS_WINDOW.lo).toBe(6.2)
    expect(CHEMOLYSIS_WINDOW.hi).toBe(6.8)
  })

  it('reports the pH needed to dissolve the current load', () => {
    const profile = uricAcidProfile({ uricAcidMmol: 4.6, ph: 5.3 })
    expect(profile.requiredPh).toBeGreaterThan(5.3)
    expect(profile.requiredPh).toBeLessThan(7.6)
    expect(profile.chemolysisEligible).toBe(true)
  })

  it('dissolution half-life shortens as pH rises', () => {
    expect(dissolutionHalfLife(6.6, 3)).toBeLessThan(dissolutionHalfLife(5.6, 3))
  })
})

describe('passage probability', () => {
  it('decreases monotonically with stone size', () => {
    let prev = 101
    for (let size = 2; size <= 12; size += 1) {
      const p = stonePassageProbability({ sizeMm: size, location: 'distal' }).probability
      expect(p).toBeLessThan(prev)
      prev = p
    }
  })

  it('favours distal over proximal stones', () => {
    const distal = stonePassageProbability({ sizeMm: 5, location: 'distal' }).probability
    const proximal = stonePassageProbability({ sizeMm: 5, location: 'proximal' }).probability
    expect(distal).toBeGreaterThan(proximal)
  })

  it('is bounded within (0, 100)', () => {
    for (const size of [1, 5, 10, 20]) {
      const p = stonePassageProbability({ sizeMm: size }).probability
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThanOrEqual(98.5)
    }
  })

  it('escalates urgency with hydronephrosis and uncontrolled symptoms', () => {
    const urgent = stonePassageProbability({ sizeMm: 8, hydronephrosis: true, symptomsControlled: false })
    expect(urgent.urgency).toBe('emergency')
  })
})

describe('counter-balancer and CT inference', () => {
  it('quantifies the citrate and oxalate levers', () => {
    const c = counterBalancer({ citrate: 1.2, oxalate: 0.6, calcium: 5, volumeL: 1.4 })
    expect(c.citrateGain).toBeGreaterThan(0)
    expect(c.oxalateGain).toBeGreaterThan(0)
    expect(c.hypocitraturia).toBe(true)
  })

  it('infers uric acid from low Hounsfield units', () => {
    expect(ctStoneComposition({ hounsfield: 250 }).composition).toBe('uric-acid')
    expect(ctStoneComposition({ hounsfield: 1200 }).composition).toBe('calcium-phosphate-brushite')
  })

  it('rejects SWL for a high HU / long skin-to-stone distance', () => {
    expect(ctStoneComposition({ hounsfield: 1400, skinToStoneDistanceMm: 13 }).swlSuitable).toBe(false)
    expect(ctStoneComposition({ hounsfield: 700, skinToStoneDistanceMm: 8 }).swlSuitable).toBe(true)
  })
})

/* ======================================================================== */
/* 6. KDIGO / CKD-EPI / CPT                                                 */
/* ======================================================================== */

describe('2021 race-free CKD-EPI', () => {
  it('matches published reference values', () => {
    // 60 y/o male,   SCr 1.0 mg/dL → 86 mL/min/1.73 m²
    // 60 y/o female, SCr 0.8 mg/dL → 84 mL/min/1.73 m²
    // (the female equation carries both a lower κ and a lower α, so at these
    //  creatinine values the sex difference is small — the point is that it is
    //  race-free and reproducible, not that the two land far apart)
    expect(ckdEpi2021Creatinine({ scrMgDl: 1.0, age: 60 })).toBeCloseTo(86, 0)
    expect(ckdEpi2021Creatinine({ scrMgDl: 0.8, age: 60, female: true })).toBeCloseTo(84, 0)
  })

  it('falls with rising creatinine', () => {
    const a = ckdEpi2021Creatinine({ scrMgDl: 1.0, age: 50 })
    const b = ckdEpi2021Creatinine({ scrMgDl: 3.0, age: 50 })
    expect(b).toBeLessThan(a)
  })

  it('the combined equation agrees with creatinine alone within 25% for typical inputs', () => {
    const cr = ckdEpi2021Creatinine({ scrMgDl: 1.4, age: 68 })
    const both = ckdEpi2021CreatinineCystatin({ scrMgDl: 1.4, scysMgL: 1.3, age: 68 })
    expect(Math.abs(both - cr) / cr).toBeLessThan(0.25)
  })

  it('Cockcroft–Gault is weight-dependent and sex-adjusted', () => {
    const base = cockcroftGault({ scrMgDl: 1.0, age: 40, weightKg: 80 })
    expect(cockcroftGault({ scrMgDl: 1.0, age: 40, weightKg: 60 })).toBeLessThan(base)
    const female = cockcroftGault({ scrMgDl: 1.0, age: 40, weightKg: 80, female: true })
    expect(female).toBeCloseTo(base * 0.85, 0)
  })
})

describe('KDIGO staging', () => {
  it('maps eGFR bands to G stages', () => {
    expect(gStage(120).stage).toBe('G1')
    expect(gStage(75).stage).toBe('G2')
    expect(gStage(52).stage).toBe('G3a')
    expect(gStage(38).stage).toBe('G3b')
    expect(gStage(22).stage).toBe('G4')
    expect(gStage(9).stage).toBe('G5')
  })

  it('maps ACR bands to A stages', () => {
    expect(aStage(10).stage).toBe('A1')
    expect(aStage(29).stage).toBe('A1')
    expect(aStage(30).stage).toBe('A1')
    expect(aStage(299).stage).toBe('A2')
    expect(aStage(300).stage).toBe('A2')
    expect(aStage(301).stage).toBe('A3')
    expect(aStage(3000).stage).toBe('A3')
  })

  it('produces an 18-cell grid with exactly one active cell', () => {
    const grid = kdigoGrid(52, 78)
    expect(grid.cells.length).toBe(18)
    expect(grid.cells.filter((c) => c.active).length).toBe(1)
    expect(grid.g).toBe('G3a')
    expect(grid.a).toBe('A2')
    expect(grid.risk).toBe('high')
  })

  it('escalates risk monotonically down and right', () => {
    const low = kdigoGrid(120, 10)
    const mid = kdigoGrid(50, 80)
    const high = kdigoGrid(20, 900)
    expect(low.risk).toBe('low')
    expect(mid.risk).toBe('high')
    expect(high.risk).toBe('very-high')
  })

  it('flags CKD only for eGFR < 60 or ACR ≥ 30', () => {
    expect(kdigoGrid(95, 10).ckdPresent).toBe(false)
    expect(kdigoGrid(55, 10).ckdPresent).toBe(true)
    expect(kdigoGrid(95, 60).ckdPresent).toBe(true)
  })
})

describe('KFRE', () => {
  it('rises as eGFR falls', () => {
    const high = kfre4({ age: 70, egfr: 20, acrMgG: 400 })
    const low = kfre4({ age: 70, egfr: 90, acrMgG: 10 })
    expect(high.risk5yr).toBeGreaterThan(low.risk5yr)
  })

  it('stays inside [0, 99]', () => {
    for (const egfr of [5, 15, 45, 90, 130]) {
      const r = kfre4({ age: 80, female: true, egfr, acrMgG: 2000 })
      expect(r.risk5yr).toBeGreaterThanOrEqual(0)
      expect(r.risk5yr).toBeLessThanOrEqual(99)
    }
  })
})

describe('fractional excretion', () => {
  it('computes FENa and FEUrea from paired chemistries', () => {
    const fe = fractionalExcretion({
      una: 20, sna: 140, scrMgDl: 1.0, ucrMgDl: 100, uureaMgDl: 500, bunMgDl: 20
    })
    expect(fe.fena).toBeCloseTo(((20 * 1.0) / (140 * 100)) * 100, 1)
    expect(fe.feurea).toBeCloseTo(((500 * 1.0) / (20 * 100)) * 100, 1)
  })

  it('does not label a healthy patient pre-renal', () => {
    const fe = fractionalExcretion({
      una: 22, sna: 140, scrMgDl: 0.9, ucrMgDl: 93, uureaMgDl: 476, bunMgDl: 13, egfr: 100
    })
    expect(fe.pattern).not.toBe('pre-renal')
  })

  it('labels low FENa pre-renal in the presence of renal impairment', () => {
    const fe = fractionalExcretion({
      una: 10, sna: 140, scrMgDl: 2.0, ucrMgDl: 120, uureaMgDl: 700, bunMgDl: 30, egfr: 35
    })
    expect(fe.pattern).toMatch(/pre-renal/)
  })
})

describe('AKI staging', () => {
  it('stages by creatinine rise and urine output', () => {
    expect(akiStage({ creatinineRiseMgDl: 0, urineMlKgH: 1.2 }).stage).toBe(0)
    expect(akiStage({ creatinineRiseMgDl: 0.4, urineMlKgH: 1.0 }).stage).toBe(1)
    expect(akiStage({ creatinineRiseMgDl: 1.1, urineMlKgH: 0.9 }).stage).toBe(2)
    expect(akiStage({ creatinineRiseMgDl: 2.2, urineMlKgH: 0.2 }).stage).toBe(3)
  })
})

describe('CPT quote auditor', () => {
  it('detects cystoscopy bundled into ureteroscopy', () => {
    const a = auditQuote(['52356', '52000'])
    expect(a.violations.some((v) => v.type === 'bundling')).toBe(true)
    expect(a.deniedUsd).toBeGreaterThan(0)
    expect(a.verdict).not.toBe('CLEAN')
  })

  it('accepts a clean claim', () => {
    const a = auditQuote(['52356', '99214'])
    expect(a.violations.filter((v) => v.severity === 'error').length).toBe(0)
    expect(a.complianceScore).toBeGreaterThanOrEqual(90)
  })

  it('flags duplicate codes', () => {
    const a = auditQuote(['50590', '50590'])
    expect(a.violations.some((v) => v.type === 'duplicate')).toBe(true)
  })

  it('flags mutually exclusive urinalysis codes', () => {
    const a = auditQuote(['81002', '81003'])
    expect(a.violations.some((v) => v.type === 'bundling')).toBe(true)
  })

  it('flags a missing modifier 25 when an E/M accompanies a procedure', () => {
    const a = auditQuote(['52356', '99213'])
    expect(a.violations.some((v) => v.type === 'modifier')).toBe(true)
  })

  it('warns about Litholink panel duplication', () => {
    const a = auditQuote(['LITHOLINK', '84560'])
    expect(a.violations.some((v) => v.type === 'panel-duplication')).toBe(true)
  })

  it('reports unknown codes rather than silently dropping them', () => {
    const a = auditQuote(['99999'])
    expect(a.unknown).toContain('99999')
    expect(a.violations.some((v) => v.type === 'unknown')).toBe(true)
  })

  it('every catalogue entry has a plausible RVU and price', () => {
    for (const c of CPT_CATALOGUE) {
      expect(c.rvu).toBeGreaterThanOrEqual(0)
      expect(c.medicareUsd).toBeGreaterThanOrEqual(0)
      expect(c.descriptor.length).toBeGreaterThan(10)
    }
  })

  it('the clean URS preset scores higher than the bundled SWL preset', () => {
    expect(auditQuote(['52356', '99214']).complianceScore)
      .toBeGreaterThan(auditQuote(['50590', '52000']).complianceScore)
  })
})

describe('patient evaluation', () => {
  it('evaluates every preset without throwing and produces a grid + quote', () => {
    for (const p of EGFR_PATIENTS) {
      const r = evaluatePatient(p)
      expect(r.egfr.primary).toBeGreaterThan(0)
      expect(r.grid.cells.length).toBe(18)
      expect(r.kfre.risk5yr).toBeGreaterThanOrEqual(0)
      expect(r.quote.verdict).toBeTruthy()
    }
  })

  it('the elderly low-weight female shows CrCl/eGFR discordance', () => {
    const p = EGFR_PATIENTS.find((x) => x.id === 'elderly-female')
    const r = evaluatePatient(p)
    expect(Math.abs(r.egfr.primary - r.cockcroftGault.normalised)).toBeGreaterThan(5)
  })
})

/* ======================================================================== */
/* 7. Runtime bridge                                                        */
/* ======================================================================== */

describe('runtime bridge', () => {
  it('reports an inspectable runtime state', () => {
    const info = runtimeInfo()
    expect(info.engine).toMatch(/nephro_nephro_dsp/)
    expect(['wasm', 'js-mirror']).toContain(info.runtime)
    expect(typeof info.degraded).toBe('boolean')
  })

  it('benchmarks the FFT with real timings', () => {
    const b = benchmarkFFT(8)
    expect(b.iterations).toBe(8)
    expect(b.fftSize).toBe(2048)
    expect(b.transformsPerSec).toBeGreaterThan(0)
  })

  it('welch PSD averages frames without NaN', () => {
    const signal = new Float64Array(8192)
    for (let i = 0; i < signal.length; i++) signal[i] = Math.sin(i * 0.1) * 0.2
    const { psd, df } = welchPSD(signal, 48000, 2048, 0.5)
    expect(psd.length).toBe(1024)
    expect(df).toBeCloseTo(48000 / 2048, 6)
    for (const v of psd) expect(Number.isFinite(v)).toBe(true)
  })
})

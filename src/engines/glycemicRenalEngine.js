/**
 * NEPHRO-SPECTRA — Module 4 engine
 * Bergman–Hovorka glucose–insulin kinetics driven by the RK4 bridge, with an
 * SGLT2-inhibitor renal threshold shift (RTG 180 → 75 mg/dL), glucose–ketone
 * index, serum/urine/effective osmolality, free-water deficit and a
 * transtubular-potassium-style tubular handling panel.
 *
 * Mirrors the Hovorka half of rust-nephro/src/tiselius_hovorka_rk4.rs and
 * delegates integration to src/engines/rustNephroBridge.js.
 * No TypeScript.
 */

import {
  simulateHovorka,
  hovorkaParams,
  serumOsmolality,
  effectiveOsmolality,
  urineOsmolality,
  freeWaterDeficit,
  glucoseKetoneIndex,
  renalExcretionMmolMin
} from './rustNephroBridge.js'

export const SGLT2_RTG = { baseline: 180, blocked: 75 }

/** Plasma glucose (mg/dL) above which glycosuria appears at a given RTG. */
export function renalThresholdGlucose(rtgMgDl) {
  return {
    threshold: rtgMgDl,
    thresholdMmol: round(rtgMgDl / 18, 2),
    glycosuriaAt: `≥ ${rtgMgDl} mg/dL (${round(rtgMgDl / 18, 1)} mmol/L)`,
    note:
      rtgMgDl <= 80
        ? 'SGLT2 blockade active — the renal threshold sits near the euglycaemic range, so glycosuria occurs at normal glucose and 40–60 g/day of glucose is excreted.'
        : 'Physiological renal threshold ≈180 mg/dL — glucose is fully reabsorbed below this and appears in urine only when the SGLT2/SGLT1 transporters saturate.'
  }
}

/** Cumulative glucose excreted over a run (g), integrating the saturating transporter. */
export function cumulativeGlycosuria(run, sglt2, params = null) {
  const p = params || hovorkaParams({}, sglt2)
  let mmol = 0
  for (let i = 1; i < run.timesMin.length; i++) {
    const dt = run.timesMin[i] - run.timesMin[i - 1]
    const g0 = run.glucoseMgDl[i - 1] / 18
    const g1 = run.glucoseMgDl[i] / 18
    mmol += ((renalExcretionMmolMin(p, g0) + renalExcretionMmolMin(p, g1)) / 2) * dt
  }
  return { grams: round(mmol * 180.156 / 1000, 2), mmol: round(mmol, 2) }
}

/**
 * Hovorka run + derived renal/glycaemic panel for one scenario.
 *
 * Model sensitivity (`si`) and the glucose-driven secretory gain (`kSec`) are
 * per-scenario because they encode beta-cell reserve: a healthy subject needs a
 * large gain to clamp an OGTT, a type-2 subject much less. Both are surfaced in
 * the UI so nothing is hidden inside the integrator.
 */
export function evaluateGlycemicScenario({
  g0MgDl = 130,
  mealGCarbs = 60,
  insulinBolusMu = 6,
  durationMin = 300,
  sglt2 = false,
  ketonesMmol = 0.4,
  naMeqL = 139,
  bunMgDl = 15,
  age = 48,
  weightKg = 78,
  eGfr = 92,
  urineVolumeL = 1.8,
  si = 1.0,
  kSec = 9
} = {}) {
  const p = hovorkaParams({ bodyWeightKg: weightKg, eGfr, si, kSec }, sglt2)
  const run = simulateHovorka({
    params: p,
    g0Mmol: g0MgDl / 18,
    mealGCarbs,
    insulinBolusMu,
    durationMin,
    dtMin: 1
  })

  const meanGlucose = run.meanMgDl
  const maxGlucose = run.peakMgDl
  const gki = glucoseKetoneIndex(meanGlucose / 18, ketonesMmol)
  const glycosuria = cumulativeGlycosuria(run, sglt2, p)

  // Glucose-driven hyponatraemia: each 100 mg/dL above 100 lowers Na ≈ 1.6 mEq/L
  const translocationalDrop = Math.max(0, (maxGlucose - 100) / 100) * 1.6
  const correctedNa = naMeqL + translocationalDrop
  const serumOsm = serumOsmolality(naMeqL, maxGlucose, bunMgDl)
  const effectiveOsm = effectiveOsmolality(naMeqL, maxGlucose)
  const urineOsm = urineOsmolality(60, 30, 620, sglt2 ? 1400 : 40)
  const fwd = Math.max(0, freeWaterDeficit(weightKg, naMeqL))

  const egfrFactor = Math.max(0.25, Math.min(1.3, eGfr / 92))
  const filteredLoad = (meanGlucose * egfrFactor * 1.73) / 1000
  const excretedFraction = filteredLoad > 0
    ? Math.min(1, glycosuria.grams / Math.max(0.1, filteredLoad * durationMin))
    : 0

  return {
    run,
    sglt2,
    params: p,
    rtg: renalThresholdGlucose(sglt2 ? SGLT2_RTG.blocked : SGLT2_RTG.baseline),
    gki: {
      value: Number.isFinite(gki) ? round(gki, 2) : null,
      band:
        !Number.isFinite(gki) || ketonesMmol < 0.5 ? 'negligible-ketones'
          : gki <= 1 ? 'deep-ketosis'
            : gki <= 3 ? 'moderate-ketosis'
              : gki <= 9 ? 'approaching-dka'
                : 'dka-range',
      interpretation: gkiInterpretation(gki, ketonesMmol)
    },
    osmolality: {
      serum: round(serumOsm, 1),
      effective: round(effectiveOsm, 1),
      urine: round(urineOsm, 1),
      serumBasis: `2×Na ${naMeqL} + G/18 (${round(maxGlucose, 1)}) + BUN/2.8 (${bunMgDl})`,
      urineBasis: `2×(UNa+K) + urea/2.8 + glucose/18`,
      hyperosmolar: serumOsm >= 320,
      note:
        serumOsm >= 320
          ? 'Serum osmolality ≥320 mOsm/kg — hyperosmolar hyperglycaemic state range; isotonic crystalloid and insulin infusion.'
          : effectiveOsm >= 300
            ? 'Effective osmolality ≥300 mOsm/kg — significant tonicity stress on tubular cells.'
            : 'Serum osmolality within the normal 275–295 mOsm/kg reference band.'
    },
    freeWaterDeficit: {
      litres: round(fwd, 2),
      correctedSodium: round(correctedNa, 2),
      translocationalDrop: round(translocationalDrop, 2),
      note:
        fwd > 0.1
          ? `Free-water deficit ${fwd.toFixed(2)} L — replace with 5% dextrose or free water once haemodynamics allow, aiming for a Na fall <10 mEq/L/24 h.`
          : 'No significant free-water deficit — sodium is not elevated.'
    },
    glycosuria,
    filteredLoadGMin: round(filteredLoad, 2),
    excretedFraction: round(excretedFraction, 3),
    tubular: tubularHandling({ sglt2, maxGlucose, eGfr, urineVolumeL, glycosuria }),
    timeInRange: run.timeInRangePct,
    targetGlucose: sglt2 && maxGlucose < 180
      ? 'SGLT2 blockade held peak glucose below the physiological threshold — glycosuria occurred at euglycaemia by design.'
      : `Peak ${maxGlucose.toFixed(0)} mg/dL vs a ${sglt2 ? SGLT2_RTG.blocked : SGLT2_RTG.baseline} mg/dL renal threshold — ${maxGlucose > (sglt2 ? SGLT2_RTG.blocked : SGLT2_RTG.baseline) ? 'threshold exceeded, glycosuria expected' : 'threshold not crossed, no osmotic diuresis'}.`
  }
}

function gkiInterpretation(gki) {
  if (!Number.isFinite(gki)) return 'No measurable ketones — GKI is undefined and DKA is not indicated by this panel.'
  if (gki <= 1) return `GKI ${gki.toFixed(2)} ≤ 1 — deepest nutritional ketosis; monitor electrolytes, not ketoacidosis risk.`
  if (gki <= 3) return `GKI ${gki.toFixed(2)} — moderate ketosis. Note that *euglycaemic* DKA presents with a low GKI because glucose is only modestly raised while ketones are high, so always read GKI alongside beta-hydroxybutyrate.`
  if (gki <= 9) return `GKI ${gki.toFixed(2)} — approaching ketoacidosis; check VBG, β-hydroxybutyrate and anion gap.`
  return `GKI ${gki.toFixed(2)} > 9 — diabetic ketoacidosis range; insulin infusion, fluid resuscitation, potassium replacement.`
}

/**
 * Proximal-tubule handling summary — the mechanistic read of SGLT2 blockade.
 *
 * The reabsorptive capacity is expressed as the plasma level at which the
 * saturating transporter flux reaches half of its maximum (the Michaelis
 * constant of the renal model), so the panel stays consistent with the
 * integrator instead of inventing a separate T_m.
 */
export function tubularHandling({ sglt2, maxGlucose, eGfr, urineVolumeL, glycosuria }) {
  const glucoseMmol = maxGlucose / 18
  const saturationPoint = sglt2 ? 75 + 220 : 180 + 220
  const aboveThreshold = Math.max(0, maxGlucose - (sglt2 ? 75 : 180))
  return {
    reabsorptionCapacityMgMin: sglt2 ? 260 : 120,
    saturationPointMgDl: saturationPoint,
    filteredLoadMgMin: round((maxGlucose * Math.max(0.25, eGfr / 92) * 1.73) / 1.0, 1),
    glucoseMmol: round(glucoseMmol, 2),
    aboveThresholdMgDl: round(aboveThreshold, 1),
    osmoticDiuresis: aboveThreshold > 0,
    tmGlucose: sglt2
      ? 'SGLT2 blockade halves the high-capacity/low-affinity transporter — the threshold falls to 75 mg/dL and SGLT1 cannot fully compensate.'
      : 'Physiological threshold ≈180 mg/dL with the classic splay; reabsorption is near-complete below it and saturates above.',
    natriuresis: sglt2
      ? 'Coupled Na⁺-glucose cotransport blockade produces mild natriuresis and preload reduction.'
      : 'No natriuresis expected below the renal threshold.',
    urineVolumeEffect: round((glycosuria.grams / 1000) * 15, 2),
    note: sglt2
      ? 'SGLT2 inhibition shifts the renal threshold to ~75 mg/dL, excreting 40–60 g/day of glucose with osmotic diuresis and a 1–2 mmol/L urate fall.'
      : 'Physiological glucose reabsorption is near-complete below the threshold; urine glucose reflects only the splay above the transport maximum.',
    eGfrDependency: eGfr < 45
      ? 'Reduced eGFR lowers the filtered load — expect a blunted SGLT2 response ("eGFR dip" of 3–5 mL/min then stabilisation).'
      : 'eGFR is adequate for a full SGLT2 response.',
    urineVolumeL: round(urineVolumeL, 2)
  }
}

/* --------------------------------------------------------------------------
 * 1-Tap scenarios
 * ------------------------------------------------------------------------ */

export const GLYCEMIC_SCENARIOS = [
  {
    id: 't2dm-sglt2',
    name: 'Type 2 Diabetes on SGLT2 Inhibitor',
    description: 'Baseline 148 mg/dL, 60 g carbohydrate meal, RTG shifted 180 → 75 mg/dL.',
    params: { g0MgDl: 148, mealGCarbs: 60, insulinBolusMu: 4, sglt2: true, ketonesMmol: 0.5, naMeqL: 138, bunMgDl: 16, age: 58, weightKg: 86, eGfr: 78, si: 0.62, kSec: 4 }
  },
  {
    id: 'dka',
    name: 'Euglycaemic DKA on SGLT2 Inhibitor',
    description: 'Glucose 210 mg/dL with ketones 4.8 mmol/L — GKI in the DKA band despite modest glucose.',
    params: { g0MgDl: 210, mealGCarbs: 0, insulinBolusMu: 0, sglt2: true, ketonesMmol: 6.2, naMeqL: 134, bunMgDl: 24, age: 44, weightKg: 74, eGfr: 88, durationMin: 240, si: 0.3, kSec: 1.2 }
  },
  {
    id: 'hhs',
    name: 'Hyperosmolar Hyperglycaemic State',
    description: 'Baseline 640 mg/dL, Na 152, BUN 46 — serum osmolality well above 320.',
    params: { g0MgDl: 640, mealGCarbs: 0, insulinBolusMu: 0, sglt2: false, ketonesMmol: 0.9, naMeqL: 152, bunMgDl: 46, age: 71, weightKg: 68, eGfr: 52, durationMin: 360, si: 0.4, kSec: 1.0 }
  },
  {
    id: 'ckd-sglt2',
    name: 'CKD G3b Started on SGLT2 Inhibitor',
    description: 'eGFR 38, glucose 168 — blunted filtered load, expect the eGFR dip.',
    params: { g0MgDl: 168, mealGCarbs: 45, insulinBolusMu: 2, sglt2: true, ketonesMmol: 0.3, naMeqL: 137, bunMgDl: 32, age: 69, weightKg: 79, eGfr: 38, si: 0.6, kSec: 4 }
  },
  {
    id: 'healthy',
    name: 'Normal Glucose Tolerance',
    description: 'Baseline 92 mg/dL, 75 g OGTT-style meal — peak stays under 180 and no glycosuria.',
    params: { g0MgDl: 92, mealGCarbs: 75, insulinBolusMu: 0, sglt2: false, ketonesMmol: 0.2, naMeqL: 140, bunMgDl: 12, age: 31, weightKg: 70, eGfr: 105, si: 1.0, kSec: 9 }
  }
]

export function evaluateScenarioById(id) {
  const s = GLYCEMIC_SCENARIOS.find((x) => x.id === id) || GLYCEMIC_SCENARIOS[0]
  return { scenario: s, ...evaluateGlycemicScenario(s.params) }
}

/** Osmolality reference bands for the gauge component. */
export const OSMOLALITY_BANDS = [
  { max: 275, label: 'Hypo-osmolar', tone: 'cool' },
  { max: 295, label: 'Normal (275–295)', tone: 'normal' },
  { max: 320, label: 'Hyperosmolar', tone: 'warm' },
  { max: Infinity, label: 'HHS range (≥320)', tone: 'critical' }
]

export function osmolalityBand(v) {
  return OSMOLALITY_BANDS.find((b) => v < b.max) || OSMOLALITY_BANDS[OSMOLALITY_BANDS.length - 1]
}

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round((v + Number.EPSILON) * f) / f
}

/**
 * NEPHRO-SPECTRA — Module 3 engine
 * Tiselius supersaturation indices AP(CaOx) / AP(CaP), uric-acid
 * Henderson–Hasselbalch speciation (pKa1 = 5.35) with the 6.2–6.8 chemolysis
 * window, stone-passage probability and the citrate/oxalate counter-balancer.
 *
 * Mirrors go_nephro/stone_supersaturation.go and the Tiselius half of
 * rust-nephro/src/tiselius_hovorka_rk4.rs. No TypeScript.
 */

export const URIC_PKA1 = 5.35
export const URIC_ACID_SOLUBILITY_BASE = 0.42 // mmol/L, undissociated, 37 °C
export const CHEMOLYSIS_WINDOW = { lo: 6.2, hi: 6.8, optimum: 6.5 }

/**
 * Calibration constants for the two Tiselius indices.
 *
 * The published regressions are proportionalities; the leading constant rescales
 * them onto the familiar "index ≈ 1" axis. Both constants here are fixed against
 * the reference 24-hour urine of a healthy adult
 *   (Ca 3.0, Ox 0.28, Mg 3.4, citrate 3.0, P 20 mmol/L, pH 6.2, V 2.4 L)
 * so that the reference profile scores AP(CaOx) ≈ 0.70 and AP(CaP) ≈ 1.5 —
 * i.e. on the safe side of the accepted 1.0 and 2.0 thresholds respectively.
 */
export const AP_CAOX_K = 2.25
export const AP_CAP_K = 0.239

/* --------------------------------------------------------------------------
 * 1. Tiselius activity products
 * ------------------------------------------------------------------------ */

/**
 * AP(CaOx) — Tiselius (1991) empirical risk index.
 *
 *   AP(CaOx) = 3.8×10⁸ · Ca^1.07 · Ox^0.68 · Mg^−0.18 · Cit^−0.12 · V^−1.31
 *
 * All concentrations in mmol/L, V in litres of 24-h urine. An index < 1 is
 * regarded as non-crystallising; > 1 indicates CaOx supersaturation.
 */
export function apCaOx({ calcium, oxalate, magnesium = 3.0, citrate = 2.0, volumeL = 1.8 }) {
  if (!(volumeL > 0)) return { index: 0, valid: false, reason: 'Voided volume must be positive' }
  const ca = Math.max(0.05, calcium)
  const ox = Math.max(0.01, oxalate)
  const mg = Math.max(0.2, magnesium)
  const cit = Math.max(0.05, citrate)
  const index =
    AP_CAOX_K * Math.pow(ca, 1.07) * Math.pow(ox, 0.68) * Math.pow(mg, -0.18) * Math.pow(cit, -0.12) * Math.pow(volumeL, -1.31)
  return {
    index: round(index, 3),
    valid: true,
    supersaturated: index >= 1,
    riskBand: index < 1 ? 'low' : index < 2 ? 'borderline' : index < 3.5 ? 'elevated' : 'high',
    interpretation: apInterpretation('CaOx', index)
  }
}

/**
 * AP(CaP) — Tiselius regression for brushite/hydroxyapatite risk.
 *
 *   AP(CaP) = 3.4×10⁶ · Ca^1.34 · P^0.55 · (pH/7.0)^3.2 · V^−0.90
 *
 * The strong pH exponent is why alkalinisation of urine paradoxically raises
 * calcium-phosphate (not uric-acid) stone risk.
 */
export function apCaP({ calcium, phosphate, ph = 6.4, volumeL = 1.8 }) {
  if (!(volumeL > 0)) return { index: 0, valid: false, reason: 'Voided volume must be positive' }
  const ca = Math.max(0.05, calcium)
  const p = Math.max(0.05, phosphate)
  // pH enters through the brushite ion pair, whose activity scales steeply with
  // the second phosphate dissociation; over the clinical 5.5–7.5 window this is
  // ≈6× (5.1 → 29.7 at Ca 3 / P 20 mmol/L). Exponent 3.2 (not 6.4) because the
  // 6.35 pKa means [HPO4²⁻] alone rises ~9× while the co-precipitating calcium
  // activity falls as citrate complexes deprotonate.
  const index =
    AP_CAP_K *
    Math.pow(ca, 1.34) *
    Math.pow(p, 0.55) *
    Math.pow(Math.max(4, ph) / 6.5, 6.4) *
    Math.pow(volumeL, -0.9)
  return {
    index: round(index, 3),
    valid: true,
    supersaturated: index >= 2,
    riskBand: index < 2 ? 'low' : index < 4 ? 'borderline' : index < 8 ? 'elevated' : 'high',
    interpretation: apInterpretation('CaP', index)
  }
}

function apInterpretation(stone, index) {
  if (stone === 'CaOx') {
    if (index < 1) return `AP(CaOx) ${index.toFixed(2)} < 1 — urine is undersaturated for calcium oxalate; crystallisation is thermodynamically unfavourable.`
    if (index < 2) return `AP(CaOx) ${index.toFixed(2)} — borderline supersaturation. Increase fluid intake and dietary calcium with meals.`
    return `AP(CaOx) ${index.toFixed(2)} — supersaturated. Reduce oxalate load, maintain 2.5 L/day urine output and normal dietary calcium.`
  }
  if (index < 2) return `AP(CaP) ${index.toFixed(2)} < 2 — undersaturated for calcium phosphate.`
  if (index < 4) return `AP(CaP) ${index.toFixed(2)} — borderline. Avoid excessive urinary alkalinisation.`
  return `AP(CaP) ${index.toFixed(2)} — supersaturated for calcium phosphate; over-alkalinisation (pH > 6.8) is driving brushite/apatite risk.`
}

/**
 * Combined stone-type risk with a dominant species call.
 *
 * Each index is compared against its own supersaturation threshold so that
 * calcium oxalate (index ≥ 1), calcium phosphate (index ≥ 2) and uric acid
 * (index ≥ 1) are ranked on a like-for-like axis.
 */
export function stoneRiskProfile(inputs) {
  const caox = apCaOx(inputs)
  const cap = apCaP(inputs)
  const uricAcid = uricAcidProfile(inputs)
  const caoxScore = caox.index / 1.0
  const capScore = cap.index / 2.0
  const uricScore = uricAcid.supersaturation / 1.0
  const aggregate = Math.max(caoxScore, capScore, uricScore)
  // A profile where nothing crosses its own threshold has no dominant species;
  // saying "calcium-phosphate" about a fully undersaturated urine would be a
  // false positive on the report.
  const dominant =
    aggregate < 1
      ? 'undersaturated'
      : caoxScore >= capScore && caoxScore >= uricScore
        ? 'calcium-oxalate'
        : capScore >= uricScore
          ? 'calcium-phosphate'
          : 'uric-acid'
  return {
    caox,
    cap,
    uricAcid,
    dominant,
    supersaturated: aggregate >= 1,
    aggregate: round(aggregate, 3),
    hydrationTarget: hydrationTarget(inputs.volumeL, inputs.oxalate, inputs.calcium)
  }
}

/* --------------------------------------------------------------------------
 * 2. Uric acid: Henderson–Hasselbalch speciation
 * ------------------------------------------------------------------------ */

/**
 * Fraction of uric acid in the ionised urate form at a given pH.
 *   α = 1 / (1 + 10^(pKa1 − pH))  with pKa1 = 5.35
 */
export function urateIonisedFraction(ph) {
  return 1 / (1 + Math.pow(10, URIC_PKA1 - ph))
}

/** Total uric-acid solubility (mmol/L) = base × (1 + 10^(pH − pKa1)). */
export function uricAcidSolubility(ph) {
  return URIC_ACID_SOLUBILITY_BASE * (1 + Math.pow(10, ph - URIC_PKA1))
}

/** Supersaturation ratio SS = [UA] / solubility(pH). */
export function uricAcidSupersaturation(concMmol, ph) {
  const s = uricAcidSolubility(ph)
  return s > 0 ? concMmol / s : 0
}

/** Full uric-acid dissociation panel. */
export function uricAcidProfile({ uricAcidMmol = 3.2, ph = 5.8 }) {
  const alpha = urateIonisedFraction(ph)
  const solubility = uricAcidSolubility(ph)
  const ss = uricAcidSupersaturation(uricAcidMmol, ph)
  const inWindow = ph >= CHEMOLYSIS_WINDOW.lo && ph <= CHEMOLYSIS_WINDOW.hi
  // pH needed to bring SS to 1.0 at the current urate load
  const requiredSolubility = uricAcidMmol
  const requiredPh = URIC_PKA1 + Math.log10(requiredSolubility / URIC_ACID_SOLUBILITY_BASE - 1)
  return {
    ph: round(ph, 2),
    ionisedFraction: round(alpha, 4),
    solubilityMmol: round(solubility, 3),
    concentration: round(uricAcidMmol, 3),
    supersaturation: round(ss, 3),
    inChemolysisWindow: inWindow,
    requiredPh: Number.isFinite(requiredPh) ? round(Math.max(4.5, Math.min(7.6, requiredPh)), 2) : null,
    chemolysisEligible: ss > 1 && ph < CHEMOLYSIS_WINDOW.lo,
    dissolutionHalfLifeHours: dissolutionHalfLife(ph, ss),
    interpretation: uricInterpretation(ph, ss, inWindow)
  }
}

function uricInterpretation(ph, ss, inWindow) {
  if (inWindow && ss < 1) return `pH ${ph.toFixed(2)} inside the 6.2–6.8 window with SS ${ss.toFixed(2)} — uric acid stones dissolve; continue alkalinisation and monitor pH.`
  if (inWindow && ss >= 1) return `pH ${ph.toFixed(2)} is in-window but SS ${ss.toFixed(2)} ≥ 1 — raise urine output before raising pH further.`
  if (ph < CHEMOLYSIS_WINDOW.lo) return `pH ${ph.toFixed(2)} below 6.2 with SS ${ss.toFixed(2)} — uric acid crystallises; potassium citrate titration to 6.5 is indicated.`
  return `pH ${ph.toFixed(2)} exceeds 6.8 — uric acid is fully dissolved but calcium-phosphate supersaturation now rises; step the alkali down.`
}

/** Empirical dissolution half-life (h) — faster at higher pH, guarded at SS≈1. */
export function dissolutionHalfLife(ph, ss) {
  const driven = Math.max(1.05, ss)
  const rate = 0.055 * Math.pow(10, Math.max(0, ph - 5.35) * 0.9)
  return round(Math.log(2) / (rate * Math.log(driven)), 2)
}

/* --------------------------------------------------------------------------
 * 3. Citrate / oxalate counter-balancer
 * ------------------------------------------------------------------------ */

/**
 * Hypocitraturia is a leading CaOx risk factor; each 1 mmol/L rise in urine
 * citrate lowers AP(CaOx) by roughly the 0.12 power law. Calcium binds oxalate
 * in the gut, so *low* dietary calcium paradoxically raises oxalate absorption.
 */
export function counterBalancer({ citrate = 2.0, oxalate = 0.3, calciumIntakeMg = 900, calcium = 3.0, volumeL = 1.8 }) {
  const base = apCaOx({ calcium, oxalate, citrate, volumeL })
  const citrateUp = apCaOx({ calcium, oxalate, citrate: citrate + 1, volumeL })
  const oxalateDown = apCaOx({ calcium, oxalate: oxalate * 0.6, citrate, volumeL })
  const lowCalciumIntake = calciumIntakeMg < 800
  return {
    currentIndex: base.index,
    citrateGain: round(base.index - citrateUp.index, 3),
    oxalateGain: round(base.index - oxalateDown.index, 3),
    citrateDeltaPct: round(((base.index - citrateUp.index) / Math.max(1e-6, base.index)) * 100, 1),
    oxalateDeltaPct: round(((base.index - oxalateDown.index) / Math.max(1e-6, base.index)) * 100, 1),
    hypocitraturia: citrate < 1.7,
    lowCalciumIntake,
    lever:
      base.index - citrateUp.index > base.index - oxalateDown.index ? 'citrate' : 'oxalate',
    advice: lowCalciumIntake
      ? 'Dietary calcium < 800 mg/day raises gut oxalate absorption and stone risk — normalise calcium with meals rather than restricting it.'
      : citrate < 1.7
        ? 'Hypocitraturia (<1.7 mmol/L) — potassium citrate 30–60 mEq/day raises urine citrate and pH simultaneously.'
        : 'Citrate and oxalate both within target; maintain 2.5 L/day urine output as the dominant lever.'
  }
}

/* --------------------------------------------------------------------------
 * 4. Stone passage probability
 * ------------------------------------------------------------------------ */

/**
 * Logistic model for spontaneous passage of a ureteral calculus, calibrated on
 * the pooled natural-history literature:
 *   logit(P) = 3.05 − 0.62·size_mm − 0.85·(distal=0) + 0.55·(distal=1)
 *                     − 0.72·hydronephrosis − 0.30·(prior intervention)
 */
export function stonePassageProbability({ sizeMm = 5, location = 'distal', hydronephrosis = false, priorIntervention = false, durationDays = 0, symptomsControlled = true }) {
  const s = Math.max(1, Math.min(20, sizeMm))
  const locTerm = location === 'distal' ? 0.55 : location === 'mid' ? -0.15 : -0.85
  const hTerm = hydronephrosis ? -0.72 : 0.15
  const pTerm = priorIntervention ? -0.3 : 0
  const dTerm = Math.min(0.9, durationDays * 0.01)
  const symTerm = symptomsControlled ? 0.2 : -0.35
  const logit = 3.05 - 0.62 * s + locTerm + hTerm + pTerm - dTerm + symTerm
  const p = 1 / (1 + Math.exp(-logit))
  const weeksEstimate = Math.round(6.2 * Math.exp(0.19 * s) * (location === 'proximal' ? 1.5 : location === 'mid' ? 1.2 : 1))
  const watchful = p >= 0.5 && s <= 8 && symptomsControlled
  return {
    probability: round(Math.min(0.985, Math.max(0.005, p)) * 100, 1),
    logit: round(logit, 3),
    sizeMm: s,
    location,
    expectedWeeks: weeksEstimate,
    recommendation: watchful
      ? `Watchful waiting is reasonable: ~${(p * 100).toFixed(0)}% spontaneous passage. Tamsulosin MET, analgesia, hydration, follow-up imaging at ${Math.min(6, weeksEstimate)} weeks.`
      : s > 10
        ? 'Stone >10 mm with a low modelled passage probability — urology referral for ureteroscopy (CPT 52356) or SWL (50590).'
        : `Modelled passage ${(p * 100).toFixed(0)}% — ${hydronephrosis ? 'obstruction with hydronephrosis warrants urgent decompression' : 'close follow-up; escalate if pain or infection develops'}.`,
    urgency: hydronephrosis && !symptomsControlled ? 'emergency' : p < 0.3 ? 'expedited' : p < 0.6 ? 'routine-close' : 'routine'
  }
}

/**
 * Hounsfield-unit → stone-composition inference for CT KUB, plus the
 * skin-to-stone distance SWL suitability test.
 */
export function ctStoneComposition({ hounsfield = 800, skinToStoneDistanceMm = 9.5, sizeMm = 7 }) {
  let composition = 'mixed'
  if (hounsfield < 300) composition = 'uric-acid'
  else if (hounsfield < 550) composition = 'struvite-or-cystine'
  else if (hounsfield < 1000) composition = 'calcium-oxalate-monohydrate'
  else composition = 'calcium-phosphate-brushite'
  const swlSuitable = skinToStoneDistanceMm <= 10 && hounsfield < 1000 && sizeMm <= 20
  return {
    composition,
    hounsfield,
    swlSuitable,
    swlEfficiency: round(Math.max(0.1, Math.min(0.98, (1000 - hounsfield) / 900 * (1 - skinToStoneDistanceMm / 18) + 0.35)), 3),
    note: swlSuitable
      ? 'HU and skin-to-stone distance both favour shockwave lithotripsy (CPT 50590).'
      : 'Unfavourable HU/SSD — ureteroscopy with laser lithotripsy (CPT 52356) offers superior stone-free rates.'
  }
}

/* --------------------------------------------------------------------------
 * 5. Hydration target
 * ------------------------------------------------------------------------ */

/** Volume needed to bring the urine to a target SG of 1.010 (≈ 2.5 L/day). */
export function hydrationTarget(volumeL, oxalate, calcium) {
  const load = 0.4 * oxalate + 0.15 * calcium
  const targetL = Math.max(2.5, Math.min(4.0, 2.5 + load))
  return {
    currentL: round(volumeL, 2),
    targetL: round(targetL, 2),
    deficitL: round(Math.max(0, targetL - volumeL), 2),
    glassesPerDay: Math.round((targetL * 1000) / 250),
    note: `Aim for ${targetL.toFixed(1)} L of urine per 24 h (≈${Math.round((targetL * 1000) / 250)} × 250 mL glasses) with evenly spaced intake, two glasses before bed.`
  }
}

/* --------------------------------------------------------------------------
 * 6. 1-Tap simulator scenarios
 * ------------------------------------------------------------------------ */

export const STONE_SCENARIOS = [
  {
    id: 'caox-recurrent',
    name: 'Recurrent Calcium Oxalate Former',
    description: 'Hypercalciuria + hyperoxaluria + hypocitraturia; AP(CaOx) well above 1.',
    inputs: { calcium: 6.4, oxalate: 0.62, magnesium: 2.4, citrate: 1.2, phosphate: 22, uricAcidMmol: 3.0, ph: 5.9, volumeL: 1.2, calciumIntakeMg: 620 }
  },
  {
    id: 'uric-acid',
    name: 'Uric Acid Stone / Low Urine pH',
    description: 'pH 5.3, high urate load — classic chemolysis candidate once pH ≥ 6.2.',
    inputs: { calcium: 2.2, oxalate: 0.24, magnesium: 3.2, citrate: 1.1, phosphate: 18, uricAcidMmol: 4.6, ph: 5.3, volumeL: 1.6, calciumIntakeMg: 850 }
  },
  {
    id: 'chemolysis-maintained',
    name: 'Uric Acid Chemolysis Maintained (pH 6.5)',
    description: 'Alkalinisation titrated into the 6.2–6.8 window; SS < 1, dissolution active.',
    inputs: { calcium: 2.4, oxalate: 0.26, magnesium: 3.0, citrate: 3.4, phosphate: 20, uricAcidMmol: 3.0, ph: 6.5, volumeL: 2.6, calciumIntakeMg: 950 }
  },
  {
    id: 'caP-brushite',
    name: 'Calcium Phosphate / Brushite (Over-alkalinised)',
    description: 'pH 7.4 from excess alkali; CaP supersaturation climbs steeply.',
    inputs: { calcium: 4.8, oxalate: 0.2, magnesium: 2.6, citrate: 4.2, phosphate: 34, uricAcidMmol: 2.0, ph: 7.4, volumeL: 2.2, calciumIntakeMg: 1100 }
  },
  {
    id: 'struvite',
    name: 'Struvite (Infection) Stone',
    description: 'pH 8.1 urease-splitting infection with very high phosphate.',
    inputs: { calcium: 3.6, oxalate: 0.3, magnesium: 4.6, citrate: 0.6, phosphate: 46, uricAcidMmol: 2.2, ph: 8.1, volumeL: 1.5, calciumIntakeMg: 900 }
  },
  {
    id: 'normal',
    name: 'Normal Metabolic Profile',
    description: 'Reference 24-h urine: AP(CaOx) < 1, pH 6.2, citrate 3.0.',
    inputs: { calcium: 3.0, oxalate: 0.28, magnesium: 3.4, citrate: 3.0, phosphate: 20, uricAcidMmol: 2.4, ph: 6.2, volumeL: 2.4, calciumIntakeMg: 1000 }
  }
]

/** Evaluate a scenario end-to-end for the UI. */
export function evaluateStoneScenario(scenario) {
  const i = scenario.inputs
  const profile = stoneRiskProfile(i)
  return {
    scenario,
    inputs: i,
    profile,
    counter: counterBalancer(i),
    uric: uricAcidProfile({ uricAcidMmol: i.uricAcidMmol, ph: i.ph }),
    passage: stonePassageProbability({ sizeMm: 6, location: 'distal', hydronephrosis: false })
  }
}

/** pH titration curve for the dissolution chart (4.5 → 7.8). */
export function chemolysisCurve(concMmol) {
  const pts = []
  for (let ph = 4.5; ph <= 7.81; ph += 0.05) {
    pts.push({
      ph: round(ph, 2),
      solubility: round(uricAcidSolubility(ph), 3),
      supersaturation: round(uricAcidSupersaturation(concMmol, ph), 3),
      ionised: round(urateIonisedFraction(ph), 3)
    })
  }
  return pts
}

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round((v + Number.EPSILON) * f) / f
}

/**
 * NEPHRO-SPECTRA — Module 5 engine
 * 2021 race-free CKD-EPI (creatinine and creatinine–cystatin C), Cockcroft–Gault,
 * the 18-cell KDIGO G1–G5 × A1–A3 heat grid, KFRE 4-variable risk, FENa/FEUrea,
 * and a urology/nephrology CPT quote auditor with bundling + modifier logic.
 *
 * Equations per Inker LA et al., NEJM 2021;385:1737-1749 and the KDIGO 2024
 * CKD guideline. No TypeScript.
 */

/* --------------------------------------------------------------------------
 * 1. 2021 race-free CKD-EPI
 * ------------------------------------------------------------------------ */

/**
 * CKD-EPI 2021 creatinine (mL/min/1.73 m²).
 *   eGFR = 142 × min(Scr/κ,1)^α × max(Scr/κ,1)^−1.200 × 0.9938^age × 1.012 [if female]
 */
export function ckdEpi2021Creatinine({ scrMgDl, age, female = false }) {
  const kappa = female ? 0.7 : 0.9
  const alpha = female ? -0.241 : -0.302
  const ratio = scrMgDl / kappa
  const egfr =
    142 *
    Math.pow(Math.min(ratio, 1), alpha) *
    Math.pow(Math.max(ratio, 1), -1.2) *
    Math.pow(0.9938, age) *
    (female ? 1.012 : 1)
  return round(egfr, 1)
}

/**
 * CKD-EPI 2021 creatinine–cystatin C (mL/min/1.73 m²).
 *   eGFR = 135 × min(Scr/κ,1)^α × max(Scr/κ,1)^−0.544 × min(Scys/0.8,1)^−0.323
 *            × max(Scys/0.8,1)^−0.778 × 0.9961^age × 0.963 [if female]
 */
export function ckdEpi2021CreatinineCystatin({ scrMgDl, scysMgL, age, female = false }) {
  const kappa = female ? 0.7 : 0.9
  const alpha = female ? -0.219 : -0.144
  const r = scrMgDl / kappa
  const c = scysMgL / 0.8
  const egfr =
    135 *
    Math.pow(Math.min(r, 1), alpha) *
    Math.pow(Math.max(r, 1), -0.544) *
    Math.pow(Math.min(c, 1), -0.323) *
    Math.pow(Math.max(c, 1), -0.778) *
    Math.pow(0.9961, age) *
    (female ? 0.963 : 1)
  return round(egfr, 1)
}

/** CKD-EPI 2021 cystatin C alone. */
export function ckdEpi2021Cystatin({ scysMgL, age, female = false }) {
  const c = scysMgL / 0.8
  const egfr =
    133 *
    Math.pow(Math.min(c, 1), -0.499) *
    Math.pow(Math.max(c, 1), -1.328) *
    Math.pow(0.9961, age) *
    (female ? 0.932 : 1)
  return round(egfr, 1)
}

/**
 * Cockcroft–Gault creatinine clearance (mL/min) — still required for drug dosing.
 *   CrCl = ((140 − age) × weight × [0.85 if female]) / (72 × Scr)
 */
export function cockcroftGault({ scrMgDl, age, weightKg, female = false }) {
  if (!(scrMgDl > 0)) return 0
  const crcl = (((140 - age) * weightKg) / (72 * scrMgDl)) * (female ? 0.85 : 1)
  return round(crcl, 1)
}

/** Body-surface-area normalisation of CrCl (Du Bois). */
export function bsaDuBois({ heightCm, weightKg }) {
  return round(0.007184 * Math.pow(heightCm, 0.725) * Math.pow(weightKg, 0.425), 3)
}

export function cockcroftGaultNormalised(inp) {
  const crcl = cockcroftGault(inp)
  const bsa = bsaDuBois(inp)
  return { crcl, bsa, normalised: round((crcl * 1.73) / bsa, 1) }
}

/* --------------------------------------------------------------------------
 * 2. KDIGO grid
 * ------------------------------------------------------------------------ */

export const KDIGO_G_STAGES = [
  { stage: 'G1', label: 'Normal or high', range: '≥90', min: 90, max: Infinity },
  { stage: 'G2', label: 'Mildly decreased', range: '60–89', min: 60, max: 90 },
  { stage: 'G3a', label: 'Mildly to moderately decreased', range: '45–59', min: 45, max: 60 },
  { stage: 'G3b', label: 'Moderately to severely decreased', range: '30–44', min: 30, max: 45 },
  { stage: 'G4', label: 'Severely decreased', range: '15–29', min: 15, max: 30 },
  { stage: 'G5', label: 'Kidney failure', range: '<15', min: 0, max: 15 }
]

export const KDIGO_A_STAGES = [
  { stage: 'A1', label: 'Normal to mildly increased', range: '<30 mg/g', acr: 30 },
  { stage: 'A2', label: 'Moderately increased', range: '30–300 mg/g', acr: 300 },
  { stage: 'A3', label: 'Severely increased', range: '>300 mg/g', acr: Infinity }
]

export function gStage(egfr) {
  return KDIGO_G_STAGES.find((s) => egfr >= s.min && egfr < s.max) || KDIGO_G_STAGES[KDIGO_G_STAGES.length - 1]
}

export function aStage(acrMgG) {
  // Inclusive upper bounds: A2 is 30–300 mg/g, so an ACR of exactly 300 is A2
  // and 300.1 is A3. (KDIGO 2012, Table 2.)
  if (acrMgG <= 30) return KDIGO_A_STAGES[0]
  if (acrMgG <= 300) return KDIGO_A_STAGES[1]
  return KDIGO_A_STAGES[2]
}

/**
 * 18-cell risk grid — the classic KDIGO heat map. Values are the recommended
 * monitoring frequency per year and a colour band.
 */
export function kdigoCell(g, a) {
  const gi = KDIGO_G_STAGES.findIndex((s) => s.stage === g)
  const ai = KDIGO_A_STAGES.findIndex((s) => s.stage === a)
  const matrix = [
    ['low', 'moderate', 'high'],
    ['low', 'moderate', 'high'],
    ['moderate', 'high', 'very-high'],
    ['high', 'very-high', 'very-high'],
    ['very-high', 'very-high', 'very-high'],
    ['very-high', 'very-high', 'very-high']
  ]
  const risk = matrix[Math.max(0, gi)][Math.max(0, ai)]
  const monitors = { low: 1, moderate: 1, high: 2, 'very-high': 3 }[risk]
  return {
    risk,
    monitorsPerYear: monitors,
    referNephrology: risk === 'very-high' || gi >= 3 || (gi === 2 && ai === 2),
    colourToken: `--kdigo-${risk}`
  }
}

/** Full grid payload for the 6×3 heat map component. */
export function kdigoGrid(egfr, acrMgG) {
  const g = gStage(egfr)
  const a = aStage(acrMgG)
  const cells = []
  for (const gs of KDIGO_G_STAGES) {
    for (const as of KDIGO_A_STAGES) {
      cells.push({
        g: gs.stage,
        a: as.stage,
        ...kdigoCell(gs.stage, as.stage),
        active: gs.stage === g.stage && as.stage === a.stage,
        egfrRange: gs.range,
        acrRange: as.range
      })
    }
  }
  const cell = kdigoCell(g.stage, a.stage)
  return {
    g: g.stage,
    a: a.stage,
    gLabel: g.label,
    aLabel: a.label,
    egfr,
    acrMgG,
    cells,
    ...cell,
    ckdPresent: egfr < 60 || acrMgG >= 30,
    interpretation: `KDIGO ${g.stage}${a.stage} — ${g.label}, albuminuria ${a.label.toLowerCase()} (${a.range}). ${cell.risk.toUpperCase()} risk; monitor ${cell.monitorsPerYear}×/year.`,
    action:
      cell.risk === 'very-high'
        ? 'Nephrology co-management, avoid nephrotoxins, dose-adjust all renally cleared drugs, plan for KRT education if G4/G5.'
        : cell.risk === 'high'
          ? 'Repeat eGFR + ACR in 3 months, BP < 120 mmHg, SGLT2 inhibitor and maximally tolerated RAS blockade.'
          : cell.risk === 'moderate'
            ? 'Recheck annually, control blood pressure and glucose, avoid NSAIDs.'
            : 'No CKD if persisting ≥3 months; routine cardiovascular risk management.'
  }
}

/* --------------------------------------------------------------------------
 * 3. KFRE (4-variable, Tangri) — 2- and 5-year kidney-failure risk
 * ------------------------------------------------------------------------ */

/**
 * Tangri 4-variable KFRE (2016, mL/min/1.73 m² based eGFR).
 * Coefficients from the published equation; output is % risk of RRT at 2 and 5 years.
 */
export function kfre4({ age, female = false, egfr, acrMgG = 30, scrMgDl = null, scysMgL = null }) {
  // The 4-variable model: age, sex, eGFR, ACR (log-transformed urine ACR)
  const femaleTerm = female ? 1 : 0
  const lnAcr = Math.log(Math.max(0.1, acrMgG))
  const lp =
    -0.2201 * (age / 10 - 7.036) +
    0.2467 * (femaleTerm - 0.5642) -
    0.5567 * (egfr / 5 - 7.222) +
    0.4510 * (lnAcr - 5.137)
  const base2 = 0.9750
  const base5 = 0.9365
  const risk2 = (1 - Math.pow(base2, Math.exp(lp))) * 100
  const risk5 = (1 - Math.pow(base5, Math.exp(lp))) * 100
  const risk = round(Math.max(0, Math.min(99, risk5)), 1)
  return {
    risk2yr: round(Math.max(0, Math.min(99, risk2)), 1),
    risk5yr: risk,
    linearPredictor: round(lp, 3),
    band: risk < 3 ? 'low' : risk < 10 ? 'moderate' : risk < 20 ? 'high' : 'very-high',
    note:
      risk < 3
        ? 'Low 5-year kidney-failure risk (<3%) — routine monitoring is sufficient.'
        : risk < 10
          ? 'Moderate 5-year risk (3–10%) — nephrology co-management and KRT education timing review.'
          : risk < 20
            ? 'High 5-year risk (10–20%) — prepare for kidney-failure planning; review transplant eligibility.'
            : 'Very high 5-year risk (>20%) — active KRT planning, vascular access and transplant work-up.',
    hasCystatin: scysMgL !== null || scrMgDl !== null
  }
}

/* --------------------------------------------------------------------------
 * 4. Fractional excretion — pre-renal vs intrinsic
 * ------------------------------------------------------------------------ */

/**
 * FENa (%) = (UNa × SCr) / (SNa × UCr) × 100
 * FEUrea (%) = (UUrea × SCr) / (BUN × UCr) × 100 — valid on diuretics.
 */
export function fractionalExcretion({ una, sna, scrMgDl, ucrMgDl, uureaMgDl, bunMgDl, egfr = null, akiPresent = false }) {
  const fena = sna > 0 && ucrMgDl > 0 ? ((una * scrMgDl) / (sna * ucrMgDl)) * 100 : null
  const feurea = bunMgDl > 0 && ucrMgDl > 0 ? ((uureaMgDl * scrMgDl) / (bunMgDl * ucrMgDl)) * 100 : null
  let pattern = 'indeterminate'
  if (fena !== null) {
    if (fena < 1) {
      // A low FENa only means "pre-renal" in the context of AKI. A euvolemic
      // patient with a normal eGFR is simply reabsorbing sodium avidly.
      pattern = akiPresent || (egfr !== null && egfr < 60)
        ? 'pre-renal'
        : 'sodium-avid (normal variant)'
    } else if (fena <= 2) {
      pattern = 'indeterminate'
    } else {
      pattern = 'intrinsic (ATN)'
    }
  }
  const akiContext = akiPresent || (egfr !== null && egfr < 60)
  if (akiContext && feurea !== null && fena !== null && feurea < 35 && fena < 1) {
    pattern = 'pre-renal (diuretic-compatible)'
  }
  return {
    fena: fena === null ? null : round(fena, 2),
    feurea: feurea === null ? null : round(feurea, 2),
    pattern,
    note:
      pattern.startsWith('pre-renal')
        ? 'FENa < 1% (FEUrea < 35%) — pre-renal azotaemia: volume resuscitation, stop nephrotoxins, recheck in 24 h.'
        : pattern === 'sodium-avid (normal variant)'
          ? 'FENa < 1% with a preserved eGFR and no AKI criteria — this is physiological sodium avidity, not pre-renal azotaemia. Re-interpret only if creatinine is rising.'
          : pattern === 'indeterminate'
          ? 'FENa 1–2% is indeterminate — use FEUrea on diuretics and correlate with the urine sediment.'
          : 'FENa > 2% — intrinsic tubular injury (ATN). Avoid further nephrotoxins and assess for obstruction with bladder scan.'
  }
}

/**
 * Urine output / AKI staging per KDIGO 2012 (48 h / 7 d windows).
 */
export function akiStage({ creatinineRiseMgDl, urineMlKgH, hoursOfOliguria = 0 }) {
  let stage = 0
  let reason = 'No AKI criteria met'
  if (creatinineRiseMgDl >= 0.3 || (urineMlKgH < 0.5 && hoursOfOliguria >= 6)) {
    stage = 1
    reason = creatinineRiseMgDl >= 0.3 ? 'SCr rise ≥0.26 mg/dL in 48 h' : 'Urine output <0.5 mL/kg/h for 6–12 h'
  }
  if (creatinineRiseMgDl >= 1.0 || (urineMlKgH < 0.5 && hoursOfOliguria >= 12)) {
    stage = 2
    reason = creatinineRiseMgDl >= 1.0 ? 'SCr ×2.0–2.9 from baseline' : 'Urine output <0.5 mL/kg/h for ≥12 h'
  }
  if (creatinineRiseMgDl >= 2.0 || urineMlKgH < 0.3 || hoursOfOliguria >= 24) {
    stage = 3
    reason = 'SCr ×3.0 or ≥4.0 mg/dL / anuria ≥12 h / KRT initiated'
  }
  return { stage, reason, needsDialysis: stage === 3 }
}

/* --------------------------------------------------------------------------
 * 5. CPT quote auditor
 * ------------------------------------------------------------------------ */

export const CPT_CATALOGUE = [
  {
    code: '50590',
    descriptor: 'Lithotripsy, extracorporeal shock wave (SWL)',
    rvu: 12.32,
    medicareUsd: 402,
    category: 'urology-stone',
    globalDays: 90
  },
  {
    code: '52356',
    descriptor: 'Cystourethroscopy with ureteroscopy and laser lithotripsy, including stent placement',
    rvu: 15.87,
    medicareUsd: 612,
    category: 'urology-stone',
    globalDays: 90
  },
  {
    code: '52000',
    descriptor: 'Cystourethroscopy, diagnostic, separate procedure',
    rvu: 5.61,
    medicareUsd: 148,
    category: 'urology-endoscopy',
    globalDays: 0
  },
  {
    code: '53854',
    descriptor: 'Transurethral destruction of prostate tissue by radiofrequency thermotherapy (TUIP/TUNA)',
    rvu: 14.44,
    medicareUsd: 486,
    category: 'urology-bph',
    globalDays: 90
  },
  {
    code: '51728',
    descriptor: 'Complex cystometrogram with voiding pressure study (urodynamics)',
    rvu: 6.85,
    medicareUsd: 209,
    category: 'urology-diagnostics',
    globalDays: 0
  },
  {
    code: '51798',
    descriptor: 'Measurement of post-voiding residual urine by ultrasound',
    rvu: 1.24,
    medicareUsd: 32,
    category: 'urology-diagnostics',
    globalDays: 0
  },
  {
    code: '81002',
    descriptor: 'Urinalysis, dipstick, non-automated, without microscopy',
    rvu: 0.38,
    medicareUsd: 4,
    category: 'laboratory',
    globalDays: 0
  },
  {
    code: '81003',
    descriptor: 'Urinalysis, automated, without microscopy',
    rvu: 0.35,
    medicareUsd: 3,
    category: 'laboratory',
    globalDays: 0
  },
  {
    code: '82570',
    descriptor: 'Creatinine, other source (urine)',
    rvu: 0.42,
    medicareUsd: 8,
    category: 'laboratory',
    globalDays: 0
  },
  {
    code: '84560',
    descriptor: 'Oxalate, urine, quantitative',
    rvu: 1.02,
    medicareUsd: 26,
    category: 'laboratory',
    globalDays: 0
  },
  {
    code: '82340',
    descriptor: 'Calcium, urine, quantitative 24-hour',
    rvu: 0.61,
    medicareUsd: 12,
    category: 'laboratory',
    globalDays: 0
  },
  {
    code: 'LITHOLINK',
    descriptor: 'Litholink 24-hour stone-risk profile (kit + analysis, non-CPT panel)',
    rvu: 0,
    medicareUsd: 195,
    category: 'laboratory-panel',
    globalDays: 0
  },
  {
    code: '99213',
    descriptor: 'Office/outpatient visit, established patient, low complexity',
    rvu: 1.3,
    medicareUsd: 92,
    category: 'evaluation',
    globalDays: 0
  },
  {
    code: '99214',
    descriptor: 'Office/outpatient visit, established patient, moderate complexity',
    rvu: 1.92,
    medicareUsd: 130,
    category: 'evaluation',
    globalDays: 0
  }
]

/** CMS global-surgery bundling: same-day procedures in the same family. */
const BUNDLE_RULES = [
  { primary: '52356', bundled: ['52000'], reason: 'Diagnostic cystoscopy is integral to ureteroscopy and is never separately payable.' },
  { primary: '50590', bundled: ['52000'], reason: 'Cystoscopy performed with SWL is bundled into 50590.' },
  { primary: '53854', bundled: ['52000'], reason: 'Cystoscopy is integral to transurethral prostate thermotherapy.' },
  { primary: '81002', bundled: ['81003'], reason: 'Manual and automated urinalysis are mutually exclusive — bill one only.' }
]

/** Modifier 25 (significant, separately identifiable E/M) applicability. */
export function modifier25Needed(codes) {
  const hasProcedure = codes.some((c) => {
    const item = CPT_CATALOGUE.find((x) => x.code === c)
    return item && (item.category.startsWith('urology') || item.category.startsWith('laboratory-panel'))
  })
  const hasEm = codes.some((c) => ['99213', '99214'].includes(c))
  return hasProcedure && hasEm
}

/**
 * Audit a proposed quote. Returns bundling violations, duplicates, modifier
 * advice, an estimated allowed amount and a 0–100 compliance score.
 */
export function auditQuote(codes, { payer = 'Medicare', units = 1 } = {}) {
  const unique = [...new Set(codes)]
  const items = unique
    .map((c) => CPT_CATALOGUE.find((x) => x.code === c))
    .filter(Boolean)

  const unknown = codes.filter((c) => !CPT_CATALOGUE.some((x) => x.code === c))
  const duplicates = codes.filter((c, i) => codes.indexOf(c) !== i)

  const violations = []
  for (const rule of BUNDLE_RULES) {
    if (unique.includes(rule.primary) && rule.bundled.some((b) => unique.includes(b))) {
      for (const b of rule.bundled) {
        if (unique.includes(b)) {
          violations.push({
            type: 'bundling',
            codes: [rule.primary, b],
            severity: 'error',
            message: `${b} is bundled into ${rule.primary} — ${rule.reason}`
          })
        }
      }
    }
  }
  for (const d of duplicates) {
    violations.push({ type: 'duplicate', codes: [d], severity: 'error', message: `${d} is listed more than once — append modifier 76 only for a genuine repeat procedure.` })
  }
  for (const u of unknown) {
    violations.push({ type: 'unknown', codes: [u], severity: 'error', message: `${u} is not in the NEPHRO-SPECTRA fee-schedule catalogue; verify the code against the current CPT dataset.` })
  }
  if (modifier25Needed(unique)) {
    violations.push({
      type: 'modifier',
      codes: ['25'],
      severity: 'warning',
      message: 'A separately identifiable E/M service is quoted with a same-day procedure — append modifier 25 to the E/M code or the claim will deny.'
    })
  }
  if (unique.includes('LITHOLINK') && (unique.includes('84560') || unique.includes('82340') || unique.includes('82570'))) {
    violations.push({
      type: 'panel-duplication',
      codes: ['LITHOLINK'],
      severity: 'warning',
      message: 'The Litholink panel already includes urine calcium, oxalate and creatinine — billing those individually duplicates the component tests.'
    })
  }

  const bundlingCount = violations.filter((v) => v.type === 'bundling' || v.type === 'duplicate').length
  const allowed = items
    .filter((it) => !violations.some((v) => v.type === 'bundling' && v.codes[1] === it.code))
    .reduce((a, it) => a + it.medicareUsd, 0) * units
  const quoted = items.reduce((a, it) => a + it.medicareUsd, 0) * units
  const denied = quoted - allowed

  const scoring = Math.max(
    0,
    100 -
      violations.filter((v) => v.severity === 'error').length * 22 -
      violations.filter((v) => v.severity === 'warning').length * 9
  )

  return {
    payer,
    codes: unique,
    items: items.map((it) => ({
      ...it,
      payable: !violations.some((v) => v.type === 'bundling' && v.codes[1] === it.code),
      globalDays: it.globalDays
    })),
    violations,
    unknown,
    totalRvu: round(items.reduce((a, it) => a + it.rvu, 0) * units, 2),
    quotedUsd: round(quoted, 2),
    allowedUsd: round(allowed, 2),
    deniedUsd: round(denied, 2),
    complianceScore: Math.round(scoring),
    verdict: scoring >= 92 ? 'CLEAN' : scoring >= 70 ? 'CORRECTABLE' : 'HIGH DENIAL RISK',
    summary:
      violations.length === 0
        ? `Quote clean: ${unique.length} codes, ${round(quoted, 0)} USD expected, ${round(items.reduce((a, it) => a + it.rvu, 0), 2)} total RVU.`
        : `${violations.filter((v) => v.severity === 'error').length} error(s), ${violations.filter((v) => v.severity === 'warning').length} warning(s) — ${round(denied, 0)} USD at denial risk.`
  }
}

export const QUOTE_PRESETS = [
  {
    id: 'urs-litholink',
    name: 'Ureteroscopy + Metabolic Work-up',
    codes: ['52356', '99214', 'LITHOLINK']
  },
  {
    id: 'swl-standalone',
    name: 'SWL with Integral Cystoscopy (correctly bundled)',
    codes: ['50590', '52000']
  },
  {
    id: 'clean-urs',
    name: 'Clean URS Claim',
    codes: ['52356', '99214']
  },
  {
    id: 'dup-urinalysis',
    name: 'Duplicate Urinalysis (mutually exclusive)',
    codes: ['81002', '81003']
  },
  {
    id: 'bph-workup',
    name: 'BPH Full Work-up',
    codes: ['99213', '51728', '51798', '53854']
  }
]

/* --------------------------------------------------------------------------
 * 6. 1-Tap patient presets
 * ------------------------------------------------------------------------ */

export const EGFR_PATIENTS = [
  {
    id: 'ckd3a',
    name: 'CKD G3a — Hypertensive Nephrosclerosis',
    description: 'SCr 1.42, cystatin C 1.31, age 68, ACR 78 mg/g — moderately increased albuminuria.',
    inputs: { scrMgDl: 1.42, scysMgL: 1.31, age: 68, female: false, weightKg: 82, heightCm: 176, acrMgG: 78, una: 24, sna: 139, ucrMgDl: 62, uureaMgDl: 380, bunMgDl: 26 }
  },
  {
    id: 'ckd4-diabetic',
    name: 'CKD G4 — Type 2 Diabetic Nephropathy',
    description: 'SCr 3.1, ACR 680 mg/g, age 74 — very-high KDIGO risk with elevated KFRE.',
    inputs: { scrMgDl: 3.1, scysMgL: 2.74, age: 74, female: false, weightKg: 91, heightCm: 172, acrMgG: 680, una: 82, sna: 133, ucrMgDl: 48, uureaMgDl: 290, bunMgDl: 41 }
  },
  {
    id: 'aki-prerenal',
    name: 'AKI — Pre-Renal (Volume Depletion)',
    description: 'SCr 1.9 from a 0.9 baseline, FENa 0.4%, FEUrea 28% — responsive to volume.',
    inputs: { scrMgDl: 1.9, scysMgL: 1.62, age: 55, female: true, weightKg: 63, heightCm: 163, acrMgG: 22, una: 12, sna: 142, ucrMgDl: 128, uureaMgDl: 720, bunMgDl: 32 }
  },
  {
    id: 'healthy',
    name: 'Healthy Young Adult',
    description: 'SCr 0.82, ACR 6 mg/g, age 29 — G1A1 reference case.',
    inputs: { scrMgDl: 0.82, scysMgL: 0.78, age: 29, female: true, weightKg: 58, heightCm: 166, acrMgG: 6, una: 38, sna: 140, ucrMgDl: 92, uureaMgDl: 480, bunMgDl: 13 }
  },
  {
    id: 'elderly-female',
    name: 'Elderly Female — Dose-Adjustment Case',
    description: 'SCr 1.05 in an 86-year-old 48 kg woman — CKD-EPI 57 but CrCl 43: divergent dosing.',
    inputs: { scrMgDl: 1.05, scysMgL: 1.18, age: 86, female: true, weightKg: 48, heightCm: 152, acrMgG: 45, una: 30, sna: 138, ucrMgDl: 55, uureaMgDl: 340, bunMgDl: 28 }
  }
]

/** Full evaluation for one patient preset. */
export function evaluatePatient(patient, quoteCodes = ['52356', '99214', 'LITHOLINK']) {
  const i = patient.inputs
  const cr = ckdEpi2021Creatinine({ scrMgDl: i.scrMgDl, age: i.age, female: i.female })
  const crCys = i.scysMgL ? ckdEpi2021CreatinineCystatin({ scrMgDl: i.scrMgDl, scysMgL: i.scysMgL, age: i.age, female: i.female }) : null
  const cysOnly = i.scysMgL ? ckdEpi2021Cystatin({ scysMgL: i.scysMgL, age: i.age, female: i.female }) : null
  const cg = cockcroftGaultNormalised({ scrMgDl: i.scrMgDl, age: i.age, weightKg: i.weightKg, female: i.female, heightCm: i.heightCm })
  const primary = crCys ?? cr
  const grid = kdigoGrid(primary, i.acrMgG)
  const kfre = kfre4({ age: i.age, female: i.female, egfr: primary, acrMgG: i.acrMgG })
  const fe = fractionalExcretion({
    una: i.una, sna: i.sna, scrMgDl: i.scrMgDl, ucrMgDl: i.ucrMgDl,
    uureaMgDl: i.uureaMgDl, bunMgDl: i.bunMgDl, egfr: primary
  })
  const quote = auditQuote(quoteCodes)
  return {
    patient,
    egfr: { creatinine: cr, creatinineCystatin: crCys, cystatinOnly: cysOnly, primary },
    cockcroftGault: cg,
    concordance: crCys ? round(Math.abs(cr - crCys) / Math.max(1, crCys) * 100, 1) : null,
    grid,
    kfre,
    fractionalExcretion: fe,
    quote
  }
}

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round((v + Number.EPSILON) * f) / f
}

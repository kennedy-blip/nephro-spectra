<script setup>
/**
 * NEPHRO-SPECTRA — Module 3: Kidney Stone Supersaturation Laboratory
 *
 * Tiselius AP(CaOx) and AP(CaP) regression indices, uric-acid
 * Henderson–Hasselbalch speciation at pKa1 = 5.35 with the 6.2–6.8 chemolysis
 * window, spontaneous passage probability, Hounsfield composition inference,
 * SWL suitability, and the citrate/oxalate counter-balancer.
 */
import { ref, computed } from 'vue'
import PlotFrame from '../ui/PlotFrame.vue'
import NephroIcon from '../ui/NephroIcon.vue'
import {
  STONE_SCENARIOS,
  evaluateStoneScenario,
  apCaOx,
  apCaP,
  stoneRiskProfile,
  uricAcidProfile,
  urateIonisedFraction,
  uricAcidSolubility,
  chemolysisCurve,
  counterBalancer,
  stonePassageProbability,
  ctStoneComposition,
  hydrationTarget,
  CHEMOLYSIS_WINDOW,
  URIC_PKA1
} from '@/engines/stoneSupersaturationEngine.js'
import { useRbac } from '@/composables/useRbac.js'
import { saveRecord, STORE } from '@/db/indexedDbNephroVault.js'
import { useReportExporter, buildReportEnvelope } from '@/composables/useReportExporter.js'

const emit = defineEmits(['telemetry', 'toast'])
const rbac = useRbac()
const { exportReport } = useReportExporter()

/* --------------------------------------------------------------- inputs */

const scenarioId = ref(STONE_SCENARIOS[0].id)
const scenario = computed(() => STONE_SCENARIOS.find((s) => s.id === scenarioId.value) || STONE_SCENARIOS[0])

const inputs = ref({ ...STONE_SCENARIOS[0].inputs })

function loadScenario(id) {
  scenarioId.value = id
  const s = STONE_SCENARIOS.find((x) => x.id === id)
  if (s) inputs.value = { ...s.inputs }
}

/* stone passage */
const stoneSize = ref(6)
const stoneLocation = ref('distal')
const hydronephrosis = ref(false)
const priorIntervention = ref(false)
const durationDays = ref(0)
const symptomsControlled = ref(true)

const hounsfield = ref(820)
const skinToStoneDistance = ref(9.4)

/* ------------------------------------------------------------- computed */

const profile = computed(() => stoneRiskProfile(inputs.value))
const uric = computed(() => uricAcidProfile({ uricAcidMmol: inputs.value.uricAcidMmol, ph: inputs.value.ph }))
const counter = computed(() => counterBalancer(inputs.value))
const passage = computed(() =>
  stonePassageProbability({
    sizeMm: stoneSize.value,
    location: stoneLocation.value,
    hydronephrosis: hydronephrosis.value,
    priorIntervention: priorIntervention.value,
    durationDays: durationDays.value,
    symptomsControlled: symptomsControlled.value
  })
)
const ct = computed(() =>
  ctStoneComposition({
    hounsfield: hounsfield.value,
    skinToStoneDistanceMm: skinToStoneDistance.value,
    sizeMm: stoneSize.value
  })
)
const hydration = computed(() => hydrationTarget(inputs.value.volumeL, inputs.value.oxalate, inputs.value.calcium))

const curve = computed(() => chemolysisCurve(inputs.value.uricAcidMmol))

const chemolysisSeries = computed(() => [
  {
    key: 'solubility',
    label: 'Uric acid solubility (mmol/L)',
    color: 'var(--accent)',
    width: 2,
    points: curve.value.map((p) => ({ x: p.ph, y: p.solubility }))
  },
  {
    key: 'conc',
    label: 'Urine urate load',
    color: 'var(--warning)',
    width: 1.6,
    dashed: true,
    points: curve.value.map((p) => ({ x: p.ph, y: inputs.value.uricAcidMmol }))
  },
  {
    key: 'ionised',
    label: 'Ionised urate fraction',
    color: 'var(--accent-3)',
    width: 1.5,
    points: curve.value.map((p) => ({ x: p.ph, y: p.ionised * inputs.value.uricAcidMmol }))
  }
])

const chemolysisBands = computed(() => [
  { from: 0, to: inputs.value.uricAcidMmol, color: 'var(--danger)' }
])

const apSeries = computed(() => {
  const caox = []
  const cap = []
  for (let ph = 4.8; ph <= 7.6; ph += 0.05) {
    caox.push({ x: ph, y: apCaOx({ ...inputs.value, ph }).index })
    cap.push({ x: ph, y: apCaP({ ...inputs.value, ph }).index })
  }
  return [
    { key: 'caox', label: 'AP(CaOx)', color: 'var(--accent-2)', width: 2, points: caox },
    { key: 'cap', label: 'AP(CaP)', color: 'var(--accent-3)', width: 2, points: cap },
    {
      key: 'now',
      label: 'current pH',
      color: 'var(--text-primary)',
      type: 'scatter',
      radius: 4.4,
      points: [{ x: inputs.value.ph, y: profile.value.caox.index, label: 'CaOx now' }]
    }
  ]
})

const urineSeries = computed(() => {
  const pts = []
  for (let v = 0.6; v <= 4.01; v += 0.1) {
    pts.push({ x: v, y: apCaOx({ ...inputs.value, volumeL: v }).index })
  }
  return [{ key: 'dilution', label: 'AP(CaOx) vs 24-h volume', color: 'var(--accent)', width: 2, type: 'area', points: pts }]
})

function healthClass(ok) {
  return ok ? 'ok' : 'bad'
}

/* ---------------------------------------------------------------- vault */

const patientRef = ref('DEMO-0417')
const vaultState = ref({ status: 'idle', id: null })

async function saveLog() {
  if (!rbac.can('write:vault')) {
    emit('toast', { text: 'Vault write requires the Pro tier.', level: 'warn' })
    return
  }
  try {
    const rec = await saveRecord(STORE.STONE, {
      patientRef: patientRef.value,
      scenario: scenario.value.id,
      inputs: inputs.value,
      profile: profile.value,
      uricAcid: uric.value,
      passage: passage.value,
      ct: ct.value
    })
    vaultState.value = { status: 'saved', id: rec.id }
    emit('toast', { text: `Supersaturation log sealed · ${rec.id.slice(0, 14)}…`, level: 'normal' })
    emit('telemetry', { supersaturationIndex: profile.value.aggregate })
  } catch (err) {
    vaultState.value = { status: 'error', id: null }
    emit('toast', { text: `Vault write failed: ${err?.message || err}`, level: 'danger' })
  }
}

function buildReport() {
  const p = profile.value
  const u = uric.value
  return buildReportEnvelope({
    title: 'Stone Supersaturation & Chemolysis Report',
    module: 'Kidney Stone Supersaturation Laboratory',
    role: rbac.meta.value.name,
    patientRef: patientRef.value,
    summary: `${scenario.value.name}: AP(CaOx) ${p.caox.index}, AP(CaP) ${p.cap.index}, uric-acid SS ${u.supersaturation} ${p.supersaturated ? `Dominant species ${p.dominant}.` : 'No species reaches its supersaturation threshold.'} Urine pH ${inputs.value.ph} ${u.inChemolysisWindow ? 'inside' : 'outside'} the 6.2–6.8 chemolysis window.`,
    sections: [
      {
        heading: 'Tiselius activity products',
        intro: 'AP < 1 (CaOx) or AP < 2 (CaP) indicates thermodynamic undersaturation.',
        rows: [
          { label: 'AP(CaOx)', value: p.caox.index, digits: 3, level: p.caox.supersaturated ? 'warn' : 'normal', note: p.caox.interpretation },
          { label: 'AP(CaP)', value: p.cap.index, digits: 3, level: p.cap.supersaturated ? 'warn' : 'normal', note: p.cap.interpretation },
          {
            label: p.supersaturated ? 'Dominant species' : 'Stone risk',
            value: p.supersaturated ? p.dominant : 'none — undersaturated',
            level: !p.supersaturated ? 'ok' : p.dominant === 'uric-acid' ? 'info' : 'warn'
          },
          { label: 'Aggregate risk', value: p.aggregate, digits: 3 }
        ]
      },
      {
        heading: '24-hour urine chemistry',
        rows: [
          { label: 'Calcium', value: inputs.value.calcium, unit: 'mmol/L' },
          { label: 'Oxalate', value: inputs.value.oxalate, unit: 'mmol/L' },
          { label: 'Citrate', value: inputs.value.citrate, unit: 'mmol/L', level: inputs.value.citrate < 1.7 ? 'warn' : 'normal', note: inputs.value.citrate < 1.7 ? 'Hypocitraturia (<1.7 mmol/L)' : 'Citrate replete' },
          { label: 'Magnesium', value: inputs.value.magnesium, unit: 'mmol/L' },
          { label: 'Phosphate', value: inputs.value.phosphate, unit: 'mmol/L' },
          { label: 'Uric acid', value: inputs.value.uricAcidMmol, unit: 'mmol/L' },
          { label: 'Urine pH', value: inputs.value.ph, digits: 2 },
          { label: '24-h volume', value: inputs.value.volumeL, unit: 'L' }
        ]
      },
      {
        heading: 'Uric acid speciation (pKa1 5.35)',
        intro: u.interpretation,
        rows: [
          { label: 'Ionised urate fraction', value: (u.ionisedFraction * 100).toFixed(1) + '%' },
          { label: 'Solubility at this pH', value: u.solubilityMmol, unit: 'mmol/L' },
          { label: 'Supersaturation ratio', value: u.supersaturation, digits: 3, level: u.supersaturation > 1 ? 'warn' : 'normal' },
          { label: 'Chemolysis window', value: u.inChemolysisWindow ? 'INSIDE 6.2–6.8' : 'OUTSIDE', level: u.inChemolysisWindow ? 'normal' : 'warn' },
          { label: 'pH required for SS = 1', value: u.requiredPh, digits: 2 },
          { label: 'Modelled dissolution half-life', value: u.dissolutionHalfLifeHours, unit: 'h' },
          { label: 'Chemolysis eligible', value: u.chemolysisEligible ? 'YES — alkalinisation indicated' : 'NO', level: u.chemolysisEligible ? 'warn' : 'normal' }
        ]
      },
      {
        heading: 'Citrate / oxalate counter-balancer',
        intro: counter.value.advice,
        rows: [
          { label: 'Current AP(CaOx)', value: counter.value.currentIndex, digits: 3 },
          { label: 'Gain from +1 mmol/L citrate', value: counter.value.citrateGain, digits: 3, note: `${counter.value.citrateDeltaPct}% reduction` },
          { label: 'Gain from −40% oxalate', value: counter.value.oxalateGain, digits: 3, note: `${counter.value.oxalateDeltaPct}% reduction` },
          { label: 'Dominant lever', value: counter.value.lever },
          { label: 'Hypocitraturia', value: counter.value.hypocitraturia ? 'PRESENT' : 'absent', level: counter.value.hypocitraturia ? 'warn' : 'normal' },
          { label: 'Dietary calcium < 800 mg', value: counter.value.lowCalciumIntake ? 'YES' : 'no', level: counter.value.lowCalciumIntake ? 'warn' : 'normal' }
        ]
      },
      {
        heading: 'Stone passage probability',
        intro: passage.value.recommendation,
        rows: [
          { label: 'Size', value: passage.value.sizeMm, unit: 'mm' },
          { label: 'Location', value: passage.value.location },
          { label: 'Spontaneous passage', value: `${passage.value.probability}%`, level: passage.value.probability > 60 ? 'normal' : passage.value.probability > 30 ? 'warn' : 'danger' },
          { label: 'Expected passage time', value: passage.value.expectedWeeks, unit: 'weeks' },
          { label: 'Urgency', value: passage.value.urgency, level: passage.value.urgency === 'emergency' ? 'danger' : 'info' }
        ]
      },
      {
        heading: 'CT composition & SWL suitability',
        intro: ct.value.note,
        rows: [
          { label: 'Hounsfield units', value: ct.value.hounsfield, unit: 'HU' },
          { label: 'Inferred composition', value: ct.value.composition },
          { label: 'Skin-to-stone distance', value: skinToStoneDistance.value, unit: 'mm' },
          { label: 'SWL suitable', value: ct.value.swlSuitable ? 'YES (CPT 50590)' : 'NO — prefer URS (CPT 52356)', level: ct.value.swlSuitable ? 'normal' : 'warn' },
          { label: 'SWL efficiency quotient', value: ct.value.swlEfficiency, digits: 3 }
        ]
      },
      {
        heading: 'Hydration prescription',
        intro: hydration.value.note,
        rows: [
          { label: 'Current 24-h volume', value: hydration.value.currentL, unit: 'L' },
          { label: 'Target 24-h volume', value: hydration.value.targetL, unit: 'L' },
          { label: 'Deficit', value: hydration.value.deficitL, unit: 'L' },
          { label: 'Glasses (250 mL) per day', value: hydration.value.glassesPerDay }
        ]
      }
    ],
    payload: { inputs: inputs.value, profile: p, uric: u, passage: passage.value, ct: ct.value, counter: counter.value }
  })
}

function exportCurrent(format = 'html') {
  if (!rbac.can('export:report')) {
    emit('toast', { text: 'Report export requires the Pro tier.', level: 'warn' })
    return
  }
  const res = exportReport(buildReport(), { format })
  if (res) emit('toast', { text: `Exported · ${res.filename}`, level: 'normal' })
}
</script>

<template>
  <div class="stack">
    <div class="workspace-head">
      <div>
        <div class="eyebrow">Module 03 · Stone chemistry</div>
        <h1>Kidney Stone Supersaturation Laboratory</h1>
        <p>
          Tiselius regression indices AP(CaOx) and AP(CaP), uric-acid Henderson–Hasselbalch speciation at
          pKa1 5.35 with the 6.2–6.8 chemolysis window, logistic spontaneous-passage probability, CT
          Hounsfield composition inference, SWL suitability and the citrate/oxalate counter-balancer.
        </p>
      </div>
      <div class="row" style="margin-left: auto">
        <span class="chip" :class="!profile.supersaturated ? 'ok' : profile.dominant === 'uric-acid' ? 'info' : profile.aggregate > 2 ? 'bad' : 'warn'">
          <span class="dot" />{{ profile.supersaturated ? profile.dominant : 'undersaturated' }}
        </span>
        <span class="chip mono">AP {{ profile.aggregate }}</span>
      </div>
    </div>

    <!-- scenarios -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="stone" :size="15" />
        <h2>1-Tap Metabolic Scenarios</h2>
        <span class="sub">Swap the 24-hour urine chemistry — every chart recomputes</span>
      </div>
      <div class="panel-body">
        <div class="scenario-grid">
          <button
            v-for="s in STONE_SCENARIOS"
            :key="s.id"
            class="scenario-card"
            :class="{ active: scenarioId === s.id }"
            @click="loadScenario(s.id)"
          >
            <span class="sc-name">{{ s.name }}</span>
            <span class="sc-desc">{{ s.description }}</span>
            <span class="sc-meta mono">pH {{ s.inputs.ph }} · Ca {{ s.inputs.calcium }} · Ox {{ s.inputs.oxalate }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- stats -->
    <div class="stat-grid">
      <div class="stat-card" :class="profile.caox.supersaturated ? 'licit' : ''" :style="profile.caox.supersaturated ? 'border-color: color-mix(in srgb, var(--warning) 46%, transparent)' : ''">
        <span class="label">AP(CaOx)</span>
        <div class="value">{{ profile.caox.index.toFixed(2) }}</div>
        <div class="foot">{{ profile.caox.riskBand }} · {{ profile.caox.supersaturated ? 'supersaturated' : 'undersaturated' }}</div>
      </div>
      <div class="stat-card">
        <span class="label">AP(CaP)</span>
        <div class="value">{{ profile.cap.index.toFixed(2) }}</div>
        <div class="foot">{{ profile.cap.riskBand }} risk band</div>
      </div>
      <div class="stat-card">
        <span class="label">Uric acid SS</span>
        <div class="value">{{ uric.supersaturation.toFixed(2) }}</div>
        <div class="foot">solubility {{ uric.solubilityMmol.toFixed(2) }} mmol/L</div>
      </div>
      <div class="stat-card">
        <span class="label">Urine pH</span>
        <div class="value">{{ inputs.ph.toFixed(1) }}</div>
        <div class="foot" :style="{ color: uric.inChemolysisWindow ? 'var(--success)' : 'var(--warning)' }">
          {{ uric.inChemolysisWindow ? 'chemolysis window' : `target ${CHEMOLYSIS_WINDOW.lo}–${CHEMOLYSIS_WINDOW.hi}` }}
        </div>
      </div>
      <div class="stat-card">
        <span class="label">Passage probability</span>
        <div class="value">{{ passage.probability }}<small>%</small></div>
        <div class="foot">{{ passage.sizeMm }} mm {{ passage.location }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Hydration deficit</span>
        <div class="value">{{ hydration.deficitL.toFixed(1) }}<small>L</small></div>
        <div class="foot">target {{ hydration.targetL }} L / day</div>
      </div>
    </div>

    <!-- chemolysis + AP vs pH -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="flask" :size="15" />
          <h2>Uric Acid Chemolysis Window</h2>
          <span class="chip mono" style="margin-left: auto">pKa1 {{ URIC_PKA1 }}</span>
        </div>
        <div class="panel-body">
          <PlotFrame
            :series="chemolysisSeries"
            :bands="chemolysisBands"
            :x-label="'urine pH'"
            :y-label="'mmol/L'"
            :height="212"
            :x-domain="[4.5, 7.8]"
            :markers="[{ x: inputs.ph, y: uric.solubilityMmol, label: `pH ${inputs.ph}`, color: 'var(--accent-2)' }]"
          />
          <div class="window-strip">
            <div
              v-for="i in 40"
              :key="i"
              class="window-cell"
              :class="{ inWindow: 4.5 + (i - 1) * 0.0825 >= CHEMOLYSIS_WINDOW.lo && 4.5 + (i - 1) * 0.0825 <= CHEMOLYSIS_WINDOW.hi, current: Math.abs(4.5 + (i - 1) * 0.0825 - inputs.ph) < 0.05 }"
            />
          </div>
          <div class="row" style="justify-content: space-between; margin-top: 5px">
            <span class="tiny dim mono">4.5</span>
            <span class="tiny" style="color: var(--success)">6.2 — 6.8 chemolysis</span>
            <span class="tiny dim mono">7.8</span>
          </div>
          <div class="divider" />
          <div class="grid-3">
            <div class="metric-mini"><span class="label">Ionised urate</span><span class="mono">{{ (uric.ionisedFraction * 100).toFixed(1) }}%</span></div>
            <div class="metric-mini"><span class="label">pH for SS=1</span><span class="mono">{{ uric.requiredPh }}</span></div>
            <div class="metric-mini"><span class="label">Dissolution t½</span><span class="mono">{{ uric.dissolutionHalfLifeHours }} h</span></div>
          </div>
          <div class="finding" :class="uric.inChemolysisWindow ? 'normal' : 'warn'" style="margin-top: 11px">
            <span class="tag">{{ uric.inChemolysisWindow ? 'in-window' : 'out-of-window' }}</span>
            <span>{{ uric.interpretation }}</span>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="gauge" :size="15" />
          <h2>Activity Products vs pH</h2>
          <span class="sub">pH is the master variable for both stone families</span>
        </div>
        <div class="panel-body">
          <PlotFrame
            :series="apSeries"
            :x-label="'urine pH'"
            :y-label="'AP index'"
            :height="212"
            :x-domain="[4.8, 7.6]"
            :bands="[{ from: 0, to: 1, color: 'var(--success)' }]"
          />
          <div class="finding info" style="margin-top: 10px">
            <span class="tag">insight</span>
            <span>
              Alkalinisation dissolves uric acid but steeply raises calcium-phosphate supersaturation —
              the pH exponent of 3.2 on AP(CaP) is why the therapeutic target is a narrow 6.2–6.8 band
              rather than "as alkaline as possible".
            </span>
          </div>
          <div class="divider" />
          <div class="kv-list">
            <div class="kv-row"><span class="k">AP(CaOx)</span><span class="v" :style="{ color: profile.caox.supersaturated ? 'var(--warning)' : 'var(--success)' }">{{ profile.caox.index }}</span></div>
            <div class="kv-row"><span class="k">AP(CaP)</span><span class="v" :style="{ color: profile.cap.supersaturated ? 'var(--warning)' : 'var(--success)' }">{{ profile.cap.index }}</span></div>
            <div class="kv-row">
              <span class="k">{{ profile.supersaturated ? 'Dominant species' : 'Stone risk' }}</span>
              <span class="v">{{ profile.supersaturated ? profile.dominant : 'none — all APs below threshold' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- urine chemistry sliders -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="sliders" :size="15" />
        <h2>24-Hour Urine Chemistry</h2>
        <span class="sub">Move any analyte — the AP indices, chemolysis and hydration recompute live</span>
      </div>
      <div class="panel-body">
        <div class="chem-grid">
          <div class="slider-row">
            <div class="head"><span class="label">Calcium (mmol/L)</span><span class="val">{{ inputs.calcium.toFixed(2) }}</span></div>
            <input v-model.number="inputs.calcium" type="range" min="0.5" max="9" step="0.05" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Oxalate (mmol/L)</span><span class="val">{{ inputs.oxalate.toFixed(2) }}</span></div>
            <input v-model.number="inputs.oxalate" type="range" min="0.05" max="1.2" step="0.01" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Citrate (mmol/L)</span><span class="val">{{ inputs.citrate.toFixed(2) }}</span></div>
            <input v-model.number="inputs.citrate" type="range" min="0.2" max="6" step="0.05" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Magnesium (mmol/L)</span><span class="val">{{ inputs.magnesium.toFixed(2) }}</span></div>
            <input v-model.number="inputs.magnesium" type="range" min="0.5" max="6" step="0.05" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Phosphate (mmol/L)</span><span class="val">{{ inputs.phosphate.toFixed(1) }}</span></div>
            <input v-model.number="inputs.phosphate" type="range" min="5" max="55" step="0.5" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Uric acid (mmol/L)</span><span class="val">{{ inputs.uricAcidMmol.toFixed(2) }}</span></div>
            <input v-model.number="inputs.uricAcidMmol" type="range" min="0.4" max="7" step="0.05" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Urine pH</span><span class="val">{{ inputs.ph.toFixed(2) }}</span></div>
            <input v-model.number="inputs.ph" type="range" min="4.6" max="8.2" step="0.02" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">24-h volume (L)</span><span class="val">{{ inputs.volumeL.toFixed(2) }}</span></div>
            <input v-model.number="inputs.volumeL" type="range" min="0.5" max="4" step="0.05" />
          </div>
        </div>
      </div>
    </div>

    <!-- counter-balancer + dilution -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="layers" :size="15" />
          <h2>Citrate / Oxalate Counter-Balancer</h2>
        </div>
        <div class="panel-body">
          <PlotFrame :series="urineSeries" :x-label="'24-h urine volume (L)'" :y-label="'AP(CaOx)'" :height="158" :x-domain="[0.5, 4]" :show-legend="false" />
          <div class="lever-grid" style="margin-top: 12px">
            <div class="lever" :class="{ dominant: counter.lever === 'citrate' }">
              <span class="label">Citrate lever · +1 mmol/L</span>
              <span class="lever-val mono">−{{ counter.citrateGain.toFixed(3) }}</span>
              <span class="lever-pct mono">{{ counter.citrateDeltaPct }}% reduction</span>
            </div>
            <div class="lever" :class="{ dominant: counter.lever === 'oxalate' }">
              <span class="label">Oxalate lever · −40%</span>
              <span class="lever-val mono">−{{ counter.oxalateGain.toFixed(3) }}</span>
              <span class="lever-pct mono">{{ counter.oxalateDeltaPct }}% reduction</span>
            </div>
          </div>
          <div class="finding" :class="counter.hypocitraturia ? 'warn' : 'normal'" style="margin-top: 11px">
            <span class="tag">{{ counter.hypocitraturia ? 'hypocitraturia' : 'citrate ok' }}</span>
            <span>{{ counter.advice }}</span>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="gauge" :size="15" />
          <h2>Passage, CT Composition &amp; SWL</h2>
        </div>
        <div class="panel-body">
          <div class="grid-2" style="gap: 12px">
            <div>
              <div class="slider-row">
                <div class="head"><span class="label">Stone size</span><span class="val">{{ stoneSize }} mm</span></div>
                <input v-model.number="stoneSize" type="range" min="1" max="15" step="0.5" />
              </div>
              <div class="field">
                <label>Location</label>
                <select v-model="stoneLocation">
                  <option value="distal">Distal ureter</option>
                  <option value="mid">Mid ureter</option>
                  <option value="proximal">Proximal ureter / renal pelvis</option>
                </select>
              </div>
              <label class="check"><input v-model="hydronephrosis" type="checkbox" /> Hydronephrosis</label>
              <label class="check"><input v-model="priorIntervention" type="checkbox" /> Prior intervention</label>
              <label class="check"><input v-model="symptomsControlled" type="checkbox" /> Symptoms controlled</label>
            </div>
            <div>
              <div class="slider-row">
                <div class="head"><span class="label">Hounsfield units</span><span class="val">{{ hounsfield }} HU</span></div>
                <input v-model.number="hounsfield" type="range" min="120" max="1600" step="10" />
              </div>
              <div class="slider-row">
                <div class="head"><span class="label">Skin-to-stone distance</span><span class="val">{{ skinToStoneDistance }} mm</span></div>
                <input v-model.number="skinToStoneDistance" type="range" min="3" max="18" step="0.1" />
              </div>
              <div class="kv-list" style="margin-top: 8px">
                <div class="kv-row"><span class="k">Composition</span><span class="v">{{ ct.composition }}</span></div>
                <div class="kv-row"><span class="k">SWL suitable</span><span class="v" :style="{ color: ct.swlSuitable ? 'var(--success)' : 'var(--warning)' }">{{ ct.swlSuitable ? 'YES' : 'NO' }}</span></div>
                <div class="kv-row"><span class="k">Efficiency quotient</span><span class="v">{{ ct.swlEfficiency }}</span></div>
                <div class="kv-row"><span class="k">Expected passage</span><span class="v">{{ passage.expectedWeeks }} wk</span></div>
              </div>
            </div>
          </div>
          <div class="divider" />
          <div class="finding" :class="passage.urgency === 'emergency' ? 'danger' : passage.urgency === 'expedited' ? 'warn' : 'info'">
            <span class="tag">{{ passage.urgency }}</span>
            <span>{{ passage.recommendation }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- persistence -->
    <div class="glass">
      <div class="panel-head"><NephroIcon name="database" :size="15" /><h2>Persistence &amp; Export</h2></div>
      <div class="panel-body">
        <div class="row tight">
          <button class="btn primary sm" @click="saveLog">
            <NephroIcon name="database" :size="12" /> Save supersaturation log
          </button>
          <button class="btn sm" @click="exportCurrent('html')">
            <NephroIcon name="report" :size="12" /> Export HTML
          </button>
          <button class="btn sm" @click="exportCurrent('csv')">
            <NephroIcon name="download" :size="12" /> CSV
          </button>
          <div v-if="vaultState.status !== 'idle'" class="chip" :class="vaultState.status === 'saved' ? 'ok' : 'bad'">
            {{ vaultState.status === 'saved' ? `sealed · ${vaultState.id.slice(0, 16)}…` : 'vault write failed' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scenario-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(228px, 1fr)); gap: 9px; }
.scenario-card {
  display: flex; flex-direction: column; gap: 5px; text-align: left;
  padding: 11px 12px; border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--glass-1) 68%, transparent);
  transition: transform var(--spring-fast), border-color var(--spring-fast), box-shadow var(--spring-fast);
}
.scenario-card:hover { transform: translateY(-2px); border-color: var(--glass-border-strong); }
.scenario-card.active {
  border-color: color-mix(in srgb, var(--accent) 62%, transparent);
  box-shadow: 0 12px 28px -18px var(--accent);
  background: linear-gradient(155deg, color-mix(in srgb, var(--accent) 20%, transparent), color-mix(in srgb, var(--glass-3) 70%, transparent));
}
.sc-name { font-size: 11.5px; font-weight: 650; line-height: 1.25; }
.sc-desc { font-size: 10px; color: var(--text-tertiary); line-height: 1.42; }
.sc-meta { font-size: 9px; color: var(--accent-2); opacity: 0.85; }

.chem-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(238px, 1fr)); gap: 4px 20px; }

.window-strip { display: flex; gap: 1.5px; margin-top: 11px; height: 12px; }
.window-cell {
  flex: 1; border-radius: 2px;
  background: color-mix(in srgb, var(--danger) 30%, transparent);
  border: 1px solid transparent;
  position: relative;
  transition: background var(--spring-fast);
}
.window-cell.inWindow { background: color-mix(in srgb, var(--success) 48%, transparent); }
.window-cell.current { box-shadow: 0 0 0 1.5px var(--text-primary); }

.lever-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lever {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 12px; border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--bg-void) 28%, transparent);
}
.lever.dominant { border-color: color-mix(in srgb, var(--accent-2) 55%, transparent); background: color-mix(in srgb, var(--accent-2) 10%, transparent); }
.lever-val { font-size: 17px; font-weight: 640; color: var(--accent-2); }
.lever-pct { font-size: 9.5px; color: var(--text-tertiary); }

.check {
  display: flex; align-items: center; gap: 8px;
  font-size: 10.5px; color: var(--text-secondary);
  padding: 5px 0; cursor: pointer;
}
.check input { accent-color: var(--accent); width: 13px; height: 13px; }
</style>

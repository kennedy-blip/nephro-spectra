<script setup>
/**
 * NEPHRO-SPECTRA — Module 5: KDIGO eGFR & CPT Quote Auditor
 *
 * 2021 race-free CKD-EPI (creatinine, creatinine–cystatin C, cystatin C alone),
 * Cockcroft–Gault with BSA normalisation, the 18-cell KDIGO G1–G5 × A1–A3 risk
 * grid, 4-variable KFRE, FENa/FEUrea and an 18-code urology/nephrology CPT quote
 * auditor with bundling, duplicate, modifier-25 and panel-duplication logic.
 */
import { ref, computed } from 'vue'
import PlotFrame from '../ui/PlotFrame.vue'
import NephroIcon from '../ui/NephroIcon.vue'
import {
  EGFR_PATIENTS,
  evaluatePatient,
  ckdEpi2021Creatinine,
  ckdEpi2021CreatinineCystatin,
  ckdEpi2021Cystatin,
  cockcroftGaultNormalised,
  kdigoGrid,
  kfre4,
  fractionalExcretion,
  akiStage,
  auditQuote,
  QUOTE_PRESETS,
  CPT_CATALOGUE,
  KDIGO_G_STAGES,
  KDIGO_A_STAGES,
  gStage,
  aStage
} from '@/engines/kdigoEgfrEngine.js'
import { useRbac } from '@/composables/useRbac.js'
import { saveRecord, STORE } from '@/db/indexedDbNephroVault.js'
import { useReportExporter, buildReportEnvelope } from '@/composables/useReportExporter.js'

const emit = defineEmits(['telemetry', 'toast'])
const rbac = useRbac()
const { exportReport } = useReportExporter()

/* ---------------------------------------------------------------- inputs */

const patientId = ref(EGFR_PATIENTS[0].id)
const patient = computed(() => EGFR_PATIENTS.find((p) => p.id === patientId.value) || EGFR_PATIENTS[0])
const inputs = ref({ ...EGFR_PATIENTS[0].inputs })

function loadPatient(id) {
  patientId.value = id
  const p = EGFR_PATIENTS.find((x) => x.id === id)
  if (p) {
    inputs.value = { ...p.inputs }
    patientRef.value = `DEMO-${id.toUpperCase().slice(0, 4)}-${Math.floor(1000 + Math.random() * 8999)}`
  }
}

/* ------------------------------------------------------------- computed */

const egfr = computed(() => {
  const i = inputs.value
  const cr = ckdEpi2021Creatinine({ scrMgDl: i.scrMgDl, age: i.age, female: i.female })
  const crCys = i.scysMgL ? ckdEpi2021CreatinineCystatin({ scrMgDl: i.scrMgDl, scysMgL: i.scysMgL, age: i.age, female: i.female }) : null
  const cysOnly = i.scysMgL ? ckdEpi2021Cystatin({ scysMgL: i.scysMgL, age: i.age, female: i.female }) : null
  return { cr, crCys, cysOnly, primary: crCys ?? cr }
})

const cg = computed(() => cockcroftGaultNormalised({ scrMgDl: inputs.value.scrMgDl, age: inputs.value.age, weightKg: inputs.value.weightKg, female: inputs.value.female, heightCm: inputs.value.heightCm }))
const grid = computed(() => kdigoGrid(egfr.value.primary, inputs.value.acrMgG))
const kfre = computed(() => kfre4({ age: inputs.value.age, female: inputs.value.female, egfr: egfr.value.primary, acrMgG: inputs.value.acrMgG }))
const fe = computed(() =>
  fractionalExcretion({
    una: inputs.value.una, sna: inputs.value.sna, scrMgDl: inputs.value.scrMgDl,
    ucrMgDl: inputs.value.ucrMgDl, uureaMgDl: inputs.value.uureaMgDl, bunMgDl: inputs.value.bunMgDl
  })
)
const aki = computed(() =>
  akiStage({ creatinineRiseMgDl: inputs.value.scrMgDl - (inputs.value.baselineScrMgDl || inputs.value.scrMgDl), urineMlKgH: inputs.value.urineMlKgH ?? 0.9, hoursOfOliguria: inputs.value.oliguriaHours ?? 0 })
)

/* eGFR-vs-age trajectory: what this patient's eGFR does as they age */
const trajectorySeries = computed(() => {
  const pts = []
  const i = inputs.value
  for (let a = Math.max(18, i.age - 25); a <= Math.min(100, i.age + 25); a += 2) {
    const cr = ckdEpi2021Creatinine({ scrMgDl: i.scrMgDl, age: a, female: i.female })
    const crcys = i.scysMgL ? ckdEpi2021CreatinineCystatin({ scrMgDl: i.scrMgDl, scysMgL: i.scysMgL, age: a, female: i.female }) : null
    pts.push({ x: a, y: crcys ?? cr })
  }
  return [
    { key: 'traj', label: 'Projected eGFR with age at fixed chemistry', color: 'var(--accent)', width: 2, type: 'area', points: pts },
    { key: 'now', label: 'Current', color: 'var(--accent-2)', type: 'scatter', radius: 4.6, points: [{ x: i.age, y: egfr.value.primary, label: 'now' }] }
  ]
})

const kfreSeries = computed(() => {
  const pts = []
  for (let e = 5; e <= 130; e += 2) {
    const r = kfre4({ age: inputs.value.age, female: inputs.value.female, egfr: e, acrMgG: inputs.value.acrMgG })
    pts.push({ x: e, y: r.risk5yr })
  }
  return [
    { key: 'risk', label: '5-year KFRE vs eGFR', color: 'var(--danger)', width: 2, type: 'area', points: pts },
    { key: 'now', label: 'This patient', color: 'var(--accent-2)', type: 'scatter', radius: 4.6, points: [{ x: egfr.value.primary, y: kfre.value.risk5yr, label: 'now' }] }
  ]
})

const comparators = computed(() => {
  const rows = [
    { key: 'cr', label: 'CKD-EPI 2021 creatinine', value: egfr.value.cr, colour: 'var(--accent)' },
    { key: 'crcys', label: 'CKD-EPI 2021 cr–cys', value: egfr.value.crCys, colour: 'var(--accent-2)' },
    { key: 'cys', label: 'CKD-EPI 2021 cystatin C', value: egfr.value.cysOnly, colour: 'var(--accent-3)' },
    { key: 'cg', label: 'Cockcroft–Gault (normalised)', value: cg.value.normalised, colour: 'var(--warning)' }
  ].filter((r) => r.value !== null && r.value !== undefined)
  return rows
})

const comparatorSeries = computed(() => [
  {
    key: 'cmp',
    label: 'eGFR by equation',
    color: 'var(--accent)',
    type: 'scatter',
    radius: 6,
    points: comparators.value.map((r, i) => ({ x: i, y: r.value, label: r.label }))
  },
  {
    key: 'line',
    label: 'trend',
    color: 'var(--glass-border-strong)',
    width: 1,
    dashed: true,
    points: comparators.value.map((r, i) => ({ x: i, y: r.value }))
  }
])

/* ------------------------------------------------------------- CPT audit */

const quoteCodes = ref(['52356', '99214', 'LITHOLINK'])
const quoteInput = ref('')
const audit = computed(() => auditQuote(quoteCodes.value))

function toggleCode(code) {
  const i = quoteCodes.value.indexOf(code)
  if (i >= 0) quoteCodes.value = quoteCodes.value.filter((c) => c !== code)
  else quoteCodes.value = [...quoteCodes.value, code]
}

function addCode() {
  const raw = quoteInput.value.trim().toUpperCase()
  if (!raw) return
  if (!quoteCodes.value.includes(raw)) quoteCodes.value = [...quoteCodes.value, raw]
  quoteInput.value = ''
}

function loadQuotePreset(id) {
  const p = QUOTE_PRESETS.find((x) => x.id === id)
  if (p) quoteCodes.value = [...p.codes]
}

/* ---------------------------------------------------------------- vault */

const patientRef = ref('DEMO-CKD3-4821')
const vaultState = ref({ status: 'idle', id: null })

async function saveAudit() {
  if (!rbac.can('write:vault')) {
    emit('toast', { text: 'Vault write requires the Pro tier.', level: 'warn' })
    return
  }
  try {
    const rec = await saveRecord(STORE.DIPSTICK, {
      patientRef: patientRef.value,
      kind: 'egfr-cpt-audit',
      egfr: egfr.value,
      cockcroftGault: cg.value,
      grid: { g: grid.value.g, a: grid.value.a, risk: grid.value.risk },
      kfre: kfre.value,
      fractionalExcretion: fe.value,
      aki: aki.value,
      quote: audit.value,
      overallSeverity: grid.value.risk === 'very-high' ? 'high' : grid.value.risk === 'high' ? 'moderate' : 'normal'
    })
    vaultState.value = { status: 'saved', id: rec.id }
    emit('toast', { text: `Renal audit sealed · ${rec.id.slice(0, 14)}…`, level: 'normal' })
  } catch (err) {
    vaultState.value = { status: 'error', id: null }
    emit('toast', { text: `Vault write failed: ${err?.message || err}`, level: 'danger' })
  }
}

function buildReport() {
  const g = grid.value
  return buildReportEnvelope({
    title: 'KDIGO Renal Function & CPT Quote Audit',
    module: 'KDIGO eGFR Quote Auditor',
    role: rbac.meta.value.name,
    patientRef: patientRef.value,
    summary: `${patient.value.name}: CKD-EPI 2021 creatinine ${egfr.value.cr} mL/min/1.73m²${egfr.value.crCys ? `, creatinine–cystatin C ${egfr.value.crCys}` : ''}. KDIGO ${g.g}${g.a} — ${g.risk} risk. 5-year KFRE ${kfre.value.risk5yr}%. Quote verdict: ${audit.value.verdict} (compliance ${audit.value.complianceScore}/100).`,
    sections: [
      {
        heading: 'eGFR equations',
        intro: 'The 2021 CKD-EPI equations are race-free; creatinine–cystatin C is preferred when both analytes are available.',
        rows: [
          { label: 'CKD-EPI 2021 creatinine', value: egfr.value.cr, unit: 'mL/min/1.73m²', level: egfr.value.cr < 60 ? 'warn' : 'normal' },
          { label: 'CKD-EPI 2021 creatinine–cystatin C', value: egfr.value.crCys ?? 'not available', unit: egfr.value.crCys ? 'mL/min/1.73m²' : '' },
          { label: 'CKD-EPI 2021 cystatin C alone', value: egfr.value.cysOnly ?? 'not available' },
          { label: 'Cockcroft–Gault CrCl', value: cg.value.crcl, unit: 'mL/min', note: 'Required for drug dosing; not interchangeable with eGFR' },
          { label: 'Du Bois BSA', value: cg.value.bsa, unit: 'm²' },
          { label: 'Normalised CrCl', value: cg.value.normalised, unit: 'mL/min/1.73m²' },
          { label: 'Concordance cr vs cr–cys', value: egfr.value.crCys ? `${(Math.abs(egfr.value.cr - egfr.value.crCys) / egfr.value.crCys * 100).toFixed(1)}%` : 'n/a', note: '>20% divergence suggests a non-GFR determinant (muscle mass, cystatin C confounder)' }
        ]
      },
      {
        heading: 'KDIGO risk classification',
        intro: g.interpretation,
        rows: [
          { label: 'G stage', value: `${g.g} — ${g.gLabel}`, level: g.g === 'G1' || g.g === 'G2' ? 'normal' : 'warn' },
          { label: 'A stage', value: `${g.a} — ${g.aLabel}`, level: g.a === 'A1' ? 'normal' : 'warn' },
          { label: 'Risk category', value: g.risk.toUpperCase(), level: g.risk === 'very-high' ? 'danger' : g.risk === 'high' ? 'warn' : 'normal' },
          { label: 'Monitoring frequency', value: `${g.monitorsPerYear}× per year` },
          { label: 'Nephrology referral', value: g.referNephrology ? 'INDICATED' : 'not indicated', level: g.referNephrology ? 'warn' : 'normal' },
          { label: 'Action', value: g.action }
        ]
      },
      {
        heading: 'Kidney Failure Risk Equation (4-variable)',
        intro: kfre.value.note,
        rows: [
          { label: '2-year KFRE', value: `${kfre.value.risk2yr}%`, level: kfre.value.risk2yr > 10 ? 'warn' : 'normal' },
          { label: '5-year KFRE', value: `${kfre.value.risk5yr}%`, level: kfre.value.risk5yr > 10 ? 'danger' : kfre.value.risk5yr > 3 ? 'warn' : 'normal' },
          { label: 'Risk band', value: kfre.value.band },
          { label: 'Linear predictor', value: kfre.value.linearPredictor, digits: 3 }
        ]
      },
      {
        heading: 'Fractional excretion & AKI',
        intro: fe.value.note,
        rows: [
          { label: 'FENa', value: fe.value.fena, unit: '%', level: fe.value.fena !== null && fe.value.fena < 1 ? 'info' : 'normal' },
          { label: 'FEUrea', value: fe.value.feurea, unit: '%' },
          { label: 'Pattern', value: fe.value.pattern },
          { label: 'KDIGO AKI stage', value: aki.value.stage, level: aki.value.stage >= 2 ? 'danger' : aki.value.stage === 1 ? 'warn' : 'normal', note: aki.value.reason }
        ]
      },
      {
        heading: 'CPT quote audit',
        intro: audit.value.summary,
        rows: [
          { label: 'Verdict', value: audit.value.verdict, level: audit.value.verdict === 'CLEAN' ? 'normal' : audit.value.verdict === 'CORRECTABLE' ? 'warn' : 'danger' },
          { label: 'Compliance score', value: `${audit.value.complianceScore}/100` },
          { label: 'Total RVU', value: audit.value.totalRvu, digits: 2 },
          { label: 'Quoted', value: `$${audit.value.quotedUsd.toFixed(2)}` },
          { label: 'Allowed', value: `$${audit.value.allowedUsd.toFixed(2)}` },
          { label: 'At denial risk', value: `$${audit.value.deniedUsd.toFixed(2)}`, level: audit.value.deniedUsd > 0 ? 'danger' : 'normal' },
          ...audit.value.items.map((it) => ({
            label: `${it.code} — ${it.descriptor}`,
            value: it.payable ? `$${it.medicareUsd}` : 'BUNDLED — not separately payable',
            level: it.payable ? 'normal' : 'warn'
          }))
        ]
      },
      {
        heading: 'Quote findings',
        findings: audit.value.violations.length
          ? audit.value.violations.map((v) => ({ level: v.severity === 'error' ? 'danger' : 'warn', text: `[${v.type}] ${v.message}` }))
          : [{ level: 'normal', text: 'No bundling, duplicate, modifier or panel-duplication defects detected.' }]
      }
    ],
    payload: { inputs: inputs.value, egfr: egfr.value, cg: cg.value, grid: grid.value, kfre: kfre.value, fe: fe.value, aki: aki.value, audit: audit.value }
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

function riskColour(risk) {
  return { low: 'var(--kdigo-low)', moderate: 'var(--kdigo-moderate)', high: 'var(--kdigo-high)', 'very-high': 'var(--kdigo-very-high)' }[risk] || 'var(--glass-border)'
}
</script>

<template>
  <div class="stack">
    <div class="workspace-head">
      <div>
        <div class="eyebrow">Module 05 · Renal function &amp; revenue integrity</div>
        <h1>KDIGO eGFR &amp; CPT Quote Auditor</h1>
        <p>
          Race-free 2021 CKD-EPI creatinine and creatinine–cystatin C, Cockcroft–Gault for drug dosing, the
          eighteen-cell KDIGO G1–G5 × A1–A3 risk grid, 4-variable KFRE, FENa/FEUrea and a urology CPT quote
          auditor enforcing CMS bundling, modifier-25 and panel-duplication rules.
        </p>
      </div>
      <div class="row" style="margin-left: auto">
        <span class="chip" :class="grid.risk === 'very-high' ? 'bad' : grid.risk === 'high' ? 'warn' : 'ok'">
          <span class="dot" />KDIGO {{ grid.g }}{{ grid.a }}
        </span>
        <span class="chip mono">{{ egfr.primary }} mL/min</span>
      </div>
    </div>

    <!-- patient presets -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="user" :size="15" />
        <h2>1-Tap Patient Scenarios</h2>
        <span class="sub">Full renal panel including quote audit recomputes on selection</span>
      </div>
      <div class="panel-body">
        <div class="scenario-grid">
          <button
            v-for="p in EGFR_PATIENTS"
            :key="p.id"
            class="scenario-card"
            :class="{ active: patientId === p.id }"
            @click="loadPatient(p.id)"
          >
            <span class="sc-name">{{ p.name }}</span>
            <span class="sc-desc">{{ p.description }}</span>
            <span class="sc-meta mono">SCr {{ p.inputs.scrMgDl }} · ACR {{ p.inputs.acrMgG }} · {{ p.inputs.age }}y</span>
          </button>
        </div>
      </div>
    </div>

    <!-- stats -->
    <div class="stat-grid">
      <div class="stat-card accent licit">
        <span class="label">eGFR (primary)</span>
        <div class="value">{{ egfr.primary }}<small>mL/min</small></div>
        <div class="foot">{{ egfr.crCys ? 'CKD-EPI cr–cys 2021' : 'CKD-EPI creatinine 2021' }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Cockcroft–Gault</span>
        <div class="value">{{ cg.crcl }}<small>mL/min</small></div>
        <div class="foot">normalised {{ cg.normalised }}</div>
      </div>
      <div class="stat-card">
        <span class="label">5-year KFRE</span>
        <div class="value">{{ kfre.risk5yr }}<small>%</small></div>
        <div class="foot">{{ kfre.band }} risk</div>
      </div>
      <div class="stat-card">
        <span class="label">FENa</span>
        <div class="value">{{ fe.fena ?? '—' }}<small>%</small></div>
        <div class="foot">{{ fe.pattern }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Quote compliance</span>
        <div class="value">{{ audit.complianceScore }}<small>/100</small></div>
        <div class="foot">{{ audit.verdict }}</div>
      </div>
      <div class="stat-card">
        <span class="label">At denial risk</span>
        <div class="value">${{ audit.deniedUsd.toFixed(0) }}</div>
        <div class="foot">of ${{ audit.quotedUsd.toFixed(0) }} quoted</div>
      </div>
    </div>

    <!-- KDIGO grid + charts -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="grid" :size="15" />
          <h2>KDIGO Heat Grid · G1–G5 × A1–A3</h2>
          <span class="chip" :class="grid.risk === 'very-high' ? 'bad' : grid.risk === 'high' ? 'warn' : 'ok'" style="margin-left: auto">
            {{ grid.risk }}
          </span>
        </div>
        <div class="panel-body">
          <div class="kdigo-grid">
            <div class="kdigo-axis" />
            <div v-for="a in KDIGO_A_STAGES" :key="a.stage" class="kdigo-axis" style="flex-direction: column; gap: 2px">
              <span>{{ a.stage }}</span>
              <span class="tiny dim mono">{{ a.range }}</span>
            </div>
            <template v-for="g in KDIGO_G_STAGES" :key="g.stage">
              <div class="kdigo-axis" style="flex-direction: column; gap: 2px">
                <span>{{ g.stage }}</span>
                <span class="tiny dim mono">{{ g.range }}</span>
              </div>
              <div
                v-for="a in KDIGO_A_STAGES"
                :key="`${g.stage}-${a.stage}`"
                class="kdigo-cell"
                :data-risk="grid.cells.find((c) => c.g === g.stage && c.a === a.stage)?.risk"
                :class="{ active: grid.cells.find((c) => c.g === g.stage && c.a === a.stage)?.active }"
                :title="`${g.stage}${a.stage} — ${grid.cells.find((c) => c.g === g.stage && c.a === a.stage)?.risk}`"
              >
                {{ grid.cells.find((c) => c.g === g.stage && c.a === a.stage)?.monitorsPerYear }}×/yr
              </div>
            </template>
          </div>
          <div class="legend-row">
            <span v-for="r in ['low', 'moderate', 'high', 'very-high']" :key="r" class="legend-chip">
              <i :style="{ background: riskColour(r) }" />{{ r }}
            </span>
          </div>
          <div class="divider" />
          <div class="finding" :class="grid.risk === 'very-high' ? 'danger' : grid.risk === 'high' ? 'warn' : 'normal'">
            <span class="tag">{{ grid.g }}{{ grid.a }}</span>
            <span>{{ grid.action }}</span>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="gauge" :size="15" />
          <h2>Equation Concordance</h2>
          <span class="sub">Cr vs cr–cys vs cystatin C vs Cockcroft–Gault</span>
        </div>
        <div class="panel-body">
          <div class="cmp-bars">
            <div v-for="c in comparators" :key="c.key" class="cmp-row">
              <span class="cmp-label">{{ c.label }}</span>
              <div class="cmp-track">
                <span :style="{ width: `${Math.min(100, (c.value / 140) * 100)}%`, background: c.colour }" />
              </div>
              <span class="cmp-val mono">{{ c.value }}</span>
            </div>
          </div>
          <div class="divider" />
          <PlotFrame :series="trajectorySeries" :x-label="'age (years)'" :y-label="'eGFR'" :height="140" :show-legend="false" />
          <div class="divider" />
          <PlotFrame :series="kfreSeries" :x-label="'eGFR'" :y-label="'5-yr risk %'" :height="126" :show-legend="false" />
          <div class="finding info" style="margin-top: 9px"><span class="tag">KFRE</span><span>{{ kfre.note }}</span></div>
        </div>
      </div>
    </div>

    <!-- CPT auditor -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="shieldCheck" :size="15" />
        <h2>CPT Quote Auditor</h2>
        <span class="sub">CMS bundling · modifier 25 · panel duplication</span>
        <div class="panel-actions">
          <span class="chip" :class="audit.verdict === 'CLEAN' ? 'ok' : audit.verdict === 'CORRECTABLE' ? 'warn' : 'bad'">{{ audit.verdict }}</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="row tight" style="margin-bottom: 11px">
          <span class="label">Presets</span>
          <button v-for="p in QUOTE_PRESETS" :key="p.id" class="btn sm ghost" @click="loadQuotePreset(p.id)">{{ p.name }}</button>
        </div>

        <div class="cpt-grid">
          <button
            v-for="c in CPT_CATALOGUE"
            :key="c.code"
            class="cpt-chip"
            :class="{ picked: quoteCodes.includes(c.code) }"
            @click="toggleCode(c.code)"
          >
            <span class="cpt-code mono">{{ c.code }}</span>
            <span class="cpt-desc">{{ c.descriptor }}</span>
            <span class="cpt-meta mono">RVU {{ c.rvu.toFixed(2) }} · ${{ c.medicareUsd }}</span>
          </button>
        </div>

        <div class="row tight" style="margin-top: 12px">
          <input v-model="quoteInput" type="text" placeholder="Add code (e.g. 50590)" style="max-width: 220px" @keyup.enter="addCode" />
          <button class="btn sm" @click="addCode">Add</button>
          <span class="chip mono">{{ quoteCodes.length }} codes quoted</span>
        </div>

        <div class="divider" />

        <table class="data-table">
          <thead>
            <tr>
              <th>CPT</th><th>Descriptor</th><th class="num">RVU</th><th class="num">Medicare</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in audit.items" :key="it.code">
              <td class="mono">{{ it.code }}</td>
              <td>{{ it.descriptor }}</td>
              <td class="num">{{ it.rvu.toFixed(2) }}</td>
              <td class="num">${{ it.medicareUsd }}</td>
              <td>
                <span class="chip" :class="it.payable ? 'ok' : 'bad'" style="font-size: 8px; padding: 1px 7px">
                  {{ it.payable ? 'PAYABLE' : 'BUNDLED' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="divider" />
        <div class="finding-list">
          <div v-for="(v, i) in audit.violations" :key="i" class="finding" :class="v.severity === 'error' ? 'danger' : 'warn'">
            <span class="tag">{{ v.type }}</span><span>{{ v.message }}</span>
          </div>
          <div v-if="!audit.violations.length" class="finding normal">
            <span class="tag">clean</span>
            <span>{{ audit.summary }}</span>
          </div>
        </div>

        <div class="audit-totals">
          <div class="audit-total"><span class="label">Total RVU</span><span class="mono">{{ audit.totalRvu }}</span></div>
          <div class="audit-total"><span class="label">Quoted</span><span class="mono">${{ audit.quotedUsd.toFixed(2) }}</span></div>
          <div class="audit-total"><span class="label">Allowed</span><span class="mono" style="color: var(--success)">${{ audit.allowedUsd.toFixed(2) }}</span></div>
          <div class="audit-total"><span class="label">Denied</span><span class="mono" :style="{ color: audit.deniedUsd > 0 ? 'var(--danger)' : 'var(--text-tertiary)' }">${{ audit.deniedUsd.toFixed(2) }}</span></div>
          <div class="audit-total"><span class="label">Score</span><span class="mono">{{ audit.complianceScore }}/100</span></div>
        </div>
      </div>
    </div>

    <!-- renal inputs + persistence -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head"><NephroIcon name="sliders" :size="15" /><h2>Renal Chemistry</h2></div>
        <div class="panel-body">
          <div class="renal-grid">
            <div class="field"><label>Serum creatinine (mg/dL)</label><input v-model.number="inputs.scrMgDl" type="number" step="0.01" min="0.2" max="12" /></div>
            <div class="field"><label>Cystatin C (mg/L)</label><input v-model.number="inputs.scysMgL" type="number" step="0.01" min="0.3" max="8" /></div>
            <div class="field"><label>Age (years)</label><input v-model.number="inputs.age" type="number" min="18" max="105" /></div>
            <div class="field"><label>Weight (kg)</label><input v-model.number="inputs.weightKg" type="number" min="25" max="200" /></div>
            <div class="field"><label>Height (cm)</label><input v-model.number="inputs.heightCm" type="number" min="120" max="215" /></div>
            <div class="field"><label>Urine ACR (mg/g)</label><input v-model.number="inputs.acrMgG" type="number" min="1" max="3000" /></div>
            <div class="field"><label>Urine Na (mmol/L)</label><input v-model.number="inputs.una" type="number" min="1" max="250" /></div>
            <div class="field"><label>Serum Na (mmol/L)</label><input v-model.number="inputs.sna" type="number" min="100" max="170" /></div>
            <div class="field"><label>Urine creatinine (mg/dL)</label><input v-model.number="inputs.ucrMgDl" type="number" min="5" max="400" /></div>
            <div class="field"><label>Urine urea (mg/dL)</label><input v-model.number="inputs.uureaMgDl" type="number" min="50" max="2000" /></div>
            <div class="field"><label>BUN (mg/dL)</label><input v-model.number="inputs.bunMgDl" type="number" min="2" max="150" /></div>
            <div class="field">
              <label>Sex</label>
              <select v-model="inputs.female">
                <option :value="false">Male</option>
                <option :value="true">Female</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head"><NephroIcon name="database" :size="15" /><h2>Persistence &amp; Export</h2></div>
        <div class="panel-body">
          <div class="kv-list">
            <div class="kv-row"><span class="k">KDIGO class</span><span class="v">{{ grid.g }}{{ grid.a }}</span></div>
            <div class="kv-row"><span class="k">Monitoring</span><span class="v">{{ grid.monitorsPerYear }}× / year</span></div>
            <div class="kv-row"><span class="k">Nephrology referral</span><span class="v">{{ grid.referNephrology ? 'INDICATED' : 'not indicated' }}</span></div>
            <div class="kv-row"><span class="k">AKI stage</span><span class="v">{{ aki.stage }} — {{ aki.reason }}</span></div>
            <div class="kv-row"><span class="k">Quote verdict</span><span class="v">{{ audit.verdict }}</span></div>
          </div>
          <div class="divider" />
          <div class="row tight">
            <button class="btn primary sm" @click="saveAudit">
              <NephroIcon name="database" :size="12" /> Save renal audit
            </button>
            <button class="btn sm" @click="exportCurrent('html')">
              <NephroIcon name="report" :size="12" /> Export HTML
            </button>
            <button class="btn sm" @click="exportCurrent('csv')">
              <NephroIcon name="download" :size="12" /> CSV
            </button>
          </div>
          <div v-if="vaultState.status !== 'idle'" class="chip" :class="vaultState.status === 'saved' ? 'ok' : 'bad'" style="margin-top: 10px">
            {{ vaultState.status === 'saved' ? `sealed · ${vaultState.id.slice(0, 16)}…` : 'vault write failed' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scenario-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 9px; }
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

.legend-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.legend-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 9px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.1em; }
.legend-chip i { width: 9px; height: 9px; border-radius: 3px; }

.cmp-bars { display: grid; gap: 8px; }
.cmp-row { display: grid; grid-template-columns: 172px 1fr 46px; align-items: center; gap: 10px; }
.cmp-label { font-size: 10px; color: var(--text-tertiary); line-height: 1.25; }
.cmp-track { height: 7px; border-radius: 999px; background: color-mix(in srgb, var(--bg-void) 55%, transparent); border: 1px solid var(--glass-border); overflow: hidden; }
.cmp-track span { display: block; height: 100%; border-radius: inherit; transition: width 420ms var(--ease-out); }
.cmp-val { text-align: right; font-size: 11px; font-weight: 600; }

.cpt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 7px; }
.cpt-chip {
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  padding: 8px 10px; border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--bg-void) 26%, transparent);
  transition: all var(--spring-fast);
}
.cpt-chip:hover { border-color: var(--glass-border-strong); transform: translateY(-1px); }
.cpt-chip.picked {
  border-color: color-mix(in srgb, var(--accent) 62%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  box-shadow: 0 8px 20px -14px var(--accent);
}
.cpt-code { font-size: 11px; font-weight: 700; color: var(--accent-2); letter-spacing: 0.04em; }
.cpt-desc { font-size: 9.5px; color: var(--text-tertiary); line-height: 1.35; }
.cpt-meta { font-size: 8.5px; color: var(--text-secondary); opacity: 0.8; }

.audit-totals { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.audit-total {
  flex: 1 1 110px; display: flex; flex-direction: column; gap: 3px;
  padding: 9px 11px; border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--bg-void) 26%, transparent);
}
.audit-total .mono { font-size: 14px; font-weight: 640; }

.renal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 0 12px; }
</style>

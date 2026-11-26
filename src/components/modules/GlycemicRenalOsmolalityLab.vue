<script setup>
/**
 * NEPHRO-SPECTRA — Module 4: Glycaemic & Renal Osmolality Laboratory
 *
 * Bergman–Hovorka glucose–insulin kinetics integrated by RK4 at 1-minute steps,
 * with an SGLT2-inhibitor renal threshold shift (RTG 180 → 75 mg/dL), glucose–
 * ketone index, serum/effective/urine osmolality, free-water deficit and the
 * proximal-tubule reabsorption panel.
 */
import { ref, computed } from 'vue'
import PlotFrame from '../ui/PlotFrame.vue'
import NephroIcon from '../ui/NephroIcon.vue'
import {
  GLYCEMIC_SCENARIOS,
  evaluateGlycemicScenario,
  SGLT2_RTG,
  renalThresholdGlucose,
  osmolalityBand,
  OSMOLALITY_BANDS
} from '@/engines/glycemicRenalEngine.js'
import { runtimeInfo } from '@/engines/rustNephroBridge.js'
import { useRbac } from '@/composables/useRbac.js'
import { saveRecord, STORE } from '@/db/indexedDbNephroVault.js'
import { useReportExporter, buildReportEnvelope } from '@/composables/useReportExporter.js'

const emit = defineEmits(['telemetry', 'toast'])
const rbac = useRbac()
const { exportReport } = useReportExporter()

/* --------------------------------------------------------------- control */

const scenarioId = ref(GLYCEMIC_SCENARIOS[0].id)
const sglt2 = ref(true)

/** Editable model inputs, seeded from the active 1-Tap scenario. */
const inputs = ref({ ...GLYCEMIC_SCENARIOS[0].params, sglt2: true })

function loadScenario(id) {
  scenarioId.value = id
  const s = GLYCEMIC_SCENARIOS.find((x) => x.id === id)
  if (s) {
    inputs.value = { ...s.params }
    sglt2.value = !!s.params.sglt2
  }
}

const result = computed(() => {
  const params = { ...inputs.value, sglt2: sglt2.value }
  return evaluateGlycemicScenario(params)
})

const run = computed(() => result.value.run)

/* --------------------------------------------------------------- charts */

const glucoseSeries = computed(() => {
  const pts = run.value.timesMin.map((t, i) => ({ x: t, y: run.value.glucoseMgDl[i] }))
  return [
    { key: 'g', label: 'Plasma glucose (mg/dL)', color: 'var(--accent)', width: 2.2, type: 'area', points: pts }
  ]
})

const insulinSeries = computed(() => {
  const pts = run.value.timesMin.map((t, i) => ({ x: t, y: run.value.insulinMuL[i] }))
  return [{ key: 'i', label: 'Plasma insulin (mU/L)', color: 'var(--accent-3)', width: 1.8, points: pts }]
})

/** Renal excretion rate over the run, g/min. */
const excretionSeries = computed(() => {
  const pts = run.value.timesMin.map((t, i) => {
    const g = run.value.glucoseMgDl[i]
    const mg = Math.max(0, g - (sglt2.value ? SGLT2_RTG.blocked : SGLT2_RTG.baseline))
    return { x: t, y: (mg / (mg + 220)) * (sglt2.value ? 260 : 120) }
  })
  return [{ key: 'e', label: 'Renal glucose excretion (mg/min)', color: 'var(--accent-2)', width: 2, type: 'area', points: pts }]
})

const rtgSeries = computed(() => [
  {
    key: 'rtg',
    label: sglt2.value ? 'RTG 75 mg/dL (SGLT2 blockade)' : 'RTG 180 mg/dL (physiological)',
    color: sglt2.value ? 'var(--warning)' : 'var(--text-tertiary)',
    width: 1.4,
    dashed: true,
    points: run.value.timesMin.map((t) => ({ x: t, y: sglt2.value ? SGLT2_RTG.blocked : SGLT2_RTG.baseline }))
  },
  { key: 'g', label: 'Plasma glucose', color: 'var(--accent)', width: 2, points: run.value.timesMin.map((t, i) => ({ x: t, y: run.value.glucoseMgDl[i] })) }
])

const osmolalityBands = computed(() =>
  OSMOLALITY_BANDS.filter((b) => Number.isFinite(b.max)).map((b, i) => ({
    from: i === 0 ? 240 : OSMOLALITY_BANDS[i - 1].max || 0,
    to: b.max,
    color: b.tone === 'critical' ? 'var(--danger)' : b.tone === 'warm' ? 'var(--warning)' : 'var(--success)'
  }))
)

const band = computed(() => osmolalityBand(result.value.osmolality.serum))

/* ---------------------------------------------------------------- vault */

const patientRef = ref('DEMO-0417')
const vaultState = ref({ status: 'idle', id: null })

async function saveRun() {
  if (!rbac.can('write:vault')) {
    emit('toast', { text: 'Vault write requires the Pro tier.', level: 'warn' })
    return
  }
  try {
    const r = result.value
    const rec = await saveRecord(STORE.GLYCEMIC, {
      patientRef: patientRef.value,
      scenario: scenarioId.value,
      sglt2: sglt2.value,
      inputs: inputs.value,
      summary: {
        peakMgDl: r.run.peakMgDl,
        nadirMgDl: r.run.nadirMgDl,
        meanMgDl: r.run.meanMgDl,
        timeInRangePct: r.run.timeInRangePct,
        gki: r.gki.value,
        serumOsmolality: r.osmolality.serum,
        freeWaterDeficit: r.freeWaterDeficit.litres,
        glycosuriaGrams: r.glycosuria.grams
      },
      curve: r.run.glucoseMgDl.filter((_, i) => i % 5 === 0)
    })
    vaultState.value = { status: 'saved', id: rec.id }
    emit('toast', { text: `Metabolic run sealed · ${rec.id.slice(0, 14)}…`, level: 'normal' })
  } catch (err) {
    vaultState.value = { status: 'error', id: null }
    emit('toast', { text: `Vault write failed: ${err?.message || err}`, level: 'danger' })
  }
}

function buildReport() {
  const r = result.value
  const s = GLYCEMIC_SCENARIOS.find((x) => x.id === scenarioId.value)
  return buildReportEnvelope({
    title: 'Glycaemic & Renal Osmolality Report',
    module: 'Glycaemic Renal Osmolality Laboratory',
    role: rbac.meta.value.name,
    patientRef: patientRef.value,
    summary: `${s?.name || 'Custom'} — RK4 Hovorka integration over ${inputs.value.durationMin ?? 300} min with ${sglt2.value ? 'SGLT2 blockade (renal threshold 75 mg/dL)' : 'a physiological renal threshold (180 mg/dL)'}. Peak ${r.run.peakMgDl} mg/dL, time-in-range ${r.run.timeInRangePct}%, GKI ${r.gki.value}, serum osmolality ${r.osmolality.serum} mOsm/kg.`,
    sections: [
      {
        heading: 'Hovorka glucose–insulin kinetics',
        intro: `7-state model integrated by classical RK4 at 1-minute steps. ${runtimeInfo().runtime} runtime.`,
        rows: [
          { label: 'Peak glucose', value: r.run.peakMgDl, unit: 'mg/dL', level: r.run.peakMgDl > 250 ? 'danger' : r.run.peakMgDl > 180 ? 'warn' : 'normal' },
          { label: 'Nadir glucose', value: r.run.nadirMgDl, unit: 'mg/dL', level: r.run.nadirMgDl < 70 ? 'danger' : 'normal' },
          { label: 'Mean glucose', value: r.run.meanMgDl, unit: 'mg/dL' },
          { label: 'Time in range 70–180', value: `${r.run.timeInRangePct}%`, level: r.run.timeInRangePct > 70 ? 'normal' : 'warn' },
          { label: 'Glucose AUC', value: r.run.aucMgDlMin, unit: 'mg/dL·min' },
          { label: 'Renal threshold (RTG)', value: r.run.renalThreshold, unit: 'mg/dL', note: sglt2.value ? 'SGLT2-inhibited: 180 → 75 mg/dL' : 'Physiological' }
        ]
      },
      {
        heading: 'Renal glucose handling',
        intro: r.tubular.note,
        rows: [
          { label: 'Cumulative glycosuria', value: r.glycosuria.grams, unit: 'g', level: r.glycosuria.grams > 20 ? 'warn' : 'normal' },
          { label: 'Filtered load', value: r.filteredLoadGMin, unit: 'g/min' },
          { label: 'Excreted fraction', value: `${(r.excretedFraction * 100).toFixed(1)}%` },
          { label: 'T_m glucose', value: r.tubular.reabsorptionCapacityMgMin, unit: 'mg/min' },
          { label: 'Osmotic diuresis', value: r.tubular.osmoticDiuresis ? 'YES' : 'no', level: r.tubular.osmoticDiuresis ? 'warn' : 'normal' },
          { label: 'Natriuresis', value: r.tubular.natriuresis }
        ]
      },
      {
        heading: 'Glucose–ketone index',
        intro: r.gki.interpretation,
        rows: [
          { label: 'GKI', value: r.gki.value ?? 'undefined', level: r.gki.band === 'dka-range' ? 'danger' : r.gki.band === 'approaching-dka' ? 'warn' : 'normal' },
          { label: 'Band', value: r.gki.band }
        ]
      },
      {
        heading: 'Osmolality panel',
        intro: r.osmolality.note,
        rows: [
          { label: 'Serum osmolality', value: r.osmolality.serum, unit: 'mOsm/kg', level: r.osmolality.serum >= 320 ? 'danger' : r.osmolality.serum >= 295 ? 'warn' : 'normal', note: r.osmolality.serumBasis },
          { label: 'Effective osmolality', value: r.osmolality.effective, unit: 'mOsm/kg', level: r.osmolality.effective >= 300 ? 'warn' : 'normal' },
          { label: 'Urine osmolality', value: r.osmolality.urine, unit: 'mOsm/kg', note: r.osmolality.urineBasis }
        ]
      },
      {
        heading: 'Free-water deficit',
        intro: r.freeWaterDeficit.note,
        rows: [
          { label: 'Free-water deficit', value: r.freeWaterDeficit.litres, unit: 'L', level: r.freeWaterDeficit.litres > 1 ? 'warn' : 'normal' },
          { label: 'Measured sodium', value: inputs.value.naMeqL, unit: 'mEq/L' },
          { label: 'Translocational correction', value: `+${r.freeWaterDeficit.translocationalDrop}`, unit: 'mEq/L' },
          { label: 'Corrected sodium', value: r.freeWaterDeficit.correctedSodium, unit: 'mEq/L' }
        ]
      },
      {
        heading: 'Targets',
        findings: [{ level: r.gki.band === 'dka-range' ? 'danger' : 'info', text: r.targetGlucose }]
      }
    ],
    payload: {
      inputs: inputs.value,
      sglt2: sglt2.value,
      summary: {
        peak: r.run.peakMgDl, nadir: r.run.nadirMgDl, tir: r.run.timeInRangePct,
        gki: r.gki.value, serum: r.osmolality.serum
      },
      glucoseCurve: run.value.glucoseMgDl.filter((_, i) => i % 4 === 0)
    }
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

function bandColor(b) {
  return b === 'critical' ? 'var(--danger)' : b === 'warm' ? 'var(--warning)' : 'var(--success)'
}
</script>

<template>
  <div class="stack">
    <div class="workspace-head">
      <div>
        <div class="eyebrow">Module 04 · Metabolic–renal</div>
        <h1>Glycaemic &amp; Renal Osmolality Laboratory</h1>
        <p>
          Seven-state Bergman–Hovorka glucose–insulin kinetics integrated with classical RK4 at one-minute
          steps, a live SGLT2-inhibitor renal-threshold shift (RTG 180 → 75 mg/dL), glucose–ketone index,
          serum/effective/urine osmolality, free-water deficit and the proximal-tubule reabsorption panel.
        </p>
      </div>
      <div class="row" style="margin-left: auto">
        <span class="chip" :class="result.gki.band === 'dka-range' ? 'bad' : 'info'">
          <span class="dot" />GKI {{ result.gki.value ?? '—' }}
        </span>
        <span class="chip mono">RK4 · {{ runtimeInfo().runtime }}</span>
      </div>
    </div>

    <!-- scenario rail -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="droplet" :size="15" />
        <h2>1-Tap Metabolic Scenarios</h2>
        <span class="sub">Each preset runs the full RK4 integration on selection</span>
        <div class="panel-actions">
          <button class="btn sm" :class="{ 'accent2': sglt2 }" @click="sglt2 = !sglt2">
            <NephroIcon name="bolt" :size="12" />
            SGLT2 {{ sglt2 ? 'BLOCKED (75)' : 'physiologic (180)' }}
          </button>
        </div>
      </div>
      <div class="panel-body">
        <div class="scenario-grid">
          <button
            v-for="s in GLYCEMIC_SCENARIOS"
            :key="s.id"
            class="scenario-card"
            :class="{ active: scenarioId === s.id }"
            @click="loadScenario(s.id)"
          >
            <span class="sc-name">{{ s.name }}</span>
            <span class="sc-desc">{{ s.description }}</span>
            <span class="sc-meta mono">
              G0 {{ s.params.g0MgDl }} · meal {{ s.params.mealGCarbs }} g · ket {{ s.params.ketonesMmol }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- stats -->
    <div class="stat-grid">
      <div class="stat-card accent licit">
        <span class="label">Peak glucose</span>
        <div class="value">{{ run.peakMgDl.toFixed(0) }}<small>mg/dL</small></div>
        <div class="foot">{{ (run.peakMgDl / 18).toFixed(1) }} mmol/L</div>
      </div>
      <div class="stat-card">
        <span class="label">Time in range</span>
        <div class="value">{{ run.timeInRangePct.toFixed(0) }}<small>%</small></div>
        <div class="foot">70–180 mg/dL</div>
      </div>
      <div class="stat-card">
        <span class="label">GKI</span>
        <div class="value">{{ result.gki.value ?? '∞' }}</div>
        <div class="foot">{{ result.gki.band.replace(/-/g, ' ') }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Serum osmolality</span>
        <div class="value">{{ result.osmolality.serum.toFixed(0) }}<small>mOsm</small></div>
        <div class="foot" :style="{ color: bandColor(band.tone) }">{{ band.label }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Free-water deficit</span>
        <div class="value">{{ result.freeWaterDeficit.litres.toFixed(2) }}<small>L</small></div>
        <div class="foot">Na⁺ {{ result.freeWaterDeficit.correctedSodium.toFixed(0) }} mEq/L corrected</div>
      </div>
      <div class="stat-card">
        <span class="label">Glycosuria</span>
        <div class="value">{{ result.glycosuria.grams.toFixed(1) }}<small>g</small></div>
        <div class="foot">{{ sglt2 ? 'RTG 75 mg/dL' : 'RTG 180 mg/dL' }}</div>
      </div>
    </div>

    <!-- charts -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="wave" :size="15" />
          <h2>Glucose–Insulin Kinetics</h2>
          <span class="chip mono" style="margin-left: auto">{{ inputs.durationMin ?? 300 }} min</span>
        </div>
        <div class="panel-body">
          <PlotFrame
            :series="glucoseSeries"
            :x-label="'time (min)'"
            :y-label="'mg/dL'"
            :height="196"
            :bands="[{ from: 70, to: 180, color: 'var(--success)' }]"
            :markers="[{ x: run.timesMin[run.glucoseMgDl.indexOf(run.peakMgDl)] || 0, y: run.peakMgDl, label: `peak ${run.peakMgDl.toFixed(0)}`, color: 'var(--warning)' }]"
          />
          <div class="divider" />
          <PlotFrame :series="insulinSeries" :x-label="'time (min)'" :y-label="'mU/L'" :height="118" :show-legend="false" />
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="kidney" :size="15" />
          <h2>Renal Threshold &amp; Excretion</h2>
          <span class="chip" :class="sglt2 ? 'warn' : 'info'" style="margin-left: auto">
            RTG {{ sglt2 ? SGLT2_RTG.blocked : SGLT2_RTG.baseline }}
          </span>
        </div>
        <div class="panel-body">
          <PlotFrame :series="rtgSeries" :x-label="'time (min)'" :y-label="'mg/dL'" :height="176" />
          <div class="divider" />
          <PlotFrame :series="excretionSeries" :x-label="'time (min)'" :y-label="'mg/min'" :height="126" :show-legend="false" />
        </div>
      </div>
    </div>

    <!-- osmolality gauges + tubular -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="gauge" :size="15" />
          <h2>Osmolality Panel</h2>
        </div>
        <div class="panel-body">
          <div class="osm-gauge">
            <div class="osm-track">
              <span class="osm-fill" :style="{ width: `${Math.min(100, (result.osmolality.serum / 400) * 100)}%`, background: `linear-gradient(90deg, var(--success), ${bandColor(band.tone)})` }" />
              <span
                v-for="b in [275, 295, 320]"
                :key="b"
                class="osm-tick"
                :style="{ left: `${(b / 400) * 100}%` }"
              />
            </div>
            <div class="osm-scale">
              <span class="tiny mono dim">0</span>
              <span class="tiny mono dim">275</span>
              <span class="tiny mono dim">295</span>
              <span class="tiny mono dim">320</span>
              <span class="tiny mono dim">400</span>
            </div>
          </div>
          <div class="grid-3" style="margin-top: 12px">
            <div class="metric-mini"><span class="label">Serum</span><span class="mono">{{ result.osmolality.serum }}</span></div>
            <div class="metric-mini"><span class="label">Effective</span><span class="mono">{{ result.osmolality.effective }}</span></div>
            <div class="metric-mini"><span class="label">Urine</span><span class="mono">{{ result.osmolality.urine }}</span></div>
          </div>
          <p class="tiny dim mono" style="margin-top: 9px">{{ result.osmolality.serumBasis }}</p>
          <div class="finding" :class="result.osmolality.hyperosmolar ? 'danger' : 'normal'" style="margin-top: 10px">
            <span class="tag">{{ result.osmolality.hyperosmolar ? 'hyperosmolar' : 'normal' }}</span>
            <span>{{ result.osmolality.note }}</span>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="flask" :size="15" />
          <h2>Proximal Tubule Handling</h2>
          <span class="chip mono" style="margin-left: auto">T_m {{ result.tubular.reabsorptionCapacityMgMin }} mg/min</span>
        </div>
        <div class="panel-body">
          <div class="kv-list">
            <div class="kv-row"><span class="k">Filtered load</span><span class="v">{{ result.tubular.filteredLoadMgMin }} mg/min</span></div>
            <div class="kv-row"><span class="k">Excreted</span><span class="v">{{ result.tubular.excretedMgMin }} mg/min</span></div>
            <div class="kv-row"><span class="k">Plasma glucose</span><span class="v">{{ result.tubular.glucoseMmol }} mmol/L</span></div>
            <div class="kv-row"><span class="k">Osmotic diuresis</span><span class="v" :style="{ color: result.tubular.osmoticDiuresis ? 'var(--warning)' : 'var(--success)' }">{{ result.tubular.osmoticDiuresis ? 'PRESENT' : 'absent' }}</span></div>
            <div class="kv-row"><span class="k">Urine volume effect</span><span class="v">+{{ result.tubular.urineVolumeEffect }} L</span></div>
          </div>
          <div class="divider" />
          <div class="finding info"><span class="tag">T_m</span><span>{{ result.tubular.tmGlucose }}</span></div>
          <div class="finding info"><span class="tag">natriuresis</span><span>{{ result.tubular.natriuresis }}</span></div>
          <div class="finding warn"><span class="tag">eGFR</span><span>{{ result.tubular.eGfrDependency }}</span></div>
          <div class="divider" />
          <div class="finding" :class="result.gki.band === 'dka-range' ? 'danger' : 'info'">
            <span class="tag">GKI</span><span>{{ result.gki.interpretation }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- model inputs -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="sliders" :size="15" />
        <h2>Model Inputs</h2>
        <span class="sub">Hovorka parameters are derived from body weight; all sliders re-integrate the RK4 system</span>
      </div>
      <div class="panel-body">
        <div class="model-grid">
          <div class="slider-row">
            <div class="head"><span class="label">Baseline glucose (mg/dL)</span><span class="val">{{ inputs.g0MgDl }}</span></div>
            <input v-model.number="inputs.g0MgDl" type="range" min="70" max="700" step="5" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Meal carbohydrate (g)</span><span class="val">{{ inputs.mealGCarbs }}</span></div>
            <input v-model.number="inputs.mealGCarbs" type="range" min="0" max="140" step="5" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Insulin bolus (mU)</span><span class="val">{{ inputs.insulinBolusMu }}</span></div>
            <input v-model.number="inputs.insulinBolusMu" type="range" min="0" max="30" step="0.5" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Ketones (mmol/L)</span><span class="val">{{ inputs.ketonesMmol }}</span></div>
            <input v-model.number="inputs.ketonesMmol" type="range" min="0" max="8" step="0.1" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Serum sodium (mEq/L)</span><span class="val">{{ inputs.naMeqL }}</span></div>
            <input v-model.number="inputs.naMeqL" type="range" min="120" max="165" step="1" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">BUN (mg/dL)</span><span class="val">{{ inputs.bunMgDl }}</span></div>
            <input v-model.number="inputs.bunMgDl" type="range" min="5" max="90" step="1" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">Body weight (kg)</span><span class="val">{{ inputs.weightKg }}</span></div>
            <input v-model.number="inputs.weightKg" type="range" min="35" max="150" step="1" />
          </div>
          <div class="slider-row">
            <div class="head"><span class="label">eGFR (mL/min/1.73m²)</span><span class="val">{{ inputs.eGfr }}</span></div>
            <input v-model.number="inputs.eGfr" type="range" min="10" max="130" step="1" />
          </div>
        </div>
        <div class="row tight" style="margin-top: 8px">
          <button class="btn primary sm" @click="saveRun">
            <NephroIcon name="database" :size="12" /> Save run
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
.scenario-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(224px, 1fr)); gap: 9px; }
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

.osm-gauge { padding: 4px 2px 0; }
.osm-track {
  position: relative; height: 14px; border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--bg-void) 55%, transparent);
  border: 1px solid var(--glass-border);
}
.osm-fill { display: block; height: 100%; transition: width 420ms var(--ease-out); }
.osm-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,.4); }
.osm-scale { display: flex; justify-content: space-between; margin-top: 4px; }
.osm-scale span { font-size: 8.5px; }

.model-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(238px, 1fr)); gap: 4px 20px; }
</style>

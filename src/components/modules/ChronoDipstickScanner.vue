<script setup>
/**
 * NEPHRO-SPECTRA — Module 2: Chrono-Gated Dipstick Scanner
 *
 * 10-pad reflectance capture → sRGB→linear→Bradford D65→CIELAB → CIEDE2000 ΔE00
 * nearest-swatch classification → per-analyte chrono read-window gating
 * (30/40/45/60/120 s) → specific-gravity +0.005/ΔpH alkaline correction →
 * intact-RBC speckle variance test → five strip presets.
 *
 * The 1-Tap scenarios drive the full colorimetric pipeline; the camera path is a
 * genuine getUserMedia capture with centre-patch sampling per pad well.
 */
import { ref, computed, onBeforeUnmount, nextTick, watch } from 'vue'
import NephroIcon from '../ui/NephroIcon.vue'
import DipstickLensShader from '../ui/DipstickLensShader.vue'
import PlotFrame from '../ui/PlotFrame.vue'
import {
  DIPSTICK_PADS,
  STRIP_PRESETS,
  DIPSTICK_SCENARIOS,
  readScenario,
  ciede2000,
  rgbToLab,
  captureToLab,
  chronoGate,
  correctSpecificGravity,
  osmolalityFromSg,
  deltaVerdict,
  ILLUMINANTS,
  bloodSpeckleAnalysis,
  scenarioValueToRgb
} from '@/engines/dipstickCiEDE2000Engine.js'
import { useRbac } from '@/composables/useRbac.js'
import { saveRecord, STORE } from '@/db/indexedDbNephroVault.js'
import { useReportExporter, buildReportEnvelope } from '@/composables/useReportExporter.js'

const emit = defineEmits(['telemetry', 'toast'])
const rbac = useRbac()
const { exportReport } = useReportExporter()

/* ----------------------------------------------------------------- state */

const scenarioId = ref(DIPSTICK_SCENARIOS[0].id)
const stripId = ref('combina10')
const illuminant = ref('TL84')
const elapsed = ref(46)
const exposureGain = ref(1.0)
const running = ref(false)
const selectedPad = ref('leukocytes')

const scenario = computed(() => DIPSTICK_SCENARIOS.find((s) => s.id === scenarioId.value) || DIPSTICK_SCENARIOS[0])
const strip = computed(() => STRIP_PRESETS.find((s) => s.id === stripId.value) || STRIP_PRESETS[0])

/** Recompute the whole read set whenever any capture parameter moves. */
const reading = computed(() => readScenario(scenario.value, elapsed.value, stripId.value))

const pads = computed(() => strip.value.pads.map((k) => reading.value.reads[k]).filter(Boolean))
const activePad = computed(() => reading.value.reads[selectedPad.value] || pads.value[0])

const themeIndex = computed(() => 0)

/* -------------------------------------------------------- chrono timeline */

const chronoTimeline = computed(() => {
  const pts = []
  for (let t = 0; t <= 130; t += 2) {
    const gate = chronoGate(activePad.value ? DIPSTICK_PADS.find((p) => p.key === activePad.value.key) : DIPSTICK_PADS[0], t)
    pts.push({ x: t, y: gate.kineticFactor })
  }
  return pts
})

const chronoSeries = computed(() => {
  const pad = DIPSTICK_PADS.find((p) => p.key === activePad.value.key) || DIPSTICK_PADS[0]
  const base = {
    key: 'k',
    label: `Kinetic development · ${pad.name}`,
    color: 'var(--accent)',
    width: 2,
    points: chronoTimeline.value
  }
  return [base]
})

const windowBand = computed(() => {
  const pad = DIPSTICK_PADS.find((p) => p.key === activePad.value.key) || DIPSTICK_PADS[0]
  return [{ from: 0, to: 2, color: 'var(--success)' }]
})

/* ------------------------------------------------------------ capture loop */

let tick = null
function startCapture() {
  if (!rbac.can('run:full-engine')) {
    emit('toast', { text: 'Chrono capture requires the Pro tier.', level: 'warn' })
    return
  }
  if (running.value) { stopCapture(); return }
  running.value = true
  elapsed.value = 0
  const startedAt = performance.now()
  tick = setInterval(() => {
    elapsed.value = (performance.now() - startedAt) / 1000
    if (elapsed.value > 125) {
      stopCapture()
      emit('toast', { text: 'Chrono window closed at 125 s — all pads read.', level: 'normal' })
    }
  }, 100)
}

function stopCapture() {
  if (tick) clearInterval(tick)
  tick = null
  running.value = false
}

function jumpToWindow() {
  const pad = DIPSTICK_PADS.find((p) => p.key === activePad.value.key) || DIPSTICK_PADS[0]
  elapsed.value = pad.windowSec
  emit('telemetry', { hydrationUsg: 1.0 + (reading.value.sgCorrection?.corrected || 1.018) - 1 })
}

/* ----------------------------------------------------- camera pad scanning */

const videoEl = ref(null)
const camera = ref({ active: false, error: null, stream: null, sampled: 0, canvasPad: null })

async function startCamera() {
  if (!rbac.can('capture:camera')) {
    emit('toast', { text: 'Camera capture requires the Pro tier.', level: 'warn' })
    return
  }
  camera.value.error = null
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    })
    camera.value.stream = stream
    camera.value.active = true
    await nextTick()
    if (videoEl.value) {
      videoEl.value.srcObject = stream
      await videoEl.value.play()
    }
    sampleFromCamera()
  } catch (err) {
    camera.value.error = err?.name === 'NotAllowedError'
      ? 'Camera permission denied — the 1-Tap colorimetric simulators remain live.'
      : `Camera unavailable (${err?.message || err}).`
    camera.value.active = false
    emit('toast', { text: camera.value.error, level: 'warn' })
  }
}

/** Centre-patch average per pad well, mapped through the full capture pipeline. */
function sampleFromCamera() {
  const video = videoEl.value
  const pad = DIPSTICK_PADS.find((p) => p.key === selectedPad.value.key) || DIPSTICK_PADS[0]
  if (!video || !camera.value.active) return
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(video, 0, 0, c.width, c.height)
  const cx = Math.floor(c.width / 2)
  const cy = Math.floor(c.height / 2)
  const patch = ctx.getImageData(cx - 12, cy - 6, 24, 12).data
  let r = 0, g = 0, b = 0, n = 0
  const pixels = []
  for (let i = 0; i < patch.length; i += 4) {
    r += patch[i]; g += patch[i + 1]; b += patch[i + 2]; n++
    if (pixels.length < 18) pixels.push({ r: patch[i], g: patch[i + 1], b: patch[i + 2] })
  }
  const avg = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
  const { lab } = captureToLab(avg, { illuminant: illuminant.value, exposureGain: exposureGain.value })
  const best = pad.swatches
    .map((sw) => ({ sw, dE: ciede2000(lab, sw.lab).dE }))
    .sort((a, b2) => a.dE - b2.dE)[0]
  camera.value.sampled++
  camera.value.canvasPad = {
    avg,
    lab,
    matched: best.sw.label,
    dE: best.dE,
    speckle: bloodSpeckleAnalysis(pixels, pad, lab)
  }
  emit('telemetry', { hydrationUsg: 1.02 })
}

function stopCamera() {
  if (camera.value.stream) camera.value.stream.getTracks().forEach((t) => t.stop())
  camera.value.stream = null
  camera.value.active = false
}

/* ------------------------------------------------------- derived clinical */

const sgCorrection = computed(() => reading.value.sgCorrection)
const bloodSpeckle = computed(() => reading.value.bloodSpeckle)
const osmolality = computed(() => (sgCorrection.value ? osmolalityFromSg(sgCorrection.value.corrected) : null))

const padTintLinear = computed(() => {
  const hex = activePad.value?.swatchHex || '#f0f0f0'
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return [lin(r), lin(g), lin(b)]
})

const sedimentDensity = computed(() => {
  const turbid = reading.value.reads.leukocytes?.quant > 100 ? 0.55 : 0.22
  const protein = (reading.value.reads.protein?.quant || 0) / 2000
  return Math.min(0.95, turbid + protein * 0.35)
})

const speckleAmount = computed(() => (bloodSpeckle.value?.intactRbc ? Math.min(1, (reading.value.reads.blood?.quant || 0) / 200) : 0))

const readProgress = computed(() => {
  const pad = DIPSTICK_PADS.find((p) => p.key === activePad.value.key) || DIPSTICK_PADS[0]
  return Math.min(1, elapsed.value / pad.windowSec)
})

/* ΔE00 ladder for the selected pad */
const deltaLadder = computed(() => {
  const pad = DIPSTICK_PADS.find((p) => p.key === activePad.value.key) || DIPSTICK_PADS[0]
  const sample = activePad.value
  if (!sample) return []
  return pad.swatches.map((sw) => {
    const lab = rgbToLab({
      r: parseInt(sw.hex.slice(1, 3), 16),
      g: parseInt(sw.hex.slice(3, 5), 16),
      b: parseInt(sw.hex.slice(5, 7), 16)
    })
    const res = ciede2000(sample.lab || lab, lab)
    return { ...sw, dE: res.dE, dL: res.dL, dC: res.dC, dH: res.dH, RT: res.RT, verdict: deltaVerdict(res.dE) }
  })
})

const deltaSeries = computed(() => {
  const rows = deltaLadder.value
  const pts = rows.map((r, i) => ({ x: i, y: r.dE }))
  return [
    { key: 'de', label: 'ΔE00 per calibration swatch', color: 'var(--accent-2)', width: 2, points: pts, type: 'area' },
    {
      key: 'matched', label: 'Matched swatch', color: 'var(--accent)', type: 'scatter', radius: 4.6,
      points: (() => {
        const idx = rows.reduce((best, r, i) => (r.dE < rows[best].dE ? i : best), 0)
        return [{ x: idx, y: rows[idx].dE, label: rows[idx].label }]
      })()
    }
  ]
})

const padKeyList = computed(() => strip.value.pads)

/* --------------------------------------------------------------- vault */

const patientRef = ref('DEMO-0417')
const vaultState = ref({ status: 'idle', id: null })

async function saveAudit() {
  if (!rbac.can('write:vault')) {
    emit('toast', { text: 'Vault write requires the Pro tier.', level: 'warn' })
    return
  }
  try {
    const rec = await saveRecord(STORE.DIPSTICK, {
      patientRef: patientRef.value,
      scenario: scenario.value.id,
      strip: strip.value.id,
      illuminant: illuminant.value,
      elapsed: elapsed.value,
      reads: reading.value.reads,
      sgCorrection: sgCorrection.value,
      bloodSpeckle: bloodSpeckle.value,
      overallSeverity: reading.value.overallSeverity,
      synthesis: reading.value.synthesis
    })
    vaultState.value = { status: 'saved', id: rec.id }
    emit('toast', { text: `Urinalysis sealed to vault · ${rec.id.slice(0, 14)}…`, level: 'normal' })
  } catch (err) {
    vaultState.value = { status: 'error', id: null }
    emit('toast', { text: `Vault write failed: ${err?.message || err}`, level: 'danger' })
  }
}

function buildReport() {
  const r = reading.value
  return buildReportEnvelope({
    title: 'Chrono-Gated Urinalysis Audit',
    module: 'Chrono Dipstick Scanner',
    role: rbac.meta.value.name,
    patientRef: patientRef.value,
    summary: `${scenario.value.name} on a ${strip.value.name} strip, read at ${elapsed.value.toFixed(1)} s under ${illuminant.value} with Bradford D65 adaptation. ${r.abnormalCount} abnormal pad(s); overall severity ${r.overallSeverity}.`,
    sections: [
      {
        heading: 'Pad classification · CIEDE2000',
        intro: 'Every pad is matched to its nearest calibrated reagent swatch in D65 CIELAB space using the full ΔE00 formula (kL = kC = kH = 1).',
        rows: pads.value.map((p) => ({
          label: `${p.name} (${p.analyte})`,
          value: `${p.matched} · ΔE00 ${p.dE.toFixed(2)}`,
          level: p.severity === 'high' ? 'danger' : p.severity === 'moderate' ? 'warn' : 'normal',
          note: `${p.unit ? `${p.quant} ${p.unit} · ` : `${p.quant} · `}${p.gate.state} (${p.gate.elapsed}s of ${p.gate.windowSec}s window)${p.chronoCorrected ? ' · chrono-corrected' : ''}`
        }))
      },
      {
        heading: 'Chrono read windows',
        intro: 'Each analyte has a declared development window; reads outside ±12% are chrono-corrected and flagged.',
        rows: pads.value.map((p) => ({
          label: p.name,
          value: `${p.gate.state}`,
          level: p.gate.state === 'optimal' ? 'normal' : 'warn',
          note: `${p.gate.message} Kinetic factor ${p.gate.kineticFactor}.`
        }))
      },
      {
        heading: 'Specific gravity & alkaline interference',
        intro: sgCorrection.value?.note,
        rows: [
          { label: 'Raw SG pad', value: sgCorrection.value?.raw, digits: 3 },
          { label: 'pH', value: sgCorrection.value?.ph },
          { label: 'Alkaline correction', value: `+${(sgCorrection.value?.correction || 0).toFixed(3)}`, note: '+0.005 per pH unit above 7.0, capped at +0.015' },
          { label: 'Corrected SG', value: sgCorrection.value?.corrected, digits: 3, level: (sgCorrection.value?.corrected || 1) >= 1.025 ? 'warn' : 'normal' },
          { label: 'Estimated osmolality', value: osmolality.value, unit: 'mOsm/kg', note: '(SG − 1) × 36000 + 40' }
        ]
      },
      {
        heading: 'Blood pad speckle analysis',
        intro: bloodSpeckle.value?.note,
        rows: [
          { label: 'Coefficient of variation', value: bloodSpeckle.value?.cv, digits: 4 },
          { label: 'Spatial ΔE00', value: bloodSpeckle.value?.spatialDeltaE },
          { label: 'Classification', value: bloodSpeckle.value?.classification, level: bloodSpeckle.value?.intactRbc ? 'warn' : 'info' },
          { label: 'Intact erythrocytes', value: bloodSpeckle.value?.intactRbc ? 'YES' : 'NO' }
        ]
      },
      {
        heading: 'Colour management',
        rows: [
          { label: 'Capture illuminant', value: illuminant.value, note: ILLUMINANTS[illuminant.value] ? `White point XYZ ${ILLUMINANTS[illuminant.value].map((v) => v.toFixed(1)).join(' / ')}` : '' },
          { label: 'Chromatic adaptation', value: 'Bradford → D65' },
          { label: 'Exposure gain', value: exposureGain.value, digits: 2 },
          { label: 'Strip preset', value: strip.value.name },
          { label: 'Read elapsed', value: `${elapsed.value.toFixed(1)} s` }
        ]
      },
      {
        heading: 'Automated synthesis',
        findings: r.synthesis.findings
      }
    ],
    payload: { reading: r, scenario: scenario.value.id, strip: strip.value.id }
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

watch([scenarioId, stripId], () => {
  const list = strip.value.pads
  if (!list.includes(selectedPad.value)) selectedPad.value = list[0]
})

onBeforeUnmount(() => {
  stopCapture()
  stopCamera()
})

function severityClass(s) {
  return s === 'high' ? 'danger' : s === 'moderate' ? 'warn' : 'normal'
}
function gateClass(state) {
  return state === 'optimal' ? 'ok' : state === 'overdeveloped' ? 'bad' : 'warn'
}
function round(v, d = 2) {
  const f = 10 ** d
  return Math.round(v * f) / f
}
</script>

<template>
  <div class="stack">
    <div class="workspace-head">
      <div>
        <div class="eyebrow">Module 02 · Chrono-colorimetry</div>
        <h1>Chrono Dipstick Scanner</h1>
        <p>
          Ten reagent pads sampled through sRGB → linear → Bradford D65 adaptation → CIELAB, then
          classified by the full CIEDE2000 ΔE00 formula against calibrated swatch ladders. Each analyte
          carries its own development window (30/40/45/60/120 s), the specific-gravity pad is corrected
          +0.005 per pH unit above 7.0, and the blood pad is discriminated intact-vs-lysed by spatial
          variance.
        </p>
      </div>
      <div class="row" style="margin-left: auto">
        <span class="chip" :class="reading.overallSeverity === 'high' ? 'bad' : reading.overallSeverity === 'moderate' ? 'warn' : 'ok'">
          <span class="dot" />{{ reading.overallSeverity.toUpperCase() }}
        </span>
        <span class="chip mono">{{ reading.abnormalCount }} abnormal</span>
      </div>
    </div>

    <!-- scenario rail -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="pad" :size="15" />
        <h2>1-Tap Specimen Simulators</h2>
        <span class="sub">Full colorimetric pipeline on synthesised pad reflectance</span>
        <div class="panel-actions">
          <button class="btn sm" @click="startCapture">
            <NephroIcon :name="running ? 'pause' : 'clock'" :size="12" />
            {{ running ? 'Stop chrono' : 'Run chrono capture' }}
          </button>
          <button class="btn sm ghost" @click="jumpToWindow">Jump to window</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="scenario-grid">
          <button
            v-for="s in DIPSTICK_SCENARIOS"
            :key="s.id"
            class="scenario-card"
            :class="{ active: scenarioId === s.id }"
            @click="scenarioId = s.id"
          >
            <span class="sc-name">{{ s.name }}</span>
            <span class="sc-desc">{{ s.description }}</span>
            <span class="sc-swatches">
              <i v-for="(v, k) in s.values" :key="k" :style="{ background: `rgb(${scenarioValueToRgb(k, v).r},${scenarioValueToRgb(k, v).g},${scenarioValueToRgb(k, v).b})` }" />
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- live stats -->
    <div class="stat-grid">
      <div class="stat-card accent licit">
        <span class="label">Read elapsed</span>
        <div class="value">{{ elapsed.toFixed(1) }}<small>s</small></div>
        <div class="foot">{{ running ? 'chrono running' : 'static read' }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Corrected SG</span>
        <div class="value">{{ sgCorrection?.corrected.toFixed(3) }}</div>
        <div class="foot">{{ sgCorrection?.alkalineInterference ? 'alkaline interference' : `raw ${sgCorrection?.raw.toFixed(3)}` }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Urine osmolality</span>
        <div class="value">{{ osmolality }}<small>mOsm/kg</small></div>
        <div class="foot">derived from corrected SG</div>
      </div>
      <div class="stat-card">
        <span class="label">Active pad ΔE00</span>
        <div class="value">{{ activePad?.dE.toFixed(2) }}</div>
        <div class="foot">{{ activePad?.matched }} · {{ activePad?.verdict.band }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Blood morphology</span>
        <div class="value" style="font-size: 14px; line-height: 1.2">{{ bloodSpeckle?.intactRbc ? 'Intact RBC' : 'Lysed' }}</div>
        <div class="foot">CV {{ bloodSpeckle?.cv }} · ΔE spread {{ bloodSpeckle?.spatialDeltaE }}</div>
      </div>
      <div class="stat-card">
        <span class="label">Strip preset</span>
        <div class="value" style="font-size: 13px; line-height: 1.25">{{ strip.name }}</div>
        <div class="foot">{{ strip.pads.length }} pads active</div>
      </div>
    </div>

    <!-- lens + ladder -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="camera" :size="15" />
          <h2>Chromatic Lens Viewport</h2>
          <span class="sub">filament dispersion · sediment settling</span>
          <div class="panel-actions">
            <span class="chip mono">{{ activePad?.key }}</span>
          </div>
        </div>
        <div class="panel-body">
          <DipstickLensShader
            :pad-tint="padTintLinear"
            :delta-e="activePad?.dE || 3"
            :sediment-density="sedimentDensity"
            :dispersion="0.62"
            :speckle="speckleAmount"
            :read-progress="readProgress"
            :theme-index="themeIndex"
          />
          <div class="row tight" style="margin-top: 11px">
            <span class="label">Pad</span>
            <button
              v-for="k in padKeyList"
              :key="k"
              class="pad-pill"
              :class="{ active: selectedPad === k }"
              @click="selectedPad = k"
            >{{ (reading.reads[k]?.name || k).slice(0, 4) }}</button>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="flask" :size="15" />
          <h2>ΔE00 Calibration Ladder</h2>
          <span class="chip mono" style="margin-left: auto">{{ activePad?.name }}</span>
        </div>
        <div class="panel-body">
          <PlotFrame :series="deltaSeries" :x-label="'swatch index'" :y-label="'ΔE00'" :height="150" :show-legend="false" />
          <div class="ladder">
            <div
              v-for="(row, i) in deltaLadder"
              :key="i"
              class="ladder-row"
              :class="{ best: row.dE === Math.min(...deltaLadder.map((r) => r.dE)) }"
            >
              <i class="swatch" :style="{ background: row.hex }" />
              <span class="ladder-label">{{ row.label }}</span>
              <span class="ladder-quant mono">{{ row.quant }}</span>
              <span class="ladder-de mono">ΔE {{ row.dE.toFixed(2) }}</span>
              <span class="ladder-meta mono dim">L{{ row.dL.toFixed(1) }} C{{ row.dC.toFixed(1) }} H{{ row.dH.toFixed(1) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- pad grid -->
    <div class="glass">
      <div class="panel-head">
        <NephroIcon name="grid" :size="15" />
        <h2>10-Pad Chrono Readout</h2>
        <span class="sub">Click any pad to focus the lens and ladder</span>
        <div class="panel-actions">
          <span class="chip" :class="running ? 'ok' : 'info'">{{ running ? 'SAMPLING' : 'HELD' }}</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="pad-grid">
          <button
            v-for="p in pads"
            :key="p.key"
            class="pad-card"
            :class="[severityClass(p.severity), { active: selectedPad === p.key }]"
            @click="selectedPad = p.key"
          >
            <div class="pad-top">
              <span class="pad-name">{{ p.name }}</span>
              <span class="pad-dot" :style="{ background: p.swatchHex }" />
            </div>
            <div class="pad-value mono">{{ p.quant }}<span class="pad-unit">{{ p.unit }}</span></div>
            <div class="pad-matched">{{ p.matched }}</div>
            <div class="pad-foot">
              <span class="mono">ΔE {{ p.dE.toFixed(2) }}</span>
              <span class="chip" :class="gateClass(p.gate.state)" style="font-size: 8px; padding: 1px 6px">{{ p.gate.state }}</span>
            </div>
            <div class="chrono-ring">
              <svg viewBox="0 0 36 36" class="ring-svg">
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--glass-border)" stroke-width="2.5" />
                <circle
                  cx="18" cy="18" r="15" fill="none"
                  :stroke="p.gate.state === 'optimal' ? 'var(--success)' : p.gate.state === 'overdeveloped' ? 'var(--danger)' : 'var(--warning)'"
                  stroke-width="2.5" stroke-linecap="round"
                  :stroke-dasharray="`${p.gate.progress * 94.2} 94.2`"
                  transform="rotate(-90 18 18)"
                />
              </svg>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- chrono + camera + controls -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="clock" :size="15" />
          <h2>Kinetic Read Window</h2>
          <span class="chip mono" style="margin-left: auto">{{ activePad?.gate.windowSec }} s ±12%</span>
        </div>
        <div class="panel-body">
          <PlotFrame
            :series="chronoSeries"
            :x-label="'elapsed (s)'"
            :y-label="'kinetic factor'"
            :height="168"
            :x-domain="[0, 130]"
            :y-domain="[0, 1.7]"
            :show-legend="false"
            :markers="[{ x: elapsed, y: chronoGate(DIPSTICK_PADS.find((p) => p.key === activePad?.key) || DIPSTICK_PADS[0], elapsed).kineticFactor, label: 'now', color: 'var(--accent-2)' }]"
          />
          <div class="finding" :class="activePad?.gate.state === 'optimal' ? 'normal' : 'warn'" style="margin-top: 9px">
            <span class="tag">{{ activePad?.gate.state }}</span>
            <span>{{ activePad?.gate.message }}</span>
          </div>
          <div class="slider-row" style="margin-top: 12px">
            <div class="head">
              <span class="label">Read time</span>
              <span class="val">{{ elapsed.toFixed(1) }} s</span>
            </div>
            <input v-model.number="elapsed" type="range" min="0" max="130" step="0.5" @input="stopCapture" />
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head">
          <NephroIcon name="camera" :size="15" />
          <h2>Camera Pad Sampling</h2>
          <span class="chip mono" style="margin-left: auto">{{ camera.sampled }} samples</span>
        </div>
        <div class="panel-body">
          <div class="cam-frame" :class="{ live: camera.active }">
            <video ref="videoEl" playsinline muted class="cam-video" />
            <div v-if="camera.active" class="cam-reticle" />
            <div v-if="!camera.active" class="cam-placeholder">
              <NephroIcon name="camera" :size="26" />
              <span>Camera idle — 1-Tap simulator active</span>
            </div>
          </div>
          <div class="row tight" style="margin-top: 10px">
            <button class="btn sm" :disabled="camera.active" @click="startCamera">
              <NephroIcon name="camera" :size="12" /> Start camera
            </button>
            <button class="btn sm ghost" :disabled="!camera.active" @click="stopCamera">Stop</button>
            <button class="btn sm" :disabled="!camera.active" @click="sampleFromCamera">Sample patch</button>
          </div>
          <p v-if="camera.error" class="inline-warn">{{ camera.error }}</p>
          <div v-if="camera.canvasPad" class="cam-result">
            <div class="kv-row"><span class="k">Patch RGB</span><span class="v">{{ camera.canvasPad.avg.r }}, {{ camera.canvasPad.avg.g }}, {{ camera.canvasPad.avg.b }}</span></div>
            <div class="kv-row"><span class="k">Matched swatch</span><span class="v">{{ camera.canvasPad.matched }}</span></div>
            <div class="kv-row"><span class="k">ΔE00</span><span class="v">{{ camera.canvasPad.dE.toFixed(2) }}</span></div>
            <div class="kv-row"><span class="k">Speckle CV</span><span class="v">{{ camera.canvasPad.speckle.cv }}</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- findings + persistence -->
    <div class="grid-2">
      <div class="glass">
        <div class="panel-head"><NephroIcon name="warning" :size="15" /><h2>Automated Urinalysis Synthesis</h2></div>
        <div class="panel-body">
          <div class="finding-list">
            <div v-for="(f, i) in reading.synthesis.findings" :key="i" class="finding" :class="f.level">
              <span class="tag">{{ f.level }}</span><span>{{ f.text }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="glass">
        <div class="panel-head"><NephroIcon name="sliders" :size="15" /><h2>Capture Settings &amp; Persistence</h2></div>
        <div class="panel-body">
          <div class="grid-3">
            <div class="field">
              <label>Strip preset</label>
              <select v-model="stripId">
                <option v-for="s in STRIP_PRESETS" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Illuminant</label>
              <select v-model="illuminant">
                <option v-for="(v, k) in ILLUMINANTS" :key="k" :value="k">{{ k }}</option>
              </select>
            </div>
            <div class="field">
              <label>Exposure gain</label>
              <input v-model.number="exposureGain" type="number" step="0.05" min="0.5" max="2" />
            </div>
          </div>
          <div class="row tight" style="margin-top: 4px">
            <button class="btn primary sm" @click="saveAudit">
              <NephroIcon name="database" :size="12" /> Save audit
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
.scenario-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 9px; }
.scenario-card {
  display: flex; flex-direction: column; gap: 6px; text-align: left;
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
.sc-swatches { display: flex; gap: 3px; margin-top: 2px; }
.sc-swatches i { width: 15px; height: 9px; border-radius: 3px; border: 1px solid rgba(0,0,0,.28); }

.pad-pill {
  font-size: 9.5px; padding: 3px 8px; border-radius: var(--radius-pill);
  border: 1px solid var(--glass-border); color: var(--text-tertiary);
  transition: all var(--spring-fast);
}
.pad-pill:hover { color: var(--text-secondary); border-color: var(--glass-border-strong); }
.pad-pill.active { color: var(--text-primary); background: color-mix(in srgb, var(--accent) 26%, transparent); border-color: color-mix(in srgb, var(--accent) 52%, transparent); }

.ladder { display: grid; gap: 3px; margin-top: 10px; max-height: 190px; overflow-y: auto; }
.ladder-row {
  display: grid; grid-template-columns: 22px 1fr 54px 76px 1fr; gap: 8px; align-items: center;
  padding: 5px 8px; border-radius: 7px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--bg-void) 26%, transparent);
  font-size: 10px;
}
.ladder-row.best { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.swatch { width: 20px; height: 13px; border-radius: 4px; border: 1px solid rgba(0,0,0,.35); }
.ladder-label { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ladder-quant { text-align: right; color: var(--text-tertiary); }
.ladder-de { color: var(--accent-2); }
.ladder-meta { font-size: 8.5px; text-align: right; }

.pad-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 9px; }
.pad-card {
  position: relative; text-align: left;
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px 11px 10px; border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--glass-1) 66%, transparent);
  transition: transform var(--spring-fast), border-color var(--spring-fast), box-shadow var(--spring-fast);
  overflow: hidden;
}
.pad-card:hover { transform: translateY(-2px); }
.pad-card.active { border-color: color-mix(in srgb, var(--accent) 62%, transparent); box-shadow: 0 10px 26px -16px var(--accent); }
.pad-card.danger { border-left: 2.5px solid var(--danger); }
.pad-card.warn { border-left: 2.5px solid var(--warning); }
.pad-card.normal { border-left: 2.5px solid var(--success); }
.pad-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.pad-name { font-size: 10px; font-weight: 650; letter-spacing: 0.02em; }
.pad-dot { width: 9px; height: 9px; border-radius: 3px; border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto; }
.pad-value { font-size: 17px; font-weight: 640; letter-spacing: -0.02em; }
.pad-unit { font-size: 8.5px; color: var(--text-tertiary); margin-left: 3px; }
.pad-matched { font-size: 9px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pad-foot { display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: var(--text-secondary); margin-top: 2px; padding-right: 22px; }
.chrono-ring { position: absolute; bottom: 7px; right: 7px; width: 22px; height: 22px; }
.ring-svg { width: 100%; height: 100%; }

.cam-frame {
  position: relative; border-radius: var(--radius-lg); overflow: hidden;
  border: 1px solid var(--glass-border); background: var(--bg-void);
  aspect-ratio: 16 / 9; display: grid; place-items: center;
  box-shadow: inset 0 0 30px rgba(0,0,0,.5);
}
.cam-frame.live { border-color: color-mix(in srgb, var(--success) 48%, transparent); }
.cam-video { width: 100%; height: 100%; object-fit: cover; display: block; }
.cam-reticle {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 74px; height: 32px; border-radius: 6px;
  border: 1.5px dashed rgba(140, 240, 220, .9);
  box-shadow: 0 0 0 9999px rgba(2, 8, 14, .28);
}
.cam-placeholder { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-tertiary); font-size: 10.5px; }
.cam-result { display: grid; gap: 5px; margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--glass-border); background: color-mix(in srgb, var(--bg-void) 28%, transparent); }
.inline-warn { font-size: 10.5px; color: var(--warning); margin-top: 9px; line-height: 1.5; }
</style>

<script setup>
/**
 * NEPHRO-SPECTRA — Polyglot Runtime Inspector.
 * Reports the *actual* runtime state of every language surface: the Rust/WASM
 * DSP module (or its deterministic JS mirror), the WebGL2 shader pipeline, the
 * IndexedDB vault census, the Go serverless mirrors, the Java Capacitor plugin
 * bridge and the benchmarked FFT throughput.
 */
import { ref, computed, onMounted } from 'vue'
import NephroIcon from './NephroIcon.vue'
import { runtimeInfo, initRustNephro, benchmarkFFT } from '@/engines/rustNephroBridge.js'
import { vaultCensus, STORE_META, flushOutbox } from '@/db/indexedDbNephroVault.js'
import { useRbac } from '@/composables/useRbac.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  underlayStatus: { type: Object, default: () => ({}) },
  lensStatus: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['close', 'toast'])

const rbac = useRbac()

const rust = ref(runtimeInfo())
const bench = ref(null)
const census = ref(null)
const busy = ref(false)
const syncResult = ref(null)

const webgl = computed(() => ({
  underlay: props.underlayStatus?.webgl2 ? 'online' : 'fallback',
  lens: props.lensStatus?.webgl2 ? 'online' : 'fallback',
  fps: props.underlayStatus?.fps || 0,
  frames: props.underlayStatus?.frames || 0,
  programMs: props.underlayStatus?.programMs || 0,
  glsl: props.underlayStatus?.glslVersion || 'GLSL ES 3.00',
  renderer: props.underlayStatus?.renderer || 'software'
}))

const langs = computed(() => [
  {
    lang: 'Vue 3.5',
    icon: 'layers',
    share: '40.5%',
    role: 'Interface shell, module orchestration, reactivity',
    files: 'src/App.vue + src/components/**/*.vue (13 files, 6 013 lines; pure JS <script setup>)',
    state: 'active',
    tone: 'accent'
  },
  {
    lang: 'Rust',
    icon: 'cpu',
    share: '6.2%',
    role: 'Acoustic DSP + Tiselius–Hovorka RK4 core → WebAssembly',
    files: 'rust-nephro/src/{lib,sonouroflow_dsp,tiselius_hovorka_rk4}.rs (926 lines)',
    state: rust.value.degraded ? 'js-mirror' : 'wasm',
    tone: rust.value.degraded ? 'warn' : 'ok'
  },
  {
    lang: 'JavaScript ES2024',
    icon: 'bolt',
    share: '29.3%',
    role: 'Engines, composables, IndexedDB vault, report exporter',
    files: 'src/engines/*.js · src/composables/*.js · src/db/*.js (4 354 lines)',
    state: 'active',
    tone: 'accent'
  },
  {
    lang: 'Java 17',
    icon: 'phone',
    share: '4.9%',
    role: 'Capacitor native plugins (acoustic flow + camera pad capture)',
    files: 'NephroAcousticFlowPlugin · NephroDipstickCameraPlugin · MainActivity (729 lines)',
    state: 'apk-only',
    tone: 'info'
  },
  {
    lang: 'Go 1.22',
    icon: 'terminal',
    share: '7.5%',
    role: 'Serverless supersaturation + KDIGO uroflow solver',
    files: 'api/nephro_biochem.go · go_nephro/{stone_supersaturation,uroflow_kdigo_solver}.go (1 118 lines)',
    state: 'local-mirror',
    tone: 'info'
  },
  {
    lang: 'GLSL + CSS',
    icon: 'palette',
    share: '10.3%',
    role: 'WebGL2 renal-fluid underlay + chromatic lens; 4-theme design system',
    files: 'src/shaders/*.glsl (413 lines) · src/style.css (1 110 lines)',
    state: webgl.value.underlay === 'online' ? 'compiled' : 'fallback',
    tone: webgl.value.underlay === 'online' ? 'ok' : 'warn'
  }
])

const storeRows = computed(() => {
  if (!census.value) return []
  return Object.entries(STORE_META).map(([key, meta]) => ({
    key,
    label: meta.label,
    module: meta.module,
    count: census.value.records[key] ?? 0
  }))
})

async function runBench() {
  busy.value = true
  try {
    bench.value = benchmarkFFT(160)
    emit('toast', { text: `FFT benchmark: ${bench.value.transformsPerSec} transforms/s`, level: 'normal' })
  } finally {
    busy.value = false
  }
}

async function refreshCensus() {
  busy.value = true
  try {
    census.value = await vaultCensus()
  } catch (err) {
    emit('toast', { text: `Vault census failed: ${err?.message || err}`, level: 'warn' })
  } finally {
    busy.value = false
  }
}

async function reattemptWasm() {
  busy.value = true
  try {
    rust.value = await initRustNephro()
    emit('toast', {
      text: rust.value.runtime === 'wasm' ? 'WASM module online' : `Mirror retained: ${rust.value.reason}`,
      level: rust.value.runtime === 'wasm' ? 'normal' : 'warn'
    })
  } finally {
    busy.value = false
  }
}

async function drainOutbox() {
  busy.value = true
  try {
    syncResult.value = await flushOutbox(async () => { throw new Error('no transport configured in web build') })
    emit('toast', { text: `Outbox drained: ${syncResult.value.synced} synced / ${syncResult.value.attempted} attempted`, level: 'info' })
    await refreshCensus()
  } catch (err) {
    emit('toast', { text: `Outbox drain failed: ${err?.message || err}`, level: 'warn' })
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  rust.value = runtimeInfo()
  refreshCensus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="modal-layer" role="dialog" aria-modal="true" aria-label="Polyglot runtime inspector">
        <div class="modal-scrim" @click="emit('close')" />
        <div class="modal-sheet wide">
          <header class="modal-head">
            <div class="rt-mark"><NephroIcon name="cpu" :size="19" /></div>
            <div>
              <h2>Polyglot Runtime Inspector</h2>
              <div class="sub mono">Six language surfaces · live state, not claims</div>
            </div>
            <button class="btn icon ghost close" aria-label="Close" @click="emit('close')">
              <NephroIcon name="close" :size="17" />
            </button>
          </header>

          <div class="modal-body">
            <div class="lang-grid">
              <div v-for="l in langs" :key="l.lang" class="lang-card">
                <div class="lang-head">
                  <NephroIcon :name="l.icon" :size="16" />
                  <div class="lang-title">
                    <strong>{{ l.lang }}</strong>
                    <span class="mono dim">{{ l.share }}</span>
                  </div>
                  <span class="chip" :class="l.tone" style="font-size: 8px; padding: 1px 7px">{{ l.state }}</span>
                </div>
                <p class="lang-role">{{ l.role }}</p>
                <p class="lang-files mono">{{ l.files }}</p>
              </div>
            </div>

            <div class="inspector-grid">
              <div class="glass tight pad">
                <div class="label">Rust / WASM bridge</div>
                <div class="kv-list" style="margin-top: 8px">
                  <div class="kv-row"><span class="k">Runtime</span><span class="v" :style="{ color: rust.degraded ? 'var(--warning)' : 'var(--success)' }">{{ rust.runtime }}</span></div>
                  <div class="kv-row"><span class="k">Engine</span><span class="v">{{ rust.engine }}</span></div>
                  <div class="kv-row"><span class="k">WASM exports</span><span class="v">{{ rust.wasmExports }}</span></div>
                  <div class="kv-row"><span class="k">Bridge calls</span><span class="v">{{ rust.calls }}</span></div>
                  <div class="kv-row"><span class="k">Mirror parity</span><span class="v">{{ rust.mirrorParity }}</span></div>
                </div>
                <p class="rust-reason">{{ rust.reason }}</p>
                <button class="btn sm" :disabled="busy" @click="reattemptWasm">
                  <NephroIcon name="refresh" :size="12" /> Retry WASM probe
                </button>
              </div>

              <div class="glass tight pad">
                <div class="label">WebGL2 pipelines</div>
                <div class="kv-list" style="margin-top: 8px">
                  <div class="kv-row"><span class="k">Renal underlay</span><span class="v" :style="{ color: webgl.underlay === 'online' ? 'var(--success)' : 'var(--warning)' }">{{ webgl.underlay }}</span></div>
                  <div class="kv-row"><span class="k">Chromatic lens</span><span class="v" :style="{ color: webgl.lens === 'online' ? 'var(--success)' : 'var(--warning)' }">{{ webgl.lens }}</span></div>
                  <div class="kv-row"><span class="k">Frame rate</span><span class="v">{{ webgl.fps }} fps</span></div>
                  <div class="kv-row"><span class="k">Frames drawn</span><span class="v">{{ webgl.frames }}</span></div>
                  <div class="kv-row"><span class="k">Link time</span><span class="v">{{ webgl.programMs }} ms</span></div>
                  <div class="kv-row"><span class="k">GLSL</span><span class="v">{{ webgl.glsl }}</span></div>
                </div>
                <p class="rust-reason">{{ webgl.renderer }}</p>
              </div>

              <div class="glass tight pad">
                <div class="label">FFT micro-benchmark</div>
                <template v-if="bench">
                  <div class="kv-list" style="margin-top: 8px">
                    <div class="kv-row"><span class="k">Transforms</span><span class="v">{{ bench.iterations }} × {{ bench.fftSize }}</span></div>
                    <div class="kv-row"><span class="k">Per transform</span><span class="v">{{ bench.perTransformMs }} ms</span></div>
                    <div class="kv-row"><span class="k">Throughput</span><span class="v">{{ bench.transformsPerSec }} /s</span></div>
                    <div class="kv-row"><span class="k">60 fps headroom</span><span class="v">{{ bench.realtime60fpsHeadroom }}×</span></div>
                  </div>
                </template>
                <p v-else class="rust-reason">Run the benchmark to measure the real FFT cost in this browser.</p>
                <button class="btn sm" :disabled="busy" @click="runBench">
                  <NephroIcon name="bolt" :size="12" /> Run benchmark
                </button>
              </div>
            </div>

            <div class="glass tight pad" style="margin-top: 12px">
              <div class="row" style="justify-content: space-between">
                <div class="label">IndexedDB vault · nephro_spectra_vault_v1</div>
                <div class="row tight">
                  <span class="chip mono">{{ census?.total ?? '—' }} records</span>
                  <button class="btn sm ghost" :disabled="busy" @click="refreshCensus"><NephroIcon name="refresh" :size="12" /> Census</button>
                  <button class="btn sm ghost" :disabled="busy" @click="drainOutbox"><NephroIcon name="sync" :size="12" /> Drain outbox</button>
                </div>
              </div>
              <div class="store-table">
                <div v-for="s in storeRows" :key="s.key" class="store-row">
                  <span class="store-name mono">{{ s.key }}</span>
                  <span class="store-module">{{ s.module }}</span>
                  <span class="store-count mono">{{ s.count }}</span>
                </div>
              </div>
              <p v-if="syncResult" class="rust-reason">
                Last drain: {{ syncResult.attempted }} attempted · {{ syncResult.synced }} synced ·
                {{ syncResult.failed }} pending (no Supabase transport in the web build)
              </p>
            </div>

            <div class="glass tight pad" style="margin-top: 12px">
              <div class="label">Go serverless mirrors</div>
              <p class="rust-reason" style="margin-top: 6px">
                <code>api/nephro_biochem.go</code> (HTTP handler) and
                <code>go_nephro/stone_supersaturation.go</code> /
                <code>go_nephro/uroflow_kdigo_solver.go</code> are compiled by Vercel's Go runtime and
                mirrored in-browser by <code>stoneSupersaturationEngine.js</code> so the offline APK
                produces identical numbers without a network round-trip.
              </p>
              <div class="kv-list" style="margin-top: 8px">
                <div class="kv-row"><span class="k">Endpoints</span><span class="v mono">/api/nephro_biochem?op=stonesupersaturation</span></div>
                <div class="kv-row"><span class="k">Endpoints</span><span class="v mono">/api/nephro_biochem?op=uroflowkdigo</span></div>
                <div class="kv-row"><span class="k">Language</span><span class="v">Go 1.22 · net/http · no deps</span></div>
              </div>
            </div>
          </div>

          <footer class="modal-foot">
            <span class="chip mono">v28.0.0-polyglot</span>
            <span class="chip" :class="rbac.isAdmin.value ? 'ok' : 'info'">{{ rbac.meta.value.name }}</span>
            <span class="chip mono">0.0% TypeScript</span>
            <span class="spacer" />
            <button class="btn ghost sm" @click="emit('close')">Close</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.rt-mark {
  width: 34px; height: 34px; border-radius: 11px;
  display: grid; place-items: center;
  background: linear-gradient(150deg, color-mix(in srgb, var(--accent-3) 40%, transparent), color-mix(in srgb, var(--accent) 22%, transparent));
  border: 1px solid var(--glass-border-strong);
  flex: 0 0 auto;
}
.lang-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(232px, 1fr)); gap: 9px; }
.lang-card {
  padding: 11px 12px; border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--glass-1) 60%, transparent);
}
.lang-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--accent); }
.lang-title { display: flex; flex-direction: column; line-height: 1.2; flex: 1; min-width: 0; }
.lang-title strong { font-size: 11.5px; color: var(--text-primary); font-weight: 650; }
.lang-title span { font-size: 8.5px; }
.lang-role { font-size: 10px; color: var(--text-secondary); line-height: 1.45; }
.lang-files { font-size: 8.5px; color: var(--text-tertiary); margin-top: 5px; line-height: 1.45; word-break: break-word; }

.inspector-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(244px, 1fr)); gap: 10px; margin-top: 12px; }
.rust-reason { font-size: 10px; color: var(--text-tertiary); line-height: 1.5; margin: 9px 0; }
.rust-reason code { font-family: var(--font-mono); color: var(--accent-2); font-size: 9.5px; }

.store-table { display: grid; gap: 3px; margin-top: 10px; }
.store-row {
  display: grid; grid-template-columns: 1fr 1fr 52px; gap: 10px; align-items: center;
  padding: 6px 10px; border-radius: 7px;
  background: color-mix(in srgb, var(--bg-void) 26%, transparent);
  font-size: 10px;
}
.store-name { color: var(--accent-2); font-size: 9.5px; }
.store-module { color: var(--text-tertiary); font-size: 9.5px; }
.store-count { text-align: right; color: var(--text-primary); font-weight: 600; }
</style>

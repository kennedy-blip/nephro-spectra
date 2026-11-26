<script setup>
/**
 * NEPHRO-SPECTRA — root shell.
 *
 * Composition:
 *   · WebGL2 renal-fluid underlay driven by live module telemetry
 *   · SVG film-grain overlay (feTurbulence baseFrequency 0.80 / 3 octaves)
 *   · Glass top bar with theme swatches, desktop/APK-frame toggle, RBAC pill
 *   · Gooey metaball dock (SVG filter #nephro-gooey-dock)
 *   · Depth-push module transitions + telemetry HUD
 *   · One-Tap APK modal + Polyglot Runtime Inspector
 *
 * 0.0% TypeScript — every <script> is plain JavaScript.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import RenalFluidUnderlay from './components/ui/RenalFluidUnderlay.vue'
import GooeyDock from './components/ui/GooeyDock.vue'
import NephroIcon from './components/ui/NephroIcon.vue'
import ApkOneTapModal from './components/ui/ApkOneTapModal.vue'
import PolyglotRuntimeInspector from './components/ui/PolyglotRuntimeInspector.vue'

import AcousticUroflowLab from './components/modules/AcousticUroflowLab.vue'
import ChronoDipstickScanner from './components/modules/ChronoDipstickScanner.vue'
import KidneyStoneSupersaturationLab from './components/modules/KidneyStoneSupersaturationLab.vue'
import GlycemicRenalOsmolalityLab from './components/modules/GlycemicRenalOsmolalityLab.vue'
import KdigoEgfrQuoteAuditor from './components/modules/KdigoEgfrQuoteAuditor.vue'

import { useRbac, ROLE_META } from './composables/useRbac.js'
import { useDepthPush } from './composables/useSpringPhysics.js'
import { seedIfEmpty, STORE, listRecords, vaultCensus } from './db/indexedDbNephroVault.js'
import { runtimeInfo } from './engines/rustNephroBridge.js'
import { buildPreset, VOIDING_PRESETS } from './engines/acousticUroflowEngine.js'

/* ---------------------------------------------------------------- themes */

const THEMES = [
  { id: 'obsidian', name: 'Obsidian Renal Lab', index: 0, accent: '#4fa9d9' },
  { id: 'daylight', name: 'Daylight Clinical Frost', index: 1, accent: '#2d7fa8' },
  { id: 'colorimeter', name: 'Chromatic D65 Colorimeter Darkroom', index: 2, accent: '#8f6ef0' },
  { id: 'eco', name: 'Eco-Glass', index: 3, accent: '#6bc99a' }
]

const themeId = ref((typeof localStorage !== 'undefined' && localStorage.getItem('nephro-spectra.theme')) || 'obsidian')
const themeIndex = computed(() => THEMES.find((t) => t.id === themeId.value)?.index ?? 0)

function setTheme(id) {
  themeId.value = id
  document.documentElement.setAttribute('data-theme', id === 'obsidian' ? 'obsidian' : id)
  if (typeof localStorage !== 'undefined') localStorage.setItem('nephro-spectra.theme', id)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEMES.find((t) => t.id === id)?.accent || '#060d18')
}

/* ------------------------------------------------------------ view mode */

const viewMode = ref('desktop') // desktop | apk
const MODULES = [
  { id: 'uroflow', label: 'Acoustic Uroflow', icon: 'wave', component: AcousticUroflowLab },
  { id: 'dipstick', label: 'Chrono Dipstick', icon: 'pad', component: ChronoDipstickScanner },
  { id: 'stones', label: 'Stone Chemistry', icon: 'stone', component: KidneyStoneSupersaturationLab },
  { id: 'glycemic', label: 'Glycemic / Osmolal', icon: 'droplet', component: GlycemicRenalOsmolalityLab },
  { id: 'kdigo', label: 'KDIGO & CPT', icon: 'gauge', component: KdigoEgfrQuoteAuditor }
]

const activeModule = ref('uroflow')
const activeComponent = computed(() => MODULES.find((m) => m.id === activeModule.value)?.component || AcousticUroflowLab)
const activeMeta = computed(() => MODULES.find((m) => m.id === activeModule.value))

const dockItems = computed(() => MODULES.map((m) => ({ id: m.id, label: m.label, icon: m.icon })))

/* ------------------------------------------------------- depth push nav */

const depth = useDepthPush()
const transitioning = ref(false)

function selectModule(id) {
  if (id === activeModule.value) return
  transitioning.value = true
  depth.open()
  setTimeout(() => {
    activeModule.value = id
    transitioning.value = false
    depth.close()
    const scroller = document.querySelector('.main-scroll')
    if (scroller) scroller.scrollTop = 0
  }, 190)
}

/* ------------------------------------------------------------- telemetry */

const telemetry = ref({ flowRateMlSec: 0, supersaturationIndex: 0, hydrationUsg: 1.018 })
const underlayStatus = ref({ webgl2: false, fps: 0 })
const lensStatus = ref({ webgl2: false })

function onTelemetry(payload) {
  telemetry.value = { ...telemetry.value, ...payload }
}

/* ---------------------------------------------------------------- toasts */

const toasts = ref([])
let toastSeq = 0
function pushToast(t) {
  const id = ++toastSeq
  toasts.value = [...toasts.value.slice(-3), { id, text: t.text, level: t.level || 'info' }]
  setTimeout(() => { toasts.value = toasts.value.filter((x) => x.id !== id) }, 4600)
}

/* ---------------------------------------------------------------- modals */

const apkOpen = ref(false)
const runtimeOpen = ref(false)
const rbacOpen = ref(false)
const hudOpen = ref(true)

const rbac = useRbac()

/* ----------------------------------------------------------------- vault */

const census = ref({ total: 0, records: {} })

async function refreshCensus() {
  try {
    census.value = await vaultCensus()
  } catch {
    census.value = { total: 0, records: {}, error: true }
  }
}

/** Seed one demonstration record per clinical store so the vault is never empty. */
async function seedVault() {
  try {
    const demo = buildPreset(VOIDING_PRESETS[0])
    await seedIfEmpty({
      [STORE.UROFLOW]: {
        patientRef: 'DEMO-SEED-0001',
        preset: 'normal-male',
        sex: 'male',
        age: 34,
        metrics: demo.metrics,
        trace: demo.trace.filter((_, i) => i % 4 === 0),
        source: 'first-run-seed'
      }
    })
    await refreshCensus()
  } catch (err) {
    console.warn('[vault] seed skipped', err?.message || err)
  }
}

/* ------------------------------------------------------------- keyboard */

function onKey(e) {
  if (e.key === 'Escape') {
    apkOpen.value = false
    runtimeOpen.value = false
    rbacOpen.value = false
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const idx = Number(e.key)
  if (idx >= 1 && idx <= MODULES.length) selectModule(MODULES[idx - 1].id)
  if (e.key.toLowerCase() === 't') {
    const i = THEMES.findIndex((t) => t.id === themeId.value)
    setTheme(THEMES[(i + 1) % THEMES.length].id)
  }
  if (e.key.toLowerCase() === 'k') apkOpen.value = true
  if (e.key.toLowerCase() === 'i') runtimeOpen.value = true
}

const rustInfo = ref(runtimeInfo())
const uptime = ref(0)
let uptimeTimer = null

onMounted(() => {
  setTheme(themeId.value)
  window.addEventListener('keydown', onKey)
  seedVault()
  uptimeTimer = setInterval(() => { uptime.value += 1 }, 1000)
  rustInfo.value = runtimeInfo()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (uptimeTimer) clearInterval(uptimeTimer)
})

watch(activeModule, () => { rustInfo.value = runtimeInfo() })

const hudUptime = computed(() => {
  const m = Math.floor(uptime.value / 60)
  const s = uptime.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})
</script>

<template>
  <div class="app-shell" :data-theme="themeId">
    <!-- WebGL2 renal fluid underlay -->
    <RenalFluidUnderlay
      :flow-rate-ml-sec="telemetry.flowRateMlSec"
      :supersaturation-index="telemetry.supersaturationIndex"
      :hydration-usg="telemetry.hydrationUsg"
      :theme-index="themeIndex"
      :intensity="0.92"
      :seed="0.42"
      @status="underlayStatus = $event"
    />

    <!-- SVG film grain -->
    <div class="grain-overlay" aria-hidden="true" />

    <!-- ============================ top bar ============================ -->
    <header class="topbar">
      <div class="brand-lockup">
        <div class="brand-mark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2.4c3.6 4.3 6.6 8 6.6 11.4A6.6 6.6 0 0 1 12 20.4 6.6 6.6 0 0 1 5.4 13.8C5.4 10.4 8.4 6.7 12 2.4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <circle cx="12" cy="12.4" r="2.2" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </div>
        <div>
          <div class="brand-title">Nephro-Spectra</div>
          <div class="brand-sub">Renal acoustics · chrono-colorimetry · stone chemistry</div>
        </div>
      </div>

      <div class="topbar-spacer" />

      <!-- desktop / apk toggle -->
      <div class="segmented" role="group" aria-label="View mode">
        <button :class="{ active: viewMode === 'desktop' }" @click="viewMode = 'desktop'">
          <NephroIcon name="monitor" :size="11" style="display: inline; vertical-align: -1px; margin-right: 4px" />Desktop
        </button>
        <button :class="{ active: viewMode === 'apk' }" @click="viewMode = 'apk'">
          <NephroIcon name="phone" :size="11" style="display: inline; vertical-align: -1px; margin-right: 4px" />Mobile APK Frame
        </button>
      </div>

      <!-- themes -->
      <div class="theme-row" role="group" aria-label="Theme">
        <button
          v-for="t in THEMES"
          :key="t.id"
          class="theme-chip"
          :class="{ active: themeId === t.id }"
          :data-theme-id="t.id"
          :title="t.name"
          :aria-label="t.name"
          :aria-pressed="themeId === t.id"
          @click="setTheme(t.id)"
        />
      </div>

      <!-- RBAC -->
      <button class="rbac-pill" @click="rbacOpen = true" :aria-label="`Role: ${rbac.meta.value.name}`">
        <span class="rbac-avatar" :style="{ color: rbac.meta.value.accent }">
          <NephroIcon :name="rbac.meta.value.icon" :size="14" />
        </span>
        <span class="rbac-text">
          <span class="rbac-role">{{ rbac.meta.value.name }}</span>
          <span class="rbac-tier">{{ rbac.meta.value.badge }}</span>
        </span>
      </button>

      <button class="btn icon ghost" title="One-Tap APK (K)" aria-label="One-Tap APK" @click="apkOpen = true">
        <NephroIcon name="download" :size="16" />
      </button>
      <button class="btn icon ghost" title="Runtime inspector (I)" aria-label="Runtime inspector" @click="runtimeOpen = true">
        <NephroIcon name="cpu" :size="16" />
      </button>
    </header>

    <!-- ============================ body ============================ -->
    <div class="apk-frame-stage" v-if="viewMode === 'apk'">
      <div class="phone-frame">
        <div class="phone-notch" />
        <div class="phone-screen">
          <main class="main-scroll">
            <div class="workspace-head" style="margin-bottom: 10px">
              <div>
                <div class="eyebrow" style="font-size: 8px">{{ activeMeta?.label }}</div>
                <h1 style="font-size: 15px">Nephro-Spectra</h1>
                <p style="font-size: 10px; line-height: 1.45">
                  Capacitor WebView frame · {{ rbac.meta.value.name }} tier · vault {{ census.total }} records
                </p>
              </div>
            </div>
            <Transition name="slide" mode="out-in">
              <component
                :is="activeComponent"
                :key="activeModule"
                @telemetry="onTelemetry"
                @toast="pushToast"
              />
            </Transition>
          </main>
          <GooeyDock :items="dockItems" :active="activeModule" @select="selectModule" @action="(a) => (a === 'apk' ? (apkOpen = true) : (runtimeOpen = true))" />
        </div>
      </div>
      <div class="phone-caption">
        <span class="chip mono">9:19.5 device frame</span>
        <span class="chip info">Capacitor WebView</span>
        <span class="chip mono">com.nephrospectra.clinical</span>
        <button class="btn sm" @click="apkOpen = true">
          <NephroIcon name="download" :size="12" /> One-Tap APK
        </button>
      </div>
    </div>

    <main v-else class="main-scroll" :style="depth.active.value ? depth.styleForBackground() : {}">
      <Transition name="slide" mode="out-in">
        <component
          :is="activeComponent"
          :key="activeModule"
          @telemetry="onTelemetry"
          @toast="pushToast"
        />
      </Transition>

      <footer class="app-footer">
        <div class="footer-brand">
          <strong>NEPHRO-SPECTRA</strong> <span class="mono">v28.0.0-polyglot</span>
          <span class="dim">· Vue 3.5 · Rust/WASM DSP · Go 1.22 · Java 17 · GLSL ES 3.00 · 0.0% TypeScript</span>
        </div>
        <div class="footer-meta">
          <span class="chip mono">vault {{ census.total }} records</span>
          <span class="chip mono">{{ rustInfo.runtime }}</span>
          <span class="chip mono">uptime {{ hudUptime }}</span>
          <span class="chip info">decision support only</span>
        </div>
      </footer>
    </main>

    <!-- telemetry HUD -->
    <aside v-if="hudOpen && viewMode === 'desktop'" class="hud">
      <div class="hud-title">
        <span class="pulse-dot" :style="{ background: underlayStatus.webgl2 ? 'var(--success)' : 'var(--warning)' }" />
        Telemetry
        <span class="spacer" />
        <button style="color: inherit; opacity: .6" aria-label="Hide HUD" @click="hudOpen = false">
          <NephroIcon name="close" :size="10" />
        </button>
      </div>
      <div class="hud-row"><span>u_flowRateMlSec</span><span class="v">{{ telemetry.flowRateMlSec.toFixed(2) }}</span></div>
      <div class="hud-row"><span>u_supersaturationIndex</span><span class="v">{{ telemetry.supersaturationIndex.toFixed(3) }}</span></div>
      <div class="hud-row"><span>u_hydrationUsg</span><span class="v">{{ telemetry.hydrationUsg.toFixed(3) }}</span></div>
      <div class="hud-row"><span>u_theme</span><span class="v">{{ themeIndex }} · {{ themeId }}</span></div>
      <div class="hud-row"><span>gl.fps</span><span class="v">{{ underlayStatus.fps || '—' }}</span></div>
      <div class="hud-row"><span>gl.frames</span><span class="v">{{ underlayStatus.frames || 0 }}</span></div>
      <div class="hud-row"><span>rust.runtime</span><span class="v">{{ rustInfo.runtime }}</span></div>
      <div class="hud-row"><span>vault.records</span><span class="v">{{ census.total }}</span></div>
    </aside>
    <button v-else-if="!hudOpen && viewMode === 'desktop'" class="hud-reopen" @click="hudOpen = true" aria-label="Show HUD">
      <NephroIcon name="sliders" :size="14" />
    </button>

    <!-- gooey dock -->
    <GooeyDock
      v-if="viewMode === 'desktop'"
      :items="dockItems"
      :active="activeModule"
      @select="selectModule"
      @action="(a) => (a === 'apk' ? (apkOpen = true) : (runtimeOpen = true))"
    />

    <!-- toasts -->
    <div class="toast-stack">
      <TransitionGroup name="slide">
        <div v-for="t in toasts" :key="t.id" class="toast-item" :class="t.level">
          <NephroIcon :name="t.level === 'danger' ? 'warning' : t.level === 'warn' ? 'info' : 'check'" :size="13" />
          <span>{{ t.text }}</span>
        </div>
      </TransitionGroup>
    </div>

    <!-- modals -->
    <ApkOneTapModal :open="apkOpen" @close="apkOpen = false" />
    <PolyglotRuntimeInspector
      :open="runtimeOpen"
      :underlay-status="underlayStatus"
      :lens-status="lensStatus"
      @close="runtimeOpen = false"
      @toast="pushToast"
    />

    <!-- RBAC drawer -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="rbacOpen" class="modal-layer" role="dialog" aria-modal="true" aria-label="Access tier">
          <div class="modal-scrim" @click="rbacOpen = false" />
          <div class="modal-sheet narrow">
            <header class="modal-head">
              <NephroIcon name="shield" :size="17" />
              <div><h2>Access Tier</h2><div class="sub">Three-tier role-based access control</div></div>
              <button class="btn icon ghost close" aria-label="Close" @click="rbacOpen = false">
                <NephroIcon name="close" :size="16" />
              </button>
            </header>
            <div class="modal-body">
              <div class="role-list">
                <button
                  v-for="r in rbac.allRoles"
                  :key="r.id"
                  class="role-card"
                  :class="{ active: rbac.role.value === r.id }"
                  @click="rbac.setRole(r.id)"
                >
                  <span class="role-icon" :style="{ color: r.accent }"><NephroIcon :name="r.icon" :size="17" /></span>
                  <span class="role-body">
                    <strong>{{ r.name }} <span class="mono dim">{{ r.badge }}</span></strong>
                    <span class="role-tagline">{{ r.tagline }}</span>
                    <span class="role-desc">{{ r.description }}</span>
                    <span class="role-caps">
                      <i v-for="c in rbac.capabilityMatrix[r.id].slice(0, 8)" :key="c" class="cap-dot" :title="c" />
                      <span class="mono dim">+{{ rbac.capabilityMatrix[r.id].length - 8 }} more</span>
                    </span>
                  </span>
                </button>
              </div>
            </div>
            <footer class="modal-foot">
              <span class="chip mono">{{ rbac.capabilities.value.size }} active capabilities</span>
              <span class="spacer" />
              <button class="btn sm ghost" @click="rbac.cycleRole">Cycle tier</button>
              <button class="btn sm" @click="rbacOpen = false">Done</button>
            </footer>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.phone-caption {
  display: flex; gap: 9px; flex-wrap: wrap; align-items: center;
  margin-top: 20px; justify-content: center;
}
.app-footer {
  margin-top: 26px; padding: 16px 4px 8px;
  border-top: 1px solid var(--glass-border);
  display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
  font-size: 10px; color: var(--text-tertiary);
}
.footer-brand { flex: 1 1 320px; line-height: 1.6; }
.footer-brand strong { color: var(--text-secondary); letter-spacing: 0.1em; font-size: 10px; }
.footer-meta { display: flex; gap: 6px; flex-wrap: wrap; }

.hud-reopen {
  position: fixed; right: 16px; bottom: 96px; z-index: 35;
  width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--hud-bg); border: 1px solid var(--glass-border);
  color: var(--text-secondary);
  backdrop-filter: blur(16px);
  transition: transform var(--spring-fast), color var(--spring-fast);
}
.hud-reopen:hover { transform: scale(1.08); color: var(--text-primary); }

.toast-stack {
  position: fixed; top: 74px; right: 18px; z-index: 100;
  display: flex; flex-direction: column; gap: 7px;
  pointer-events: none; max-width: 360px;
}
.toast-item {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 13px; border-radius: var(--radius-md);
  background: var(--hud-bg); border: 1px solid var(--glass-border);
  backdrop-filter: blur(20px);
  font-size: 11px; line-height: 1.45; color: var(--text-secondary);
  box-shadow: 0 16px 38px -22px rgba(0, 0, 0, 0.9);
}
.toast-item.normal { border-color: color-mix(in srgb, var(--success) 46%, transparent); }
.toast-item.normal :deep(.nephro-icon) { color: var(--success); }
.toast-item.warn { border-color: color-mix(in srgb, var(--warning) 46%, transparent); }
.toast-item.warn :deep(.nephro-icon) { color: var(--warning); }
.toast-item.danger { border-color: color-mix(in srgb, var(--danger) 46%, transparent); }
.toast-item.danger :deep(.nephro-icon) { color: var(--danger); }
.toast-item.info :deep(.nephro-icon) { color: var(--info); }

.role-list { display: grid; gap: 9px; }
.role-card {
  display: flex; gap: 12px; text-align: left;
  padding: 13px 14px; border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--glass-1) 62%, transparent);
  transition: all var(--spring-fast);
}
.role-card:hover { border-color: var(--glass-border-strong); transform: translateY(-1px); }
.role-card.active {
  border-color: color-mix(in srgb, var(--accent) 62%, transparent);
  background: linear-gradient(155deg, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--glass-3) 70%, transparent));
  box-shadow: 0 12px 30px -20px var(--accent);
}
.role-icon {
  width: 32px; height: 32px; border-radius: 10px;
  display: grid; place-items: center;
  background: color-mix(in srgb, currentColor 16%, transparent);
  border: 1px solid var(--glass-border);
  flex: 0 0 auto;
}
.role-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.role-body strong { font-size: 12px; font-weight: 650; }
.role-tagline { font-size: 10px; color: var(--accent-2); }
.role-desc { font-size: 10px; color: var(--text-tertiary); line-height: 1.5; }
.role-caps { display: flex; align-items: center; gap: 3px; margin-top: 4px; flex-wrap: wrap; }
.cap-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.7; }
.role-caps .mono { margin-left: 4px; font-size: 8.5px; }
</style>

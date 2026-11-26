/**
 * NEPHRO-SPECTRA — application entry point.
 * Mounts the Vue 3.5 root, warms the IndexedDB vault, and upgrades the Rust/WASM
 * DSP module if a compiled artefact is deployed (deterministic JS mirror
 * otherwise). Zero TypeScript anywhere in the tree.
 */
import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

import { openVault } from './db/indexedDbNephroVault.js'
import { initRustNephro } from './engines/rustNephroBridge.js'

const app = createApp(App)

app.config.errorHandler = (err, instance, info) => {
  // Never swallow a real fault: surface it on the console with the component
  // stack so the Polyglot Inspector's error ring can pick it up.
  console.error('[NEPHRO-SPECTRA] component fault', { info, err })
}

app.mount('#app')

// Non-blocking warm-up. Both are best-effort and individually inspectable.
openVault()
  .then((db) => {
    console.info('[vault] nephro_spectra_vault_v1 ready', db.version)
  })
  .catch((err) => console.warn('[vault] unavailable', err?.message || err))

initRustNephro()
  .then((info) => {
    console.info(`[rust] ${info.runtime} — ${info.reason || 'compiled module loaded'}`)
  })
  .catch((err) => console.warn('[rust] bridge init failed', err?.message || err))

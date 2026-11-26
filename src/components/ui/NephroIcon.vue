<script setup>
/**
 * NEPHRO-SPECTRA — inline stroke icon set.
 * Every glyph is drawn from a single 24×24 path table so the whole workstation
 * shares one optical weight, and no external icon font is ever fetched.
 */
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 20 },
  stroke: { type: [Number, String], default: 1.6 }
})

const PATHS = {
  wave: 'M2 12h3l2.5-7 4 14 3-9 2.5 4H22',
  droplet: 'M12 2.6c3.4 4.1 6.4 7.8 6.4 11.1A6.4 6.4 0 0 1 12 20a6.4 6.4 0 0 1-6.4-6.3C5.6 10.4 8.6 6.7 12 2.6Z',
  kidney: 'M9 3c-3.3 0-6 2.9-6 6.5 0 4 2.4 5.4 3.6 8.2.6 1.5 1.5 3.3 3 3.3 2 0 2.4-2.6 2.4-5.3V8.3C12 5.2 11.4 3 9 3Zm6 0c3.3 0 6 2.9 6 6.5 0 4-2.4 5.4-3.6 8.2-.6 1.5-1.5 3.3-3 3.3',
  crystal: 'M12 2.6 4 8.2v7.6l8 5.6 8-5.6V8.2L12 2.6Zm0 0v19M4 8.2l8 4.4 8-4.4',
  pad: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 4h8M8 11h8M8 15h5',
  gauge: 'M21 12a9 9 0 1 0-18 0M12 12l4.2-4.2M12 21v-1.5M3.5 12H5M19 12h1.5M6 6l1 1M18 6l-1 1',
  shield: 'M12 3 4.5 6v5.4c0 4 3.1 7.7 7.5 9.6 4.4-1.9 7.5-5.6 7.5-9.6V6L12 3Z',
  terminal: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3.5 6.5L11 14l-3.5 3.5M13 17.5h4',
  stethoscope: 'M6 3v6a4 4 0 0 0 8 0V3M5 3h2M13 3h2M10 13v3a4 4 0 0 0 8 0v-2.5M18 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0',
  report: 'M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v4h4M9 12h6M9 16h6M9 8h2',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  play: 'M7 4.5v15l13-7.5-13-7.5Z',
  pause: 'M8 4.5v15M16 4.5v15',
  reset: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V10H9',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm8 3v6c0 1.7-3.6 3-8 3s-8-1.3-8-3V6m16 6v6c0 1.7-3.6 3-8 3s-8-1.3-8-3v-6',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M7 14v6',
  camera: 'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm8 3.2a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3M9 22h6',
  flask: 'M9 3h6M10 3v6L5.5 18a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9V3M7.5 14h9',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v.5M12 11v6',
  warning: 'M12 3.5 21 19H3l9-15.5Zm0 5v5.5M12 17v.5',
  check: 'M4.5 12.5 9.5 17.5 20 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  cpu: 'M8 8h8v8H8V8ZM4 10h2M4 14h2M18 10h2M18 14h2M10 4v2M14 4v2M10 18v2M14 18v2M5 5h14v14H5V5Z',
  layers: 'M12 3 3 8l9 5 9-5-9-7ZM3 13l9 5 9-5M3 17.5l9 5 9-5',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm2 17h4',
  monitor: 'M3 5h18v11H3V5Zm5 15h8M12 16v4',
  qr: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4.5V10H15',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 8 18a3 3 0 0 0 4 1V4.5A2 2 0 0 0 9 4Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8A3 3 0 0 1 16 18a3 3 0 0 1-4 1',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  palette: 'M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2s-.6-1.6-.6-2.4c0-.8.7-1.6 1.6-1.6H18a3 3 0 0 0 3-3c0-4.4-4-9-9-9ZM7.5 9v.5M11 6.5v.5M15.5 8v.5M7 14v.5',
  urine: 'M6 3h12l-1.4 15.2A2 2 0 0 1 14.6 20H9.4a2 2 0 0 1-2-1.8L6 3Zm2 4h8M9.4 11h5.2',
  stone: 'M12 3.2 5 7.5v9L12 21l7-4.5v-9L12 3.2Zm-2.4 6.1 2.4 2.4 2.4-2.4M12 11.7v7',
  shieldCheck: 'M12 3 4.5 6v5.4c0 4 3.1 7.7 7.5 9.6 4.4-1.9 7.5-5.6 7.5-9.6V6L12 3Zm-2.6 8.4 2 2 4-4.2'
}

const sizeValue = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))
const d = computed(() => PATHS[props.name] || PATHS.info)
</script>

<template>
  <svg
    class="nephro-icon"
    :width="sizeValue"
    :height="sizeValue"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="stroke"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="d" />
  </svg>
</template>

<style scoped>
.nephro-icon {
  display: block;
  flex: 0 0 auto;
  vector-effect: non-scaling-stroke;
  overflow: visible;
}
</style>

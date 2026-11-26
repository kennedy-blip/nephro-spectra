<script setup>
/**
 * NEPHRO-SPECTRA — dependency-free SVG plotting primitives.
 * Draws real axes, ticks and series from the engine outputs — no chart library,
 * no canvas rasterisation, fully crisp at any DPR and printable.
 */
import { computed, ref } from 'vue'

const props = defineProps({
  series: { type: Array, default: () => [] }, // [{ key, label, points:[{x,y}], color, width, dashed, fill, type:'line'|'area'|'scatter'|'band' }]
  xDomain: { type: Array, default: null },
  yDomain: { type: Array, default: null },
  xLabel: { type: String, default: '' },
  yLabel: { type: String, default: '' },
  height: { type: Number, default: 190 },
  xTicks: { type: Number, default: 6 },
  yTicks: { type: Number, default: 5 },
  showLegend: { type: Boolean, default: true },
  markers: { type: Array, default: () => [] }, // [{ x, y, label, color }]
  bands: { type: Array, default: () => [] } // [{ from, to, color, label }]  (y-ranges)
})

const W = 640
const PAD = { l: 46, r: 14, t: 12, b: 30 }

const hover = ref(null)

const innerW = W - PAD.l - PAD.r
const innerH = computed(() => props.height - PAD.t - PAD.b)

const allPoints = computed(() => props.series.flatMap((s) => s.points || []))

const xDom = computed(() => {
  if (props.xDomain) return props.xDomain
  const xs = allPoints.value.map((p) => p.x)
  if (!xs.length) return [0, 1]
  return [Math.min(...xs), Math.max(...xs)]
})

const yDom = computed(() => {
  if (props.yDomain) return props.yDomain
  const ys = allPoints.value.map((p) => p.y)
  if (!ys.length) return [0, 1]
  const lo = Math.min(...ys)
  const hi = Math.max(...ys)
  const pad = (hi - lo) * 0.12 || 1
  return [lo - pad, hi + pad]
})

function sx(x) {
  const [a, b] = xDom.value
  const t = b === a ? 0 : (x - a) / (b - a)
  return PAD.l + t * innerW
}

function sy(y) {
  const [a, b] = yDom.value
  const t = b === a ? 0.5 : (y - a) / (b - a)
  return PAD.t + (1 - t) * innerH.value
}

function pathFor(points) {
  if (!points.length) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' ')
}

function areaFor(points) {
  if (!points.length) return ''
  const base = sy(Math.max(yDom.value[0], 0))
  const line = points.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' L')
  return `M${sx(points[0].x).toFixed(2)},${base.toFixed(2)} L${line} L${sx(points[points.length - 1].x).toFixed(2)},${base.toFixed(2)} Z`
}

const xTickVals = computed(() => niceTicks(xDom.value[0], xDom.value[1], props.xTicks))
const yTickVals = computed(() => niceTicks(yDom.value[0], yDom.value[1], props.yTicks))

function niceTicks(a, b, count) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return [a]
  const span = b - a
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag
  const start = Math.ceil(a / step) * step
  const out = []
  for (let v = start; v <= b + step * 1e-6; v += step) out.push(Number(v.toFixed(10)))
  return out
}

function fmtTick(v) {
  if (Math.abs(v) >= 10000) return v.toExponential(1)
  if (Math.abs(v) >= 100) return v.toFixed(0)
  if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, '')
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(2).replace(/0$/, '')
}

function onMove(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const relX = ((e.clientX - rect.left) / rect.width) * W
  const [a, b] = xDom.value
  const t = (relX - PAD.l) / innerW
  if (t < 0 || t > 1) { hover.value = null; return }
  const xVal = a + t * (b - a)
  // nearest point across all series
  let best = null
  for (const s of props.series) {
    for (const p of s.points || []) {
      const dx = Math.abs(p.x - xVal)
      if (!best || dx < best.dx) best = { dx, p, s }
    }
  }
  hover.value = best ? { ...best, px: sx(best.p.x), py: sy(best.p.y) } : null
}

const gradientId = `plot-grad-${Math.random().toString(36).slice(2, 9)}`
</script>

<template>
  <div class="chart-frame">
    <svg
      :viewBox="`0 0 ${W} ${height}`"
      :style="{ height: `${height}px` }"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`${yLabel} plotted against ${xLabel}`"
      @mousemove="onMove"
      @mouseleave="hover = null"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.34" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- horizontal bands (e.g. KDIGO or normal ranges) -->
      <rect
        v-for="(b, i) in bands"
        :key="`band-${i}`"
        :x="PAD.l"
        :y="sy(b.to)"
        :width="innerW"
        :height="Math.max(0, sy(b.from) - sy(b.to))"
        :fill="b.color"
        opacity="0.10"
      />

      <!-- grid -->
      <g>
        <line
          v-for="t in yTickVals"
          :key="`gy-${t}`"
          :x1="PAD.l"
          :x2="W - PAD.r"
          :y1="sy(t)"
          :y2="sy(t)"
          stroke="var(--chart-grid)"
          stroke-width="1"
        />
      </g>

      <!-- zero line when range straddles zero -->
      <line
        v-if="yDom[0] < 0 && yDom[1] > 0"
        :x1="PAD.l" :x2="W - PAD.r" :y1="sy(0)" :y2="sy(0)"
        stroke="var(--chart-axis)" stroke-width="1" stroke-dasharray="3 3"
      />

      <!-- areas -->
      <path
        v-for="s in series.filter((x) => x.type === 'area' || x.fill)"
        :key="`a-${s.key}`"
        :d="areaFor(s.points || [])"
        :fill="s.fillColor || `url(#${gradientId})`"
        stroke="none"
      />

      <!-- lines -->
      <path
        v-for="s in series.filter((x) => x.type !== 'scatter' && x.type !== 'band')"
        :key="`l-${s.key}`"
        :d="pathFor(s.points || [])"
        fill="none"
        :stroke="s.color || 'var(--accent)'"
        :stroke-width="s.width || 2"
        :stroke-dasharray="s.dashed ? '5 4' : 'none'"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />

      <!-- scatter -->
      <g v-for="s in series.filter((x) => x.type === 'scatter')" :key="`sc-${s.key}`">
        <circle
          v-for="(p, i) in s.points || []"
          :key="`p-${s.key}-${i}`"
          :cx="sx(p.x)"
          :cy="sy(p.y)"
          :r="s.radius || 3.4"
          :fill="s.color || 'var(--accent-2)'"
          :stroke="s.strokeColor || 'var(--bg-void)'"
          stroke-width="1.1"
        >
          <title>{{ p.label || `${fmtTick(p.x)}, ${fmtTick(p.y)}` }}</title>
        </circle>
      </g>

      <!-- markers -->
      <g v-for="(m, i) in markers" :key="`m-${i}`">
        <circle :cx="sx(m.x)" :cy="sy(m.y)" r="5" :fill="m.color || 'var(--accent-2)'" stroke="var(--bg-void)" stroke-width="1.6" />
        <text
          :x="sx(m.x) + 9"
          :y="sy(m.y) + 3.5"
          fill="var(--text-secondary)"
          font-size="8.5"
          font-family="var(--font-mono)"
          letter-spacing="0.06em"
        >{{ m.label }}</text>
      </g>

      <!-- axes -->
      <line :x1="PAD.l" :x2="PAD.l" :y1="PAD.t" :y2="height - PAD.b" stroke="var(--chart-axis)" stroke-width="1" />
      <line :x1="PAD.l" :x2="W - PAD.r" :y1="height - PAD.b" :y2="height - PAD.b" stroke="var(--chart-axis)" stroke-width="1" />

      <!-- ticks -->
      <text
        v-for="t in yTickVals"
        :key="`ty-${t}`"
        :x="PAD.l - 7"
        :y="sy(t) + 3"
        text-anchor="end"
        fill="var(--text-tertiary)"
        font-size="8.5"
        font-family="var(--font-mono)"
      >{{ fmtTick(t) }}</text>
      <text
        v-for="t in xTickVals"
        :key="`tx-${t}`"
        :x="sx(t)"
        :y="height - PAD.b + 13"
        text-anchor="middle"
        fill="var(--text-tertiary)"
        font-size="8.5"
        font-family="var(--font-mono)"
      >{{ fmtTick(t) }}</text>

      <!-- axis labels -->
      <text
        v-if="xLabel"
        :x="W - PAD.r"
        :y="height - 3"
        text-anchor="end"
        fill="var(--text-tertiary)"
        font-size="8"
        letter-spacing="1.4"
      >{{ xLabel.toUpperCase() }}</text>
      <text
        v-if="yLabel"
        :x="11"
        :y="PAD.t + 4"
        fill="var(--text-tertiary)"
        font-size="8"
        letter-spacing="1.4"
      >{{ yLabel.toUpperCase() }}</text>

      <!-- hover crosshair -->
      <g v-if="hover">
        <line
          :x1="hover.px" :x2="hover.px"
          :y1="PAD.t" :y2="height - PAD.b"
          stroke="var(--glass-border-strong)" stroke-width="1" stroke-dasharray="2 3"
        />
        <circle :cx="hover.px" :cy="hover.py" r="4" fill="var(--accent-2)" stroke="var(--bg-void)" stroke-width="1.5" />
      </g>
    </svg>

    <div v-if="hover" class="chart-tip mono">
      {{ hover.s.label }} · x {{ fmtTick(hover.p.x) }} · y {{ fmtTick(hover.p.y) }}
    </div>

    <div v-if="showLegend && series.length > 1" class="chart-legend">
      <span v-for="s in series" :key="`lg-${s.key}`">
        <i :style="{ background: s.color || 'var(--accent)' }" />{{ s.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.chart-tip {
  position: absolute;
  top: 2px;
  right: 4px;
  font-size: 9.5px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--hud-bg);
  border: 1px solid var(--glass-border);
  color: var(--text-secondary);
  pointer-events: none;
  white-space: nowrap;
}
</style>

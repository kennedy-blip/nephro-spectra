<script setup>
/**
 * NEPHRO-SPECTRA — chromatic lens shader viewport for the dipstick scanner.
 * Renders src/shaders/dipstick_sediment_chromatic_lens.glsl against the live
 * pad classification: matched swatch tint, CIEDE2000 ΔE00, sediment density,
 * intact-RBC speckle and the chrono read-progress scan bar.
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import fragmentSource from '@/shaders/dipstick_sediment_chromatic_lens.glsl?raw'

const props = defineProps({
  padTint: { type: Array, default: () => [0.72, 0.82, 0.7] },
  deltaE: { type: Number, default: 3 },
  sedimentDensity: { type: Number, default: 0.3 },
  dispersion: { type: Number, default: 0.55 },
  speckle: { type: Number, default: 0 },
  readProgress: { type: Number, default: 0.55 },
  lensCenter: { type: Array, default: () => [0.5, 0.52] },
  lensRadius: { type: Number, default: 0.38 },
  themeIndex: { type: Number, default: 0 }
})

const emit = defineEmits(['status'])
const canvas = ref(null)
const status = ref({ webgl2: false, reason: 'init' })

let gl = null
let program = null
let uniforms = {}
let raf = null
let t0 = 0
let disposed = false

const VERTEX = `#version 300 es
precision highp float;
const vec2 p[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main(){ gl_Position = vec4(p[gl_VertexID], 0.0, 1.0); }`

function stripVersion(src) {
  return src.split('\n').filter((l) => !l.trim().startsWith('#version')).join('\n')
}

function compile(type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(log)
  }
  return sh
}

function init() {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('webgl2', { alpha: false, antialias: false, depth: false })
  if (!ctx) {
    status.value = { webgl2: false, reason: 'WebGL2 unavailable' }
    emit('status', status.value)
    return
  }
  gl = ctx
  try {
    const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es\n${stripVersion(fragmentSource)}`)
    const vs = compile(gl.VERTEX_SHADER, VERTEX)
    program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    gl.useProgram(program)
    for (const n of [
      'u_time', 'u_resolution', 'u_padTint', 'u_deltaE', 'u_sedimentDensity',
      'u_dispersion', 'u_speckle', 'u_readProgress', 'u_lensCenter', 'u_lensRadius', 'u_theme'
    ]) uniforms[n] = gl.getUniformLocation(program, n)
    gl.bindVertexArray(gl.createVertexArray())
    status.value = { webgl2: true, reason: 'chromatic lens online' }
    emit('status', status.value)
    t0 = performance.now()
    frame()
  } catch (err) {
    status.value = { webgl2: false, reason: String(err.message || err) }
    emit('status', status.value)
  }
}

function resize() {
  const el = canvas.value
  if (!el) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.floor(el.clientWidth * dpr)
  const h = Math.floor(el.clientHeight * dpr)
  if (el.width !== w || el.height !== h) { el.width = w; el.height = h }
  gl.viewport(0, 0, w, h)
}

function frame() {
  if (disposed) return
  raf = requestAnimationFrame(frame)
  if (!gl || !program) return
  const el = canvas.value
  if (!el) return
  resize()
  gl.uniform1f(uniforms.u_time, (performance.now() - t0) / 1000)
  gl.uniform2f(uniforms.u_resolution, el.width, el.height)
  gl.uniform3f(uniforms.u_padTint, props.padTint[0], props.padTint[1], props.padTint[2])
  gl.uniform1f(uniforms.u_deltaE, props.deltaE)
  gl.uniform1f(uniforms.u_sedimentDensity, props.sedimentDensity)
  gl.uniform1f(uniforms.u_dispersion, props.dispersion)
  gl.uniform1f(uniforms.u_speckle, props.speckle)
  gl.uniform1f(uniforms.u_readProgress, props.readProgress)
  gl.uniform2f(uniforms.u_lensCenter, props.lensCenter[0], props.lensCenter[1])
  gl.uniform1f(uniforms.u_lensRadius, props.lensRadius)
  gl.uniform1i(uniforms.u_theme, props.themeIndex)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
}

const onResize = () => resize()

onMounted(() => {
  init()
  window.addEventListener('resize', onResize, { passive: true })
})
onBeforeUnmount(() => {
  disposed = true
  if (raf) cancelAnimationFrame(raf)
  window.removeEventListener('resize', onResize)
  if (gl && program) gl.deleteProgram(program)
})

watch(() => props.themeIndex, () => {})
</script>

<template>
  <div class="shader-viewport">
    <canvas ref="canvas" />
    <div class="viewport-badge">
      <span class="pulse-dot" :style="{ background: status.webgl2 ? 'var(--success)' : 'var(--warning)' }" />
      GLSL ES 3.00 · {{ status.webgl2 ? 'D65 LENS' : 'FALLBACK' }}
    </div>
  </div>
</template>

<style scoped>
.shader-viewport { aspect-ratio: 4 / 3; }
</style>

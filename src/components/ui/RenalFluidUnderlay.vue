<script setup>
/**
 * NEPHRO-SPECTRA — WebGL2 renal-fluid underlay.
 * Full-screen fragment shader (src/shaders/renal_fluid_underlay.glsl) driven by
 * live module state: flow rate, supersaturation, hydration, pointer and gyro.
 * Falls back to a CSS gradient composite if WebGL2 is unavailable, and reports
 * the true runtime state upward so no panel ever claims a shader it lacks.
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import fragmentSource from '@/shaders/renal_fluid_underlay.glsl?raw'
import { usePointerVector, useGyroTilt } from '@/composables/useSpringPhysics.js'

const props = defineProps({
  flowRateMlSec: { type: Number, default: 0 },
  supersaturationIndex: { type: Number, default: 0 },
  hydrationUsg: { type: Number, default: 1.018 },
  themeIndex: { type: Number, default: 0 },
  intensity: { type: Number, default: 0.92 },
  seed: { type: Number, default: 0.5 }
})

const emit = defineEmits(['status'])

const canvas = ref(null)
const pointer = usePointerVector()
const gyro = useGyroTilt()

const status = ref({ webgl2: false, reason: 'initialising', fps: 0, frames: 0, programMs: 0, error: null })

let gl = null
let program = null
let uniforms = {}
let raf = null
let startTime = 0
let frames = 0
let fpsWindow = 0
let disposed = false

// A single oversized triangle covers the viewport with no vertex buffer.
const VERTEX = `#version 300 es
precision highp float;
const vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}`

/** Strip the authored `#version` line so we can control the injection point. */
function withoutVersion(source) {
  return source
    .split('\n')
    .filter((l) => !l.trim().startsWith('#version'))
    .join('\n')
}

function compile(type, source) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, source)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return sh
}

function init() {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  })
  if (!ctx) {
    status.value = { ...status.value, webgl2: false, reason: 'WebGL2 context unavailable — CSS composite fallback active' }
    emit('status', status.value)
    return
  }
  gl = ctx
  try {
    const started = performance.now()
    const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es\n${withoutVersion(fragmentSource)}`)
    const vs = compile(gl.VERTEX_SHADER, VERTEX)
    program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    gl.useProgram(program)

    const names = [
      'u_time', 'u_flowRateMlSec', 'u_supersaturationIndex', 'u_hydrationUsg',
      'u_pointer', 'u_gyroTilt', 'u_resolution', 'u_theme', 'u_intensity', 'u_seed'
    ]
    for (const n of names) uniforms[n] = gl.getUniformLocation(program, n)

    gl.bindVertexArray(gl.createVertexArray())

    status.value = {
      webgl2: true,
      reason: 'WebGL2 pipeline online',
      fps: 0,
      frames: 0,
      programMs: Math.round(performance.now() - started),
      error: null,
      renderer: gl.getParameter(gl.RENDERER),
      glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION)
    }
    emit('status', status.value)
    startTime = performance.now()
    resize()
    loop()
  } catch (err) {
    status.value = { ...status.value, webgl2: false, reason: 'shader-fault', error: String(err.message || err) }
    emit('status', status.value)
  }
}

function resize() {
  const el = canvas.value
  if (!el) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.floor(el.clientWidth * dpr)
  const h = Math.floor(el.clientHeight * dpr)
  if (el.width !== w || el.height !== h) {
    el.width = w
    el.height = h
  }
  if (gl) gl.viewport(0, 0, w, h)
}

function loop() {
  if (disposed) return
  raf = requestAnimationFrame(loop)
  if (!gl || !program) return
  const el = canvas.value
  if (!el) return

  resize()

  const now = performance.now()
  frames++
  if (now - fpsWindow > 500) {
    status.value.fps = Math.round((frames * 1000) / (now - fpsWindow))
    status.value.frames += frames
    emit('status', { ...status.value })
    frames = 0
    fpsWindow = now
  }

  gl.uniform1f(uniforms.u_time, (now - startTime) / 1000)
  gl.uniform1f(uniforms.u_flowRateMlSec, Math.max(0, Math.min(45, props.flowRateMlSec)))
  gl.uniform1f(uniforms.u_supersaturationIndex, Math.max(0, Math.min(8, props.supersaturationIndex)))
  gl.uniform1f(uniforms.u_hydrationUsg, Math.max(1.0, Math.min(1.035, props.hydrationUsg)))
  gl.uniform2f(uniforms.u_pointer, pointer.x.value, pointer.y.value)
  gl.uniform2f(uniforms.u_gyroTilt, gyro.tilt.value.x, gyro.tilt.value.y)
  gl.uniform2f(uniforms.u_resolution, el.width, el.height)
  gl.uniform1i(uniforms.u_theme, props.themeIndex)
  gl.uniform1f(uniforms.u_intensity, props.intensity)
  gl.uniform1f(uniforms.u_seed, props.seed)

  gl.drawArrays(gl.TRIANGLES, 0, 3)
}

const onResize = () => resize()

onMounted(() => {
  init()
  window.addEventListener('resize', onResize, { passive: true })
  gyro.request()
})

onBeforeUnmount(() => {
  disposed = true
  if (raf) cancelAnimationFrame(raf)
  window.removeEventListener('resize', onResize)
  if (gl && program) gl.deleteProgram(program)
})

watch(
  () => props.intensity,
  (v) => { if (gl && uniforms.u_intensity) gl.uniform1f(uniforms.u_intensity, v) }
)

defineExpose({ status })
</script>

<template>
  <canvas
    ref="canvas"
    class="underlay-canvas"
    :class="{ 'underlay-fallback': !status.webgl2 }"
    :data-theme-index="themeIndex"
    aria-hidden="true"
  />
</template>

<style scoped>
.underlay-fallback {
  background:
    radial-gradient(ellipse 90% 60% at 50% -10%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%),
    radial-gradient(ellipse 60% 50% at 12% 108%, color-mix(in srgb, var(--accent-3) 22%, transparent), transparent 72%),
    linear-gradient(180deg, var(--bg-void), var(--bg-deep));
}
</style>

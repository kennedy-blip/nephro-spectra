/**
 * NEPHRO-SPECTRA — spring physics composable.
 *
 * Damped harmonic oscillator integrated at the display refresh rate:
 *   m·x¨ + c·x˙ + k·(x − target) = 0
 * with stiffness 210 N/m, damping 19 N·s/m, mass 1.0 kg (ζ ≈ 0.66,
 * under-damped → the signature 1.015 hover overshoot).
 *
 * Exposes press/hover scale springs, depth-push modal transition values and a
 * generic `useSpring` for any scalar. Pure ES2024, no dependencies.
 */

import { ref, onBeforeUnmount, watch } from 'vue'

export const SPRING = {
  stiffness: 210,
  damping: 19,
  mass: 1.0,
  restDelta: 0.0008,
  restSpeed: 0.02
}

export const INTERACTION = {
  hoverScale: 1.015,
  tapScale: 0.96,
  depthPushScale: 0.94,
  depthPushRadius: 28,
  depthPushBrightness: 0.66,
  gooeyBlur: 12
}

/**
 * Integrate a damped spring toward `target`, driven by requestAnimationFrame.
 * Returns { value, velocity, set, snap, stop }.
 */
export function useSpring(target = 0, config = SPRING) {
  const value = ref(target)
  const velocity = ref(0)
  let current = target
  let vel = 0
  let goal = target
  let raf = null
  let last = 0

  const cfg = { ...SPRING, ...config }

  function step(now) {
    if (!last) last = now
    let dt = (now - last) / 1000
    last = now
    if (dt > 1 / 20) dt = 1 / 20 // clamp after tab-switch stalls

    const displacement = current - goal
    const springForce = -cfg.stiffness * displacement
    const dampingForce = -cfg.damping * vel
    const accel = (springForce + dampingForce) / cfg.mass
    vel += accel * dt
    current += vel * dt

    if (Math.abs(vel) < cfg.restSpeed && Math.abs(displacement) < cfg.restDelta) {
      current = goal
      vel = 0
      value.value = current
      velocity.value = 0
      raf = null
      last = 0
      return
    }
    value.value = current
    velocity.value = vel
    raf = requestAnimationFrame(step)
  }

  function kick() {
    if (raf === null) {
      last = 0
      raf = requestAnimationFrame(step)
    }
  }

  function set(next, { immediate = false } = {}) {
    goal = next
    if (immediate) {
      current = next
      vel = 0
      value.value = next
      velocity.value = 0
      if (raf !== null) { cancelAnimationFrame(raf); raf = null }
      return
    }
    kick()
  }

  function snap(next) {
    set(next, { immediate: true })
  }

  function stop() {
    if (raf !== null) cancelAnimationFrame(raf)
    raf = null
    last = 0
  }

  if (typeof window !== 'undefined') onBeforeUnmount(stop)

  return { value, velocity, set, snap, stop, config: cfg }
}

/**
 * Press + hover springs for a tappable element. Bind the returned refs and
 * handlers to any element/component; the transform string is ready to use.
 */
export function usePressSpring({ hoverScale = INTERACTION.hoverScale, tapScale = INTERACTION.tapScale } = {}) {
  const scale = useSpring(1)
  const lift = useSpring(0, { stiffness: 180, damping: 21 })
  const hovering = ref(false)
  const pressing = ref(false)
  const glow = ref(0)

  function apply() {
    scale.set(pressing.value ? tapScale : hovering.value ? hoverScale : 1)
    lift.set(hovering.value ? -2.5 : 0)
    glow.value = hovering.value ? 1 : 0
  }

  function onEnter() { hovering.value = true; apply() }
  function onLeave() { hovering.value = false; pressing.value = false; apply() }
  function onDown() { pressing.value = true; apply() }
  function onUp() { pressing.value = false; apply() }

  return {
    scale,
    lift,
    glow,
    hovering,
    pressing,
    handlers: {
      onPointerenter: onEnter,
      onPointerleave: onLeave,
      onPointerdown: onDown,
      onPointerup: onUp,
      onPointercancel: onUp
    },
    style: () => ({
      transform: `translate3d(0, ${lift.value.value.toFixed(2)}px, 0) scale(${scale.value.value.toFixed(4)})`,
      filter: `brightness(${(1 + glow.value * 0.06).toFixed(3)})`
    })
  }
}

/**
 * Depth-push transition for modals: the background layer scales to 0.94,
 * blurs to 28 px and drops to 0.66 brightness while the sheet rises.
 */
export function useDepthPush() {
  const depth = useSpring(0, { stiffness: 190, damping: 24 })
  const active = ref(false)

  function open() {
    active.value = true
    depth.set(1)
  }
  function close() {
    depth.set(0)
    const t = setTimeout(() => { active.value = false }, 260)
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => clearTimeout(t), { once: true })
  }

  function styleForBackground() {
    const d = depth.value.value
    return {
      transform: `scale(${1 - d * (1 - INTERACTION.depthPushScale)})`,
      filter: `blur(${(d * INTERACTION.depthPushRadius).toFixed(2)}px) brightness(${(1 - d * (1 - INTERACTION.depthPushBrightness)).toFixed(3)})`,
      transition: 'none',
      willChange: 'transform, filter'
    }
  }

  return { depth, active, open, close, styleForBackground, INTERACTION }
}

/** Hook a raw pointer position (normalised −1..1) for shader uniforms. */
export function usePointerVector() {
  const x = ref(0)
  const y = ref(0)
  const moving = ref(false)
  let timeout = null

  function onMove(e) {
    x.value = (e.clientX / window.innerWidth) * 2 - 1
    y.value = (e.clientY / window.innerHeight) * 2 - 1
    moving.value = true
    clearTimeout(timeout)
    timeout = setTimeout(() => { moving.value = false }, 900)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onMove, { passive: true })
    onBeforeUnmount(() => {
      window.removeEventListener('pointermove', onMove)
      clearTimeout(timeout)
    })
  }
  return { x, y, moving }
}

/** Device-orientation tilt (radians) for the u_gyroTilt uniform. */
export function useGyroTilt() {
  const tilt = ref({ x: 0, y: 0 })
  const supported = ref(false)
  const permission = ref('unknown')

  async function request() {
    if (typeof window === 'undefined') return 'unsupported'
    if (typeof DeviceOrientationEvent === 'undefined') {
      permission.value = 'unsupported'
      return 'unsupported'
    }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission()
        permission.value = res
        if (res !== 'granted') return res
      } catch {
        permission.value = 'denied'
        return 'denied'
      }
    } else {
      permission.value = 'granted'
    }
    window.addEventListener('deviceorientation', (e) => {
      supported.value = true
      tilt.value = {
        x: ((e.beta || 0) * Math.PI) / 180,
        y: ((e.gamma || 0) * Math.PI) / 180
      }
    }, { passive: true })
    return 'granted'
  }

  return { tilt, supported, permission, request }
}

/** Track a value with a spring, mirroring changes reactively. */
export function useSpringValue(source, config) {
  const spring = useSpring(typeof source === 'number' ? source : 0, config)
  if (typeof source === 'object' && source !== null && 'value' in source) {
    watch(source, (v) => spring.set(Number(v) || 0))
  }
  return spring
}

/**
 * NEPHRO-SPECTRA — native plugin bridge.
 *
 * The Android build ships two Java Capacitor plugins
 * (`NephroAcousticFlow`, `NephroDipstickCamera`). They only exist inside the
 * packaged APK, so this module is the single place that decides, at runtime,
 * whether the native path is available or whether the browser path (Web Audio /
 * getUserMedia camera frames) must be used instead.
 *
 * Nothing here throws: every entry point resolves to a plain object describing
 * what actually happened, which is what the polyglot inspector reports.
 */

/** Capacitor injects `window.Capacitor` in the native WebView only. */
export function capacitorRuntime() {
  const C = typeof window !== 'undefined' ? window.Capacitor : undefined
  if (!C) return { present: false, native: false, platform: 'web', version: null }
  return {
    present: true,
    native: typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : false,
    platform: typeof C.getPlatform === 'function' ? C.getPlatform() : 'web',
    version: typeof C.version === 'string' ? C.version : null
  }
}

/**
 * Resolve a registered native plugin by name.
 * @returns the plugin object, or null when it is not available.
 */
export function nativePlugin(name) {
  const C = typeof window !== 'undefined' ? window.Capacitor : undefined
  const plugin = C?.Plugins?.[name]
  if (!plugin) return null
  // Capacitor 6 proxies unimplemented plugins with an empty object; a real one
  // exposes at least one callable method.
  const callable = Object.values(plugin).some((v) => typeof v === 'function')
  return callable ? plugin : null
}

export const ACOUSTIC_PLUGIN = 'NephroAcousticFlow'
export const CAMERA_PLUGIN = 'NephroDipstickCamera'

/** Which capture paths are usable right now. */
export function captureCapabilities() {
  const runtime = capacitorRuntime()
  const acoustic = nativePlugin(ACOUSTIC_PLUGIN)
  const camera = nativePlugin(CAMERA_PLUGIN)
  const nav = typeof navigator !== 'undefined' ? navigator : {}
  return {
    runtime,
    acoustic: {
      available: Boolean(acoustic),
      path: acoustic ? 'native-48khz' : nav.mediaDevices?.getUserMedia ? 'web-audio' : 'simulation'
    },
    camera: {
      available: Boolean(camera),
      path: camera ? 'native-camerax' : nav.mediaDevices?.getUserMedia ? 'web-usermedia' : 'simulation'
    }
  }
}

/**
 * Open a native acoustic capture session.
 *
 * Resolves `{ ok, session }` or `{ ok: false, reason }` — never rejects, so the
 * caller can fall back to the Web Audio path without a try/catch maze.
 */
export async function startNativeAcousticCapture({ posture = 'seated', calibrationMs = 1600, onFrame, onNoiseFloor } = {}) {
  const plugin = nativePlugin(ACOUSTIC_PLUGIN)
  if (!plugin) return { ok: false, reason: 'NephroAcousticFlow is only available in the packaged APK' }

  const listeners = []
  if (typeof plugin.addListener === 'function') {
    if (onFrame) {
      const handle = await plugin.addListener('flowFrame', (frame) => onFrame(frame))
      listeners.push(handle)
    }
    if (onNoiseFloor) {
      const handle = await plugin.addListener('noiseFloorCalibrated', (floor) => onNoiseFloor(floor))
      listeners.push(handle)
    }
  }

  try {
    const session = await plugin.startCapture({ posture, calibrationMs })
    return { ok: true, session, listeners }
  } catch (err) {
    await stopNativeAcousticCapture(listeners)
    return { ok: false, reason: err?.message || String(err) }
  }
}

export async function stopNativeAcousticCapture(listeners = []) {
  const plugin = nativePlugin(ACOUSTIC_PLUGIN)
  for (const handle of listeners) {
    try {
      await handle?.remove?.()
    } catch {
      /* listener already gone */
    }
  }
  if (!plugin) return { ok: false, reason: 'plugin unavailable' }
  try {
    return { ok: true, summary: await plugin.stopCapture() }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

/**
 * Open a native camera pad-scan session (CameraX YUV_420_888 → per-pad RGB
 * means with channel variance, which is what the intact-RBC speckle test needs).
 */
export async function startNativePadScan({ padCount = 10, orientation = 'vertical', onSample, onPadSample } = {}) {
  const plugin = nativePlugin(CAMERA_PLUGIN)
  if (!plugin) return { ok: false, reason: 'NephroDipstickCamera is only available in the packaged APK' }

  const listeners = []
  const handler = onSample || onPadSample
  if (handler && typeof plugin.addListener === 'function') {
    listeners.push(await plugin.addListener('padSample', (sample) => handler(sample)))
  }
  try {
    const session = await plugin.startScan({ padCount, orientation })
    return { ok: true, session, listeners }
  } catch (err) {
    await stopNativePadScan(listeners)
    return { ok: false, reason: err?.message || String(err) }
  }
}

export async function stopNativePadScan(listeners = []) {
  const plugin = nativePlugin(CAMERA_PLUGIN)
  for (const handle of listeners) {
    try {
      await handle?.remove?.()
    } catch {
      /* listener already gone */
    }
  }
  if (!plugin) return { ok: false, reason: 'plugin unavailable' }
  try {
    return { ok: true, summary: await plugin.stopScan() }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

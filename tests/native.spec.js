/**
 * NEPHRO-SPECTRA — native plugin bridge.
 *
 * The Java plugins only run inside the packaged APK, so the contract that can
 * break silently is the *bridge*: does the web layer detect the plugin, call
 * the right method names and payloads, and fall back cleanly when absent?
 * These tests drive the bridge through a fake `window.Capacitor`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  capacitorRuntime,
  nativePlugin,
  captureCapabilities,
  startNativeAcousticCapture,
  stopNativeAcousticCapture,
  startNativePadScan,
  stopNativePadScan,
  ACOUSTIC_PLUGIN,
  CAMERA_PLUGIN
} from '@/native/nativeBridge.js'

/** Build a fake plugin that records calls and can be made to fail. */
function fakePlugin(methods, { failOn = null } = {}) {
  const calls = []
  const listeners = []
  const plugin = { calls, listeners, addListener: vi.fn(async (event, cb) => {
    const handle = { event, cb, remove: vi.fn(async () => {}) }
    listeners.push(handle)
    return handle
  }) }
  for (const m of methods) {
    plugin[m] = vi.fn(async (args) => {
      calls.push({ method: m, args })
      if (m === failOn) throw new Error(`${m} exploded`)
      if (m === 'startCapture') return { sampleRate: 48000, frameSize: 2048, calibrationFrames: 8, encoding: 'PCM_FLOAT_32' }
      if (m === 'startScan') return { padCount: 10, sampleIntervalMs: 220, format: 'YUV_420_888' }
      if (m === 'stopCapture') return { wasRunning: true, framesEmitted: 42, calibrated: true, noiseBins: 1024, peakFlowMlSec: 18.4 }
      if (m === 'stopScan') return { wasRunning: true, samplesEmitted: 7 }
      return {}
    })
  }
  return plugin
}

afterEach(() => {
  delete window.Capacitor
})

describe('runtime detection', () => {
  it('reports plain web when Capacitor is absent', () => {
    delete window.Capacitor
    const rt = capacitorRuntime()
    expect(rt.present).toBe(false)
    expect(rt.native).toBe(false)
    expect(rt.platform).toBe('web')
  })

  it('reports the native Android WebView', () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', version: '6.2.0' }
    const rt = capacitorRuntime()
    expect(rt.present).toBe(true)
    expect(rt.native).toBe(true)
    expect(rt.platform).toBe('android')
  })
})

describe('plugin resolution', () => {
  it('treats an empty plugin proxy as unavailable', () => {
    window.Capacitor = { Plugins: { [ACOUSTIC_PLUGIN]: {} } }
    expect(nativePlugin(ACOUSTIC_PLUGIN)).toBeNull()
  })

  it('resolves a plugin that exposes callable methods', () => {
    window.Capacitor = { Plugins: { [ACOUSTIC_PLUGIN]: fakePlugin(['startCapture', 'stopCapture']) } }
    expect(nativePlugin(ACOUSTIC_PLUGIN)).toBeTruthy()
    expect(nativePlugin('NotAPlugin')).toBeNull()
  })
})

describe('capture capability reporting', () => {
  it('falls back to web-audio / web-usermedia in a browser', () => {
    delete window.Capacitor
    const caps = captureCapabilities()
    expect(caps.acoustic.available).toBe(false)
    expect(caps.camera.available).toBe(false)
    expect(['web-audio', 'simulation']).toContain(caps.acoustic.path)
  })

  it('reports the native paths inside the APK', () => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        [ACOUSTIC_PLUGIN]: fakePlugin(['startCapture', 'stopCapture']),
        [CAMERA_PLUGIN]: fakePlugin(['startScan', 'stopScan'])
      }
    }
    const caps = captureCapabilities()
    expect(caps.acoustic.path).toBe('native-48khz')
    expect(caps.camera.path).toBe('native-camerax')
  })
})

describe('acoustic capture session', () => {
  it('declines cleanly without the plugin', async () => {
    delete window.Capacitor
    const res = await startNativeAcousticCapture({})
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/APK/)
  })

  it('startCapture carries posture and calibration, and listeners receive frames', async () => {
    const plugin = fakePlugin(['startCapture', 'stopCapture'])
    window.Capacitor = { Plugins: { [ACOUSTIC_PLUGIN]: plugin } }

    const frames = []
    const floors = []
    const res = await startNativeAcousticCapture({
      posture: 'standing',
      calibrationMs: 1600,
      onFrame: (f) => frames.push(f),
      onNoiseFloor: (f) => floors.push(f)
    })

    expect(res.ok).toBe(true)
    expect(plugin.startCapture).toHaveBeenCalledWith({ posture: 'standing', calibrationMs: 1600 })
    expect(plugin.listeners.map((l) => l.event)).toEqual(['flowFrame', 'noiseFloorCalibrated'])

    // the plugin emits events; the caller must receive them
    plugin.listeners[0].cb({ frameIndex: 12, rms: 0.032, instantFlowMlSec: 14.2, peakFlowMlSec: 18.9, sampleRate: 48000, clipped: false })
    plugin.listeners[1].cb({ noiseBins: 1024 })
    expect(frames[0].instantFlowMlSec).toBe(14.2)
    expect(floors.length).toBe(1)
  })

  it('returns the stop summary and removes listeners', async () => {
    const plugin = fakePlugin(['startCapture', 'stopCapture'])
    window.Capacitor = { Plugins: { [ACOUSTIC_PLUGIN]: plugin } }
    const res = await startNativeAcousticCapture({ onFrame: () => {} })
    const stopped = await stopNativeAcousticCapture(res.listeners)
    expect(stopped.ok).toBe(true)
    expect(stopped.summary.framesEmitted).toBe(42)
    expect(res.listeners[0].remove).toHaveBeenCalled()
  })

  it('reports a start failure instead of throwing, and cleans up', async () => {
    const plugin = fakePlugin(['startCapture', 'stopCapture'], { failOn: 'startCapture' })
    window.Capacitor = { Plugins: { [ACOUSTIC_PLUGIN]: plugin } }
    const res = await startNativeAcousticCapture({ onFrame: () => {} })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/exploded/)
    expect(plugin.listeners[0].remove).toHaveBeenCalled()
  })
})

describe('dipstick pad scan session', () => {
  it('declines cleanly without the plugin', async () => {
    delete window.Capacitor
    const res = await startNativePadScan({})
    expect(res.ok).toBe(false)
  })

  it('startScan carries padCount/orientation and emits padSample payloads', async () => {
    const plugin = fakePlugin(['startScan', 'stopScan'])
    window.Capacitor = { Plugins: { [CAMERA_PLUGIN]: plugin } }
    const samples = []
    const res = await startNativePadScan({ padCount: 10, orientation: 'vertical', onSample: (s) => samples.push(s) })

    expect(res.ok).toBe(true)
    expect(plugin.startScan).toHaveBeenCalledWith({ padCount: 10, orientation: 'vertical' })
    plugin.listeners[0].cb({
      pads: [{ index: 0, r: 127, g: 182, b: 166, luminance: 172, varianceR: 4, varianceG: 6, varianceB: 9, coefficientOfVariation: 0.03, sampleCount: 24 }],
      width: 1280,
      height: 720,
      orientation: 'vertical',
      sampleIndex: 3
    })
    expect(samples[0].pads[0].coefficientOfVariation).toBe(0.03)
    expect(samples[0].sampleIndex).toBe(3)
  })

  it('returns the stop summary', async () => {
    const plugin = fakePlugin(['startScan', 'stopScan'])
    window.Capacitor = { Plugins: { [CAMERA_PLUGIN]: plugin } }
    const res = await startNativePadScan({ onSample: () => {} })
    const stopped = await stopNativePadScan(res.listeners)
    expect(stopped.summary.samplesEmitted).toBe(7)
  })
})

/**
 * jsdom does not implement WebGL, canvas 2D, IndexedDB or the Web Audio API.
 * These stubs let the component tree mount so the DOM structure and live
 * numerical output can be asserted; the engines themselves are pure and are
 * tested directly without any of this.
 */
import { vi } from 'vitest'

// --- canvas / WebGL -------------------------------------------------------
HTMLCanvasElement.prototype.getContext = vi.fn((type) => {
  if (type === '2d') {
    return {
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(24 * 12 * 4).fill(180) }),
      putImageData: vi.fn(),
      fillRect: vi.fn(),
      createImageData: () => ({ data: new Uint8ClampedArray(4) })
    }
  }
  // No WebGL2 in jsdom — the components must degrade, not crash.
  return null
})

// --- matchMedia -----------------------------------------------------------
window.matchMedia = window.matchMedia || ((query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn()
}))

// --- Web Audio ------------------------------------------------------------
class StubAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels
    this.length = length
    this.sampleRate = sampleRate
    this._data = new Float32Array(length)
  }
  getChannelData() {
    return this._data
  }
}

class StubAudioContext {
  constructor() {
    this.sampleRate = 48000
    this.state = 'running'
    this.currentTime = 0
  }
  createBuffer(channels, length, sampleRate) {
    return new StubAudioBuffer(channels, length, sampleRate)
  }
  createMediaStreamSource() { return { connect: vi.fn() } }
  createAnalyser() {
    return { fftSize: 2048, smoothingTimeConstant: 0.2, getFloatTimeDomainData: vi.fn(), getByteTimeDomainData: vi.fn() }
  }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}
window.AudioContext = StubAudioContext
window.webkitAudioContext = StubAudioContext

// --- media devices --------------------------------------------------------
if (!navigator.mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) }
  })
}

// --- IndexedDB (minimal, enough for the vault to report "unavailable") ----
if (!window.indexedDB) {
  window.indexedDB = {
    open: vi.fn(() => {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, error: new Error('stubbed') }
      setTimeout(() => req.onerror && req.onerror(new Event('error')), 0)
      return req
    }),
    deleteDatabase: vi.fn()
  }
}

// --- crypto ---------------------------------------------------------------
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 4294967295)
        return arr
      },
      subtle: {
        digest: async (_alg, buffer) => {
          const bytes = new Uint8Array(buffer)
          let h = 2166136261
          for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i]
            h = Math.imul(h, 16777619) >>> 0
          }
          const out = new Uint8Array(32)
          for (let i = 0; i < 32; i++) out[i] = (h >>> ((i % 4) * 8)) & 0xff
          return out.buffer
        }
      }
    }
  })
}

// --- requestAnimationFrame -------------------------------------------------
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 8)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
}

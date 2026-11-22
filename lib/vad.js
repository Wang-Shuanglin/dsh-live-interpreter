// Speech/silence detection with Silero VAD.
//
// Why this exists: paragraph boundaries used to be decided from a raw RMS
// threshold on each 240 ms frame. That works in a quiet room and fails the
// moment there is any steady noise — a fan, a projector, a USB interface's
// self-noise — because the level never drops back under the threshold and the
// session then has to fall back on a wall-clock timer, which is why paragraphs
// used to arrive at a fixed interval instead of at real pauses.
//
// The VAD answers the question the level cannot: "is this frame speech?" It is
// a small classifier (600 KB) that sherpa-onnx already ships a binding for, and
// measured on a 10 s clip it consumes 35 ms — about 0.3% of realtime.
//
// Everything here degrades to "no VAD" rather than throwing: the model is a
// 600 KB download and a meeting must not fail to start because it is absent.

import { findModel, modelPaths, modelState } from './models.js'

const VAD_MODEL_ID = 'silero-vad'

let loading = null
let instance = null
let unavailable = false

function loadSherpa() {
  return import('sherpa-onnx-node')
}

export function vadReady() {
  return modelState(VAD_MODEL_ID, 'vad').ready
}

/**
 * Load the detector once per process. Returns null when the model file or the
 * native addon is missing — callers fall back to the energy threshold.
 */
export async function ensureVad() {
  if (instance !== null) return instance
  if (unavailable || !vadReady()) return null
  if (loading !== null) return loading
  loading = (async () => {
    try {
      const sherpa = await loadSherpa()
      const Vad = sherpa.Vad ?? sherpa.default?.Vad
      if (typeof Vad !== 'function') {
        unavailable = true
        return null
      }
      const paths = modelPaths(VAD_MODEL_ID, 'vad')
      // windowSize is also the size of the chunks the detector expects to be fed
      // — 512 samples at 16 kHz, i.e. 32 ms. Feeding whole 240 ms frames works
      // because sherpa buffers internally, but the chunk size has to be stated
      // so it does not assume the model default (which is the same value).
      const config = {
        sileroVad: {
          model: paths.model,
          threshold: 0.5,
          minSilenceDuration: 0.45,
          minSpeechDuration: 0.2,
          windowSize: 512,
          maxSpeechDuration: 12,
        },
        sampleRate: 16000,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      }
      // The buffer holds recent audio so a detected segment can be handed back
      // with its onset included. Ten seconds covers the longest paragraph we
      // ever keep.
      instance = new Vad(config, 10)
      return instance
    } catch (error) {
      console.warn('[dsh-live-interpreter] VAD unavailable', error)
      unavailable = true
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

/**
 * One detection gate per meeting. Keeps the native detector's state local so
 * two meetings never see each other's audio.
 */
export class SpeechGate {
  constructor(vad) {
    this.vad = vad
  }

  /**
   * Feed one frame and report whether it contained speech.
   * @param {Float32Array} samples 16 kHz mono
   * @returns {boolean|null} null when no detector is loaded
   */
  accept(samples) {
    if (this.vad === null) return null
    try {
      this.vad.acceptWaveform(samples)
      const detected = this.vad.isDetected()
      // Detected segments are drained immediately: the session keeps its own
      // paragraph buffer, so holding a second copy here would only grow memory.
      while (!this.vad.isEmpty()) this.vad.front()
      return detected
    } catch (error) {
      console.warn('[dsh-live-interpreter] VAD frame rejected', error)
      return null
    }
  }

  reset() {
    if (this.vad === null) return
    try {
      this.vad.reset()
    } catch {
      // a detector that refuses to reset is treated as stateless from here on
    }
  }

  dispose() {
    if (this.vad === null) return
    try {
      this.vad.flush()
    } catch {
      // already gone
    }
    this.vad = null
  }
}

/** Returns a gate, or one bound to no detector when the model is not installed. */
export async function createSpeechGate() {
  const vad = await ensureVad()
  return new SpeechGate(vad)
}

export function releaseVad() {
  instance = null
}

export { VAD_MODEL_ID, findModel }

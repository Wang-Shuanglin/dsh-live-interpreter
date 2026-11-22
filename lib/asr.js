// Streaming recognition with sherpa-onnx online models.
//
// One recognizer instance is shared per model because loading weights costs
// hundreds of milliseconds; every meeting gets its own OnlineStream so partial
// hypotheses never leak between meetings.
//
// Two model families are supported and they are not interchangeable:
//   transducer  — zipformer style, needs encoder + decoder + joiner
//   paraformer  — needs encoder + decoder only, emits whole-sentence hypothesis
// The catalog records which one an entry is (`arch`), so this loader branches on
// the entry instead of guessing from file names.

import os from 'node:os'

import { findModel, modelPaths, modelState } from './models.js'

const ENGINE_IDLE_MS = 5 * 60 * 1000

// Decoding ran on two threads by default, which leaves most of a modern CPU
// idle: measured on a 16-thread machine a 240 ms frame decodes in 5-18 ms, and
// the extra threads are what keep that true once refinement and translation are
// also running. Capped at four because returns flatten out and every thread
// holds its own arena.
const DECODE_THREADS = Math.max(1, Math.min(4, os.cpus().length || 1))

const engines = new Map()

function loadSherpa() {
  // Lazy on purpose: the native addon ships per platform. A missing binary must
  // degrade to "engine unavailable", never crash the whole DSH host.
  return import('sherpa-onnx-node')
}

/** Cheap readiness probe that never loads weights. */
export function isModelReady(modelId) {
  return modelState(modelId).ready
}

export async function engineStatus(modelId) {
  const state = modelState(modelId)
  if (!state.ready) return { ready: false, reason: 'model-missing', model: state }
  try {
    await ensureEngine(modelId)
    return { ready: true, model: state }
  } catch (error) {
    return {
      ready: false,
      reason: 'runtime-missing',
      message: error instanceof Error ? error.message : String(error),
      model: state,
    }
  }
}

export async function ensureEngine(modelId) {
  const cached = engines.get(modelId)
  if (cached !== undefined) {
    cached.touched = Date.now()
    return cached.ready
  }
  const entry = { touched: Date.now(), ready: undefined }
  engines.set(modelId, entry)
  const loading = (async () => {
    const sherpa = await loadSherpa()
    const model = findModel(modelId, 'asr')
    const paths = modelPaths(modelId, 'asr')
    const arch = model.arch ?? 'transducer'
    const modelConfig = { tokens: paths.tokens, numThreads: DECODE_THREADS, provider: 'cpu', debug: 0 }
    if (arch === 'paraformer') {
      modelConfig.paraformer = { encoder: paths.encoder, decoder: paths.decoder }
    } else {
      modelConfig.transducer = {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      }
    }
    const recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
      decodingMethod: 'greedy_search',
      // sherpa's own endpoint detector is deliberately OFF. Measured on real
      // speech, it fires on every ~1 s intra-sentence pause and — because it
      // resets the stream — throws away everything decoded so far, so one
      // sentence arrives as fragments ("昨天是 MONDAY" / "TODAY" / "IS LIBR").
      // Utterance boundaries are decided by the session instead, from the
      // energy envelope it already tracks.
      enableEndpoint: false,
    })
    entry.recognizer = recognizer
    return recognizer
  })()
  entry.ready = loading
  try {
    return await loading
  } catch (error) {
    engines.delete(modelId)
    throw error
  }
}

/** Drop recognizers nobody used for a while so idle meetings free their memory. */
export function sweepEngines() {
  const now = Date.now()
  for (const [id, entry] of engines) {
    if (now - entry.touched < ENGINE_IDLE_MS) continue
    engines.delete(id)
  }
}

/** Unload one engine so switching models releases the old weights immediately. */
export function releaseEngine(modelId) {
  engines.delete(modelId)
}

export function toFloat32(pcmBytes) {
  // 16-bit little endian mono PCM -> normalised float samples.
  const count = Math.floor(pcmBytes.byteLength / 2)
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, count * 2)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768
  }
  return samples
}

export function rmsOf(samples) {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index]
  return Math.sqrt(sum / samples.length)
}

export class AsrStream {
  constructor(recognizer) {
    this.recognizer = recognizer
    this.stream = recognizer.createStream()
    this.lastText = ''
    this.finished = false
  }

  /**
   * Feed one audio frame.
   * @returns {{text: string, changed: boolean, endpoint: boolean}}
   */
  accept(samples) {
    if (this.finished) return { text: this.lastText, changed: false, endpoint: false }
    this.stream.acceptWaveform({ samples, sampleRate: 16000 })
    let guard = 0
    while (this.recognizer.isReady(this.stream) && guard < 512) {
      this.recognizer.decode(this.stream)
      guard += 1
    }
    const result = this.recognizer.getResult(this.stream)
    const text = typeof result?.text === 'string' ? result.text : ''
    const changed = text !== this.lastText
    this.lastText = text
    // `endpoint` is always false here: the recognizer's detector is disabled
    // (see ensureEngine) and the session owns utterance boundaries.
    return { text, changed, endpoint: false }
  }

  /** Close the utterance and return the trailing hypothesis. */
  finish() {
    if (this.finished) return this.lastText
    this.finished = true
    try {
      this.stream.inputFinished()
      let guard = 0
      while (this.recognizer.isReady(this.stream) && guard < 512) {
        this.recognizer.decode(this.stream)
        guard += 1
      }
      const result = this.recognizer.getResult(this.stream)
      const text = typeof result?.text === 'string' ? result.text : this.lastText
      this.lastText = text
      return text
    } catch {
      return this.lastText
    }
  }

  dispose() {
    this.finished = true
    this.stream = undefined
  }
}

export async function createAsrStream(modelId) {
  const recognizer = await ensureEngine(modelId)
  return new AsrStream(recognizer)
}

/**
 * Decode a complete WAV/PCM buffer offline, used by the "re-translate this
 * segment" path and by the self test. Accepts mono 16-bit PCM samples.
 */
export async function decodePcmBuffer(modelId, samples, chunkSize = 3200) {
  const stream = await createAsrStream(modelId)
  let text = ''
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    const slice = samples.subarray(offset, Math.min(offset + chunkSize, samples.length))
    const frame = stream.accept(slice)
    if (frame.text !== '') text = frame.text
    if (frame.endpoint) text = ''
  }
  const tail = stream.finish()
  stream.dispose()
  return tail || text
}

// Offline refinement of a closed paragraph.
//
// Streaming recognition has to commit tokens before it knows how the sentence
// ends, so on real speech it drops characters, invents homophones and produces
// no punctuation at all. An offline model hears the whole utterance and gets it
// right — measured on the same audio, SenseVoice returned
// "昨天是monday，today is礼拜2the day after tomorrow是星期三。" where every
// streaming model produced a fragment.
//
// So the pipeline is: streaming for latency, offline refinement for accuracy.
// The refined text replaces the paragraph's source, then that text is
// translated. The user sees the grey paragraph settle into its corrected form.
//
// Whisper was measured too and lost clearly: it dropped characters and could not
// keep Chinese and English in one pass. SenseVoice is the one worth shipping.

import fsp from 'node:fs/promises'

import { findModel, modelPaths, modelState } from './models.js'

const VOICE_IDLE_MS = 10 * 60 * 1000

const instances = new Map()

function loadSherpa() {
  return import('sherpa-onnx-node')
}

export function refineStatus(modelId = 'sense-voice-zh-en') {
  const state = modelState(modelId, 'refine')
  return {
    id: state.id,
    name: state.name,
    detail: state.detail,
    ready: state.ready,
    bytes: state.bytes,
    totalBytes: state.totalBytes,
  }
}

/** True when refinement is available. Never loads the graph. */
export function canRefine(modelId = 'sense-voice-zh-en') {
  return modelState(modelId, 'refine').ready
}

export async function ensureRefine(modelId = 'sense-voice-zh-en') {
  const cached = instances.get(modelId)
  if (cached !== undefined) {
    cached.touched = Date.now()
    return cached.recognizer
  }
  const entry = { touched: Date.now(), recognizer: undefined }
  instances.set(modelId, entry)
  const loading = (async () => {
    const sherpa = await loadSherpa()
    // Only `OnlineRecognizer` is a named export; everything else — including
    // OfflineRecognizer — hangs off the default export.
    const OfflineRecognizer = sherpa.OfflineRecognizer ?? sherpa.default?.OfflineRecognizer
    if (typeof OfflineRecognizer !== 'function') {
      throw new Error('sherpa-onnx-node 没有导出 OfflineRecognizer')
    }
    const model = findModel(modelId, 'refine')
    const paths = modelPaths(modelId, 'refine')
    const modelConfig = {
      tokens: paths.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    }
    if (model.arch === 'sensevoice') {
      modelConfig.senseVoice = {
        model: paths.model,
        // 'auto' lets the model tag the language itself, which is what we want:
        // a meeting mixes Chinese and English and the streaming pass already
        // tells us the dominant one.
        language: 'auto',
        useInverseTextNormalization: 1,
      }
    } else if (model.arch === 'whisper') {
      modelConfig.whisper = {
        encoder: paths.encoder,
        decoder: paths.decoder,
        language: 'zh',
        task: 'transcribe',
      }
    }
    return new OfflineRecognizer({ modelConfig })
  })()
  entry.recognizer = loading
  try {
    return await loading
  } catch (error) {
    instances.delete(modelId)
    throw error
  }
}

export function releaseRefine(modelId = 'sense-voice-zh-en') {
  instances.delete(modelId)
}

export function sweepRefine() {
  const now = Date.now()
  for (const [id, entry] of instances) {
    if (now - entry.touched < VOICE_IDLE_MS) continue
    instances.delete(id)
  }
}

/** 16 kHz mono PCM16 -> Float32 samples in [-1, 1]. */
function toFloat32(pcm) {
  const count = Math.floor(pcm.byteLength / 2)
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768
  }
  return samples
}

/**
 * Send it through once more, keeping only the words.
 *
 * The model tags its own output (`<|zh|>`, `<|Speech|>`, `<|NOSPEECH|>`, emotion
 * and event markers). Those are control tokens, not text, and they must never
 * reach the transcript or the translator.
 */
function stripTags(value) {
  return String(value ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Re-decode a whole paragraph.
 *
 * @param {Uint8Array} pcm 16 kHz mono PCM16 covering exactly this paragraph
 * @returns {Promise<{text: string, lang: string}>} empty text when unavailable
 */
export async function refineParagraph(pcm, modelId = 'sense-voice-zh-en') {
  if (!canRefine(modelId)) return { text: '', lang: '' }
  if (pcm.byteLength < 3200) return { text: '', lang: '' }
  const recognizer = await ensureRefine(modelId)
  const stream = recognizer.createStream()
  try {
    stream.acceptWaveform({ samples: toFloat32(pcm), sampleRate: 16000 })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    return {
      text: stripTags(result?.text),
      lang: stripTags(result?.lang).replace(/[<>|]/g, ''),
    }
  } catch {
    return { text: '', lang: '' }
  }
}

/** Node's Buffer.concat over an array of Uint8Array, kept local for clarity. */
export function concatPcm(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function pruneRefineRoot(dir) {
  // Nothing cached on disk beyond the weights themselves.
  await fsp.mkdir(dir, { recursive: true }).catch(() => {})
}

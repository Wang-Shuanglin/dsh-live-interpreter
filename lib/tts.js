// Local text-to-speech for the read-aloud path.
//
// Why not window.speechSynthesis: it cannot be routed to a chosen output
// device. `HTMLMediaElement.setSinkId(deviceId)` can, and that is the only way
// to honour "read the translation into the headphones, not the speakers". So
// the host synthesizes a WAV and hands the browser a URL to play through an
// <audio> element the client controls.
//
// Both are used: TTS_MODELS voices when downloaded (routable, offline, better
// prosody for mixed zh/en), and the browser engine as a fallback that still
// reads but ignores the device choice.

import fsp from 'node:fs/promises'
import path from 'node:path'

import { findModel, modelPaths, modelState } from './models.js'
import { dataRoot } from './util.js'

const instantiations = new Map()
const VOICE_CACHE_IDLE_MS = 10 * 60 * 1000

function loadSherpa() {
  return import('sherpa-onnx-node')
}

/** Cheap readiness probe for the settings card. */
export function voiceStatus(voiceId = 'tts-zh-en') {
  const state = modelState(voiceId, 'tts')
  return {
    id: state.id,
    name: state.name,
    ready: state.ready,
    bytes: state.bytes,
    totalBytes: state.totalBytes,
  }
}

export async function ensureVoice(voiceId = 'tts-zh-en') {
  const cached = instantiations.get(voiceId)
  if (cached !== undefined) {
    cached.touched = Date.now()
    return cached.ready
  }
  const entry = { touched: Date.now(), ready: undefined }
  instantiations.set(voiceId, entry)
  const loading = (async () => {
    const sherpa = await loadSherpa()
    const model = findModel(voiceId, 'tts')
    const paths = modelPaths(voiceId, 'tts')
    const config = {
      model: {
        vits: {
          model: paths.model,
          lexicon: paths.lexicon,
          tokens: paths.tokens,
        },
      },
      numThreads: 2,
      provider: 'cpu',
    }
    // The CommonJS bundle only re-exports `OnlineRecognizer` at the top level;
    // everything else (OfflineTts included) hangs off `default`, so resolve
    // through both shapes instead of assuming one.
    const OfflineTts = sherpa.OfflineTts ?? sherpa.default?.OfflineTts
    if (typeof OfflineTts !== 'function') throw new Error('sherpa-onnx-node 没有导出 OfflineTts')
    // createAsync keeps the host responsive while the 50 MB graph loads; the
    // sync constructor would block the event loop for a second or more.
    const tts = typeof OfflineTts.createAsync === 'function'
      ? await OfflineTts.createAsync(config)
      : new OfflineTts(config)
    entry.tts = tts
    entry.sampleRate = tts.sampleRate ?? 22050
    entry.numSpeakers = tts.numSpeakers ?? 1
    entry.config = model
    return tts
  })()
  entry.ready = loading
  try {
    return await loading
  } catch (error) {
    instantiations.delete(voiceId)
    throw error
  }
}

export function releaseVoice(voiceId = 'tts-zh-en') {
  instantiations.delete(voiceId)
}

export function sweepVoices() {
  const now = Date.now()
  for (const [id, entry] of instantiations) {
    if (now - entry.touched < VOICE_CACHE_IDLE_MS) continue
    instantiations.delete(id)
  }
}

/** 16-bit mono WAV with a RIFF header, from normalised float samples. */
function encodeWav(samples, sampleRate) {
  const bytes = samples.length * 2
  const buffer = Buffer.alloc(44 + bytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + bytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(bytes, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2)
  }
  return buffer
}

/**
 * Synthesize `text` and write it under the data directory, returning the file
 * name the client can fetch. Files are short-lived: the client only needs one
 * utterance at a time and `pruneSpeech` trims the directory.
 */
export async function synthesize(text, options = {}) {
  const { voiceId = 'tts-zh-en', speed = 1, speakerId = 0 } = options
  const value = String(text ?? '').trim()
  if (value === '') throw new Error('没有要朗读的内容')
  await ensureVoice(voiceId)
  const entry = instantiations.get(voiceId)
  if (entry?.tts === undefined) throw new Error('朗读模型未就绪')
  entry.touched = Date.now()
  const lengthScale = speed > 0 ? 1 / speed : 1
  const safeSpeed = Number.isFinite(speed) ? Math.max(0.5, Math.min(2, speed)) : lengthScale
  // `sid` is a speaker index and `speed` a rate multiplier; both are per
  // request, so one loaded graph serves every voice speed.
  //
  // `enableExternalBuffer: false` is mandatory inside Electron: the addon's
  // default path hands sample data back through a V8 external buffer, which
  // Electron refuses ("External buffers are not allowed"). Under plain Node it
  // silently works, so this only shows up in the real app.
  const audio = await entry.tts.generateAsync({
    text: value,
    sid: Math.max(0, Math.floor(speakerId)),
    speed: safeSpeed,
    enableExternalBuffer: false,
  })
  const samples = audio?.samples ?? audio
  const rate = audio?.sampleRate ?? entry.sampleRate
  if (!samples || samples.length === 0) throw new Error('朗读合成为空')
  const dir = path.join(dataRoot(), 'speech')
  await fsp.mkdir(dir, { recursive: true })
  const name = `say-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`
  const file = path.join(dir, name)
  await fsp.writeFile(file, encodeWav(samples, rate))
  return { filename: name, bytes: 44 + samples.length * 2, sampleRate: rate, seconds: samples.length / rate }
}

/** Keep the speech directory small: the client only ever plays the newest file. */
export async function pruneSpeech(keep = 6) {
  const dir = path.join(dataRoot(), 'speech')
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return 0
  }
  if (names.length <= keep) return 0
  const stats = []
  for (const name of names) {
    try {
      stats.push({ name, at: (await fsp.stat(path.join(dir, name))).mtimeMs })
    } catch {
      // vanished
    }
  }
  stats.sort((a, b) => b.at - a.at)
  let removed = 0
  for (const item of stats.slice(keep)) {
    try {
      await fsp.rm(path.join(dir, item.name), { force: true })
      removed += 1
    } catch {
      // ignore
    }
  }
  return removed
}

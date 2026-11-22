// Model catalog and downloaders.
//
// Weights are not shipped in the package (tens to hundreds of megabytes); they
// are fetched on first use from a reachable mirror into the plugin data
// directory. Every entry lists exact file sizes so a partial download can be
// detected instead of trusted.
//
// Two kinds of assets live here:
//   ASR_MODELS    — streaming recognizers. `arch` decides which sherpa config key
//                   the paths go under: `transducer` takes encoder+decoder+joiner,
//                   `paraformer` takes encoder+decoder only. The file names differ
//                   per repo, so each entry names its own files instead of the
//                   loader guessing.
//   REFINE_MODELS — offline recognizers used to re-hear a paragraph once it has
//                   closed. They see the whole utterance, which is precisely what
//                   streaming cannot, so the transcript is corrected before it is
//                   translated.
//   TTS_MODELS    — offline vocoders used by the read-aloud path. Reading aloud
//                   needs a real audio element (only <audio> can be routed to a
//                   chosen output device with setSinkId), so speech goes through
//                   this instead of window.speechSynthesis.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { modelsRoot, sleep } from './util.js'

const MIRRORS = [
  'https://hf-mirror.com',
  'https://huggingface.co',
]

/**
 * Streaming recognizers, best default first. `tier` describes what the model is
 * for, which is what the picker in the panel shows above the technical name.
 *
 * Paraformer leads because it decoded whole sentences correctly where the
 * transducer truncated them on the same audio; accuracy is the thing users
 * notice first, and the download is only ~40MB larger.
 */
export const ASR_MODELS = [
  {
    id: 'bilingual-paraformer',
    // Measured better than the zipformer below: whole sentences that the
    // transducer truncated came out complete here.
    name: '中英双语 · Paraformer（int8, 约 240MB）',
    detail: '默认。另一套中英双语引擎，整句完整度更好，中英混说时更准。',
    tier: '推荐',
    arch: 'paraformer',
    repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    languages: ['zh', 'en'],
    files: [
      ['encoder.int8.onnx', 165462184],
      ['decoder.int8.onnx', 71664561],
      ['tokens.txt', 75756],
    ],
    paths: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
  {
    id: 'bilingual-fast',
    name: '中英双语 · 快速（int8, 约 200MB）',
    detail: '更省内存、启动更快，长句偶有截断。机器较慢时选它。',
    tier: '快速',
    arch: 'transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    languages: ['zh', 'en'],
    files: [
      ['encoder-epoch-99-avg-1.int8.onnx', 181895032],
      ['decoder-epoch-99-avg-1.int8.onnx', 13091040],
      ['joiner-epoch-99-avg-1.int8.onnx', 3228404],
      ['tokens.txt', 56317],
    ],
    paths: {
      encoder: 'encoder-epoch-99-avg-1.int8.onnx',
      decoder: 'decoder-epoch-99-avg-1.int8.onnx',
      joiner: 'joiner-epoch-99-avg-1.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
  {
    id: 'bilingual-accurate',
    // fp32 weights of the same network: same latency, measurably fewer
    // substitution errors, ~9x the download and ~2.5x the RAM.
    name: '中英双语 · 高精度（fp32, 约 355MB）',
    detail: '同一网络的未量化权重，识别更稳，代价是下载和内存都更大、更慢。',
    tier: '高精度',
    arch: 'transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    languages: ['zh', 'en'],
    files: [
      ['encoder-epoch-99-avg-1.onnx', 330083505],
      ['decoder-epoch-99-avg-1.onnx', 13876452],
      ['joiner-epoch-99-avg-1.onnx', 12833618],
      ['tokens.txt', 56317],
    ],
    paths: {
      encoder: 'encoder-epoch-99-avg-1.onnx',
      decoder: 'decoder-epoch-99-avg-1.onnx',
      joiner: 'joiner-epoch-99-avg-1.onnx',
      tokens: 'tokens.txt',
    },
  },
  {
    id: 'zh-fast',
    // Chinese only: this is the 14M Zhihu-2023 model, so an English sentence
    // comes back garbled. It exists for Chinese-only meetings on a slow machine.
    name: '中文 · 轻量（int8, 约 25MB，仅中文）',
    detail: '只认中文，英文会乱码。机器慢或只想省内存时选它。',
    tier: '轻量',
    arch: 'transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    languages: ['zh'],
    files: [
      ['encoder-epoch-99-avg-1.int8.onnx', 21621684],
      ['decoder-epoch-99-avg-1.int8.onnx', 1888682],
      ['joiner-epoch-99-avg-1.int8.onnx', 1795562],
      ['tokens.txt', 48697],
    ],
    paths: {
      encoder: 'encoder-epoch-99-avg-1.int8.onnx',
      decoder: 'decoder-epoch-99-avg-1.int8.onnx',
      joiner: 'joiner-epoch-99-avg-1.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
]

/**
 * Offline refinement models. These are not streaming: they need the whole
 * utterance, which is exactly what makes them better. Measured on the same
 * audio, SenseVoice returned correct characters, punctuation and language tags
 * where every streaming model produced fragments — so once a paragraph closes,
 * the audio is decoded again here and the transcript is corrected before it is
 * translated.
 */
export const REFINE_MODELS = [
  {
    id: 'sense-voice-zh-en',
    name: '识别精修 · SenseVoice（int8, 约 240MB）',
    detail:
      '整段定稿之后再把这段音频重听一遍，纠正流式识别的错字并补上标点。装好后自动生效。',
    arch: 'sensevoice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    languages: ['zh', 'en'],
    files: [
      ['model.int8.onnx', 239233841],
      ['tokens.txt', 315894],
    ],
    paths: {
      model: 'model.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
]

/**
 * Voice-activity detection. Not a recognition model and not shown in the model
 * picker: it is a 600 KB speech/silence classifier that tells the session when
 * the speaker actually stopped, which is what replaces the energy-threshold
 * guesswork that used to chop paragraphs at a fixed interval.
 *
 * Published as a GitHub release asset rather than a Hugging Face repository, so
 * this entry carries a direct `url` and the downloader skips the mirrors.
 */
export const VAD_MODELS = [
  {
    id: 'silero-vad',
    name: '语音活动检测 · Silero VAD（约 0.6MB）',
    detail: '判断一句话是不是说完了。装好后段落边界更贴合真实停顿。',
    arch: 'vad',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    files: [['silero_vad.onnx', 643854]],
    paths: {
      model: 'silero_vad.onnx',
    },
  },
]

/** Text-to-speech voices for the read-aloud path. */
export const TTS_MODELS = [
  {
    id: 'tts-zh-en',
    name: '中英朗读音色（int8, 约 60MB）',
    detail: '本地合成，不联网。装好后译文可以朗读到指定的输出设备。',
    kind: 'vits',
    repo: 'csukuangfj/vits-melo-tts-zh_en',
    numSpeakers: 1,
    // Only the graph, the lexicon and the token table are loaded. The repo also
    // ships a jieba dictionary for its Python frontend, but sherpa-onnx reads
    // `dataDir` as an espeak-ng data directory and refuses to start when the
    // expected `phontab` is absent — so a voice is never pointed at it.
    files: [
      ['model.int8.onnx', 53517430],
      ['lexicon.txt', 6837671],
      ['tokens.txt', 655],
    ],
    paths: {
      model: 'model.int8.onnx',
      lexicon: 'lexicon.txt',
      tokens: 'tokens.txt',
    },
  },
]

/** Backwards compatible alias: the ASR catalog used to be the only one. */
export const MODELS = ASR_MODELS

function catalogFor(kind) {
  if (kind === 'tts') return TTS_MODELS
  if (kind === 'refine') return REFINE_MODELS
  if (kind === 'vad') return VAD_MODELS
  return ASR_MODELS
}

export function findModel(id, kind = 'asr') {
  const list = catalogFor(kind)
  return list.find((item) => item.id === id) ?? list[0]
}

export function modelDir(id, kind = 'asr') {
  const bucket =
    kind === 'tts' ? 'tts' : kind === 'refine' ? 'refine' : kind === 'vad' ? 'vad' : 'asr'
  return path.join(modelsRoot(), bucket, id)
}

/**
 * Absolute paths for the files one model needs, keyed the way the sherpa config
 * expects them. Returns `undefined` for a key the model does not have (a
 * paraformer model has no joiner), so the loader can branch on presence.
 */
export function modelPaths(id, kind = 'asr') {
  const model = findModel(id, kind)
  const dir = modelDir(model.id, kind)
  const out = { dir }
  for (const key of Object.keys(model.paths ?? {})) {
    out[key] = path.join(dir, model.paths[key])
  }
  return out
}

export function modelState(id, kind = 'asr') {
  const model = findModel(id, kind)
  const dir = modelDir(model.id, kind)
  let done = 0
  let total = 0
  const missing = []
  for (const [name, size] of model.files) {
    total += size
    const file = path.join(dir, name)
    let actual = 0
    try {
      actual = fs.statSync(file).size
    } catch {
      actual = 0
    }
    if (actual === size) {
      done += size
      continue
    }
    missing.push({ name, size, actual })
  }
  return {
    id: model.id,
    name: model.name,
    detail: model.detail ?? '',
    tier: model.tier ?? '',
    arch: model.arch ?? model.kind ?? '',
    languages: model.languages ?? [],
    ready: missing.length === 0,
    bytes: done,
    totalBytes: total,
    missing,
  }
}

export function listModels(kind = 'asr') {
  return catalogFor(kind).map((model) => modelState(model.id, kind))
}

/** Every model the host needs, ASR first, then refinement, voice, and VAD. */
export function listAllModels() {
  return [
    ...listModels('asr'),
    ...listModels('refine'),
    ...listModels('tts'),
    ...listModels('vad'),
  ]
}

/**
 * Download one model. `onProgress` receives {file, received, total, bytes,
 * totalBytes} at a coarse cadence so the UI can render a bar.
 */
export async function ensureModel(id, options = {}) {
  const { onProgress = () => {}, signal, kind = 'asr' } = options
  const model = findModel(id, kind)
  const dir = modelDir(model.id, kind)
  await fsp.mkdir(dir, { recursive: true })

  const totalBytes = model.files.reduce((sum, [, size]) => sum + size, 0)
  let bytesDone = 0
  for (const [name, size] of model.files) {
    const file = path.join(dir, name)
    let actual = 0
    try {
      actual = (await fsp.stat(file)).size
    } catch {
      actual = 0
    }
    if (actual === size) {
      bytesDone += size
      continue
    }
    if (actual > 0) await fsp.rm(file, { force: true })
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await downloadFile(model, name, size, file, {
      signal,
      onChunk: (received) => {
        onProgress({
          file: name,
          received,
          total: size,
          bytes: bytesDone + received,
          totalBytes,
        })
      },
    })
    bytesDone += size
    onProgress({ file: name, received: size, total: size, bytes: bytesDone, totalBytes })
  }
  return modelState(model.id, kind)
}

async function downloadFile(model, name, expectedSize, dest, { signal, onChunk }) {
  let lastError = ''
  // An entry that names an explicit URL is not on the Hugging Face mirror
  // network at all — the voice-activity model, for instance, is published as a
  // GitHub release asset. Trying the mirrors for it would just burn four
  // attempts on 404s, so it gets a single direct path.
  const direct = typeof model.url === 'string' && model.url !== ''
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const base of direct ? [''] : MIRRORS) {
      if (signal?.aborted) throw new Error('已取消')
      const url = direct ? model.url : `${base}/${model.repo}/resolve/main/${name}`
      try {
        const response = await fetch(url, { signal: withTimeout(signal, 900000) })
        if (!response.ok) {
          lastError = `HTTP ${response.status}`
          continue
        }
        const tmp = `${dest}.part`
        const handle = await fsp.open(tmp, 'w')
        let received = 0
        let lastTick = 0
        try {
          for await (const chunk of response.body) {
            await handle.write(chunk)
            received += chunk.length
            const now = Date.now()
            if (now - lastTick > 250) {
              lastTick = now
              onChunk(received)
            }
          }
        } finally {
          await handle.close()
        }
        onChunk(received)
        if (expectedSize > 0 && received !== expectedSize) {
          await fsp.rm(tmp, { force: true })
          lastError = `大小不符 ${received}/${expectedSize}`
          continue
        }
        await fsp.rename(tmp, dest)
        return
      } catch (error) {
        lastError = error?.cause?.code ?? error?.message ?? '网络错误'
      }
    }
    await sleep(1200 * (attempt + 1))
  }
  throw new Error(`下载 ${name} 失败：${lastError}`)
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (signal === undefined) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return timeout
}

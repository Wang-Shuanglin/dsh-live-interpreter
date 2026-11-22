// Host half of dsh-live-interpreter.
//
// Responsibilities:
//   — the streaming session runtime (audio frames -> partial text -> staged
//     translation -> finalized turn)
//   — the HTTP surface under /dsh-live-interpreter/api
//   — project persistence and export rendering
//
// All translation goes through the DSH `llm` service, so the plugin needs no
// key of its own: it uses whichever model the user already configured.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAsrStream, ensureEngine, isModelReady, rmsOf, sweepEngines, toFloat32 } from './asr.js'
import {
  EXTENSIONS,
  MINUTES_SYSTEM,
  RENDERERS,
  fallbackMinutes,
  filenameFor,
  minutesPrompt,
} from './exporters.js'
import { listAllModels, listModels as listModelCatalog, modelState } from './models.js'
import { canRefine, concatPcm, refineParagraph, refineStatus } from './refine.js'
import { createSpeechGate } from './vad.js'
import { pruneSpeech, synthesize, voiceStatus } from './tts.js'
import {
  appendTurn,
  createProject,
  deleteProject,
  getProject,
  indexPath,
  listExports,
  listProjects,
  listTurns,
  patchProject,
  readExport,
  updateTurn,
  writeExport,
} from './store.js'
import { agreedPrefix, cleanRepair, foldCommitted, parseAligned, translateText } from './translate.js'
import {
  SseChannel,
  dataRoot,
  detectLang,
  formatClock,
  nowMs,
  otherLang,
  readJsonl,
} from './util.js'

const API = '/dsh-live-interpreter/api'

// The version the panel displays comes from package.json, so a release bump is
// one edit. Reading it at module load keeps `/state` free of I/O on every call.
const PLUGIN_VERSION = (function () {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

const FRAME_BYTES = 7_680 // 240 ms of 16 kHz mono PCM16
const SILENCE_RMS = 0.004
const SILENCE_FRAMES = 6
// How long the speaker must be quiet before the SENTENCE is considered over.
//
// This used to be 900 ms and it was the single worst setting in the plugin:
// everyday speech pauses for about a second mid-sentence ("Ladies and
// gentlemen, today is a very good day … and"), so almost every sentence was cut
// while it was still being built. The fragments were then decoded from a fresh
// stream that had lost all context, which is exactly what produces the
// "我我我对对六六啪啪啪" repetition seen in real meetings — short audio makes a
// transducer loop on the same tokens. Requiring a real pause keeps one stream
// alive across intra-sentence hesitations, so the decoder keeps its context and
// the sentence arrives whole.
const ENDPOINT_SILENCE_MS = 1_600
// Between a hesitation and a real stop. A sentence that already looks finished
// — the recognizer produced a closing punctuation mark — may end here; anything
// else keeps listening and appends to the same sentence.
const SOFT_SILENCE_MS = 700
// Sentences are merged into PARAGRAPHS — the unit the right-hand column shows.
// A paragraph only ends when the speaker really stops: a longer pause, a long
// monologue, or the end of the meeting. Translating whole paragraphs instead of
// isolated sentences is what makes the output read like an interpreter rather
// than a sentence-by-sentence machine: pronouns and connectives survive.
const SEGMENT_SILENCE_MS = 1_800
const SEGMENT_MAX_MS = 45_000
// A speaker who never pauses would hold one endless turn. Cap it so a long
// monologue still reaches the transcript in readable pieces.
const MAX_TURN_MS = 20_000
// How often the input level is pushed to the panel. The meter used to ride on
// the two-second state snapshot, which made it look frozen — the one piece of
// UI that has to move continuously to prove the microphone is live.
const LEVEL_INTERVAL_MS = 120
// How much new text a paragraph must gain before re-running the draft
// translation. Re-translating the whole paragraph on every sentence would cost
// quadratically as the paragraph grows, but the threshold is the largest single
// contributor to how long the right-hand column stays empty: at ten characters
// a Chinese speaker had to say a full clause before the first word of
// translation appeared. Four characters is one short phrase, and the debounce
// below keeps the request rate sane.
const SEGMENT_DRAFT_MIN_GROWTH = 2
const DRAFT_DEBOUNCE_MS = 40
const MAX_CONTEXT_TURNS = 3
// Frames held while a recognizer stream is being swapped. 40 frames is ten
// seconds of speech — far longer than a stream swap ever takes, so this is a
// safety cap rather than a real limit.
const BACKLOG_LIMIT = 40
// Raw audio we are willing to hold for one paragraph so the offline pass can
// re-hear it. A paragraph is capped at SEGMENT_MAX_MS, so 45 s of 16 kHz mono
// PCM16 is ~1.4 MB — cheap enough to keep in memory, and dropped as soon as the
// paragraph is finalized.
const PCM_SEGMENT_LIMIT = 1_800_000
// What the panel may ask the browser to capture. Kept here as well so an
// unknown value from an older client is rejected instead of silently stored.
const SOUND_SOURCES = ['mic', 'system', 'mix']

export const inject = ['webServer', 'commands']

/* --------------------------------------------------------------- utilities */

function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('请求不是合法 JSON')
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

// Debug trace helper. Kept as a no-op so call sites can stay in place during
// development; the host child process's stdout is not visible to the agent, so
// any real tracing must go to a file, but that is stripped for release.
function dbg() {}

// A captured WASAPI loopback helper process. The browser cannot open system
// audio on its own — Electron never registers a display-media handler, and the
// "Stereo Mix" recording endpoint only hears the onboard chip, never a USB or
// Bluetooth speaker. A tiny Python helper uses the WASAPI loopback API through
// `soundcard` to hook the *default render device itself*, which is the only way
// to hear a USB speaker or an online meeting that plays out of one.
const WASAPI_HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'wasapi-capture.py',
)
// 16 kHz mono PCM16LE: two bytes per sample, so a 240 ms frame is 7680 bytes.
const WASAPI_FRAME_BYTES = 7_680
// The helper must be sent data even when the machine is quiet, otherwise the
// silence meter freezes and the paragraph boundary never fires.
const WASAPI_PYTHON = (function () {
  const win = process.platform === 'win32'
  return {
    win,
    candidates: win
      ? [
          'python',
          'py',
          process.env.PYTHON ?? '',
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : '',
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe') : '',
        ]
      : ['python3', 'python'],
  }
})()

function spawnWasapiCapture({ deviceId, onFrame, onError }) {
  // Spawn the helper and stream its PCM16LE output into the session. Returns a
  // stop() function that kills the process and drains its stdout.
  //
  // Dependency self-heal: the helper exits with code 3 when `soundcard`/`numpy`
  // are missing. In that case this auto-runs `python -m pip install soundcard
  // numpy` once, then retries the spawn. If the install or the retry fails it
  // falls back to a clear manual-install message. Python itself must already be
  // on the machine; installing an interpreter is out of scope for the plugin.
  const args = [WASAPI_HELPER, '--sr', '16000', '--frames', '3840']
  if (typeof deviceId === 'string' && deviceId !== '') args.push('--device', deviceId)

  let child = null
  let pending = Buffer.alloc(0)
  let stopped = false
  let failed = false
  let installing = false

  const pump = (chunk) => {
    // `chunk` is a Node Buffer of raw PCM16LE. Chunk-agnostic framing: split
    // into 7680-byte frames and hand each to the session.
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    while (pending.length >= WASAPI_FRAME_BYTES) {
      const frame = pending.subarray(0, WASAPI_FRAME_BYTES)
      pending = pending.subarray(WASAPI_FRAME_BYTES)
      onFrame(frame)
    }
  }

  const fail = (message) => {
    if (failed || stopped) return
    failed = true
    onError(new Error(message))
  }

  const stop = () => {
    stopped = true
    if (child !== null) {
      try {
        child.stdout.removeAllListeners('data')
        child.stderr.removeAllListeners('data')
        child.removeAllListeners('error')
        child.removeAllListeners('exit')
        child.kill()
      } catch {
        /* ignore */
      }
      child = null
    }
  }

  const installDeps = (pythonExe) =>
    new Promise((resolve) => {
      let proc = null
      try {
        proc = spawn(pythonExe, ['-m', 'pip', 'install', 'soundcard', 'numpy'], {
          stdio: ['ignore', 'ignore', 'ignore'],
        })
      } catch {
        resolve(false)
        return
      }
      proc.on('error', () => resolve(false))
      proc.on('exit', (code) => resolve(code === 0))
    })

  // Resolve on the first signal that settles the spawn: the first PCM on stdout
  // means it is capturing, an exit before that means it failed to start (code 3
  // = missing dependency, code 4/5 = no matching loopback device, -1 = no
  // interpreter). A later non-zero exit (after stdout already flowed) is a
  // mid-capture crash and is reported through `fail`.
  const spawnOnce = () =>
    new Promise((resolve) => {
      for (const candidate of WASAPI_PYTHON.candidates) {
        if (candidate === '') continue
        let proc = null
        try {
          proc = spawn(candidate, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch {
          continue
        }
        child = proc
        let settled = false
        const settle = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        proc.stdout.on('data', (chunk) => {
          pump(chunk)
          settle({ ok: true, python: candidate })
        })
        proc.stderr.on('data', () => {})
        proc.on('error', () => {
          if (stopped) return
          child = null
          settle({ ok: false, code: -1, python: candidate })
        })
        proc.on('exit', (code) => {
          if (stopped) return
          child = null
          if (!settled) {
            settle({ ok: false, code, python: candidate })
          } else if (code !== 0) {
            fail(`系统声音采集进程已退出（code=${code}）：请确认 Python 3 已安装并执行 pip install soundcard numpy`)
          }
        })
        return
      }
      resolve({ ok: false, code: -1, python: '' })
    })

  // Run the spawn (and the one-shot dependency install when needed) in the
  // background so `start()` returns immediately; the meter shows the requesting
  // state while the install may take a moment, then frames start flowing.
  ;(async () => {
    const first = await spawnOnce()
    if (stopped) return
    if (first.ok) return

    if (first.code === 3 && first.python !== '' && !installing) {
      installing = true
      const installed = await installDeps(first.python)
      if (stopped) return
      if (installed) {
        const second = await spawnOnce()
        if (stopped) return
        if (second.ok) return
        fail(`系统声音采集进程已退出（code=${second.code}）：请确认 Python 3 已安装并执行 pip install soundcard numpy`)
        return
      }
      fail('系统声音采集需要 soundcard 与 numpy，自动安装失败：请手动执行 pip install soundcard numpy')
      return
    }

    if (first.code === -1 || first.python === '') {
      fail('无法启动系统声音采集：本机没有可用的 Python 解释器，请安装 Python 3 并 pip install soundcard numpy')
    } else {
      fail(`系统声音采集进程已退出（code=${first.code}）：请确认已安装 Python 3 并执行 pip install soundcard numpy`)
    }
  })()

  return stop
}

/**
 * Accept an offline refinement only when it is plausibly the same speech.
 *
 * The offline pass is better almost always, but it can also hallucinate a
 * completely different sentence when the audio is mostly silence, and then it
 * would replace a correct transcript with an invented one. A refinement that
 * shares no characters at all with what the streaming pass heard is rejected.
 */
function cleanedRefinement(refined) {
  const value = refined.trim()
  if (value === '') return ''
  // Control tokens only, no words.
  if (value.replace(/[\s\p{P}\p{S}]/gu, '') === '') return ''
  return value
}

/**
 * Does the refinement describe the same speech the streaming pass heard?
 *
 * Both passes heard the same audio, so they must agree on roughly half of the
 * characters. A low overlap means the offline model produced something else
 * entirely — usually because the segment is mostly silence or noise — and the
 * safer answer is to keep what we have.
 */
function sharesContent(refined, original) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const a = normalize(refined)
  const b = normalize(original)
  if (a === '' || b === '') return false
  const counts = new Map()
  for (const char of b) counts.set(char, (counts.get(char) ?? 0) + 1)
  let shared = 0
  for (const char of a) {
    const left = counts.get(char) ?? 0
    if (left > 0) {
      shared += 1
      counts.set(char, left - 1)
    }
  }
  // Character recall of the streaming text within the refinement: a different
  // sentence scores near zero, a corrected version of the same sentence scores
  // high even when individual characters were fixed.
  return shared / b.length >= 0.4
}

/* ------------------------------------------------------- sentence boundary */

const SENTENCE_END = /[。．.!！?？…]$/
const TRAILING_JOINER = /[，,、；;：:—–-]$/
// English words that cannot end a sentence. When a hypothesis stops on one of
// these the speaker was cut off mid-clause, whatever else the text looks like.
const OPEN_TAIL = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'because', 'if', 'when', 'while',
  'as', 'than', 'that', 'which', 'who', 'whom', 'whose', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'from', 'with', 'without', 'into', 'onto', 'about', 'over', 'under', 'between',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'has', 'have',
  'had', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'i', 'we', 'you', 'they', 'he', 'she', 'it', 'my', 'our', 'your', 'their', 'his', 'her',
  'its', 'this', 'these', 'those', 'there', 'here', 'not', 'no', 'very', 'just', 'also',
])
// Chinese particles that commonly close a spoken clause. Only trusted for a
// sentence long enough that the particle really is the end of it.
const ZH_CLOSER = /[了啊吧呢吗嘛呀哈哦噢嘞]$/
// Single-character Chinese words that cannot end a sentence on their own. A
// streaming recognizer often drops a full stop right after a pronoun ("首先，我。")
// or after a preposition/auxiliary, and taking that as a finished sentence is
// exactly the premature split that produced "首先，我。" as its own row. If the
// last meaningful character is one of these the clause is still open.
const ZH_OPEN_TAIL = new Set([
  '我', '你', '他', '她', '它', '这', '那', '谁', '哪',
  '在', '把', '被', '让', '给', '对', '从', '向', '到', '往', '为', '以', '因', '所', '由',
  '与', '和', '及', '或', '但', '而', '且', '并', '其', '于', '之', '则', '亦', '若', '虽', '然', '将',
  '是', '有', '会', '能', '要', '想', '就', '都', '还', '也', '再', '又', '很', '更', '最', '才', '刚', '只', '仅',
])

/**
 * Does this hypothesis read as a FINISHED sentence?
 *
 * Used only to allow an early close during a short hesitation (`settled` in
 * handleFrame). It answers "no" by default, on purpose: the streaming models
 * often emit no punctuation at all, and guessing too early is precisely the
 * failure this rule exists to prevent — a sentence cut while it is still being
 * built loses its decoder context and comes back as "我我我对对六六".
 *
 * So a sentence counts as finished only when the recognizer itself closed it
 * (a full stop, and for English a tail that is not a function word) or when it
 * ends on an unambiguous Chinese closing particle.
 */
function looksFinished(text, lang) {  const value = String(text ?? '').replace(/[」』”’"'\s]+$/u, '').trimEnd()
  if (value === '') return false
  if (TRAILING_JOINER.test(value)) return false
  if (lang === 'en') {
    const words = value.toLowerCase().replace(/[^a-z' ]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return false
    if (OPEN_TAIL.has(words[words.length - 1])) return false
    if (!SENTENCE_END.test(value)) return false
    return words.length >= 3
  }
  if (ZH_CLOSER.test(value)) return value.length >= 6
  if (SENTENCE_END.test(value)) {
    // A full stop from the streaming recognizer is only a reliable "finished"
    // signal when the clause also ends on a noun-ish tail. If the recognizer
    // dropped the stop right after an open word ("首先，我。", "因为。", "就是"),
    // treat it as still mid-clause and let the real pause boundary close it.
    const core = value.replace(/[」』”’"'\s]+$/u, '').replace(/[。．.!！?？…]+$/u, '')
    const lastChar = core.slice(-1)
    const len = core.length
    if (len < 2) return false
    if (ZH_OPEN_TAIL.has(lastChar)) return false
    return len >= 4
  }
  return false
}

/* ------------------------------------------------------- paragraph layout */

// Characters that end a sentence on their own. CJK text has no space after the
// full stop, so these cut immediately; ASCII marks need a following sentence
// start, otherwise "3.5" and "U.S." would be torn apart.
const CJK_STOP = new Set(['。', '．', '！', '？', '；', '…'])
const ASCII_STOP = new Set(['.', '!', '?', ';'])
const CLOSING_MARK = new Set(['」', '』', '”', '’', '"', "'", ')', '）', ']', '】', '》'])
// Short forms whose trailing full stop is not the end of a sentence. Meeting
// speech uses very few of these, so the list stays deliberately small.
const ABBREVIATION = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'no', 'fig'])

/**
 * Split a paragraph into the sentences a reader would recognise.
 *
 * The transcript used to keep whatever fragments the streaming recognizer
 * happened to close, which after offline refinement no longer matched the text
 * they were rendered next to. Splitting the FINAL text keeps the left column and
 * its per-sentence translation derived from one and the same string.
 */
function splitSentences(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (text === '') return []
  const out = []
  let start = 0
  const cut = (end) => {
    const piece = text.slice(start, end).trim()
    if (piece !== '') out.push(piece)
    start = end
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    let end = -1
    if (CJK_STOP.has(char)) {
      end = index + 1
    } else if (ASCII_STOP.has(char)) {
      const before = text.slice(start, index)
      const word = (before.match(/([A-Za-z.]+)$/u)?.[1] ?? '').toLowerCase()
      if (char === '.' && ABBREVIATION.has(word)) continue
      const next = text[index + 1] ?? ''
      // A mark glued to what follows is part of a number, an acronym or an
      // ellipsis, never a boundary.
      if (next !== '' && next !== ' ') continue
      end = index + 1
    }
    if (end <= start) continue
    while (end < text.length && CLOSING_MARK.has(text[end])) end += 1
    cut(end)
    index = end - 1
  }
  if (start < text.length) cut(text.length)
  return out
}

/**
 * Sentence list that matches the FINAL paragraph text.
 *
 * Refinement and repair rewrite the text but the stored sentences are the ones
 * the streaming pass closed, so the two drift apart and the columns stop lining
 * up. Whenever the final text can be split we trust the split; the streaming
 * fragments stay only as a fallback for text with no sentence marks at all.
 */
function resegment(text, previous) {
  const lines = splitSentences(text)
  if (lines.length > 0) return lines
  return Array.isArray(previous) ? previous.map((line) => String(line ?? '').trim()).filter((line) => line !== '') : []
}

// A paragraph that is a couple of bare characters with no sentence mark is a
// recognizer tail fragment — the leftover of a paragraph that already closed
// ("本领", "嗯嗯的"), not a real utterance. Persisting it produced a row like
// "本领 → This zero.", which is worse than omitting it. Only short punctuation-
// free text is dropped: a real short reply ("好的。", "明白。") keeps its full
// stop and survives.
function isTailFragment(text) {
  const value = String(text ?? '').trim()
  if (value === '') return true
  const core = value.replace(/[^\p{L}\p{N}]/gu, '')
  if (core.length >= 4) return false
  return !/[。．.!！?？…]/.test(value)
}

/**
 * Lay the paragraph out as rows of { source, target }.
 *
 * The panel renders one row per pair, so the two columns share a row height and
 * can never drift apart — which is what the reader actually asked for. When the
 * translated line count does not match the source sentence count we refuse to
 * guess and fall back to one full-width pair: a wrong pairing is worse than an
 * unpaired paragraph.
 */
function pairsFor(sentences, aligned, translation) {
  const sources = (Array.isArray(sentences) ? sentences : []).map((line) => String(line ?? '').trim()).filter((line) => line !== '')
  const whole = String(translation ?? '').trim()
  const lines = Array.isArray(aligned)
    ? aligned.map((line) => String(line ?? '').trim())
    : []
  if (sources.length > 0 && lines.length === sources.length && lines.every((line) => line !== '')) {
    return sources.map((source, index) => ({ source, target: lines[index] }))
  }
  if (sources.length > 0) {
    // No usable per-sentence translation: keep the paragraph readable as one
    // pair instead of leaving the right-hand side blank.
    return [{ source: sources.join(' '), target: whole }]
  }
  return whole === '' ? [] : [{ source: '', target: whole }]
}

/* ----------------------------------------------------------- live sessions */
/**
 * One live session owns the recognizer stream for one project. Creating it does
 * not start the microphone: the browser does that, we only consume frames.
 */
class LiveSession {
  constructor(ctx, projectId) {
    this.ctx = ctx
    this.projectId = projectId
    this.channels = new Set()
    this.status = 'idle'
    this.startedAt = 0
    this.asr = null
    this.asrModel = 'bilingual-paraformer'
    this.voice = 'tts-zh-en'
    // Which DSH model translates this meeting, picked in the panel. `null` means
    // "whatever DSH itself is configured to use", so a fresh install needs no
    // choice and a later change of the profile default still follows through.
    this.route = null
    // Use the DSH text model to clean up the transcript as well? Speech repair
    // is text work, so the same model can do it; it is opt-out because it costs
    // one extra call per paragraph.
    this.repair = true
    // Where the audio comes from. The capture itself happens in the browser; the
    // host only records the choice so a meeting resumed later still says what it
    // was listening to. `mix` is the online-meeting case where both the room and
    // the call have to be heard.
    this.source = 'mic'
    // `turn` is the SENTENCE currently being recognized; `segment` is the
    // PARAGRAPH being built from finished sentences. Only a segment is
    // persisted and shown in the right-hand column: translating isolated
    // sentences loses the pronouns and connectives that make speech read
    // coherently.
    this.turn = null
    this.segment = null
    this.seq = 0
    this.lastVoiceAt = 0
    this.segmentTimer = null
    this.segmentAbort = null
    this.segmentBusy = false
    this.segmentPending = false
    this.lang = 'zh'
    this.silentFrames = 0
    this.draftTimer = null
    this.draftAbort = null
    this.draftBusy = false
    this.queue = Promise.resolve()
    this.finals = Promise.resolve()
    this.pendingReopen = Promise.resolve()
    this.asrToken = 0
    this.backlog = []
    // Audio of the paragraph currently being assembled, on the SESSION because a
    // segment does not exist until its first sentence closes. Cleared once the
    // offline pass has consumed it.
    this.audioBuffer = []
    // Speech/silence classifier for this meeting. `null` means the energy
    // threshold decides, which is the behaviour when the 600 KB VAD model is not
    // installed.
    this.gate = null
    // Stops the WASAPI loopback helper when the meeting ends or the source is
    // switched away. `null` means no system-audio helper is running.
    this.wasapiStop = null
    this.audioBytes = 0
    this.lastError = ''
    // Diagnostics surfaced in the snapshot: a browser that produces no frames at
    // all and a browser whose frames are all silence look identical from the
    // transcript, but need completely different fixes.
    this.frames = 0
    this.voicedFrames = 0
    this.level = 0
    this.lastFrameAt = 0
    this.meterTimer = null
    this.levelTimer = null
    // Smoothed input level for the meter. Raw per-frame RMS swings between
    // near-silence and full scale on every syllable, which reads as a strobe;
    // a decaying envelope looks like a real VU meter and still falls to zero
    // within a few hundred milliseconds of the speaker stopping.
    this.meterLevel = 0
  }

  attach(channel) {
    this.channels.add(channel)
    channel.send('state', this.snapshot())
    return channel
  }

  broadcast(event, data) {
    for (const channel of this.channels) {
      if (channel.closed) this.channels.delete(channel)
      else channel.send(event, data)
    }
  }

  snapshot() {
    return {
      projectId: this.projectId,
      status: this.status,
      startedAt: this.startedAt,
      elapsed: this.startedAt === 0 ? 0 : nowMs() - this.startedAt,
      seq: this.seq,
      lang: this.lang,
      // "Ready" must mean "the weights are on disk and loadable", not "a
      // recognizer stream happens to exist this instant": the stream is null
      // for a few hundred ms between sentences, and reporting that as 未就绪
      // made the panel flash a scary error during perfectly normal speech.
      asrReady: isModelReady(this.asrModel),
      asrModel: this.asrModel,
      voice: this.voice,
      route: this.route,
      repair: this.repair,
      source: this.source,
      error: this.lastError,
      // Zero frames while recording means the browser never delivered audio
      // (denied microphone, wrong input device, suspended AudioContext); frames
      // with a near-zero level mean it delivered silence (muted device).
      frames: this.frames,
      voicedFrames: this.voicedFrames,
      level: Math.round(this.level * 1000) / 1000,
      lastFrameAgo: this.lastFrameAt === 0 ? -1 : nowMs() - this.lastFrameAt,
    }
  }

  async start(options = {}) {
    if (this.status === 'recording') return this.snapshot()
    this.asrModel = String(options.engine ?? this.asrModel)
    if (typeof options.voice === 'string') this.voice = options.voice
    const repairGiven = typeof options.repair === 'boolean'
    if (repairGiven) this.repair = options.repair
    // The capture runs in the browser, so this is only remembered, not acted on.
    // It still has to be persisted: a meeting that listened to system audio must
    // say so when it is reopened, or the next reader cannot tell whether the
    // transcript is the room or the call.
    const sourceGiven = SOUND_SOURCES.includes(String(options.source ?? ''))
    if (sourceGiven) this.source = String(options.source)
    const routeGiven = options.route !== null && options.route !== undefined
    if (routeGiven) {
      const provider = String(options.route.provider ?? '')
      const model = String(options.route.model ?? '')
      this.route = provider === '' || model === '' ? null : { provider, model }
    }
    // The project remembers its own model choice. Reopening a meeting after a
    // restart must translate it the same way it was translated before, not fall
    // back to whatever the profile default happens to be today. An explicit
    // choice in this call always wins over the stored one.
    const saved = await getProject(this.projectId)
    if (!routeGiven && this.route === null && saved !== null && saved.route !== null && saved.route !== undefined) {
      const provider = String(saved.route.provider ?? '')
      const model = String(saved.route.model ?? '')
      if (provider !== '' && model !== '') this.route = { provider, model }
    }
    if (!repairGiven && saved !== null && typeof saved.repair === 'boolean') this.repair = saved.repair
    if (!sourceGiven && saved !== null && SOUND_SOURCES.includes(String(saved.source ?? ''))) {
      this.source = String(saved.source)
    }
    const state = modelState(this.asrModel)
    if (!state.ready) {
      this.lastError = `语音模型未就绪（${this.asrModel}），请先在面板底部下载`
      this.broadcast('error', { message: this.lastError })
      return this.snapshot()
    }
    await ensureEngine(this.asrModel)
    this.asr = await createAsrStream(this.asrModel)
    // Loaded lazily and non-fatally: without the model the session still runs on
    // the energy threshold, it just ends paragraphs less gracefully.
    this.gate = await createSpeechGate()
    // System audio cannot come from the browser: Electron never grants display
    // capture and "Stereo Mix" only hears the onboard chip, not a USB/Bluetooth
    // speaker. A WASAPI loopback helper (Python + soundcard) hooks the *default
    // render device* and streams 16 kHz PCM16LE straight into the session. It is
    // started here because the session's own frame path (pushFrame) is what the
    // helper feeds; the browser continues to supply the microphone half in "mix".
    if (this.source === 'system' || this.source === 'mix') {
      this.wasapiStop = spawnWasapiCapture({
        deviceId: '',
        onFrame: (frame) => {
          this.pushFrame(frame)
        },
        onError: (error) => {
          this.lastError = errorText(error)
          this.broadcast('error', { message: this.lastError })
        },
      })
    }
    this.seq = (await listTurns(this.projectId)).length
    this.startedAt = nowMs()
    this.status = 'recording'
    this.frames = 0
    this.voicedFrames = 0
    this.level = 0
    this.lastFrameAt = 0
    this.segment = null
    this.audioBuffer = []
    this.audioBytes = 0
    this.turn = this.newTurn()
    this.draftAbort?.abort()
    this.draftAbort = null
    this.draftBusy = false
    this.segmentBusy = false
    this.segmentPending = false
    if (this.segmentTimer !== null) {
      clearTimeout(this.segmentTimer)
      this.segmentTimer = null
    }
    const meta = await getProject(this.projectId)
    const persist = {
      status: 'recording',
      engine: this.asrModel,
      route: this.route,
      repair: this.repair,
      source: this.source,
    }
    if (meta !== null && meta.startedAt === null) {
      await patchProject(this.projectId, { ...persist, startedAt: this.startedAt })
    } else {
      await patchProject(this.projectId, persist)
    }
    this.broadcast('state', this.snapshot())
    // The panel needs a periodic snapshot even when the browser is sending
    // nothing at all — otherwise "zero frames" never reaches it and the user
    // stares at an empty transcript with no explanation.
    this.startMeter()
    return this.snapshot()
  }

  startMeter() {
    this.stopMeter()
    // Two cadences on purpose. The full snapshot is expensive to serialise and
    // the panel only needs it for counters, so it stays slow. The input level is
    // the one number that has to look alive; it goes out on its own fast timer
    // as a tiny event instead of dragging a whole snapshot with it.
    this.meterTimer = setInterval(() => {
      if (this.status === 'recording') this.broadcast('state', this.snapshot())
    }, 2000)
    this.levelTimer = setInterval(() => {
      if (this.status !== 'recording') return
      this.broadcast('level', {
        level: Math.round(this.meterLevel * 1000) / 1000,
        frames: this.frames,
        voiced: this.voicedFrames,
        // Same wall-clock measure handleFrame uses, so the number in the panel
        // and the decision to end a paragraph can never disagree.
        silentMs: Math.round(this.silenceMs()),
      })
    }, LEVEL_INTERVAL_MS)
    if (typeof this.meterTimer?.unref === 'function') this.meterTimer.unref()
    if (typeof this.levelTimer?.unref === 'function') this.levelTimer.unref()
  }

  stopMeter() {
    if (this.meterTimer !== null) {
      clearInterval(this.meterTimer)
      this.meterTimer = null
    }
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer)
      this.levelTimer = null
    }
  }

  pause() {
    if (this.status !== 'recording') return this.snapshot()
    this.status = 'paused'
    this.stopMeter()
    this.broadcast('state', this.snapshot())
    return this.snapshot()
  }

  async resume() {
    if (this.status !== 'paused') return this.snapshot()
    this.status = 'recording'
    this.startMeter()
    this.broadcast('state', this.snapshot())
    return this.snapshot()
  }

  /**
   * One in-progress SENTENCE. Sentences are not persisted and get no sequence
   * number: only the paragraph they belong to becomes a transcript row.
   */
  newTurn() {
    return {
      startMs: nowMs() - this.startedAt,
      hypothesis: '',
      previous: '',
      committed: '',
      lastVoiceMs: nowMs(),
    }
  }

  /**
   * One PARAGRAPH being assembled from finished sentences. It owns the seq that
   * ends up in the transcript, the export files and the read-aloud queue.
   */
  startSegment(lang, at) {
    this.seq += 1
    const startMs = typeof at === 'number' && Number.isFinite(at) ? at : nowMs() - this.startedAt
    this.segment = {
      seq: this.seq,
      startMs,
      endMs: startMs,
      sentences: [],
      source: '',
      translation: '',
      draftSource: '',
      drafts: 0,
      lang: typeof lang === 'string' && lang !== '' ? lang : this.lang,
    }
    this.broadcast('segment', {
      seq: this.segment.seq,
      stage: 'open',
      startMs: this.segment.startMs,
      lang: this.segment.lang,
    })
    return this.segment
  }

  /**
   * What the right-hand column should translate right now: the finished
   * sentences of this paragraph plus the sentence currently being spoken. The
   * paragraph grows from a word to a sentence to a whole passage, and every
   * draft is a translation of that whole prefix — not of one isolated sentence.
   */
  segmentSource() {
    const parts = []
    if (this.segment !== null && this.segment.source !== '') parts.push(this.segment.source)
    if (this.turn !== null && this.turn.committed.trim() !== '') parts.push(this.turn.committed.trim())
    return parts.join(' ')
  }

  /**
   * How long the speaker has been quiet, measured in SILENT FRAMES of audio.
   *
   * Frame time (not wall clock) is the only measure that works for both a live
   * microphone and a replayed file: a buffered stream delivers frames far faster
   * than real time, so wall clock never accumulates enough to reach a threshold
   * while frame time reaches it as soon as the equivalent audio has passed.
   * `FRAME_BYTES` bytes of PCM16 @ 16 kHz is exactly 240 ms, so a count of
   * silent frames is a count of 240 ms steps.
   */
  silenceMs() {
    return (this.silentFrames * FRAME_BYTES * 1000) / 32000
  }

  /**
   * Consume one audio frame. Frames arrive on the order they were recorded, so
   * a single serial queue keeps recognition and translation strictly ordered.
   */
  pushFrame(buffer) {
    this.queue = this.queue
      .then(() => this.handleFrame(buffer))
      .catch((error) => {
        this.lastError = errorText(error)
        this.broadcast('error', { message: this.lastError })
      })
    return this.queue
  }

  async handleFrame(buffer) {
    if (this.status !== 'recording') return
    const samples = toFloat32(buffer)
    if (samples.length === 0) return

    // Keep the raw audio of the paragraph being assembled. The streaming pass
    // is what gives us the first text, but it commits tokens before the
    // sentence ends; the offline pass needs the entire stretch to fix what it
    // got wrong. Bounded by SEGMENT_MAX_MS, so this is at most a couple of MB.
    //
    // Collected on the SESSION, not on the segment: a paragraph only comes into
    // existence once its first sentence closes, so buffering on the segment
    // would silently drop everything said before that — which is the whole
    // opening sentence of every paragraph. Pushed here even while the
    // recognizer is being swapped, so the offline pass re-hears the same audio
    // the streaming pass saw.
    if (this.audioBytes + buffer.byteLength <= PCM_SEGMENT_LIMIT) {
      this.audioBuffer.push(buffer)
      this.audioBytes += buffer.byteLength
    }

    const level = rmsOf(samples)
    // Speech detection, when the VAD model is installed, replaces the raw energy
    // threshold: a fan or a USB interface's self-noise sits above the threshold
    // continuously, so the level alone never reports "silence" and the paragraph
    // boundary has to fall back on a timer. The classifier answers the question
    // the level cannot — is this frame speech — and falls back to the threshold
    // when it is not installed.
    //
    // This accounting runs even while the recognizer stream is being rebuilt:
    // the VAD and the energy meter do not depend on the recognizer, and freezing
    // the silence count during that window is what made paragraph boundaries
    // unreachable (only the fallback timer ever fired).
    const detected = this.gate === null ? null : this.gate.accept(samples)
    const voiced = detected === null ? level >= SILENCE_RMS : detected
    this.frames += 1
    this.lastFrameAt = nowMs()
    this.level = level
    // Fast attack, slow release: jump to a new peak immediately so the first
    // syllable shows up, then decay so the bar does not flicker between
    // syllables. Below the noise floor it snaps to zero instead of crawling
    // down, so "no sound at all" is unmistakable.
    if (level >= this.meterLevel) this.meterLevel = level
    else this.meterLevel = level < SILENCE_RMS ? 0 : this.meterLevel * 0.72 + level * 0.28
    if (voiced) {
      this.voicedFrames += 1
      this.silentFrames = 0
      if (this.turn !== null) this.turn.lastVoiceMs = nowMs()
    } else {
      this.silentFrames += 1
    }

    if (this.asr === null) {
      // The recognizer is being swapped between utterances. Audio that arrives
      // during that window is real speech — dropping it would swallow the first
      // words of the next sentence, which is exactly what a live interpreter
      // must never do. Hold it and replay once the stream is up. (Already
      // buffered above for offline refinement.)
      if (this.backlog.length < BACKLOG_LIMIT) this.backlog.push(buffer)
      return
    }

    const frame = this.asr.accept(samples)
    if (this.turn === null) this.turn = this.newTurn()
    this.turn.hypothesis = frame.text

    const lang = detectLang(frame.text, this.lang)
    if (frame.text.trim() !== '') {
      // A language switch at the start of a new sentence (the current turn has
      // committed nothing yet) is the signal to rebuild the recognizer stream:
      // the previous sentence was in one language and this one is in the other,
      // and decoding the new language with the old sentence's context garbles it
      // into repeated, mixed-up characters. Mid-sentence mixing stays untouched —
      // that is a single bilingual utterance, not a switch.
      if (lang !== this.lang && this.turn.committed.trim() === '') {
        this.lang = lang
        this.backlog.push(buffer)
        this.closeTurn('pause')
        return
      }
      this.lang = lang
    }

    // Open the paragraph row on the FIRST recognisable word instead of waiting
    // for the sentence to end. The left column shows live text from the outset,
    // so the reader sees the transcript move while the speaker is still talking
    // — waiting for closeTurn meant nothing appeared until a whole sentence had
    // been recognized and finalized.
    if (this.segment === null && frame.text.trim() !== '') {
      this.startSegment(lang, this.turn.startMs)
    }

    // Two consecutive hypotheses share a leading part that the recognizer has
    // stopped rewriting; only that part is safe to translate. Comparing
    // against the already-committed prefix could never grow, because that
    // prefix is by construction a prefix of *every* later hypothesis.
    const agreed = agreedPrefix(this.turn.previous, frame.text, lang)
    if (frame.text !== this.turn.previous) this.turn.previous = frame.text
    const folded = foldCommitted(this.turn.committed, agreed, frame.text)
    const grew = folded.length > this.turn.committed.length
    this.turn.committed = folded

    this.broadcast('asr', {
      seq: this.segment?.seq ?? 0,
      text: frame.text,
      stable: this.turn.committed,
      volatile: frame.text.slice(this.turn.committed.length),
      lang,
      endpoint: false,
    })

    if (frame.changed && grew) this.scheduleDraft()

    // Sentence boundary. The recognizer's own endpoint detector is disabled —
    // it fires on every short intra-sentence pause and resets the stream, which
    // shreds one sentence into fragments. Boundaries here are energy-based, but
    // two different pauses count:
    //
    //   • a hesitation after a text that already reads as complete (the model
    //     emitted a full stop) closes the sentence early, which keeps the
    //     transcript moving without letting a half-built clause escape;
    //   • otherwise only a long pause counts, so a speaker pausing mid-thought
    //     keeps the SAME stream alive and the decoder keeps its context. That is
    //     what prevents the "我我我对对六六" repetition: a stream that is never
    //     reset does not have to re-acquire the sentence.
    // Measured from the last frame that carried speech, in wall-clock time.
    // Counting silent FRAMES looks equivalent but is not: while the recognizer
    // stream is being rebuilt frames return early above and no counter advances,
    // so the paragraph boundary froze and only the fallback timer ever fired —
    // which is why paragraphs kept ending at a suspiciously exact 3.5 s.
    const silentMs = this.silenceMs()
    const settled =
      !voiced && silentMs >= SOFT_SILENCE_MS && looksFinished(this.turn.committed, this.lang)
    const quiet = !voiced && silentMs >= ENDPOINT_SILENCE_MS
    // A speaker who never pauses would otherwise hold one endless turn, and the
    // transcript would only appear when they finally stop. Cap the utterance so
    // a long monologue still lands in readable pieces.
    const spanMs = nowMs() - this.startedAt - this.turn.startMs
    const tooLong = spanMs >= MAX_TURN_MS && this.turn.committed.trim() !== ''
    if ((quiet || settled || tooLong) && this.turn.committed.trim() !== '') {
      this.closeTurn(voiced ? 'cap' : 'pause')
    }

    // Paragraph boundary measured in SILENCE, not in wall-clock time. The timer
    // armed by closeTurn is right for a live microphone, where a real two
    // seconds pass, but audio that arrives faster than real time (a replayed
    // file, a buffered stream) would never let that timer run. Counting silent
    // audio makes the boundary independent of how fast frames are delivered.
    const idle = this.turn === null || this.turn.committed.trim() === ''
    if (!voiced && idle && this.segment !== null && silentMs >= SEGMENT_SILENCE_MS) {
      this.flushSegment()
    }
  }

  /**
   * Close the current SENTENCE and start the next one immediately.
   *
   * This runs synchronously inside the audio queue: the recognizer stream is
   * swapped before the next frame arrives, so speech that begins the instant
   * the endpoint fires is not lost. The (slow) translation pass is deliberately
   * NOT awaited here — awaiting an LLM call inside the serial audio queue
   * would stop recognizing for its whole duration, which is exactly the
   * failure a live interpreter cannot afford.
   *
   * `reason` decides whether the PARAGRAPH also ends: 'pause' means the speaker
   * actually stopped ('cap' is a mid-sentence split of a monologue and must not
   * break the paragraph).
   */
  closeTurn(reason = 'pause') {
    if (this.turn === null) return
    const turn = this.turn
    const tailText = this.asr?.finish?.() ?? turn.hypothesis
    // The recognizer's trailing hypothesis is only an improvement when it
    // actually continues the committed prefix. finish() can also return a
    // SHORTER or re-decoded string that drops words already folded in, and
    // blindly swapping it in is how a correct mid-sentence stream got replaced
    // by a worse one (a real source of dropped characters).
    const tail = String(tailText ?? '').trim()
    const head = turn.committed.slice(0, Math.min(12, turn.committed.length))
    const text =
      tail !== '' && tail.length > turn.committed.length && head !== '' && tail.startsWith(head)
        ? tail
        : turn.committed
    this.asr?.dispose()
    this.asr = null
    this.turn = null
    if (this.draftTimer !== null) {
      clearTimeout(this.draftTimer)
      this.draftTimer = null
    }
    this.draftAbort?.abort()
    this.draftAbort = null
    if (text.trim() !== '') {
      if (this.segment === null) this.startSegment(detectLang(text, this.lang))
      this.segment.sentences.push(text.trim())
      this.segment.source = this.segment.sentences.join(' ')
      this.segment.endMs = nowMs() - this.startedAt
      this.segment.lang = detectLang(this.segment.source, this.lang)
      this.lastVoiceAt = nowMs()
      // The paragraph keeps growing in the right-hand column as sentences land,
      // so a draft over the new full text is scheduled right away.
      this.scheduleDraft()
      this.broadcast('segment', {
        seq: this.segment.seq,
        stage: 'grow',
        source: this.segment.source,
        lang: this.segment.lang,
        startMs: this.segment.startMs,
        endMs: this.segment.endMs,
      })
    }
    // Otherwise nothing was actually said (a cough, a door, the very first
    // silent frames) and the paragraph simply keeps waiting for real speech.
    this.reopenAsr()
    // A paragraph that has been running for SEGMENT_MAX_MS ends even if the
    // speaker keeps going: one transcript row must stay readable, and a draft
    // over an ever-growing passage costs more than it is worth. This applies to
    // BOTH 'pause' (speaker stopped) and 'cap' (a monologue split mid-speech):
    // a continuous speaker who never pauses otherwise grows one unbounded
    // paragraph, and its whole-text translation overflows the model's window —
    // the "模型返回 max-tokens" failure seen in long sessions.
    const spanMs = this.segment === null ? 0 : nowMs() - this.startedAt - this.segment.startMs
    if (this.segment !== null && spanMs >= SEGMENT_MAX_MS) this.flushSegment()
    else if (reason === 'pause') this.armSegmentFlush()
    this.broadcast('state', this.snapshot())
  }

  /**
   * Arm the paragraph boundary. Every new sentence resets it, so a paragraph
   * only ends after the speaker has been quiet for SEGMENT_SILENCE_MS — one
   * sentence is not a paragraph, and translating per sentence is exactly the
   * behaviour that reads badly.
   */
  armSegmentFlush() {
    if (this.segment === null) return
    if (this.segmentTimer !== null) clearTimeout(this.segmentTimer)
    this.segmentTimer = setTimeout(() => {
      this.segmentTimer = null
      this.flushSegment()
    }, SEGMENT_SILENCE_MS + 500)
  }

  /**
   * End the current PARAGRAPH and turn it into a transcript row. Called when
   * the speaker has stopped for SEGMENT_SILENCE_MS, when the paragraph hits
   * SEGMENT_MAX_MS, or when the meeting ends.
   */
  flushSegment() {
    if (this.segmentTimer !== null) {
      clearTimeout(this.segmentTimer)
      this.segmentTimer = null
    }
    const segment = this.segment
    if (segment === null) return
    // Whatever the in-progress sentence has so far is part of this paragraph:
    // dropping it would lose the tail of the meeting.
    if (this.turn !== null && this.turn.committed.trim() !== '') {
      segment.sentences.push(this.turn.committed.trim())
      segment.source = segment.sentences.join(' ')
      this.turn.committed = ''
    }
    this.segment = null
    if (segment.source.trim() === '' || isTailFragment(segment.source)) {
      // Nothing worth persisting (or a bare recognizer tail fragment): recycle
      // the sequence number so the transcript never has holes.
      this.seq -= 1
      return
    }
    // The paragraph boundary fired during a real pause, so any frames still
    // waiting in the backlog belong to audio that was already recognised into
    // the closed paragraph — a slow stream swap replayed them into a fresh
    // stream and the SAME speech came back as a second, near-identical row a
    // few seconds later. Dropping them here (they are already in the closed
    // paragraph's text) stops that duplicate before it is ever rendered.
    this.backlog = []
    segment.endMs = nowMs() - this.startedAt
    segment.aborted = false
    segment.translation = segment.translation ?? ''
    segment.drafts = segment.drafts ?? 0
    // Finalization is serialized on its own chain so a slow paragraph cannot
    // land in the transcript after a later, faster one.
    this.finals = this.finals
      .then(() => this.finalizeSegment(segment))
      .catch(async (error) => {
        this.lastError = errorText(error)
        this.broadcast('error', { message: this.lastError })
        // A paragraph that failed to finalize must still reach the transcript.
        // Its seq has already been handed out, so dropping it would leave a hole
        // in the numbering and silently lose speech the user watched arrive on
        // screen. The raw streaming text is worth more than nothing.
        await this.salvageSegment(segment).catch(() => {})
      })
  }

  /**
   * Write a paragraph that could not be finalized. Keeps the transcript
   * complete: sequence numbers stay dense and the source column keeps what the
   * recognizer had already produced.
   */
  async salvageSegment(segment) {
    const text = String(segment.source ?? '').trim()
    if (text === '' || isTailFragment(text)) return
    const existing = (await listTurns(this.projectId)).filter((row) => row.seq === segment.seq)
    if (existing.length > 0) return
    const lang = detectLang(text, this.lang)
    const sentences = resegment(text, segment.sentences)
    const row = {
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: segment.endMs,
      lang,
      speaker: null,
      source: text,
      translation: String(segment.translation ?? ''),
      sentences,
      aligned: null,
      pairs: pairsFor(sentences, null, segment.translation ?? ''),
      revisions: [],
      engine: this.asrModel,
      final: true,
      salvaged: true,
    }
    await appendTurn(this.projectId, row)
    const meta = await getProject(this.projectId)
    if (meta !== null) {
      await patchProject(this.projectId, { turns: (meta.turns ?? 0) + 1, lang, engine: this.asrModel })
    }
    this.broadcast('turn', { ...row, stage: 'final' })
  }

  async finalizeSegment(segment) {
    let text = segment.source
    let lang = detectLang(text, this.lang)
    dbg('finalize:enter', { seq: segment.seq, textLen: text.length })

    // Offline refinement: re-hear the whole paragraph with a model that is not
    // constrained to emit words as they arrive. On the same audio the streaming
    // pass dropped characters and produced no punctuation while the offline
    // model returned the correct sentence, so this pass is what makes the
    // transcript read like text instead of like guesses.
    const pcm = this.audioBuffer
    this.audioBuffer = []
    this.audioBytes = 0
    if (pcm.length > 0 && canRefine()) {
      try {
        const refined = await refineParagraph(concatPcm(pcm))
        if (refined.text !== '' && refined.text !== text) {
          const cleaned = cleanedRefinement(refined.text)
          // Only accept a refinement that plausibly heard the same speech. An
          // offline model fed mostly silence invents a confident sentence, and
          // replacing a correct transcript with an invented one is worse than
          // leaving the streaming result alone.
          if (cleaned !== '' && sharesContent(cleaned, text)) {
            text = cleaned
            lang = detectLang(text, lang)
            this.broadcast('segment', {
              seq: segment.seq,
              stage: 'refined',
              source: text,
              lang,
              startMs: segment.startMs,
              endMs: segment.endMs,
            })
          }
        }
      } catch (error) {
        // Refinement is an improvement, never a requirement: if it fails the
        // streaming transcript stands and the meeting continues.
        console.warn('[dsh-live-interpreter] refinement skipped', error)
      }
    }

    const target = otherLang(lang)
    this.broadcast('segment', {
      seq: segment.seq,
      stage: 'finalizing',
      source: text,
      lang,
      target,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })

    // Everything below needs the same two lookups, and each of them walks the
    // project directory. Fetch them once instead of once per pass.
    const context = await this.recentContext(segment.seq)
    const glossary = await this.glossary()
    dbg('finalize:context-ready', { seq: segment.seq })

    // Re-split the FINAL text. Refinement above may have rewritten the
    // paragraph, and the sentences collected by closeTurn describe the
    // streaming pass, not this text — keeping them would render a left column
    // that no longer matches what it says.
    const preRepairSentences = resegment(text, segment.sentences)

    // The transcript repair and the translation used to run back to back, and
    // in the order repair-then-translate: two full round trips before a
    // finished paragraph showed any translated text. Neither pass needs the
    // other's output (the aligned pass pairs the PRE-repair sentences, and a
    // repair only fixes characters inside a sentence), so they run together and
    // the paragraph lands in one round trip instead of two.
    const repairWork = async () => {
      if (!this.repair || text.trim() === '') { dbg('repair:skip', { seq: segment.seq }); return '' }
      dbg('repair:start', { seq: segment.seq })
      try {
        const repaired = cleanRepair(
          await translateText(this.ctx, {
            text,
            source: lang,
            target: lang,
            mode: 'repair',
            glossary,
            route: this.route,
            preferFast: true,
          }),
        )
        dbg('repair:got', { seq: segment.seq, len: repaired.length })
        // Accept only a repair that still looks like the same paragraph in both
        // directions: one-way containment lets the model delete half of it.
        if (repaired === '' || repaired === text) return ''
        if (!sharesContent(repaired, text) || !sharesContent(text, repaired)) return ''
        // A repair is a character-level fix, not a re-punctuation. If it changes
        // the sentence count, the per-sentence translation the aligned pass
        // computed (in parallel, against the pre-repair sentences) no longer
        // maps to the text on screen — line 3 would sit beside sentence 2. Keep
        // the streaming text instead of accepting a misaligned repair.
        if (resegment(repaired, []).length !== resegment(text, []).length) return ''
        return repaired
      } catch (error) {
        console.warn('[dsh-live-interpreter] transcript repair skipped', error)
        return ''
      }
    }

    const translateWork = async () => {
      dbg('translate:start', { seq: segment.seq })
      let translation = segment.translation
      const revisions = segment.drafts > 0 && translation !== '' ? [translation] : []
      // When the paragraph is a single sentence there is nothing to align. With
      // more than one, ask for one output line per input sentence so the two
      // columns stay in step: a model given a blob of text happily reorders
      // clauses, and then the reader cannot tell which translation belongs to
      // which sentence. Alignment runs even when a draft is already on screen,
      // because the draft is one unbroken paragraph and cannot be paired up.
      const multi =
        preRepairSentences.length > 1 && preRepairSentences.every((line) => line.trim() !== '')
      let aligned = null
      if (multi) {
        dbg('translate:aligned-start', { seq: segment.seq, n: preRepairSentences.length })
        try {
          const reply = await translateText(this.ctx, {
            text: preRepairSentences.join(' '),
            source: lang,
            target,
            mode: 'aligned',
            sentences: preRepairSentences,
            context,
            glossary,
            route: this.route,
            preferFast: true,
          })
          const lines = parseAligned(reply, preRepairSentences.length)
          // A count mismatch means the model merged or split sentences; showing
          // line 2 against sentence 1 is worse than not aligning at all.
          if (lines !== null) {
            aligned = lines
            translation = lines.join(' ')
            revisions.push(translation)
            // The aligned pass does not stream, so publish the finished
            // paragraph once here; otherwise the column keeps showing the draft
            // until the turn event lands.
            this.broadcast('translation', {
              seq: segment.seq,
              mode: 'final',
              text: translation,
              done: false,
              lang,
              target,
            })
          }
        } catch (error) {
          console.warn('[dsh-live-interpreter] aligned translation skipped', error)
        }
      }
      try {
        // With a draft already on screen the final pass is a REVISION of it, not
        // a fresh translation: re-rolling the wording of a paragraph the viewer
        // has been reading for half a minute is visible as the text jumping.
        const seeded = translation.trim() !== ''
        dbg('translate:final-pass-start', { seq: segment.seq, seeded, multi, aligned: aligned !== null })
        const revised =
          aligned === null
            ? await translateText(this.ctx, {
                text,
                source: lang,
                target,
                mode: seeded ? 'refine' : preRepairSentences.length > 1 ? 'segment' : 'revise',
                previous: seeded ? translation : '',
                context,
                glossary,
                route: this.route,
                preferFast: true,
                onDelta: (delta, full) => {
                  this.broadcast('translation', {
                    seq: segment.seq,
                    mode: 'final',
                    text: full,
                    done: false,
                    lang,
                    target,
                  })
                },
              })
            : translation
        if (revised !== '') {
          translation = revised
          if (aligned === null) revisions.push(revised)
        }
      } catch (error) {
        this.broadcast('error', { message: `定稿翻译失败：${errorText(error)}` })
      }
      dbg('translate:done', { seq: segment.seq, translationLen: translation.length })
      return { translation, aligned, revisions }
    }

    // The two passes used to run in a single Promise.all, but the host `llm`
    // stream does not terminate reliably when two requests run concurrently —
    // both async iterators hang on the missing `finish` chunk, so a finished
    // paragraph never lands a turn. Run them one at a time instead; the
    // translation (the pass the reader is waiting for) goes first, and the
    // transcript repair follows. Draft translation already covers the latency,
    // so this costs no perceived delay.
    const translated = await translateWork()
    dbg('finalize:translate-done', { seq: segment.seq, translationLen: translated.translation.length })
    const repaired = await repairWork()
    dbg('finalize:repair-done', { seq: segment.seq, repairedLen: repaired.length })
    let translation = translated.translation
    let aligned = translated.aligned
    const revisions = translated.revisions

    if (repaired !== '') {
      text = repaired
      lang = detectLang(text, lang)
      this.broadcast('segment', {
        seq: segment.seq,
        stage: 'repaired',
        source: text,
        lang,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })
    }

    // Sentences of the text that is actually on screen. A repair that changed
    // the sentence count invalidates the aligned lines — pairing sentence 3 with
    // the translation of sentence 2 is worse than showing the paragraph whole.
    let sentences = resegment(text, preRepairSentences)
    if (aligned !== null && aligned.length !== sentences.length) aligned = null

    // Last resort: the paragraph must never be blank on the right-hand side,
    // because the exports read this column.
    if (translation.trim() === '') {
      try {
        translation = await translateText(this.ctx, {
          text,
          source: lang,
          target,
          mode: 'revise',
          context,
          glossary,
          route: this.route,
          preferFast: true,
        })
      } catch {
        translation = ''
      }
    }

    const row = {
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: segment.endMs,
      lang,
      speaker: null,
      source: text,
      translation,
      // Sentences of the FINAL text, not of the streaming pass: everything the
      // panel renders is derived from the string the reader is looking at.
      sentences,
      // One translated line per sentence, when the model managed to keep them
      // in step. Without it the paragraph is still complete text.
      aligned: aligned === null ? null : aligned,
      // The paragraph as rows of { source, target }. This is what the panel
      // lays out, so a long translation and a short original share one row
      // height instead of drifting apart down the page.
      pairs: pairsFor(sentences, aligned, translation),
      revisions,
      engine: this.asrModel,
      final: true,
    }
    dbg('finalize:building-row', { seq: segment.seq, translationLen: translation.length })
    await appendTurn(this.projectId, row)
    dbg('finalize:appendTurn-done', { seq: segment.seq })
    const meta = await getProject(this.projectId)
    if (meta !== null) {
      await patchProject(this.projectId, { turns: (meta.turns ?? 0) + 1, lang, engine: this.asrModel })
    }
    this.broadcast('turn', { ...row, stage: 'final' })
    // Read-aloud only starts once a paragraph is written, so the voice reads
    // whole passages instead of restarting on every sentence.
    this.queueSpeech(row)
  }

  /**
   * Hand a finished paragraph to the browser for read-aloud. The host only
   * decides what to say and where the audio comes from; the browser owns the
   * output device (only an <audio> element can be routed with setSinkId).
   */
  queueSpeech(row) {
    if (row.translation.trim() === '' || this.voice === '') return
    this.broadcast('speak', {
      seq: row.seq,
      text: row.translation,
      lang: otherLang(row.lang),
      voice: this.voice,
    })
  }

  /**
   * Schedule a paragraph-level draft translation. Drafts always cover the whole
   * paragraph so far — a word, then a sentence, then a passage — which is what
   * makes the right-hand column converge instead of restarting per sentence.
   */
  scheduleDraft() {
    if (this.segment === null) return
    const source = this.segmentSource()
    if (source.trim() === '') return
    const growth = source.length - this.segment.draftSource.length
    // Re-run on new text, or on a same-length REWRITE (the recognizer fixing a
    // word in place), but never re-translate an unchanged string.
    if (growth < SEGMENT_DRAFT_MIN_GROWTH && source === this.segment.draftSource) return
    if (this.segmentBusy) {
      this.segmentPending = true
      return
    }
    if (this.draftTimer !== null) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      void this.runDraft()
    }, DRAFT_DEBOUNCE_MS)
  }

  async runDraft() {
    if (this.segment === null || this.status !== 'recording') return
    const segment = this.segment
    const source = this.segmentSource()
    if (source.trim() === '') return
    const lang = detectLang(source, this.lang)
    const target = otherLang(lang)
    const seq = segment.seq
    this.segmentBusy = true
    this.segmentPending = false
    this.draftAbort?.abort()
    const controller = new AbortController()
    this.draftAbort = controller
    const prevSource = segment.draftSource ?? ''
    segment.draftSource = source
    try {
      let emitted = ''
      const seeded = String(segment.translation ?? '').trim() !== ''
      // Append-only fast path. While a sentence is still being spoken the source
      // only GROWS: every new hypothesis is the previous one plus a few more
      // characters. Re-sending the whole paragraph on each step is what made the
      // translation slower and slower as the paragraph grew. So when the source
      // is a pure prefix extension of the last draft's source, translate just the
      // fresh tail and concatenate it onto the wording the reader already saw —
      // the stable prefix stays byte-for-byte stable and only the newest words
      // are ever re-fetched from the model. A recognizer that REWROTE an earlier
      // word (source no longer starts with the old source) still takes the full
      // refine path, which is the only case that genuinely needs a re-read.
      const appendOnly = seeded && prevSource !== '' && source.startsWith(prevSource)
      const freshTail = appendOnly ? source.slice(prevSource.length).trim() : ''
      const join = target === 'en' ? ' ' : ''
      const accumulate = (translation, part) => {
        const clean = String(part ?? '')
        if (clean === '') return translation
        return String(translation ?? '') === '' ? clean : String(translation) + join + clean
      }
      const text = await translateText(this.ctx, {
        text: appendOnly ? freshTail : source,
        source: lang,
        target,
        mode: appendOnly ? 'draft' : seeded ? 'refine' : 'draft',
        previous: appendOnly ? '' : seeded ? segment.translation : '',
        route: this.route,
        preferFast: true,
        signal: controller.signal,
        onDelta: (delta, full) => {
          if (controller.signal.aborted || this.segment !== segment) return
          const out = appendOnly ? accumulate(segment.translation, full) : full
          if (out.length > emitted.length) {
            emitted = out
            this.broadcast('translation', { seq, mode: 'draft', text: out, done: false, lang, target })
          }
        },
      })
      dbg('draft:translate-done', { seq, textLen: text.length })
      if (!controller.signal.aborted && this.segment === segment && text !== '') {
        const next = appendOnly ? accumulate(segment.translation, text) : text
        segment.drafts += 1
        segment.translation = next
        this.broadcast('translation', { seq, mode: 'draft', text: next, done: true, lang, target })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      this.broadcast('error', { message: `草稿翻译失败：${errorText(error)}` })
    } finally {
      if (this.draftAbort === controller) this.draftAbort = null
      this.segmentBusy = false
      // Speech kept arriving while this draft was in flight: run one more draft
      // over the now-longer paragraph instead of dropping it.
      if (this.segment === segment && this.segmentPending && this.status === 'recording') {
        this.segmentPending = false
        this.scheduleDraft()
      }
    }
  }

  /**
   * Swap in a fresh recognizer stream for the next utterance. Deliberately
   * synchronous-looking: the caller is the audio queue, which must never wait
   * on engine setup, and the previous stream is already disposed by then.
   */
  reopenAsr() {
    const token = (this.asrToken = (this.asrToken ?? 0) + 1)
    if (this.status !== 'recording') {
      this.asr = null
      this.turn = null
      return
    }
    this.pendingReopen = this.pendingReopen
      .then(() => createAsrStream(this.asrModel))
      .then(async (stream) => {
        // A later close already opened a newer stream: drop this stale one.
        if (token !== this.asrToken) {
          stream.dispose()
          return
        }
        this.asr = stream
        this.turn = this.newTurn()
        // Replay whatever arrived while the swap was in progress. These frames
        // are the head of the new utterance, so they must run through the same
        // recognition path — before any new frame is accepted.
        const pending = this.backlog
        this.backlog = []
        for (let index = 0; index < pending.length; index += 1) {
          // Replay itself can close the utterance (a pause inside the backlog),
          // which swaps in yet another stream. Hand the remaining frames back
          // so the newer stream replays them instead of losing them.
          if (this.asr !== stream || this.status !== 'recording') {
            this.backlog = pending.slice(index).concat(this.backlog)
            break
          }
          await this.handleFrame(pending[index])
        }
      })
      .catch((error) => {
        if (token !== this.asrToken) return
        this.asr = null
        this.turn = null
        this.broadcast('error', { message: `识别流重建失败：${errorText(error)}` })
      })
  }

  async recentContext(seq) {
    const rows = await listTurns(this.projectId)
    return rows
      .filter((row) => row.seq < seq && row.final === true)
      .slice(-MAX_CONTEXT_TURNS)
      .map((row) => `${row.source} => ${row.translation}`)
  }

  async glossary() {
    const meta = await getProject(this.projectId)
    return Array.isArray(meta?.glossary) ? meta.glossary : []
  }

  async stop() {
    if (this.status === 'idle') return this.snapshot()
    // A paused session still holds an unfinished paragraph, so it takes the
    // same tail path; only an idle session has nothing left to write.
    const wasRecording = this.status === 'recording' || this.status === 'paused'
    if (wasRecording && this.turn !== null) {
      const tailText = this.asr?.finish?.() ?? this.turn.hypothesis
      const pending = String(tailText ?? '').trim() === '' ? this.turn.committed : String(tailText)
      if (pending.trim() !== '') {
        if (this.segment === null) this.startSegment(detectLang(pending, this.lang))
        this.segment.sentences.push(pending.trim())
        this.segment.source = this.segment.sentences.join(' ')
      }
    }
    this.asr?.dispose()
    this.asr = null
    this.turn = null
    this.gate?.dispose()
    this.gate = null
    this.wasapiStop?.()
    this.wasapiStop = null
    this.backlog = []
    // The last paragraph is flushed before the status flips, so its translation
    // is serialized ahead of anything still in flight and the meeting does not
    // end with an untranslated tail.
    this.flushSegment()
    this.status = 'idle'
    this.stopMeter()
    if (this.segmentTimer !== null) {
      clearTimeout(this.segmentTimer)
      this.segmentTimer = null
    }
    // The status flips immediately so the button and the "recording" badge stop
    // the moment the user presses End. Finalizing the last paragraph (refine +
    // repair ∥ translate) can take several seconds of LLM round-trips, so it
    // must NOT gate the state flip; it keeps running in the background and only
    // marks the project "done" when it settles.
    this.broadcast('state', this.snapshot())
    void this.finals.then(async () => {
      const meta = await getProject(this.projectId)
      if (meta !== null) {
        await patchProject(this.projectId, {
          status: 'done',
          endedAt: nowMs(),
          turns: (await listTurns(this.projectId)).filter((row) => row.final === true).length,
        })
      }
      this.broadcast('state', this.snapshot())
    })
    return this.snapshot()
  }

  dispose() {
    this.draftAbort?.abort()
    if (this.draftTimer !== null) clearTimeout(this.draftTimer)
    if (this.segmentTimer !== null) {
      clearTimeout(this.segmentTimer)
      this.segmentTimer = null
    }
    this.segment = null
    this.turn = null
    this.stopMeter()
    this.asr?.dispose()
    this.asr = null
    this.gate?.dispose()
    this.gate = null
    this.wasapiStop?.()
    this.wasapiStop = null
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    this.status = 'idle'
  }
}

/* ----------------------------------------------------------------- plugin */

export function apply(ctx) {
  const sessions = new Map()
  const disposers = []
  let disposed = false

  const sessionFor = (projectId) => {
    const existing = sessions.get(projectId)
    if (existing !== undefined) return existing
    const created = new LiveSession(ctx, projectId)
    sessions.set(projectId, created)
    return created
  }

  const projectIdFrom = (segments) => {
    // /dsh-live-interpreter/api/projects/<id>/...
    return segments[1] ?? ''
  }

  async function handleApi(req, res, segments) {
    const method = String(req.method ?? 'GET').toUpperCase()
    // `segments` already excludes the `/dsh-live-interpreter/api` prefix.
    const tail = segments

    if (tail.length === 0 && method === 'GET') {
      return writeJson(res, 200, await metaSnapshot())
    }

    if (tail[0] === 'state' && tail.length === 1 && method === 'GET') {
      return writeJson(res, 200, await metaSnapshot())
    }

    if (tail[0] === 'models') {
      // Recognizers, refinement models and voices are downloaded, chosen and
      // reported independently — they are separate catalogs on disk too.
      if (method === 'GET' && tail.length === 1) {
        return writeJson(res, 200, {
          // `models` stays ASR-only for older clients that treat it as the
          // recognizer list; `all` carries every catalog for newer callers.
          models: listModelCatalog('asr'),
          asr: listModelCatalog('asr'),
          refine: listModelCatalog('refine'),
          tts: listModelCatalog('tts'),
          vad: listModelCatalog('vad'),
          all: listAllModels(),
        })
      }
      if (method === 'POST') {
        // /models/<id>/download            -> ASR (kept for older clients)
        // /models/<kind>/<id>/download     -> explicit kind
        const kind = tail.length >= 4 ? tail[1] : 'asr'
        const id = tail.length >= 4 ? tail[2] : tail[1]
        const isDownload = tail[tail.length - 1] === 'download'
        if (isDownload && id !== undefined) {
          const bucket =
            kind === 'tts' ? 'tts' : kind === 'refine' ? 'refine' : kind === 'vad' ? 'vad' : 'asr'
          void downloadModel(id, bucket)
          return writeJson(res, 202, { started: true, id, kind: bucket })
        }
      }
      return writeJson(res, 404, { error: 'not found' })
    }

    if (tail[0] === 'speech' && method === 'GET' && tail.length === 2) {
      // Synthesized paragraph audio. The browser plays it through an <audio>
      // element so it can be routed to the output device the user picked;
      // window.speechSynthesis cannot be routed at all.
      try {
        const file = path.join(dataRoot(), 'speech', path.basename(decodeURIComponent(tail[1])))
        const audio = await fsp.readFile(file)
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(audio.length),
          'cache-control': 'no-store',
        })
        res.end(audio)
        return undefined
      } catch {
        return writeJson(res, 404, { error: '音频不存在' })
      }
    }

    if (tail[0] === 'say' && method === 'POST') {
      // Synthesize one paragraph here and hand back a file name. The browser
      // plays it through an <audio> element so the voice follows the output
      // device the user picked; window.speechSynthesis cannot be routed.
      const body = await readJsonBody(req, 64 * 1024)
      try {
        const result = await synthesize(String(body.text ?? ''), {
          voiceId: String(body.voice ?? 'tts-zh-en'),
          speed: Number(body.speed ?? 1),
          speakerId: Number(body.speakerId ?? 0),
        })
        void pruneSpeech(6)
        return writeJson(res, 200, result)
      } catch (error) {
        return writeJson(res, 500, { error: errorText(error) })
      }
    }

    if (tail[0] === 'projects') {
      if (tail.length === 1) {
        if (method === 'GET') return writeJson(res, 200, { projects: await listProjects() })
        if (method === 'POST') {
          const body = await readJsonBody(req, 64 * 1024)
          const meta = await createProject(body)
          return writeJson(res, 201, { project: meta })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      }

      const projectId = tail[1]
      const meta = await getProject(projectId)
      if (meta === null) return writeJson(res, 404, { error: '项目不存在' })

      if (tail.length === 2) {
        if (method === 'GET') {
          return writeJson(res, 200, {
            project: meta,
            turns: await listTurns(projectId),
            exports: await listExports(projectId),
            session: sessionFor(projectId).snapshot(),
          })
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req, 256 * 1024)
          const next = await patchProject(projectId, {
            ...(typeof body.title === 'string' ? { title: body.title.slice(0, 200) } : {}),
            ...(Array.isArray(body.glossary) ? { glossary: body.glossary.slice(0, 200) } : {}),
            // A meeting remembers which model translated it: reopening the project
            // must not silently switch back to the profile default halfway
            // through, which would change the wording style mid-document.
            ...(body.route === null
              ? { route: null }
              : body.route !== undefined && typeof body.route === 'object'
                ? {
                    route: {
                      provider: String(body.route.provider ?? ''),
                      model: String(body.route.model ?? ''),
                    },
                  }
                : {}),
            ...(typeof body.repair === 'boolean' ? { repair: body.repair } : {}),
            ...(SOUND_SOURCES.includes(String(body.source ?? '')) ? { source: String(body.source) } : {}),
          })
          return writeJson(res, 200, { project: next })
        }
        if (method === 'DELETE') {
          sessions.get(projectId)?.dispose()
          sessions.delete(projectId)
          await deleteProject(projectId)
          return writeJson(res, 200, { deleted: true })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      }

      const action = tail[2]
      const session = sessionFor(projectId)

      if (action === 'start' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024)
        const snapshot = await session.start(body)
        return writeJson(res, 200, { session: snapshot })
      }
      if (action === 'stop' && method === 'POST') {
        return writeJson(res, 200, { session: await session.stop() })
      }
      if (action === 'pause' && method === 'POST') {
        return writeJson(res, 200, { session: session.pause() })
      }
      if (action === 'resume' && method === 'POST') {
        return writeJson(res, 200, { session: await session.resume() })
      }
      if (action === 'audio' && method === 'POST') {
        const raw = await readBody(req, 4 * 1024 * 1024)
        if (raw.length === 0) return writeJson(res, 200, { accepted: 0 })
        await session.pushFrame(raw)
        return writeJson(res, 200, { accepted: raw.length })
      }
      if (action === 'events' && method === 'GET') {
        const channel = new SseChannel(res)
        session.attach(channel)
        const keepAlive = setInterval(() => channel.send('ping', { at: nowMs() }), 15_000)
        req.on('close', () => {
          clearInterval(keepAlive)
          session.channels.delete(channel)
        })
        return undefined
      }
      if (action === 'glossary' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024)
        const next = await patchProject(projectId, {
          glossary: Array.isArray(body.glossary) ? body.glossary.slice(0, 200) : [],
        })
        return writeJson(res, 200, { project: next })
      }
      if (action === 'turns' && tail[4] === 'retranslate' && method === 'POST') {
        const seq = Number.parseInt(tail[3], 10)
        const rows = await listTurns(projectId)
        const row = rows.find((item) => item.seq === seq)
        if (row === undefined) return writeJson(res, 404, { error: '话轮不存在' })
        const lang = row.lang === 'en' ? 'en' : 'zh'
        const target = otherLang(lang)
        try {
          const revised = await translateText(ctx, {
            text: row.source,
            source: lang,
            target,
            mode: 'revise',
            context: await session.recentContext(seq),
            glossary: await session.glossary(),
            preferFast: true,
          })
          const revisions = [...(Array.isArray(row.revisions) ? row.revisions : []), revised]
          const next = await updateTurn(projectId, seq, {
            translation: revised === '' ? row.translation : revised,
            revisions,
          })
          return writeJson(res, 200, { turn: next })
        } catch (error) {
          return writeJson(res, 500, { error: errorText(error) })
        }
      }
      if (action === 'export' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024)
        const kind = String(body.kind ?? 'bilingual')
        try {
          const result = await runExport(kind, meta, await listTurns(projectId))
          return writeJson(res, 200, result)
        } catch (error) {
          return writeJson(res, 500, { error: errorText(error) })
        }
      }
      if (action === 'exports' && method === 'GET') {
        if (tail.length === 3) return writeJson(res, 200, { exports: await listExports(projectId) })
        const name = decodeURIComponent(tail[3] ?? '')
        try {
          const content = await readExport(projectId, name)
          const isSrt = name.endsWith('.srt')
          res.writeHead(200, {
            'content-type': isSrt ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
            'content-disposition': `attachment; filename="${path.basename(name)}"`,
          })
          res.end(content)
          return undefined
        } catch {
          return writeJson(res, 404, { error: '文件不存在' })
        }
      }
      if (action === 'state' && method === 'GET') {
        return writeJson(res, 200, { session: session.snapshot() })
      }
      return writeJson(res, 404, { error: 'not found' })
    }

    return writeJson(res, 404, { error: 'not found' })
  }

  async function metaSnapshot() {
    let translate = { ready: false, provider: '', model: '', message: '' }
    let providers = []
    try {
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('宿主没有 llm 服务')
      let provider = ''
      let model = ''
      try {
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
        provider = String(selection?.provider ?? '')
        model = String(selection?.model ?? '')
      } catch {
        // ignore
      }
      // The panel lets one meeting use a different model from the profile
      // default, so it needs the choices, not just the resolved pair.
      try {
        const listed = await llm.listProviders()
        for (const entry of Array.isArray(listed) ? listed : []) {
          const models = await llm.listModels(entry.id).catch(() => [])
          if (!Array.isArray(models) || models.length === 0) continue
          providers.push({
            id: String(entry.id),
            name: String(entry.name ?? entry.id),
            models: models.map((item) => ({ id: String(item.id), name: String(item.name ?? item.id) })),
          })
        }
      } catch {
        providers = []
      }
      if (provider === '' || model === '') {
        const providers = await llm.listProviders()
        for (const entry of Array.isArray(providers) ? providers : []) {
          const models = await llm.listModels(entry.id).catch(() => [])
          if (Array.isArray(models) && models.length > 0) {
            provider = entry.id
            model = models[0].id
            break
          }
        }
      }
      translate =
        provider === ''
          ? { ready: false, provider: '', model: '', message: 'DSH 里没有可用的对话模型' }
          : { ready: true, provider, model, message: '' }
    } catch (error) {
      translate = { ready: false, provider: '', model: '', message: errorText(error) }
    }
    return {
      version: PLUGIN_VERSION,
      dataRoot: dataRoot(),
      models: listModelCatalog('asr'),
      recognizers: listModelCatalog('asr'),
      refine: listModelCatalog('refine'),
      refineState: refineStatus('sense-voice-zh-en'),
      vad: listModelCatalog('vad'),
      voices: listModelCatalog('tts'),
      voice: voiceStatus('tts-zh-en'),
      translate,
      providers,
    }
  }

  async function downloadModel(id, kind = 'asr') {
    const { ensureModel } = await import('./models.js')
    try {
      await ensureModel(id, { kind })
    } catch {
      // the client polls /models and sees the missing files
    }
  }

  async function runExport(kind, meta, rows) {
    if (kind === 'minutes') {
      let content = ''
      try {
        content = await renderMinutes(meta, rows)
      } catch (error) {
        content = fallbackMinutes(meta, rows)
      }
      if (content.trim() === '') content = fallbackMinutes(meta, rows)
      const filename = filenameFor('minutes', meta)
      const written = await writeExport(meta.id, filename, content)
      return { kind, filename, bytes: written.bytes }
    }
    const renderer = RENDERERS[kind]
    if (renderer === undefined) throw new Error(`未知的导出类型：${kind}`)
    const content = renderer(meta, rows)
    const filename = filenameFor(kind, meta)
    const written = await writeExport(meta.id, filename, content)
    return { kind, filename, bytes: written.bytes, extension: EXTENSIONS[kind] ?? 'md' }
  }

  async function renderMinutes(meta, rows) {
    const finalRows = rows.filter((row) => row.final === true)
    if (finalRows.length === 0) return fallbackMinutes(meta, rows)
    const chunks = []
    const size = 40
    for (let index = 0; index < finalRows.length; index += size) {
      chunks.push(finalRows.slice(index, index + size))
    }
    const parts = []
    for (let index = 0; index < chunks.length; index += 1) {
      const label = chunks.length > 1 ? `（第 ${index + 1}/${chunks.length} 段）` : ''
      const prompt = minutesPrompt(meta, chunks[index], label)
      const text = await translateText(ctx, {
        text: prompt,
        source: 'zh',
        target: 'zh',
        mode: 'minutes',
        glossary: await sessionGlossary(meta),
      }).catch(() => '')
      if (text.trim() !== '') parts.push(text.trim())
    }
    if (parts.length === 0) return fallbackMinutes(meta, rows)
    if (parts.length === 1) return `# ${meta.title} — 会议纪要\n\n${stripTitle(parts[0])}\n`
    const merged = await translateText(ctx, {
      text: parts.join('\n\n---\n\n'),
      source: 'zh',
      target: 'zh',
      mode: 'minutes-merge',
    }).catch(() => '')
    const body = merged.trim() === '' ? parts.join('\n\n') : merged.trim()
    return `# ${meta.title} — 会议纪要\n\n${stripTitle(body)}\n`
  }

  async function sessionGlossary(meta) {
    return Array.isArray(meta?.glossary) ? meta.glossary : []
  }

  /* ------------------------------------------------------------ http layer */

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname
      if (!pathname.startsWith(`${API}/`) && pathname !== API) {
        return writeJson(res, 404, { error: 'not found' })
      }
      const segments = pathname.slice(API.length + 1).split('/').filter((part) => part !== '')
      await handleApi(req, res, segments)
    } catch (error) {
      if (!res.headersSent) writeJson(res, 500, { error: errorText(error) })
      else {
        try {
          res.end()
        } catch {
          // peer already gone
        }
      }
    }
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: API, handler }))

  const sweeper = setInterval(() => sweepEngines(), 60_000)
  if (typeof sweeper.unref === 'function') sweeper.unref()

  if (ctx.commands !== undefined) {
    disposers.push(
      ctx.commands.register({
        name: 'interpret',
        description: 'Open the live interpreter panel',
        input: { hint: '可选：会议标题', images: false },
        async handler(invocation) {
          const title = String(invocation?.rawInput ?? '').trim()
          const meta = await createProject({ title })
          return { kind: 'success', text: `已创建同传项目「${meta.title}」，在左侧「同声传译」打开即可开始。` }
        },
      }),
    )
  }

  const cleanup = () => {
    if (disposed) return
    disposed = true
    clearInterval(sweeper)
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // the fiber may already be tearing down
      }
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  return cleanup
}

function stripTitle(text) {
  return String(text ?? '')
    .replace(/^\s*#[^\n]*\n+/u, '')
    .replace(/^\s*##?\s*会议纪要\s*\n+/u, '')
    .trim()
}

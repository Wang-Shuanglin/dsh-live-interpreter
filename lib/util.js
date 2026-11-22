// Shared helpers for the live interpreter host half: ids, language detection,
// JSON file io with serialized writes, and an SSE channel.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/* --------------------------------------------------------------- data root */

export function dataRoot() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-live-interpreter')
}

export function projectsRoot() {
  return path.join(dataRoot(), 'projects')
}

export function modelsRoot() {
  return path.join(dataRoot(), 'models')
}

export function projectDir(id) {
  return path.join(projectsRoot(), id)
}

/* --------------------------------------------------------------------- ids */

export function newId(prefix) {
  const stamp = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  return `${prefix}-${stamp}${rand}`
}

export function nowMs() {
  return Date.now()
}

export function safeSegment(value, fallback = 'x') {
  const text = String(value ?? '').trim()
  if (text === '') return fallback
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? fallback : cleaned.slice(0, 80)
}

/* ------------------------------------------------------------------ json io */

/** Serialized write queue so two concurrent saves never interleave. */
const writeChains = new Map()

export async function writeJsonAtomic(file, value) {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const next = previous.then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, file)
  })
  writeChains.set(file, next.catch(() => {}))
  await next
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function appendJsonl(file, value) {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const next = previous.then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
  })
  writeChains.set(file, next.catch(() => {}))
  await next
}

export async function readJsonl(file) {
  let raw = ''
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      out.push(JSON.parse(text))
    } catch {
      // a torn last line from a crash: skip it rather than failing the read
    }
  }
  return out
}

export async function rewriteJsonl(file, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n')
  await writeJsonAtomicRaw(file, body === '' ? '' : `${body}\n`)
}

async function writeJsonAtomicRaw(file, body) {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const next = previous.then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, body, 'utf8')
    await fsp.rename(tmp, file)
  })
  writeChains.set(file, next.catch(() => {}))
  await next
}

export function existsSync(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- language */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/

export function cjkRatio(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  let cjk = 0
  let latinWords = 0
  let inWord = false
  for (const ch of value) {
    if (CJK.test(ch)) {
      cjk += 1
      inWord = false
      continue
    }
    if (/[A-Za-z']/.test(ch)) {
      if (!inWord) {
        latinWords += 1
        inWord = true
      }
      continue
    }
    inWord = false
  }
  const weight = cjk + latinWords * 2
  if (weight === 0) return 0
  return cjk / weight
}

/**
 * Decide the language of one utterance.
 *
 * Short fragments inherit the previous language, but only when they carry no
 * usable evidence of their own: a two-character Chinese fragment ("我这") used
 * to inherit "en" from the previous sentence and then be translated as if it
 * were English. Any CJK character at all in a short fragment is decisive.
 */
export function detectLang(text, previous) {
  const value = String(text ?? '').trim()
  const fallback = previous === 'en' ? 'en' : 'zh'
  if (value === '') return fallback
  if (value.length < 4) return CJK.test(value) ? 'zh' : fallback
  return cjkRatio(value) >= 0.25 ? 'zh' : 'en'
}

export function otherLang(lang) {
  return lang === 'zh' ? 'en' : 'zh'
}

export function langLabel(lang) {
  return lang === 'zh' ? '中' : 'EN'
}

/* --------------------------------------------------------------------- sse */

export class SseChannel {
  constructor(response) {
    this.response = response
    this.closed = false
    this.seq = 0
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
  }

  send(event, data) {
    if (this.closed) return
    this.seq += 1
    const payload = JSON.stringify(data ?? {})
    try {
      this.response.write(`id: ${this.seq}\nevent: ${event}\ndata: ${payload}\n\n`)
    } catch {
      this.closed = true
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.response.end()
    } catch {
      // the peer went away first
    }
  }
}

/* ------------------------------------------------------------------- misc */

export function clampText(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(0, limit)
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export function srtClock(ms) {
  const total = Math.max(0, Math.floor(ms))
  const h = String(Math.floor(total / 3600000)).padStart(2, '0')
  const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0')
  const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0')
  const t = String(total % 1000).padStart(3, '0')
  return `${h}:${m}:${s},${t}`
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

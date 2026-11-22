// Meeting projects on disk.
//
// Layout under <DSH_HOME>/dsh-live-interpreter/:
//   index.json                  — ordered project summaries for the sidebar
//   projects/<id>/meta.json     — title, times, counters, settings snapshot
//   projects/<id>/turns.jsonl   — one JSON object per finished segment
//   projects/<id>/exports/<f>   — generated export files
//
// turns.jsonl is the single source of truth: meta.json only caches aggregates
// that are cheap to recompute.

import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  appendJsonl,
  dataRoot,
  newId,
  nowMs,
  projectDir,
  projectsRoot,
  readJson,
  readJsonl,
  rewriteJsonl,
  writeJsonAtomic,
} from './util.js'

export function indexPath() {
  return path.join(dataRoot(), 'index.json')
}

export function metaPath(id) {
  return path.join(projectDir(id), 'meta.json')
}

export function turnsPath(id) {
  return path.join(projectDir(id), 'turns.jsonl')
}

export function exportsDir(id) {
  return path.join(projectDir(id), 'exports')
}

export async function listProjects() {
  const index = await readJson(indexPath(), { projects: [] })
  const rows = Array.isArray(index?.projects) ? index.projects : []
  return rows.map((row) => ({ ...row }))
}

async function writeIndex(rows) {
  await writeJsonAtomic(indexPath(), { version: 1, projects: rows })
}

export async function createProject(input = {}) {
  await fsp.mkdir(projectsRoot(), { recursive: true })
  const id = newId('mtg')
  const at = nowMs()
  const meta = {
    id,
    title: String(input.title ?? '').trim() || defaultTitle(at),
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    endedAt: null,
    status: 'idle',
    turns: 0,
    lang: 'zh',
    engine: String(input.engine ?? 'bilingual-paraformer'),
    translateModel: String(input.translateModel ?? ''),
    // Which DSH model translates this meeting. `null` follows the profile
    // default, so a new project needs no choice and a later change of the DSH
    // default still applies; an explicit pick sticks to this document.
    route: input.route === null || input.route === undefined ? null : input.route,
    repair: input.repair === undefined ? true : input.repair === true,
    // Which sound the meeting listened to: the room (mic), the call (system), or
    // both. Recorded because the same two-column transcript means something
    // different depending on it.
    source: ['mic', 'system', 'mix'].includes(input.source) ? input.source : 'mic',
    glossary: [],
  }
  await writeJsonAtomic(metaPath(id), meta)
  await rewriteJsonl(turnsPath(id), [])
  const index = await listProjects()
  index.unshift({
    id,
    title: meta.title,
    createdAt: at,
    updatedAt: at,
    status: 'idle',
    turns: 0,
  })
  await writeIndex(index)
  return meta
}

export function defaultTitle(at) {
  const date = new Date(at)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} 同传`
}

export async function getProject(id) {
  const meta = await readJson(metaPath(id), null)
  if (meta === null) return null
  return meta
}

export async function patchProject(id, patch) {
  const meta = await getProject(id)
  if (meta === null) return null
  const next = { ...meta, ...patch, id: meta.id, updatedAt: nowMs() }
  await writeJsonAtomic(metaPath(id), next)
  await syncIndexEntry(next)
  return next
}

async function syncIndexEntry(meta) {
  const rows = await listProjects()
  const at = rows.findIndex((row) => row.id === meta.id)
  const entry = {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: meta.status,
    turns: meta.turns ?? 0,
  }
  if (at === -1) rows.unshift(entry)
  else rows[at] = entry
  await writeIndex(rows)
}

export async function deleteProject(id) {
  const rows = await listProjects()
  const next = rows.filter((row) => row.id !== id)
  await writeIndex(next)
  await fsp.rm(projectDir(id), { recursive: true, force: true })
  return next.length !== rows.length
}

export async function listTurns(id) {
  return readJsonl(turnsPath(id))
}

export async function appendTurn(id, turn) {
  await appendJsonl(turnsPath(id), turn)
  return turn
}

export async function replaceTurns(id, rows) {
  await rewriteJsonl(turnsPath(id), rows)
}

export async function updateTurn(id, seq, patch) {
  const rows = await listTurns(id)
  const at = rows.findIndex((row) => row.seq === seq)
  if (at === -1) return null
  rows[at] = { ...rows[at], ...patch, seq }
  await rewriteJsonl(turnsPath(id), rows)
  return rows[at]
}

export async function recountTurns(id) {
  const rows = await listTurns(id)
  const meta = await getProject(id)
  if (meta === null) return 0
  const turns = rows.filter((row) => row.final === true).length
  if (meta.turns !== turns) await patchProject(id, { turns })
  return turns
}

/* ------------------------------------------------------------------ exports */

export async function writeExport(id, filename, content) {
  const dir = exportsDir(id)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, filename)
  await fsp.writeFile(file, content, 'utf8')
  return { file, filename, bytes: Buffer.byteLength(content, 'utf8') }
}

export async function listExports(id) {
  const dir = exportsDir(id)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    try {
      const stat = await fsp.stat(path.join(dir, name))
      out.push({ filename: name, bytes: stat.size, at: stat.mtimeMs })
    } catch {
      // vanished between readdir and stat
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

export async function readExport(id, filename) {
  const safe = path.basename(filename)
  const file = path.join(exportsDir(id), safe)
  return fsp.readFile(file, 'utf8')
}

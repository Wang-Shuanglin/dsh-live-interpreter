// Export renderers. Six kinds, all derived from turns.jsonl.
//
//   minutes   — meeting minutes: agenda / decisions / action items only
//   bilingual — source and written-style translation side by side
//   source    — transcript only
//   target    — translation only
//   srt       — timed bilingual subtitles
//   md        — markdown with front matter and a summary header

import { srtClock } from './util.js'

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

function stamp(at) {
  const date = new Date(at)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function finished(rows) {
  return rows.filter((row) => row.final === true && String(row.source ?? '').trim() !== '')
}

function header(meta) {
  const started = meta.startedAt === null ? meta.createdAt : meta.startedAt
  return [
    `# ${meta.title}`,
    '',
    `- 时间：${stamp(started)}`,
    `- 时长：${clock((meta.endedAt ?? meta.updatedAt) - started)}`,
    `- 话轮：${finished.length}（本次导出）`,
    '',
  ]
}

export function renderBilingual(meta, rows) {
  const list = finished(rows)
  const lines = header(meta)
  lines.push('| 时间 | 原文 | 译文（书面语） |')
  lines.push('| --- | --- | --- |')
  for (const row of list) {
    const src = oneLine(row.source)
    const dst = oneLine(row.translation)
    lines.push(`| ${clock(row.startMs)} | ${src} | ${dst} |`)
  }
  lines.push('')
  return lines.join('\n')
}

export function renderSource(meta, rows) {
  const list = finished(rows)
  const lines = header(meta)
  for (const row of list) {
    lines.push(`**[${clock(row.startMs)}] ${langTag(row.lang)}** ${oneLine(row.source)}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function renderTarget(meta, rows) {
  const list = finished(rows)
  const lines = header(meta)
  for (const row of list) {
    lines.push(`**[${clock(row.startMs)}] ${langTag(row.lang)}** ${oneLine(row.translation)}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function renderSrt(meta, rows) {
  const list = finished(rows)
  const out = []
  let index = 0
  for (const row of list) {
    index += 1
    const start = row.startMs
    const end = row.endMs > start ? row.endMs : start + 1200
    const src = oneLine(row.source)
    const dst = oneLine(row.translation)
    out.push(String(index))
    out.push(`${srtClock(start)} --> ${srtClock(end)}`)
    out.push(src)
    if (dst !== '') out.push(dst)
    out.push('')
  }
  return out.join('\n')
}

export function renderMarkdown(meta, rows) {
  const list = finished(rows)
  const lines = header(meta)
  lines.push('## 双语记录')
  lines.push('')
  for (const row of list) {
    lines.push(`### [${clock(row.startMs)}] ${langTag(row.lang)}`)
    lines.push('')
    lines.push(`- 原文：${oneLine(row.source)}`)
    lines.push(`- 译文：${oneLine(row.translation)}`)
    if (Array.isArray(row.revisions) && row.revisions.length > 1) {
      lines.push(`- 修订：${row.revisions.length} 次`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Meeting minutes: strictly three sections. The structure is produced by the
 * model, this function only owns the prompt and a deterministic fallback so an
 * offline/disabled model still yields a usable document.
 */
export const MINUTES_SYSTEM = `You write meeting minutes from a bilingual transcript. Output Markdown with exactly three second-level sections, in this order and with these exact Chinese headings:

## 议题
## 决议
## 待办

Rules:
- 议题: bullet list of the topics that were actually discussed, one line each, no speculation.
- 决议: bullet list of decisions reached. If a topic had no decision, do not invent one; leave the section short.
- 待办: bullet list formatted as "- 事项 — 责任人 — 时间". When the transcript names no owner write 未指派; when it names no date write 未指定.
- Do not add a summary, a preamble, risk analysis, speaker attribution or any extra section.
- Be terse. Use written Chinese regardless of the source language.`

export function minutesPrompt(meta, rows, chunkLabel = '') {
  const list = finished(rows)
  const body = list
    .map((row) => `[${clock(row.startMs)}] ${row.source}\n => ${row.translation}`)
    .join('\n\n')
  return `会议标题：${meta.title}${chunkLabel}\n\n转写与译文：\n${body}\n\n请按要求输出会议纪要。`
}

export function fallbackMinutes(meta, rows) {
  const list = finished(rows)
  const topics = []
  for (const row of list) {
    const text = oneLine(row.source)
    if (text.length >= 6) topics.push(`- ${text.slice(0, 60)}`)
    if (topics.length >= 12) break
  }
  return [
    `# ${meta.title} — 会议纪要`,
    '',
    '## 议题',
    ...(topics.length > 0 ? topics : ['- （未记录到有效议题）']),
    '',
    '## 决议',
    '- （模型未启用，无法提炼决议，请查阅双语对照）',
    '',
    '## 待办',
    '- （模型未启用，无法提炼待办，请查阅双语对照）',
    '',
  ].join('\n')
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .replace(/\|/gu, '\\|')
    .trim()
}

function langTag(lang) {
  return lang === 'en' ? 'EN' : '中'
}

export const RENDERERS = {
  bilingual: renderBilingual,
  source: renderSource,
  target: renderTarget,
  srt: renderSrt,
  md: renderMarkdown,
}

export const EXTENSIONS = {
  minutes: 'md',
  bilingual: 'md',
  source: 'md',
  target: 'md',
  srt: 'srt',
  md: 'md',
}

export function filenameFor(kind, meta) {
  const date = new Date(meta.createdAt)
  const stampText = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
  const names = {
    minutes: 'minutes',
    bilingual: 'bilingual',
    source: 'source',
    target: 'target',
    srt: 'subtitles',
    md: 'meeting',
  }
  return `${stampText}-${names[kind] ?? kind}.${EXTENSIONS[kind] ?? 'md'}`
}

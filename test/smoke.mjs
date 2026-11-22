// Smoke test for the pieces that do not need the microphone or a model.
// Run with: node --test  (or plain node) after setting DSH_HOME.
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  RENDERERS,
  fallbackMinutes,
  filenameFor,
  minutesPrompt,
  renderSrt,
} from '../lib/exporters.js'
import { modelState, listModels } from '../lib/models.js'
import {
  appendTurn,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  listTurns,
  patchProject,
  readExport,
  writeExport,
  listExports,
  updateTurn,
} from '../lib/store.js'
import { agreedPrefix, cleanTranslation, foldCommitted } from '../lib/translate.js'
import { cjkRatio, detectLang, formatClock, srtClock, dataRoot, otherLang } from '../lib/util.js'

console.log('dataRoot =', dataRoot())

/* language detection ------------------------------------------------------ */
assert.equal(detectLang('我们今天讨论产品评审的流程'), 'zh')
assert.equal(detectLang('We reviewed the product roadmap today'), 'en')
assert.equal(detectLang('OK', 'zh'), 'zh', 'short fragment inherits previous')
assert.equal(detectLang('OK', 'en'), 'en', 'short fragment inherits previous')
assert.ok(cjkRatio('中英混合 mixed 文本') > 0.2)
assert.equal(otherLang('zh'), 'en')
console.log('OK language detection')

/* agreed prefix ---------------------------------------------------------- */
assert.equal(agreedPrefix('我们今天', '我们今天讨论', 'zh'), '我们今天')
assert.equal(agreedPrefix('', 'abc', 'zh'), '')
assert.equal(agreedPrefix('we re', 'we reviewed the plan', 'en'), 'we ')
assert.equal(foldCommitted('我们今天', '我们今天', '我们今天讨论'), '我们今天')
assert.equal(foldCommitted('我们今天讨论', '我们今天', '我们今天讨论'), '我们今天讨论', 'keeps a longer committed prefix')
console.log('OK agreedPrefix')

/* cleaning --------------------------------------------------------------- */
assert.equal(cleanTranslation('```\n你好\n```'), '你好')
assert.equal(cleanTranslation('译文：你好'), '你好')
assert.equal(cleanTranslation('"hello"'), 'hello')
console.log('OK cleanTranslation')

/* clocks ----------------------------------------------------------------- */
assert.equal(formatClock(3_723_000), '01:02:03')
assert.equal(srtClock(3_723_456), '01:02:03,456')
console.log('OK clocks')

/* models ----------------------------------------------------------------- */
const models = listModels()
assert.ok(models.length >= 1)
console.log(
  'models =',
  models.map((item) => `${item.id}:${item.ready ? 'ready' : item.missing.length + ' missing'}`).join(', '),
)
assert.ok(modelState('bilingual-fast').totalBytes > 0)
console.log('OK models catalog')

/* projects --------------------------------------------------------------- */
const created = await createProject({})
assert.ok(created.id.startsWith('mtg-'))
assert.equal(created.turns, 0)

const now = Date.now()
await appendTurn(created.id, {
  seq: 1,
  startMs: 0,
  endMs: 4200,
  lang: 'zh',
  speaker: null,
  source: '我们先看一下这一季度的收入情况。',
  translation: 'Let us begin with this quarter’s revenue.',
  revisions: ['Let us look at this quarter revenue.'],
  engine: 'bilingual-fast',
  final: true,
})
await appendTurn(created.id, {
  seq: 2,
  startMs: 4200,
  endMs: 9100,
  lang: 'en',
  speaker: null,
  source: 'Margins improved by two points, mainly from the cloud business.',
  translation: '毛利率提升了两个百分点，主要来自云业务。',
  revisions: [],
  engine: 'bilingual-fast',
  final: true,
})
await patchProject(created.id, { turns: 2, endedAt: now, status: 'done' })

const rows = await listTurns(created.id)
assert.equal(rows.length, 2)
assert.equal(rows[1].lang, 'en')

const updated = await updateTurn(created.id, 2, { translation: '毛利率提升了两个百分点，主要得益于云业务。' })
assert.match(updated.translation, /云业务/u)

const listed = await listProjects()
assert.equal(listed[0].id, created.id)
assert.equal((await getProject(created.id)).turns, 2)
console.log('OK project store')

/* exporters -------------------------------------------------------------- */
const meta = await getProject(created.id)
const bilingual = RENDERERS.bilingual(meta, rows)
assert.match(bilingual, /原文/u)
assert.match(bilingual, /我们先看一下这一季度的收入情况/u)
const srt = renderSrt(meta, rows)
assert.match(srt, /00:00:00,000 --> 00:00:04,200/u)
assert.match(srt, /00:00:04,200 --> 00:00:09,100/u)
const sourceOnly = RENDERERS.source(meta, rows)
assert.ok(!sourceOnly.includes('Let us begin'), 'source-only export must not include the translation')
const targetOnly = RENDERERS.target(meta, rows)
assert.ok(!targetOnly.includes('Margins improved'), 'target-only export must not include the source')

const minutesFallback = fallbackMinutes(meta, rows)
assert.match(minutesFallback, /## 议题/u)
assert.match(minutesFallback, /## 决议/u)
assert.match(minutesFallback, /## 待办/u)
assert.equal(minutesFallback.match(/^## /gmu).length, 3, 'minutes must have exactly three sections')

const prompt = minutesPrompt(meta, rows)
assert.match(prompt, /我们先看一下这一季度的收入情况/u)
assert.match(prompt, /Margins improved/u)

assert.match(filenameFor('minutes', meta), /-minutes\.md$/u)
assert.match(filenameFor('srt', meta), /-subtitles\.srt$/u)
console.log('OK exporters')

/* export files ----------------------------------------------------------- */
const file = filenameFor('bilingual', meta)
const written = await writeExport(created.id, file, bilingual)
assert.ok(written.bytes > 0)
const exportsList = await listExports(created.id)
assert.equal(exportsList.length, 1)
const roundTrip = await readExport(created.id, file)
assert.equal(roundTrip, bilingual)
console.log('OK export files')

/* cleanup ---------------------------------------------------------------- */
await deleteProject(created.id)
assert.equal((await listProjects()).length, 0)
assert.equal(await getProject(created.id), null)
console.log('OK delete project')

console.log('\nSMOKE PASS')

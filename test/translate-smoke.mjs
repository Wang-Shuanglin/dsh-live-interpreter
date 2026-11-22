// Verify the DSH translation channel end to end: write a turn straight into the
// real data root, then ask the host to retranslate it through the running server.
//
// This is the check that proves "translation uses the DSH model channel", with no
// third-party API key and no plugin-specific credential.
//
// `dsh web` picks a fresh port on restart, so the origin is overridable:
//   DSH_ORIGIN=http://127.0.0.1:50108 node test/translate-smoke.mjs
const origin = (process.env.DSH_ORIGIN ?? 'http://127.0.0.1:55759').replace(/\/+$/, '')
const base = origin + '/dsh-live-interpreter/api'

async function call(path, init) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(60000), ...init })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 300)
  }
  return { status: response.status, body }
}

const { createProject, appendTurn, deleteProject, listTurns } = await import('../lib/store.js')

const meta = await createProject({ title: '翻译通道冒烟测试' })
console.log('project', meta.id)

await appendTurn(meta.id, {
  seq: 1,
  startMs: 0,
  endMs: 3000,
  lang: 'zh',
  speaker: null,
  source: '我们先看一下这个季度的收入情况，主要增长来自云业务。',
  translation: '',
  revisions: [],
  engine: 'bilingual-fast',
  final: true,
})
await appendTurn(meta.id, {
  seq: 2,
  startMs: 3000,
  endMs: 7000,
  lang: 'en',
  speaker: null,
  source: 'Margins improved by two points, mainly from the cloud business.',
  translation: '',
  revisions: [],
  engine: 'bilingual-fast',
  final: true,
})

let r = await call(`/projects/${meta.id}/turns/1/retranslate`, { method: 'POST' })
console.log('zh->en', r.status, JSON.stringify(r.body?.turn?.translation ?? r.body))
if (r.status !== 200) throw new Error('retranslate zh failed')
const zhToEn = r.body.turn.translation

r = await call(`/projects/${meta.id}/turns/2/retranslate`, { method: 'POST' })
console.log('en->zh', r.status, JSON.stringify(r.body?.turn?.translation ?? r.body))
if (r.status !== 200) throw new Error('retranslate en failed')
const enToZh = r.body.turn.translation

if (!/[A-Za-z]/.test(zhToEn)) throw new Error(`zh->en did not produce English: ${zhToEn}`)
if (!/[\u4e00-\u9fff]/.test(enToZh)) throw new Error(`en->zh did not produce Chinese: ${enToZh}`)

const rows = await listTurns(meta.id)
console.log('revisions recorded =', rows.map((row) => row.revisions.length).join(','))

await deleteProject(meta.id)
console.log('\nTRANSLATE PASS')

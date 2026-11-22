// End-to-end HTTP check against the running DSH Web server.
// Exercises the project lifecycle, exports, and the session endpoints.
// `dsh web` picks a fresh port on restart, so the origin is overridable:
//   DSH_ORIGIN=http://127.0.0.1:50108 node test/http-smoke.mjs
const origin = (process.env.DSH_ORIGIN ?? 'http://127.0.0.1:55759').replace(/\/+$/, '')
const base = origin + '/dsh-live-interpreter/api'

async function call(path, init) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000), ...init })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 300)
  }
  return { status: response.status, body }
}

const clean = []

let r = await call('/state')
console.log('state', r.status, Object.keys(r.body ?? {}).join(','))
if (r.status !== 200) throw new Error('state failed')

r = await call('/projects')
console.log('projects list', r.status, Array.isArray(r.body?.projects) ? r.body.projects.length : r.body)
if (r.status !== 200) throw new Error('projects failed')

r = await call('/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '接口冒烟测试' }),
})
console.log('create', r.status, r.body?.project?.id, r.body?.project?.title)
if (r.status !== 201) throw new Error('create failed')
const id = r.body.project.id
clean.push(id)

r = await call(`/projects/${id}`)
console.log('detail', r.status, 'turns=', r.body?.turns?.length, 'session=', r.body?.session?.status)

r = await call(`/projects/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '接口冒烟测试（改名）', glossary: [['roadmap', '路线图']] }),
})
console.log('patch', r.status, r.body?.project?.title, JSON.stringify(r.body?.project?.glossary))

r = await call(`/projects/${id}/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ engine: 'bilingual-fast' }),
})
console.log('start', r.status, JSON.stringify(r.body?.session ?? r.body).slice(0, 300))

r = await call(`/projects/${id}/pause`, { method: 'POST' })
console.log('pause', r.status, r.body?.session?.status)

r = await call(`/projects/${id}/resume`, { method: 'POST' })
console.log('resume', r.status, r.body?.session?.status)

r = await call(`/projects/${id}/audio`, { method: 'POST', body: new Uint8Array(0) })
console.log('audio(empty)', r.status, JSON.stringify(r.body))

r = await call(`/projects/${id}/stop`, { method: 'POST' })
console.log('stop', r.status, r.body?.session?.status)

r = await call(`/projects/${id}/exports`)
console.log('exports list', r.status, JSON.stringify(r.body?.exports))

r = await call(`/projects/${id}/export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'bilingual' }),
})
console.log('export bilingual', r.status, JSON.stringify(r.body).slice(0, 200))

r = await call(`/projects/${id}/export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'minutes' }),
})
console.log('export minutes', r.status, JSON.stringify(r.body).slice(0, 300))

r = await call(`/models`)
console.log('models', r.status, r.body?.models?.map((m) => `${m.id}:${m.ready}`).join(','))
console.log('voices', r.body?.tts?.map((m) => `${m.id}:${m.ready}`).join(','))

r = await call(`/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '接口冒烟测试', voice: 'tts-zh-en' }),
})
console.log('say', r.status, JSON.stringify(r.body).slice(0, 160))

for (const projectId of clean) {
  const del = await call(`/projects/${projectId}`, { method: 'DELETE' })
  console.log('delete', projectId, del.status)
}

console.log('\nHTTP PASS')

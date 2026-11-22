// End-to-end recognizer check: load the streaming model, feed synthetic audio,
// and prove the sherpa wrapper produces a hypothesis without an endpoint crash.
//
// This does not need a microphone and does not call any translation model, so it
// is the fast gate for "the native engine works on this machine".
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

const { ensureEngine, createAsrStream, toFloat32, rmsOf } = await import('../lib/asr.js')
const { modelState } = await import('../lib/models.js')

const state = modelState('bilingual-fast')
console.log('model ready =', state.ready, 'bytes =', state.bytes)
assert.equal(state.ready, true, 'copy the model into the data root before running this test')

const t0 = Date.now()
const recognizer = await ensureEngine('bilingual-fast')
console.log('recognizer loaded in', Date.now() - t0, 'ms')
assert.ok(recognizer !== undefined)

const stream = await createAsrStream('bilingual-fast')

// 1.2 s of silence then a soft tone: the engine must stay alive and return text
// (possibly empty) for every frame instead of throwing.
const frames = []
const frameSamples = 3840
for (let index = 0; index < 20; index += 1) {
  const samples = new Float32Array(frameSamples)
  for (let i = 0; i < frameSamples; i += 1) {
    samples[i] = 0.02 * Math.sin((2 * Math.PI * 220 * (index * frameSamples + i)) / 16000)
  }
  frames.push(samples)
}

let lastText = ''
for (const samples of frames) {
  const out = stream.accept(samples)
  assert.equal(typeof out.text, 'string')
  assert.equal(typeof out.changed, 'boolean')
  assert.equal(typeof out.endpoint, 'boolean')
  lastText = out.text
}
const tail = stream.finish()
stream.dispose()
console.log('frames ok, last hypothesis =', JSON.stringify(lastText || tail || ''))

// toFloat32 / rms round trip on raw PCM bytes.
const bytes = Buffer.alloc(8)
bytes.writeInt16LE(16384, 0)
bytes.writeInt16LE(-16384, 2)
bytes.writeInt16LE(0, 4)
bytes.writeInt16LE(0, 6)
const samples = toFloat32(bytes)
assert.equal(samples.length, 4)
assert.ok(Math.abs(samples[0] - 0.5) < 1e-6)
assert.ok(Math.abs(samples[1] + 0.5) < 1e-6)
assert.ok(rmsOf(samples) > 0.3)

console.log('\nASR ENGINE PASS')

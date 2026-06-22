import test from 'brittle'
import { MockMic } from '../lib/mic.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('MockMic replays chunks then stops', async function (t) {
  const got = []
  const mic = new MockMic({ chunks: [Buffer.from([1, 2]), Buffer.from([3, 4])], intervalMs: 1 })
  mic.start((c) => got.push(c))
  await sleep(30)
  t.is(got.length, 2)
  t.is(got[0][0], 1)
  t.is(got[1][1], 4)
})

test('MockMic.stop halts emission', async function (t) {
  const got = []
  const mic = new MockMic({ chunks: [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])], intervalMs: 5 })
  mic.start((c) => got.push(c))
  mic.stop()
  await sleep(20)
  t.is(got.length, 0, 'nothing emitted after immediate stop')
})

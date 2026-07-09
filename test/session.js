import test from 'brittle'
import fs from 'bare-fs'
import { RecorderSession } from '../lib/session.js'
import { MockMic } from '../lib/mic.js'
import { MockTranscriber } from '../lib/transcriber.js'
import { MockSummarizer } from '../lib/summarizer.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A fake meeting that records what the session writes.
function fakeMeeting (overrides = {}) {
  return {
    isHost: true,
    writable: true, // host starts writable; a guest flips this once admitted
    localWriterKey: 'ab'.repeat(32),
    id: 'abcd1234' + 'x'.repeat(44),
    metaObj: {},
    appended: [],
    audios: [],
    admitted: [],
    async open () {},
    async setMeta (p) { this.metaObj = { ...this.metaObj, ...p } },
    async meta () { return this.metaObj },
    async transcript () { return this.appended.slice() },
    async addTranscript (s) { this.appended.push(s) },
    async addAudio (c) { this.audios.push(c) },
    admit (k) { this.admitted.push(k); return Promise.resolve() },
    async update () {},
    closed: false,
    async close () { this.closed = true },
    ...overrides
  }
}

test('RecorderSession: mic -> transcriber -> meeting, then stores audio on stop', async function (t) {
  const meeting = fakeMeeting()
  const mic = new MockMic({ chunks: [Buffer.alloc(64), Buffer.alloc(64)], intervalMs: 1 })
  const transcriber = new MockTranscriber({
    segments: [
      { text: 'hello', startMs: 0, endMs: 1000, id: 0, append: false },
      { text: 'there', startMs: 1000, endMs: 2000, id: 1, append: false }
    ]
  })
  const session = new RecorderSession({ mic, transcriber, meeting, track: 'track-me', rate: 16000 })

  await session.start()
  await sleep(30) // let mic chunks + segment consumption settle

  t.is(meeting.appended.length, 2, 'both segments appended to the meeting')
  t.is(meeting.appended[0].track, 'track-me')
  t.is(meeting.appended[0].text, 'hello')
  t.ok(transcriber.written.length >= 2, 'mic chunks were written to the transcriber')

  const snap = await session.snapshot()
  t.is(snap.recording, true)
  t.is(snap.track, 'track-me')
  t.is(snap.segments.length, 2)

  await session.finishRecording()
  t.is(session.recording, false)
  t.is(meeting.audios.length, 1, 'audio pushed on finish')
  t.ok(meeting.audios[0].data.length > 44, 'WAV header + PCM data')
  t.ok(Number.isFinite(meeting.metaObj.duration), 'host set duration on finish')
  t.is(meeting.closed, false, 'meeting stays open (still seeding) after finishRecording')

  await session.teardown()
  t.is(meeting.closed, true, 'teardown closes the meeting')
})

test('guest: capture is deferred until the host admits it (writable flips)', async function (t) {
  const meeting = fakeMeeting({ isHost: false, writable: false, localWriterKey: 'cd'.repeat(32) })
  const mic = new MockMic({ chunks: [Buffer.alloc(64)], intervalMs: 1 })
  const transcriber = new MockTranscriber({ segments: [{ text: 'hi', startMs: 0, endMs: 500, id: 0 }] })
  const session = new RecorderSession({ mic, transcriber, meeting, track: 'track-bob', rate: 16000 })

  await session.start()
  let snap = await session.snapshot()
  t.is(snap.capturing, false, 'not capturing while waiting to be admitted')
  t.is(snap.writerKey, 'cd'.repeat(32), 'exposes our writer key for the host')
  t.is(meeting.appended.length, 0, 'nothing recorded yet')

  // Host admits us -> writable flips; the next snapshot starts capture.
  meeting.writable = true
  snap = await session.snapshot()
  await sleep(30)
  t.is(snap.capturing, true, 'capture began once admitted')
  t.ok(meeting.appended.length >= 1, 'segments flow after admission')

  await session.finishRecording()
  await session.teardown()
})

test('anchored transcriber: segments land at their audio position, not arrival time', async function (t) {
  const meeting = fakeMeeting()
  const mic = new MockMic({ chunks: [Buffer.alloc(64)], intervalMs: 1 })
  // Speech at 3.0-5.0s into the recording; with anchored timestamps the
  // session must preserve that position (segment yield happens ~immediately,
  // so the old arrival-clock path would have placed it near 0 instead).
  const transcriber = new MockTranscriber({
    segments: [{ text: 'late arrival', startMs: 3000, endMs: 5000, id: 0, append: false }]
  })
  transcriber.anchoredTimestamps = true
  const session = new RecorderSession({ mic, transcriber, meeting, track: 'track-me', rate: 16000 })

  await session.start()
  await sleep(30)

  t.is(meeting.appended.length, 1)
  const seg = meeting.appended[0]
  t.ok(seg.start >= 3000 && seg.start < 3100, `start ${seg.start} anchored to the audio position`)
  t.is(seg.end - seg.start, 2000, 'duration preserved')

  await session.finishRecording()
  await session.teardown()
})

test('suggestImprovements: full transcript + agenda to the LLM, mapped back to segments', async function (t) {
  const meeting = fakeMeeting()
  meeting.appended = [
    { track: 'track-me', start: 0, end: 1000, id: 0, text: 'hello everyone' },
    { track: 'track-bob', start: 1000, end: 2000, id: 1, text: 'we shud ship hyper korr' }
  ]
  const summarizer = new MockSummarizer({ suggestions: [{ i: 1, text: 'we should ship hypercore' }] })
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting,
    track: 'track-me',
    summarizer,
    agenda: 'ship hypercore this week'
  })

  const out = await session.suggestImprovements([1, 99]) // 99: out of range, dropped
  t.alike(out, [{
    index: 1,
    segment: meeting.appended[1],
    suggestion: 'we should ship hypercore'
  }])

  const call = summarizer.calls[0]
  t.is(call.method, 'suggest')
  t.is(call.segments.length, 2, 'LLM sees the FULL transcript, not just the selection')
  t.alike(call.selectedIndices, [1])
  t.is(call.agenda, 'ship hypercore this week', 'agenda passed for context')
  t.is(session.llmStatus, null, 'status cleared after the run')

  const snap = await session.snapshot()
  t.is(snap.llm, true, 'snapshot advertises the LLM')
})

test('applyTranscriptFix: re-adds the segment with the same track/start and new text', async function (t) {
  const meeting = fakeMeeting()
  const seg = { track: 'track-bob', start: 1000, end: 2000, id: 1, append: false, text: 'we shud ship hyper korr' }
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting,
    track: 'track-me'
  })

  await session.applyTranscriptFix(seg, 'we should ship hypercore')
  t.alike(meeting.appended, [{
    track: 'track-bob',
    start: 1000,
    end: 2000,
    id: 1,
    append: false,
    text: 'we should ship hypercore'
  }], 'same key fields, corrected text (autobee overwrites on track+start)')
})

test('generateSummary: writes the summary to a tmp file', async function (t) {
  const meeting = fakeMeeting()
  meeting.appended = [{ track: 'track-me', start: 0, end: 1000, id: 0, text: 'hello' }]
  meeting.metaObj = { title: 'standup', startedAt: 1234567890 }
  const summarizer = new MockSummarizer({ summary: '## Key points\n- hello was said' })
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting,
    track: 'track-me',
    summarizer,
    agenda: 'say hello',
    summaryPrompt: 'custom prompt'
  })

  const { path: file, text } = await session.generateSummary()
  t.is(text, '## Key points\n- hello was said')
  t.ok(file.includes('hmr-summary-'), 'tmp file name is recognizable')
  t.is(fs.readFileSync(file, 'utf8'), text + '\n', 'summary written to disk')
  fs.unlinkSync(file)

  const call = summarizer.calls[0]
  t.is(call.method, 'summarize')
  t.is(call.agenda, 'say hello')
  t.is(call.promptOverride, 'custom prompt', '--prompt replaces the built-in prompt')
  t.is(call.meta.title, 'standup')
})

test('generateSummary: refuses an empty transcript; no summarizer means a clear error', async function (t) {
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting: fakeMeeting(),
    track: 'track-me',
    summarizer: new MockSummarizer()
  })
  await t.exception(() => session.generateSummary(), /no transcript/)

  const bare = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting: fakeMeeting(),
    track: 'track-me'
  })
  await t.exception(() => bare.generateSummary(), /no LLM/)
  const snap = await bare.snapshot()
  t.is(snap.llm, false, 'snapshot says no LLM without a summarizer')
})

test('teardown unloads the summarizer', async function (t) {
  const summarizer = new MockSummarizer()
  await summarizer.ensureLoaded()
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting: fakeMeeting(),
    track: 'track-me',
    summarizer
  })
  await session.start()
  await session.teardown()
  t.is(summarizer.loaded, false, 'summarizer unloaded on teardown')
})

test('host: admit() forwards the pasted writer key to the meeting', async function (t) {
  const meeting = fakeMeeting()
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting,
    track: 'track-me'
  })
  await session.start()
  await session.admit('ef'.repeat(32))
  t.alike(meeting.admitted, ['ef'.repeat(32)], 'writer key handed to the meeting')
  await session.teardown()
})

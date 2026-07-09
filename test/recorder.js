import test from 'brittle'
import tui from 'bare-tui'
import Recorder from '../lib/recorder.js'

const { style, KeyMsg } = tui

const SNAP = {
  isHost: true,
  capturing: true,
  writable: true,
  writerKey: 'aa'.repeat(32),
  recording: true,
  elapsed: 5000,
  level: 0.3,
  track: 'track-me',
  key: 'meetingkey123',
  appended: 1,
  meta: { title: 'standup' },
  segments: [
    { track: 'track-me', start: 0, end: 1000, text: 'hello everyone' },
    { track: 'track-bob', start: 1000, end: 2000, text: 'hi there' }
  ],
  tracks: ['track-bob', 'track-me']
}

function fakeSession () {
  return {
    finished: false,
    toredown: false,
    admitted: [],
    suggestions: [],
    suggestedWith: null,
    applied: [],
    async snapshot () { return SNAP },
    async admit (k) { this.admitted.push(k) },
    async finishRecording () { this.finished = true },
    async teardown () { this.toredown = true },
    async suggestImprovements (indices) { this.suggestedWith = indices; return this.suggestions },
    async applyTranscriptFix (segment, text) { this.applied.push({ segment, text }) },
    async generateSummary () { return { path: '/tmp/hmr-summary-x.md', text: 'Key points: none' } }
  }
}

// A recorder already on the seeding screen with the LLM features available.
function seeding (session, snap = { ...SNAP, recording: false, llm: true }) {
  const r = booted(session, snap)
  r.phase = 'seeding'
  return r
}

function booted (session, snap = SNAP) {
  const r = new Recorder({ session, track: 'track-me' })
  r.update({ type: 'resize', width: 80, height: 20 })
  r.update({ type: 'snap', data: snap })
  return r
}

test('recording view shows REC, transcript, and the "Exit meeting" menu', function (t) {
  const out = style.stripAnsi(booted(fakeSession()).view())
  t.ok(out.includes('REC'))
  t.ok(out.includes('hello everyone') && out.includes('hi there'))
  t.ok(out.includes('Exit meeting'), 'recording menu item')
  t.ok(out.includes('meetingkey123'), 'meeting key is visible to copy/paste')
})

test('Exit meeting finishes recording, then shows the seeding screen with the key', async function (t) {
  const session = fakeSession()
  const r = booted(session)

  const [, cmd] = r.update(new KeyMsg({ name: 'return' })) // enter activates the menu
  t.is(r.busy, true)
  const msg = await cmd()
  t.alike(msg, { type: 'finished' })
  t.is(session.finished, true, 'recording stopped')
  t.is(session.toredown, false, 'still seeding (not torn down)')

  r.update(msg)
  t.is(r.phase, 'seeding')
  t.is(r.busy, false)

  const out = style.stripAnsi(r.view())
  t.ok(out.includes('seeding'), 'seeding screen')
  t.ok(out.includes('meetingkey123'), 'shows the meeting key')
  t.ok(out.includes('bin/cli.js meetingkey123'), 'shows the player command (positional key)')
  t.ok(out.includes('Exit'), 'exit menu item')
})

test('host recording view offers "add writer"', function (t) {
  const out = style.stripAnsi(booted(fakeSession()).view())
  t.ok(out.includes('add writer'), 'host sees the add-writer hint')
})

test('host: "a" opens a paste prompt; typing + enter admits the writer key', async function (t) {
  const session = fakeSession()
  const r = booted(session)

  r.update(new KeyMsg({ name: 'a' }))
  t.is(r.adding, true, 'add-writer prompt open')
  t.ok(style.stripAnsi(r.view()).includes('paste writer key'), 'prompt is shown')

  for (const ch of 'beef') r.update(new KeyMsg({ name: ch }))
  t.is(r.buffer, 'beef', 'keys accumulate into the buffer')

  const [, cmd] = r.update(new KeyMsg({ name: 'return' }))
  t.is(r.adding, false, 'prompt closes on enter')
  const msg = await cmd()
  t.alike(msg, { type: 'admitted', ok: true, key: 'beef' })
  t.alike(session.admitted, ['beef'], 'session.admit called with the typed key')
})

test('host: esc cancels the add-writer prompt without admitting', function (t) {
  const session = fakeSession()
  const r = booted(session)
  r.update(new KeyMsg({ name: 'a' }))
  r.update(new KeyMsg({ name: 'b' }))
  r.update(new KeyMsg({ name: 'escape' }))
  t.is(r.adding, false, 'prompt closed')
  t.is(r.buffer, '', 'buffer cleared')
  t.is(session.admitted.length, 0, 'nothing admitted')
})

test('guest waiting view shows our writer key and does not record yet', function (t) {
  const guestSnap = { ...SNAP, isHost: false, capturing: false, writable: false, writerKey: 'dd'.repeat(32) }
  const r = booted(fakeSession(), guestSnap)
  const out = style.stripAnsi(r.view())
  t.ok(out.includes('Waiting to be admitted'), 'waiting screen')
  t.ok(out.includes('dd'.repeat(32)), 'shows our writer key to give the host')
  t.absent(out.includes('REC'), 'not recording while waiting')
})

test('Exit on the seeding screen tears down and quits', async function (t) {
  const session = fakeSession()
  const r = booted(session)
  r.phase = 'seeding'

  const [, cmd] = r.update(new KeyMsg({ name: 'q' }))
  const msg = await cmd()
  t.alike(msg, { type: 'quit' })
  t.is(session.toredown, true, 'swarm/meeting torn down')
})

test('seeding menu: LLM items only when the session has one; ↑/↓ + enter navigate', async function (t) {
  const plain = style.stripAnsi(seeding(fakeSession(), { ...SNAP, recording: false }).view())
  t.absent(plain.includes('Improve transcriptions'), 'no LLM -> no AI items')
  t.ok(plain.includes('Exit'))

  const session = fakeSession()
  const r = seeding(session)
  const out = style.stripAnsi(r.view())
  t.ok(out.includes('Improve transcriptions'))
  t.ok(out.includes('Generate summary'))
  t.ok(out.includes('Exit'))

  r.update(new KeyMsg({ name: 'down' }))
  r.update(new KeyMsg({ name: 'down' }))
  t.is(r.menuIndex, 2, 'cursor on Exit')
  const [, cmd] = r.update(new KeyMsg({ name: 'return' }))
  t.alike(await cmd(), { type: 'quit' })
  t.is(session.toredown, true)
})

test('improve flow: select lines -> suggestions -> accept updates the transcript', async function (t) {
  const session = fakeSession()
  session.suggestions = [
    { index: 0, segment: SNAP.segments[0], suggestion: 'hello, everyone!' }
  ]
  const r = seeding(session)

  // Enter on "Improve transcriptions" opens select mode.
  r.update(new KeyMsg({ name: 'return' }))
  t.is(r.mode, 'select')
  t.ok(style.stripAnsi(r.view()).includes('space select'), 'select-mode hints shown')

  // Space selects the line under the cursor; enter asks the LLM.
  r.update(new KeyMsg({ name: 'space' }))
  t.ok(r.selected.has(0))
  const [, cmd] = r.update(new KeyMsg({ name: 'return' }))
  t.is(r.busy, true)
  const msg = await cmd()
  t.alike(session.suggestedWith, [0], 'selected indices sent to the session')

  // Suggestions arrive -> review mode shows original vs suggested.
  r.update(msg)
  t.is(r.mode, 'review')
  const out = style.stripAnsi(r.view())
  t.ok(out.includes('Suggestion 1 of 1'))
  t.ok(out.includes('hello everyone'), 'original text')
  t.ok(out.includes('hello, everyone!'), 'suggested text')

  // Accept writes the fix and, being the last one, returns to the menu.
  const [, apply] = r.update(new KeyMsg({ name: 'a' }))
  r.update(await apply())
  t.alike(session.applied, [{ segment: SNAP.segments[0], text: 'hello, everyone!' }])
  t.is(r.mode, null, 'back on the menu')
  t.ok(r.notice.includes('applied 1 of 1'), 'result notice')
})

test('improve flow: skip applies nothing; esc leaves select mode', async function (t) {
  const session = fakeSession()
  session.suggestions = [
    { index: 0, segment: SNAP.segments[0], suggestion: 'hello, everyone!' }
  ]
  const r = seeding(session)
  r.update(new KeyMsg({ name: 'return' })) // improve
  r.update(new KeyMsg({ name: 'space' }))
  const [, cmd] = r.update(new KeyMsg({ name: 'return' }))
  r.update(await cmd())
  t.is(r.mode, 'review')
  r.update(new KeyMsg({ name: 's' })) // skip the only suggestion
  t.is(r.mode, null)
  t.is(session.applied.length, 0, 'nothing written')
  t.ok(r.notice.includes('applied 0 of 1'))

  r.update(new KeyMsg({ name: 'return' })) // improve again
  t.is(r.mode, 'select')
  r.update(new KeyMsg({ name: 'escape' }))
  t.is(r.mode, null, 'esc backs out')
})

test('generate summary shows the tmp file path on the seeding screen', async function (t) {
  const session = fakeSession()
  const r = seeding(session)
  r.update(new KeyMsg({ name: 'down' })) // -> Generate summary
  const [, cmd] = r.update(new KeyMsg({ name: 'return' }))
  t.is(r.busy, true)
  r.update(await cmd())
  t.is(r.busy, false)
  const out = style.stripAnsi(r.view())
  t.ok(out.includes('/tmp/hmr-summary-x.md'), 'summary path shown')
  t.ok(out.includes('Key points: none'), 'summary preview shown')
})

test('seeding: q still quits directly from the menu', async function (t) {
  const session = fakeSession()
  const r = seeding(session)
  const [, cmd] = r.update(new KeyMsg({ name: 'q' }))
  t.alike(await cmd(), { type: 'quit' })
  t.is(session.toredown, true)
})

test('ctrl+c force-quits: finish + teardown', async function (t) {
  const session = fakeSession()
  const r = booted(session)

  const [, cmd] = r.update(new KeyMsg({ name: 'c', ctrl: true }))
  const msg = await cmd()
  t.alike(msg, { type: 'quit' })
  t.is(session.finished, true)
  t.is(session.toredown, true)
})

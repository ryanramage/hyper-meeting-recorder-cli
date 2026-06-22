// The recorder TUI (The Elm Architecture). It owns no IO — it polls a `session`
// (snapshot() / admit() / finishRecording() / teardown()) and renders.
//
// Three things show up here, all driven by snapshot():
//
//   * waiting (guest only) — before the host admits us we're not writable, so
//     we can't record yet. We show OUR writer key; the guest copies it to the
//     host out of band. Once admitted (writable -> capturing) we drop into the
//     recording view automatically.
//   * recording — REC, live transcript, the "Exit meeting" menu. On the HOST,
//     `a` opens a prompt to paste a guest's writer key and admit them.
//   * seeding — after "Exit meeting": capture stopped + audio saved, but the
//     swarm stays up so the player can connect. "Exit" tears it all down.
//
//   waiting ─(admitted)─▶ recording ─[Exit meeting]─▶ seeding ─[Exit]─▶ quit
import tui from 'bare-tui'
import * as fmt from './format.js'

const { quit, batch, every, key, style } = tui

const KEYS = {
  activate: key.binding({ keys: ['enter', 'q', 'space'] }),
  addWriter: key.binding({ keys: ['a'] }),
  force: key.binding({ keys: ['ctrl+c'] })
}

export default class Recorder {
  constructor ({ session, track = 'me', pollMs = 250 } = {}) {
    this.session = session
    this.track = track
    this.pollMs = pollMs

    this.width = 0
    this.height = 0
    this.ready = false
    this.error = null

    this.phase = 'recording' // 'recording' | 'seeding'
    this.busy = false // a phase transition is in flight

    this.isHost = false
    this.capturing = false // mic/transcription running (guest: post-admission)
    this.writerKey = null // our own writer key (a guest shows it for admission)

    // Host "add writer" paste prompt.
    this.adding = false
    this.buffer = ''
    this.notice = null // last admit result, shown briefly

    this.recording = true
    this.elapsed = 0
    this.level = 0
    this.key = null
    this.meta = {}
    this.segments = []
    this.tracks = []
  }

  init () {
    return batch(this._snapshotCmd(), this._pollCmd())
  }

  _snapshotCmd () {
    return () =>
      this.session
        .snapshot()
        .then((data) => ({ type: 'snap', data }))
        .catch((error) => ({ type: 'err', error }))
  }

  _pollCmd () {
    return every(this.pollMs, () => ({ type: 'poll' }))
  }

  update (msg) {
    switch (msg.type) {
      case 'resize':
        this.width = msg.width
        this.height = msg.height
        return [this, null]

      case 'snap': {
        const d = msg.data
        this.ready = true
        this.isHost = !!d.isHost
        this.capturing = !!d.capturing
        this.writerKey = d.writerKey || this.writerKey
        this.recording = d.recording
        this.elapsed = d.elapsed
        this.level = d.level
        this.key = d.key || this.key
        this.meta = d.meta || {}
        this.segments = d.segments || []
        this.tracks = d.tracks || []
        return [this, null]
      }

      case 'poll':
        return [this, batch(this._snapshotCmd(), this._pollCmd())]

      case 'err':
        this.error = msg.error
        return [this, null]

      case 'finished': // recording stopped; now seeding
        this.busy = false
        this.phase = 'seeding'
        return [this, null]

      case 'admitted':
        this.notice = msg.ok
          ? '✔ admitted ' + msg.key.slice(0, 12) + '…'
          : '✖ ' + (msg.error?.message || 'could not admit that key')
        return [this, null]

      case 'key':
        return this._onKey(msg)

      case 'quit':
        return [this, quit]

      default:
        return [this, null]
    }
  }

  _onKey (msg) {
    // ctrl+c always force-quits: stop recording + tear down, then exit.
    if (key.matches(msg, KEYS.force)) {
      if (this.busy) return [this, null]
      this.busy = true
      return [this, async () => {
        try { await this.session.finishRecording() } catch {}
        try { await this.session.teardown() } catch {}
        return { type: 'quit' }
      }]
    }

    // Host add-writer prompt swallows all other keys while open.
    if (this.adding) return this._onAddKey(msg)
    if (this.busy) return [this, null]

    // Host, while recording: open the paste-a-writer-key prompt.
    if (this.isHost && this.phase === 'recording' && key.matches(msg, KEYS.addWriter)) {
      this.adding = true
      this.buffer = ''
      this.notice = null
      return [this, null]
    }

    if (key.matches(msg, KEYS.activate)) return this._activate()
    return [this, null]
  }

  // Accumulate a pasted/typed writer key. enter admits, esc cancels, backspace
  // edits; any single printable char is appended.
  _onAddKey (msg) {
    if (msg.is('escape')) { this.adding = false; this.buffer = ''; return [this, null] }
    if (msg.is('backspace')) { this.buffer = this.buffer.slice(0, -1); return [this, null] }
    if (msg.is('enter')) {
      const k = this.buffer.trim()
      this.adding = false
      this.buffer = ''
      if (!k) return [this, null]
      return [this, async () => {
        try { await this.session.admit(k); return { type: 'admitted', ok: true, key: k } }
        catch (error) { return { type: 'admitted', ok: false, error } }
      }]
    }
    if (!msg.ctrl && !msg.meta && msg.name && msg.name.length === 1) this.buffer += msg.name
    return [this, null]
  }

  // Activate the single menu item for the current phase.
  _activate () {
    this.busy = true
    if (this.phase === 'recording') {
      // Exit meeting: stop + save, keep seeding.
      return [this, async () => {
        try { await this.session.finishRecording() } catch {}
        return { type: 'finished' }
      }]
    }
    // Exit: tear down the swarm/meeting and quit.
    return [this, async () => {
      try { await this.session.teardown() } catch {}
      return { type: 'quit' }
    }]
  }

  view () {
    const W = this.width
    const H = this.height
    if (!W || !H) return 'starting…'
    if (this.error) return style().foreground('203').render('✖ ' + (this.error.message || String(this.error)))
    if (!this.ready) return '  connecting…'
    if (this.phase === 'seeding') return this._seedingView(W, H)
    if (!this.capturing && !this.isHost) return this._waitingView(W, H)
    return this._recordingView(W, H)
  }

  // Guest, pre-admission: show our writer key for the host to admit.
  _waitingView (W, H) {
    const lines = [
      '',
      '  ' + style().foreground('220').bold(true).render('⧗ Waiting to be admitted'),
      '  ' + style().faint(true).render('the host must add your writer key before you can record'),
      '',
      '  ' + style().faint(true).render('Your writer key (give this to the host):'),
      '    ' + style().bold(true).foreground('39').render(this.writerKey || '…'),
      '',
      '  ' + style().faint(true).render('Meeting key:'),
      '    ' + style().foreground('252').render(this.key || '…'),
      '',
      '  ' + style().faint(true).render('ctrl+c to cancel')
    ]
    while (lines.length < H) lines.push('')
    return lines.slice(0, H).join('\n')
  }

  _recordingView (W, H) {
    const lines = []
    lines.push(this._header(W))
    // The full meeting key on its own line, so it can be copied to invite others.
    lines.push(
      style().faint(true).render('  invite key: ') +
      style().bold(true).foreground('39').render(this.key || '…')
    )
    lines.push('')
    lines.push(this._participants(W))
    lines.push('')
    lines.push(style().bold(true).render('Live transcript'))

    const footer = this._footer()
    const footerH = footer.length
    const bodyH = Math.max(1, H - lines.length - footerH)
    for (const l of this._transcriptTail(W, bodyH)) lines.push(l)
    for (const l of footer) lines.push(l)
    return lines.slice(0, H).join('\n')
  }

  // The bottom-of-screen controls for the recording view. Either the host's
  // paste-a-writer-key prompt, or the menu + (host) add-writer hint + notice.
  _footer () {
    if (this.adding) {
      return [
        style().foreground('220').render('  paste writer key, then enter ') +
          style().faint(true).render('(esc cancels)'),
        '  ' + style().foreground('252').render('▸ ' + this.buffer) + style().reverse(true).render(' ')
      ]
    }
    let line = this._menu('Exit meeting', 'saving…')
    if (!this.busy && this.isHost) {
      line += '   ' + style().reverse(true).bold(true).render(' a ') + ' ' + style().faint(true).render('add writer')
    }
    if (this.notice) line += '   ' + style().faint(true).render(this.notice)
    return [line]
  }

  _seedingView (W, H) {
    const key = this.key || '(no key yet)'
    const lines = [
      '',
      '  ' + style().foreground('42').bold(true).render('● Meeting is seeding'),
      '  ' + style().faint(true).render('keep this running so others can join / replay it'),
      '',
      '  ' + style().faint(true).render('Meeting key:'),
      '    ' + style().bold(true).foreground('39').render(key),
      '',
      '  ' + style().faint(true).render('Play it back (in the player):'),
      '    ' + style().foreground('252').render('bare bin/cli.js ' + key),
      '',
      '  ' + this._menu('Exit', 'exiting…')
    ]
    while (lines.length < H) lines.push('')
    return lines.slice(0, H).join('\n')
  }

  // A one-item menu: a highlighted, selected item activated with enter.
  _menu (label, busyLabel) {
    if (this.busy) return style().foreground('220').render(busyLabel)
    return style().reverse(true).bold(true).render(` ▸ ${label} `) + '  ' + style().faint(true).render('enter')
  }

  _header (W) {
    const title = style().bold(true).render(fmt.truncate(this.meta.title || 'meeting', 24))
    const dot = this.recording
      ? style().foreground('203').render('●') + ' ' + style().bold(true).render('REC')
      : style().foreground('245').render('◼ stopped')
    const clock = style().foreground('252').render(fmt.fmtClock(this.elapsed))
    const meter = this.recording
      ? style().foreground('42').render(fmt.levelBar(this.level, 12))
      : ''
    const you = style().foreground('245').render('you: ') + style().foreground(this._myColor()).render(fmt.speaker(this.track))
    return `${title}  ${dot}  ${clock}  ${meter}  ${you}`
  }

  _participants (W) {
    if (!this.tracks.length) {
      return style().faint(true).render('  (waiting for participants…)')
    }
    const names = this.tracks.map((trk, i) => {
      const me = trk === this.track ? '•' : ' '
      return style().foreground(fmt.trackColor(i)).render(me + fmt.speaker(trk))
    })
    return style().faint(true).render('participants: ') + names.join('  ')
  }

  _transcriptTail (W, height) {
    const segs = this.segments
    const start = Math.max(0, segs.length - height) // follow the live tail
    const out = []
    for (let r = 0; r < height; r++) {
      const i = start + r
      if (i >= segs.length) {
        out.push('')
        continue
      }
      const s = segs[i]
      const ts = fmt.fmtClock(s.start).padStart(6)
      const ci = this.tracks.indexOf(s.track)
      const who = fmt.speaker(s.track)
      const mine = s.track === this.track
      const label = who + (mine ? ' (you)' : '') + ':'
      const prefixLen = ts.length + 2 + label.length + 1
      const text = fmt.truncate(s.text.trim(), Math.max(0, W - prefixLen))
      out.push(
        style().foreground('245').render(ts) + '  ' +
        style().foreground(fmt.trackColor(ci)).bold(mine).render(label) + ' ' +
        style().foreground(mine ? '252' : '250').render(text)
      )
    }
    return out
  }

  _myColor () {
    const i = this.tracks.indexOf(this.track)
    return fmt.trackColor(i < 0 ? 0 : i)
  }
}

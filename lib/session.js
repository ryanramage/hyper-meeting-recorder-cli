// RecorderSession wires the pieces into the live pipeline:
//
//   mic  ──s16le PCM──▶  transcriber.write()   (live Whisper)
//                        transcriber segments ─▶ meeting.addTranscript()
//        └─ accumulate PCM ───────────────────▶ meeting.addAudio() on stop
//
// It exposes the same shape the player's source does — snapshot() for the UI to
// poll, plus stop(). The TUI model only ever calls those two, so it's testable
// with a fake session and this is testable with mock mic/transcriber/meeting.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { rmsS16 } from './format.js'
import { encodeWav } from './meeting.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class RecorderSession {
  constructor ({ mic, transcriber, meeting, track, rate = 16000, summarizer = null, agenda = null, summaryPrompt = null } = {}) {
    this.mic = mic
    this.transcriber = transcriber
    this.meeting = meeting
    this.track = track
    this.rate = rate

    this.summarizer = summarizer
    this.agenda = agenda
    this.summaryPrompt = summaryPrompt
    this.llmStatus = null // model download/load/inference progress for the TUI
    if (summarizer) summarizer.onStatus = (s) => { this.llmStatus = s }

    this.recording = false
    this.startedAt = 0
    this.level = 0
    this.error = null

    this._pcm = []
    this._appended = 0
    this._epochOffset = 0 // ms between meeting start and this recording's start
    this._elapsed = 0
    this._lastStart = -1 // keeps appended timestamps strictly increasing
    this._consumePromise = null
    this._tornDown = false
    this._capturing = false // mic + transcription pipeline running
  }

  async start () {
    await this.meeting.open()

    // The host defines the meeting's zero; everyone aligns segments to it.
    if (this.meeting.isHost) {
      await this.meeting.setMeta({ title: this.meeting.id.slice(0, 8), startedAt: Date.now() })
    }

    // Load the (heavy) model up front, even for a guest still waiting to be
    // admitted, so capture can start instantly the moment the host admits it.
    await this.transcriber.load()

    // The host is writable immediately; a guest only after the host admits its
    // writer key. Capture begins the moment we're writable — see snapshot().
    if (this.meeting.writable) await this._beginCapture()
  }

  // Start the mic + live transcription pipeline. Idempotent: only ever runs once
  // (the host on start(); a guest the first time it becomes writable).
  async _beginCapture () {
    if (this._capturing) return
    this._capturing = true

    const meta = await this.meeting.meta()
    const session = await this.transcriber.openSession()

    this.startedAt = Date.now()
    this._epochOffset = Math.max(0, this.startedAt - (Number(meta.startedAt) || this.startedAt))
    this.recording = true

    this.mic.start((chunk) => {
      if (!this.recording) return
      this.transcriber.write(chunk)
      this._pcm.push(Buffer.from(chunk))
      this.level = rmsS16(chunk)
    })

    this._consumePromise = this._consume(session)
  }

  // Host-only: admit a guest by the writer key shown on their screen.
  admit (writerKey) { return this.meeting.admit(writerKey) }

  async _consume (session) {
    const anchored = this.transcriber.anchoredTimestamps === true
    try {
      for await (const seg of session) {
        // Anchored transcribers (parakeet) report startMs/endMs as positions in
        // the audio we fed them, so segments land exactly where the speech is:
        // offset by _epochOffset to align with the shared meeting start.
        // Whisper's streaming session instead reports per-utterance times
        // (startMs resets to 0 each segment), so for it we fall back to the
        // recorder's elapsed clock at arrival minus the model's measured
        // length — late by the pipeline latency, but monotonic and usable.
        const dur = Math.max(0, Math.round((seg.endMs || 0) - (seg.startMs || 0)))
        let start
        if (anchored) {
          start = this._epochOffset + Math.max(0, Math.round(seg.startMs || 0))
        } else {
          const arrival = Date.now() - this.startedAt
          start = this._epochOffset + Math.max(0, arrival - dur)
        }
        if (start <= this._lastStart) start = this._lastStart + 1
        this._lastStart = start

        await this.meeting.addTranscript({
          track: this.track,
          start,
          end: start + dur,
          text: seg.text,
          id: seg.id,
          append: seg.append
        })
        this._appended++
      }
    } catch (err) {
      this.error = err
    }
  }

  // Polled by the UI. Includes everyone's transcript (mine + replicated peers).
  // Also drives deferred capture: a guest starts the pipeline the first poll
  // after the host admits its writer key.
  async snapshot () {
    await this.meeting.update()
    if (!this._capturing && this.meeting.writable) await this._beginCapture()

    const segments = await this.meeting.transcript()
    const meta = await this.meeting.meta()
    const tracks = [...new Set(segments.map((s) => s.track))].sort()
    return {
      isHost: this.meeting.isHost,
      capturing: this._capturing,
      writable: this.meeting.writable,
      writerKey: this.meeting.localWriterKey, // a guest shows this for admission
      recording: this.recording,
      elapsed: this._capturing ? (this.recording ? Date.now() - this.startedAt : this._elapsed) : 0,
      level: this.recording ? this.level : 0,
      track: this.track,
      key: this.meeting.id,
      appended: this._appended,
      llm: !!this.summarizer,
      llmStatus: this.llmStatus,
      meta,
      segments,
      tracks
    }
  }

  // --- post-meeting LLM features (seeding screen) -------------------------
  // These throw to the CALLER (the TUI shows a notice) — never into
  // this.error, which would take down the whole UI.

  // Ask the LLM for corrections to the given transcript indices, with the
  // agenda + full transcript as context. [{ index, segment, suggestion }]
  async suggestImprovements (selectedIndices) {
    if (!this.summarizer) throw new Error('no LLM configured')
    try {
      const segments = await this.meeting.transcript()
      const picked = selectedIndices.filter((i) => segments[i])
      if (!picked.length) return []
      const out = await this.summarizer.suggest({ segments, selectedIndices: picked, agenda: this.agenda })
      return out.map(({ i, text }) => ({ index: i, segment: segments[i], suggestion: text }))
    } finally {
      this.llmStatus = null
    }
  }

  // Replace a segment's text in place: re-adding with the same track + start
  // overwrites the autobee entry (the key is transcript/<track>/<start>), and
  // the correction replicates to every peer and the player.
  applyTranscriptFix (segment, text) {
    return this.meeting.addTranscript({
      track: segment.track,
      start: segment.start,
      end: segment.end,
      id: segment.id,
      append: segment.append,
      text
    })
  }

  // Summarize the whole meeting and write it to a local tmp file.
  async generateSummary () {
    if (!this.summarizer) throw new Error('no LLM configured')
    try {
      const segments = await this.meeting.transcript()
      if (!segments.length) throw new Error('no transcript to summarize')
      const meta = await this.meeting.meta()
      const text = await this.summarizer.summarize({
        segments,
        meta,
        agenda: this.agenda,
        promptOverride: this.summaryPrompt
      })
      const name = `hmr-summary-${String(this.meeting.id || 'meeting').slice(0, 8)}-${Date.now().toString(36)}.md`
      const file = path.join(os.tmpdir(), name)
      fs.writeFileSync(file, text + '\n')
      return { path: file, text }
    } finally {
      this.llmStatus = null
    }
  }

  // Stop capturing + transcribing and persist this peer's audio, but KEEP the
  // meeting + swarm open so it keeps seeding (others can still join / replay).
  // Bounded + defensive so it always resolves (a hang here would block the UI).
  async finishRecording () {
    if (!this.recording) return
    this.recording = false
    this._elapsed = Date.now() - this.startedAt
    this.level = 0

    this.mic.stop()
    try { this.transcriber.end() } catch {}
    if (this._consumePromise) await Promise.race([this._consumePromise, sleep(2000)])
    try { this.transcriber.session?.destroy?.() } catch {}

    // Persist the recorded audio + duration (these must land, so they're awaited).
    try {
      const pcm = Buffer.concat(this._pcm)
      if (pcm.length) {
        await this.meeting.addAudio({ track: this.track, start: this._epochOffset, data: encodeWav(pcm, this.rate) })
      }
      if (this.meeting.isHost) {
        const segs = await this.meeting.transcript()
        const dur = segs.reduce((m, s) => Math.max(m, s.end == null ? s.start : s.end), 0)
        await this.meeting.setMeta({ duration: dur })
      }
    } catch (err) {
      this.error = err
    }

    await Promise.race([this.transcriber.unload().catch(() => {}), sleep(2000)])
  }

  // Tear down the swarm + meeting and stop seeding. Idempotent + bounded.
  async teardown () {
    if (this._tornDown) return
    this._tornDown = true
    this.recording = false
    this.mic.stop()
    if (this.summarizer) await Promise.race([this.summarizer.unload().catch(() => {}), sleep(2000)])
    await Promise.race([this.meeting.close().catch(() => {}), sleep(3000)])
  }
}

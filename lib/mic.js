// Audio capture, abstracted so the recorder can run against a real microphone,
// a file (to simulate a live mic, great for testing without hardware), or an
// in-memory mock (unit tests). All sources emit mono s16le PCM Buffers via the
// onData callback passed to start().
import subprocess from 'bare-subprocess'

const { spawn } = subprocess

// Capture via ffmpeg — it handles every platform's audio device, so we don't
// have to. Output is always mono s16le at `rate`.
//
//   new FfmpegMic({ rate })                       // default system mic
//   new FfmpegMic({ file: 'meeting.wav' })        // simulate a live mic (-re)
//   new FfmpegMic({ inputFormat: 'alsa', device: 'hw:0' })
export class FfmpegMic {
  constructor ({ file = null, device = null, inputFormat = null, rate = 16000, bin = 'ffmpeg' } = {}) {
    this.file = file
    this.device = device
    this.inputFormat = inputFormat
    this.rate = rate
    this.bin = bin
    this.proc = null
  }

  _inputArgs () {
    if (this.file) return ['-re', '-i', this.file] // -re = read at native rate (live-ish)
    switch (Bare.platform) {
      case 'darwin':
        return ['-f', this.inputFormat || 'avfoundation', '-i', this.device || ':default']
      case 'win32':
        return ['-f', this.inputFormat || 'dshow', '-i', this.device || 'audio=default']
      default: // linux & friends — pulse/pipewire is the common default
        return ['-f', this.inputFormat || 'pulse', '-i', this.device || 'default']
    }
  }

  start (onData) {
    const args = [
      ...this._inputArgs(),
      '-ac', '1',
      '-ar', String(this.rate),
      '-f', 's16le',
      '-loglevel', 'quiet',
      'pipe:1'
    ]
    this.proc = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    this.proc.stdout.on('data', onData)
    this.proc.on('error', () => { this.proc = null })
    this.proc.on('exit', () => { this.proc = null })
  }

  stop () {
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
  }
}

// In-memory mic for tests: replays `chunks` on a timer.
export class MockMic {
  constructor ({ chunks = [], rate = 16000, intervalMs = 5 } = {}) {
    this.chunks = chunks
    this.rate = rate
    this.intervalMs = intervalMs
    this._timer = null
  }

  start (onData) {
    let i = 0
    this._timer = setInterval(() => {
      if (i >= this.chunks.length) {
        this.stop()
        return
      }
      onData(this.chunks[i++])
    }, this.intervalMs)
  }

  stop () {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }
}

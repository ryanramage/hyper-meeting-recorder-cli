// Audio capture, abstracted so the recorder can run against a real microphone,
// a file (to simulate a live mic, great for testing without hardware), or an
// in-memory mock (unit tests). All sources emit mono s16le PCM Buffers via the
// onData callback passed to start().
//
// Capture runs in-process through bare-ffmpeg (native FFmpeg bindings) — the
// production path, no external ffmpeg binary needed. One gap: the stock
// bare-ffmpeg Linux prebuilds compile in no audio capture device (no
// pulse/alsa), so live-mic capture on Linux falls back to spawning the system
// ffmpeg binary until upstream ships a pulse-enabled build. File decode uses
// bare-ffmpeg on every platform.
import ffmpeg from 'bare-ffmpeg'
import fs from 'bare-fs'
import subprocess from 'bare-subprocess'

const { spawn } = subprocess

//   new FfmpegMic({ rate })                       // default system mic
//   new FfmpegMic({ file: 'meeting.wav' })        // simulate a live mic (paced)
//   new FfmpegMic({ inputFormat: 'avfoundation', device: ':1' })
export class FfmpegMic {
  constructor ({ file = null, device = null, inputFormat = null, rate = 16000 } = {}) {
    this.file = file
    this.device = device
    this.inputFormat = inputFormat
    this.rate = rate
    this.backend = null // 'bare-ffmpeg' | 'ffmpeg-cli', set on start()
    this._running = false
    this._proc = null
  }

  // The libavdevice demuxer + device URL for this platform, or null when the
  // prebuild has no usable audio capture device (Linux, today).
  _deviceInput () {
    const candidates = []
    switch (Bare.platform) {
      case 'darwin':
        // ":<dev>" = audio-only avfoundation input
        candidates.push([this.inputFormat || 'avfoundation', this.device || ':default'])
        break
      case 'win32':
        candidates.push([this.inputFormat || 'dshow', this.device || 'audio=default'])
        break
      default: // linux & friends — pulse/pipewire is the common default
        if (this.inputFormat) candidates.push([this.inputFormat, this.device || 'default'])
        else {
          candidates.push(['pulse', this.device || 'default'])
          candidates.push(['alsa', this.device || 'default'])
        }
    }
    for (const [name, url] of candidates) {
      let format
      try {
        format = new ffmpeg.InputFormat(name)
      } catch {
        continue // demuxer not compiled into this prebuild
      }
      // Non-blocking device reads: readFrame() returns false on EAGAIN instead
      // of stalling the event loop (and the TUI) until a packet arrives.
      const options = ffmpeg.Dictionary.from({ fflags: 'nonblock' })
      return new ffmpeg.InputFormatContext(format, options, url)
    }
    return null
  }

  _fileInput () {
    // Whole-file IO context; -re style pacing happens in the read loop.
    const data = fs.readFileSync(this.file)
    return new ffmpeg.InputFormatContext(new ffmpeg.IOContext(data))
  }

  start (onData) {
    if (this._running) return
    this._running = true

    if (this.file) {
      this.backend = 'bare-ffmpeg'
      this._runPipeline(this._fileInput(), onData, { live: false })
      return
    }

    const format = this._deviceInput()
    if (format) {
      this.backend = 'bare-ffmpeg'
      this._runPipeline(format, onData, { live: true })
    } else {
      this.backend = 'ffmpeg-cli' // Linux fallback, see header comment
      this._startSubprocess(onData)
    }
  }

  _runPipeline (format, onData, { live }) {
    const stream = format.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)
    if (!stream) {
      format.destroy()
      this._running = false
      throw new Error('no audio stream found in input')
    }

    const decoder = stream.decoder()
    decoder.open()

    const params = stream.codecParameters
    const resampler = new ffmpeg.Resampler(
      params.sampleRate,
      params.channelLayout,
      params.format,
      this.rate,
      ffmpeg.constants.channelLayouts.MONO,
      ffmpeg.constants.sampleFormats.S16
    )

    const packet = new ffmpeg.Packet()
    const raw = new ffmpeg.Frame()
    const output = new ffmpeg.Frame()
    const samples = new ffmpeg.Samples()

    const prepareOutput = (nbSamples) => {
      output.channelLayout = ffmpeg.constants.channelLayouts.MONO
      output.format = ffmpeg.constants.sampleFormats.S16
      output.sampleRate = this.rate
      output.nbSamples = nbSamples
      samples.fill(output) // binds samples.data as the frame's buffer
    }

    const emit = (count) => {
      if (count > 0) {
        onData(Buffer.from(samples.data.subarray(0, count * 2))) // mono s16 = 2 B/sample
        samplesSent += count
      }
    }

    const drainDecoder = () => {
      while (decoder.receiveFrame(raw)) {
        // 16k mono output can't need more samples than the input frame holds
        // (input rates are >= 16k), so raw.nbSamples is a safe capacity.
        prepareOutput(raw.nbSamples)
        emit(resampler.convert(raw, output))
      }
    }

    const cleanup = () => {
      try { resampler.destroy() } catch {}
      try { decoder.destroy() } catch {}
      try { format.destroy() } catch {}
    }

    const finish = () => {
      // EOF: drain the decoder (blank packet = flush), then the resampler.
      try {
        decoder.sendPacket(new ffmpeg.Packet())
        drainDecoder()
        prepareOutput(1024)
        let n
        while ((n = resampler.flush(output)) > 0) emit(n)
      } catch {}
      this._running = false
      cleanup()
    }

    // File mode paces delivery to the wall clock (like ffmpeg -re) so a file
    // behaves like a live mic; a live device is paced by the hardware.
    const startedAt = Date.now()
    let samplesSent = 0

    const step = () => {
      if (!this._running) return cleanup()

      if (!live) {
        const ahead = (samplesSent / this.rate) * 1000 - (Date.now() - startedAt)
        if (ahead > 20) return setTimeout(step, ahead)
      }

      let got = false
      try {
        // Bounded work per turn so a chatty device can't starve the TUI.
        for (let i = 0; i < 8; i++) {
          if (!format.readFrame(packet)) break
          got = true
          if (packet.streamIndex === stream.index) {
            decoder.sendPacket(packet)
            drainDecoder()
          }
          packet.unref()
        }
      } catch (err) {
        this._running = false
        cleanup()
        throw err
      }

      // readFrame() === false means EAGAIN on a nonblock device (idle-wait and
      // retry) but EOF for a file (finish up).
      if (!got && !live) return finish()
      setTimeout(step, got ? 0 : 10)
    }

    setImmediate(step)
  }

  // Legacy capture via the system ffmpeg binary — Linux only, until the
  // bare-ffmpeg prebuilds ship an audio capture device there.
  _startSubprocess (onData) {
    const args = [
      '-f', this.inputFormat || 'pulse',
      '-i', this.device || 'default',
      '-ac', '1',
      '-ar', String(this.rate),
      '-f', 's16le',
      '-loglevel', 'quiet',
      'pipe:1'
    ]
    this._proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    this._proc.stdout.on('data', onData)
    this._proc.on('error', () => { this._proc = null })
    this._proc.on('exit', () => { this._proc = null })
  }

  stop () {
    this._running = false // the bare-ffmpeg read loop notices and tears down
    if (this._proc) {
      try { this._proc.kill() } catch {}
      this._proc = null
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

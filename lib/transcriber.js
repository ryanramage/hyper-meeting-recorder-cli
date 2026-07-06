// Live transcription via the QVAC SDK's bidirectional streaming session: feed
// it mono s16le PCM with write(), iterate it for TranscribeSegment objects as
// the model's VAD detects complete utterances.
import { plugins, WHISPER_TINY, VAD_SILERO_5_1_2, PARAKEET_EOU_120M_V1_Q8_0 } from '@qvac/sdk'
import { whisperPlugin } from '@qvac/sdk/whispercpp-transcription/plugin'
import { parakeetPlugin } from '@qvac/sdk/parakeet-transcription/plugin'
import TranscriptionParakeet from '@qvac/transcription-parakeet'

const DEFAULT_CONFIG = {
  vadModelSrc: VAD_SILERO_5_1_2,
  audio_format: 's16le', // matches what the mic produces
  strategy: 'greedy',
  n_threads: 4,
  language: 'en',
  no_timestamps: true,
  suppress_blank: true,
  suppress_nst: true,
  temperature: 0.0,
  vad_params: {
    threshold: 0.6,
    min_speech_duration_ms: 250,
    min_silence_duration_ms: 500,
    max_speech_duration_s: 15.0,
    speech_pad_ms: 200
  }
}

export class QvacTranscriber {
  constructor ({ modelSrc = WHISPER_TINY, modelConfig = DEFAULT_CONFIG } = {}) {
    this.api = plugins([whisperPlugin]) // registers the plugin, returns host API
    this.modelSrc = modelSrc
    this.modelConfig = modelConfig
    this.modelId = null
    this.session = null
  }

  async load () {
    this.modelId = await this.api.loadModel({
      modelType: 'whispercpp-transcription',
      modelSrc: this.modelSrc,
      modelConfig: this.modelConfig
    })
  }

  // Open a live session. Returns an async-iterable of TranscribeSegment.
  async openSession () {
    this.session = await this.api.transcribeStream({ modelId: this.modelId, metadata: true })
    return this.session
  }

  write (chunk) {
    if (this.session) this.session.write(chunk)
  }

  end () {
    if (this.session) this.session.end()
  }

  async unload () {
    if (this.modelId) await this.api.unloadModel({ modelId: this.modelId })
    this.modelId = null
  }
}

const DEFAULT_PARAKEET_MODEL_CONFIG = {
  streaming: true,
  streamingChunkMs: 1000,
  streamingEmitPartials: true
}

const DEFAULT_PARAKEET_STREAMING_CONFIG = {
  chunkMs: 1000,
  emitPartials: true
}

// A push-based adapter over runStreaming()'s pull-based audio input: the mic
// callback write()s chunks in, the addon's pump for-await's them out.
function pushQueue () {
  const chunks = []
  let notify = null
  let done = false
  return {
    write (chunk) {
      if (done) return
      chunks.push(chunk)
      if (notify) { notify(); notify = null }
    },
    end () {
      done = true
      if (notify) { notify(); notify = null }
    },
    async * [Symbol.asyncIterator] () {
      while (true) {
        while (chunks.length) yield chunks.shift()
        if (done) return
        await new Promise((resolve) => { notify = resolve })
      }
    }
  }
}

// Re-shape the addon's raw streaming segments into the {text, startMs, endMs,
// id, append} utterance shape session.js consumes. Raw segments are partial
// appends within a turn -- {text, start, end (seconds of AUDIO time),
// isEndOfTurn} -- so buffer them until the EOU model closes the turn (or the
// stream ends) and keep the audio-time positions. That's the whole point of
// going through the raw addon: startMs says where in the recorded audio the
// speech is, unaffected by chunking + inference latency (which can lag 3-4s).
async function * toSegments (outputs) {
  let text = ''
  let startMs = null
  let endMs = 0
  let id = 0

  for await (const batch of outputs) {
    for (const seg of Array.isArray(batch) ? batch : [batch]) {
      if (seg.text) {
        if (startMs === null) startMs = seg.start * 1000
        text += seg.text
        endMs = seg.end * 1000
      }
      if (seg.isEndOfTurn) {
        const turn = text.trim()
        if (turn) yield { text: turn, startMs, endMs, id: id++, append: false }
        text = ''
        startMs = null
      }
    }
  }

  const turn = text.trim()
  if (turn) yield { text: turn, startMs: startMs === null ? endMs : startMs, endMs, id: id++, append: false }
}

// Streams via @qvac/transcription-parakeet directly rather than the SDK's
// transcribeStream: the SDK strips segments down to bare text for parakeet
// (metadata is whisper-only there), losing the audio-time start/end we need
// to place segments on the meeting timeline. The SDK still handles model
// download + caching (downloadAsset / getModelInfo).
export class ParakeetTranscriber {
  constructor ({
    modelSrc = PARAKEET_EOU_120M_V1_Q8_0,
    modelConfig = DEFAULT_PARAKEET_MODEL_CONFIG,
    streamingConfig = DEFAULT_PARAKEET_STREAMING_CONFIG
  } = {}) {
    this.api = plugins([parakeetPlugin])
    this.modelSrc = modelSrc
    this.modelConfig = modelConfig
    this.streamingConfig = streamingConfig
    this.model = null
    this.session = null
    this.response = null
    // Tells session.js that startMs/endMs are positions in the recorded
    // audio (not per-utterance or arrival-relative times).
    this.anchoredTimestamps = true
  }

  async load () {
    await this.api.downloadAsset({ assetSrc: this.modelSrc })
    const info = await this.api.getModelInfo({ name: this.modelSrc.name })
    this.model = new TranscriptionParakeet({
      files: { model: info.cacheFiles[0].path },
      config: { enableStats: true, parakeetConfig: this.modelConfig }
    })
    await this.model.load()
  }

  // Open a live session. Returns an async-iterable of TranscribeSegment.
  async openSession () {
    const queue = pushQueue()
    this.response = await this.model.runStreaming(queue, this.streamingConfig)
    this.session = {
      write: (chunk) => queue.write(chunk),
      end: () => queue.end(),
      destroy: () => { this.response?.cancel().catch(() => {}) }
    }
    return toSegments(this.response.iterate())
  }

  write (chunk) {
    if (this.session) this.session.write(chunk)
  }

  end () {
    if (this.session) this.session.end()
  }

  async unload () {
    if (this.model) await this.model.destroy()
    this.model = null
  }
}

// A canned transcriber for tests: yields the given segments, no model/audio.
export class MockTranscriber {
  constructor ({ segments = [] } = {}) {
    this.segments = segments
    this.written = []
    this._ended = false
  }

  async load () {}

  async openSession () {
    const segs = this.segments
    const self = this
    this.session = {
      write (chunk) { self.written.push(chunk) },
      end () { self._ended = true },
      destroy () {},
      async * [Symbol.asyncIterator] () {
        for (const s of segs) yield s
      }
    }
    return this.session
  }

  write (chunk) { this.written.push(chunk) }
  end () { this._ended = true }
  async unload () {}
}

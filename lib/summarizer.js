// Post-meeting LLM features via the QVAC SDK's completion API: suggest
// corrections for selected transcript segments and generate a meeting summary.
// The model loads lazily on first use — by then finishRecording() has already
// unloaded the transcription model, so they never compete for memory.
import { plugins, QWEN3_600M_INST_Q4, QWEN3_1_7B_INST_Q4, QWEN3_4B_INST_Q4_K_M } from '@qvac/sdk'
import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'
import * as fmt from './format.js'

export const MODELS = {
  'qwen3-0.6b': QWEN3_600M_INST_Q4,
  'qwen3-1.7b': QWEN3_1_7B_INST_Q4,
  'qwen3-4b': QWEN3_4B_INST_Q4_K_M
}

const SUGGEST_SYSTEM =
  'You correct errors in a speech-to-text transcript of a meeting. ' +
  'Use the agenda/notes and the full transcript for context, especially for ' +
  'spelling of names, products, and technical terms. Only fix transcription ' +
  'errors — never rephrase or embellish.'

const SUMMARY_SYSTEM =
  'This is a speech to text transcription of a meeting. Also included is an ' +
  'agenda for context (if available). We will provide the transcript, who said ' +
  'what and when. Please summarize the meeting with the following sections: ' +
  'Key points, Action Items, and Topics discussed. Please be as detailed as possible.'

// Transcript segments -> "[m:ss] speaker: text" lines the model reads.
export function renderTranscript (segments) {
  return segments.map((s) => `[${fmt.fmtClock(s.start)}] ${fmt.speaker(s.track)}: ${String(s.text).trim()}`)
}

// Keep the rendered transcript inside the model's context budget by dropping
// the OLDEST lines (the recent discussion matters most for both features).
export function fitTranscript (lines, budgetChars) {
  let total = 0
  for (const l of lines) total += l.length + 1
  if (total <= budgetChars) return lines
  const out = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > budgetChars) break
    used += lines[i].length + 1
    out.unshift(lines[i])
  }
  out.unshift('(transcript truncated — earlier part omitted)')
  return out
}

// Sanity-guard the model's suggestions: only keep ones that reference a
// selected segment and look like a correction, not a rewrite/hallucination.
export function filterSuggestions (raw, segments, selectedIndices) {
  const selected = new Set(selectedIndices)
  const out = []
  const seen = new Set()
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || !Number.isInteger(s.i) || typeof s.text !== 'string') continue
    if (!selected.has(s.i) || seen.has(s.i) || !segments[s.i]) continue
    let text = s.text.trim()
    // Models sometimes echo the "[m:ss] speaker:" framing from the prompt.
    text = text.replace(/^\[\d+:\d\d(?::\d\d)?\]\s*/, '')
    const who = fmt.speaker(segments[s.i].track)
    if (text.toLowerCase().startsWith(who.toLowerCase() + ':')) text = text.slice(who.length + 1).trim()
    const orig = String(segments[s.i].text).trim()
    if (!text || text === orig) continue
    const ratio = text.length / Math.max(1, orig.length)
    if (ratio < 0.5 || ratio > 2.0) continue
    seen.add(s.i)
    out.push({ i: s.i, text })
  }
  return out
}

export class Summarizer {
  constructor ({ model = 'qwen3-1.7b', ctxSize = 8192, onStatus = null } = {}) {
    this.modelSrc = MODELS[model]
    if (!this.modelSrc) throw new Error(`unknown LLM "${model}" (expected one of: ${Object.keys(MODELS).join(', ')})`)
    this.api = plugins([llmPlugin]) // registers the plugin, returns host API
    this.ctxSize = ctxSize
    this.onStatus = onStatus
    this.modelId = null
    this._loading = null
  }

  _status (text) {
    if (this.onStatus) this.onStatus(text)
  }

  // Lazy + idempotent: concurrent callers share one load; a failed load can be
  // retried on the next call.
  ensureLoaded () {
    if (!this._loading) {
      this._loading = this._load()
      this._loading.catch(() => { this._loading = null })
    }
    return this._loading
  }

  async _load () {
    this._status('loading model…')
    this.modelId = await this.api.loadModel({
      modelSrc: this.modelSrc,
      // verbosity 0 keeps llama.cpp's native log lines off the TUI screen.
      modelConfig: { ctx_size: this.ctxSize, verbosity: 0 },
      onProgress: (p) => this._status(`downloading model ${p.percentage.toFixed(0)}%`)
    })
    this._status(null)
  }

  // Rough chars-per-token estimate, leaving room for the prompts + response.
  get _transcriptBudget () {
    return Math.floor(this.ctxSize * 0.7 * 4)
  }

  async _complete ({ history, responseFormat = undefined, predict }) {
    await this.ensureLoaded()
    this._status('thinking…')
    try {
      const run = this.api.completion({
        modelId: this.modelId,
        history,
        stream: false,
        captureThinking: true, // keep <think> blocks out of contentText
        responseFormat,
        generationParams: { predict, reasoning_budget: 0 }
      })
      const final = await run.final
      return final.contentText.trim()
    } finally {
      this._status(null)
    }
  }

  // Ask for corrections to the selected segments (indices into `segments`),
  // with the agenda + full transcript as context. Returns [{ i, text }].
  async suggest ({ segments, selectedIndices, agenda = null }) {
    const transcript = fitTranscript(renderTranscript(segments), this._transcriptBudget)
    const numbered = selectedIndices.map((i) => `${i}. [${fmt.fmtClock(segments[i].start)}] ${fmt.speaker(segments[i].track)}: ${String(segments[i].text).trim()}`)
    const system = SUGGEST_SYSTEM + (agenda ? `\n\nAgenda / notes:\n${agenda}` : '')
    const user =
      'Full transcript:\n' + transcript.join('\n') +
      '\n\nSuggest corrected text for these numbered segments. ' +
      'Return corrections only for segments you would change, keyed by their number. ' +
      'Each correction must be ONLY the corrected spoken text — no timestamp, no speaker name:\n' +
      numbered.join('\n')

    const text = await this._complete({
      history: [{ role: 'system', content: system }, { role: 'user', content: user }],
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'corrections',
          schema: {
            type: 'object',
            properties: {
              suggestions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { i: { type: 'integer' }, text: { type: 'string' } },
                  required: ['i', 'text'],
                  additionalProperties: false
                }
              }
            },
            required: ['suggestions'],
            additionalProperties: false
          }
        }
      },
      predict: 800
    })

    let parsed
    try { parsed = JSON.parse(text) } catch { return [] }
    return filterSuggestions(parsed.suggestions, segments, selectedIndices)
  }

  // Generate the meeting summary (markdown). `promptOverride` (from --prompt)
  // replaces the built-in system prompt wholesale.
  async summarize ({ segments, meta = {}, agenda = null, promptOverride = null }) {
    const system = (promptOverride || SUMMARY_SYSTEM) + (agenda ? `\n\nAgenda:\n${agenda}` : '')
    const header = []
    if (meta.title) header.push(`Meeting: ${meta.title}`)
    if (meta.startedAt) header.push(`Started: ${new Date(Number(meta.startedAt)).toISOString()}`)
    if (meta.duration) header.push(`Duration: ${fmt.fmtClock(meta.duration)}`)
    const transcript = fitTranscript(renderTranscript(segments), this._transcriptBudget)
    const user = (header.length ? header.join('\n') + '\n\n' : '') + 'Transcript:\n' + transcript.join('\n')

    return this._complete({
      history: [{ role: 'system', content: system }, { role: 'user', content: user }],
      predict: 1200
    })
  }

  async unload () {
    if (!this.modelId) return
    try { await this.api.unloadModel({ modelId: this.modelId }) } catch {}
    this.modelId = null
    this._loading = null
  }
}

// A canned summarizer for tests: no model, records what it was asked.
export class MockSummarizer {
  constructor ({ suggestions = [], summary = 'mock summary' } = {}) {
    this.suggestions = suggestions
    this.summary = summary
    this.onStatus = null
    this.loaded = false
    this.calls = []
  }

  async ensureLoaded () { this.loaded = true }

  async suggest (params) {
    this.calls.push({ method: 'suggest', ...params })
    return this.suggestions
  }

  async summarize (params) {
    this.calls.push({ method: 'summarize', ...params })
    return this.summary
  }

  async unload () { this.loaded = false }
}

// Translation through the DSH host `llm` service.
//
// The plugin never carries its own API key: every request goes through the
// model the user already configured in DSH. Two prompts exist:
//   • draft   — cheap, fires while the speaker is still talking (stable prefix)
//   • revise  — fires at the sentence boundary with the previous turns as
//               context, and produces the written-style final line
// Both are cancellable: a superseded draft must not overwrite a newer one.

import { MINUTES_SYSTEM } from './exporters.js'

// Filler sounds carry no meaning and read as errors in a transcript. They are
// listed explicitly because models otherwise dutifully translate "嗯嗯" into
// "uh-huh, uh-huh", which is what filled the right-hand column with noise.
const FILLER_RULE = `Drop filler sounds and hesitation noise entirely (嗯 呃 啊 哦 这个 那个 就是说 然后 那个什么, um, uh, er, ah, like, you know, I mean, well, sort of, kind of). Drop a start that is repeated while the speaker was still getting going ("我我我" / "the the"). Do not translate filler as words; never output them.`

const SYSTEM_DRAFT = `You are a simultaneous interpreter. Translate the user's text into {target}. Output ONLY the translation, no quotes, no notes, no romanisation. Keep it short and spoken. ${FILLER_RULE} If the text is an unfinished fragment, translate it as an unfinished fragment and do not guess at the missing end.`

const SYSTEM_REVISE = `You are a professional conference interpreter producing written-style output. Translate the user's text into {target}. Output ONLY the translation. Use precise, formal written language, correct any speech disfluencies, and keep terminology consistent with the glossary. ${FILLER_RULE} Keep the sentence order and the level of detail of the source: do not summarise, do not add information, do not add explanations.`

// Paragraph-level mode: the source is several finished sentences of one
// continuous stretch of speech, so the output must read as ONE paragraph —
// pronouns, connectives and tense carried across sentence boundaries, no
// per-sentence restarts, no bullet points.
const SYSTEM_SEGMENT = `You are a professional conference interpreter. The user's text is one continuous stretch of speech, already segmented into sentences. Translate the WHOLE stretch into {target} as a single cohesive paragraph. Requirements: output ONLY the translation; connect the sentences with natural discourse markers so it reads as one paragraph, not as separate sentences; resolve pronouns and ellipsis using the earlier sentences; keep terminology consistent with the glossary; do not summarise, do not add information, do not use bullet points or line breaks. ${FILLER_RULE} The translation must track the source clause by clause: same order, same assertions, no merge and no addition.`

// Pass over an EXISTING translation: the paragraph grew, or an earlier sentence
// was corrected after the offline pass. Rewriting from the source each time
// would re-roll wording the viewer already read, so the previous translation is
// supplied and only the parts that changed should move.
const SYSTEM_REFINE = `You are a professional conference interpreter revising your own draft translation. You receive the current source text and your previous translation of its earlier part. Produce the translation of the FULL current source, in {target}. Keep every part of the previous translation that still matches the source: the reader has already seen it and re-wording it is a visible glitch. Only change what the new or corrected source requires. Requirements: output ONLY the translation; one cohesive paragraph; no bullets, no line breaks, no notes. ${FILLER_RULE}`

// Transcript repair: the ONLY prompt that returns SOURCE text rather than a
// translation. Streaming recognition plus a single offline pass still leaves
// homophone errors and dropped syllables, and a wrong word in the left column
// becomes a wrong sentence in the right one. The model sees the paragraph and
// fixes what a human reader would stumble over — never rewrites, never
// summarises, never translates.
const SYSTEM_REPAIR = `You repair a speech-recognition transcript of a meeting. The user sends one paragraph of raw ASR output and you return the SAME paragraph with recognition errors fixed.

Rules:
- Output ONLY the corrected paragraph, in the SAME language as the input. Never translate it.
- Keep the speaker's wording and sentence order. Do not summarise, do not add information, do not explain.
- Fix what is plainly a recognition error: homophones, split or merged words, repeated syllables from a stuttering decoder, missing or wrong punctuation, wrong number or name spelling when the surrounding context makes the right one obvious.
- Use the glossary spellings when a term in the text clearly refers to a glossary entry.
- Remove filler sounds and hesitation noise: 嗯 呃 啊 哦 就是说 那个什么, um, uh, er, like, you know.
- If a stretch is too garbled to infer, delete it rather than inventing words.
- Never add quotation marks or commentary around the result.`

// Sentence-aligned paragraph mode: the source is N sentences and the answer
// must be exactly N lines, one translated sentence per source sentence. The
// caller verifies the line count before trusting the mapping, so a model that
// merges or splits simply falls back to the unaligned paragraph.
const SYSTEM_ALIGNED = `You are a professional conference interpreter. The user sends one paragraph of source text split into numbered sentences. Translate EVERY sentence into {target} and return exactly one line per sentence, in the same order, with no numbering and no blank lines. Line 1 is the translation of sentence 1, line 2 of sentence 2, and so on. Translate each sentence faithfully on its own while keeping the paragraph coherent: resolve pronouns using the earlier sentences, keep terminology consistent with the glossary, correct speech disfluencies. Output ONLY those lines. ${FILLER_RULE}`

export class TranslatorUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'TranslatorUnavailable'
  }
}

// Pick the cheapest flash-tier model from the host catalogue. The default DSH
// model can be a slow "pro" model (a minute per short paragraph in testing),
// which makes live drafting unusable. This only runs when nobody chose a model;
// a user's explicit panel choice always wins.
async function pickFlash(llm) {
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch {
    providers = []
  }
  for (const entry of Array.isArray(providers) ? providers : []) {
    let models = []
    try {
      models = await llm.listModels(entry.id)
    } catch {
      models = []
    }
    for (const pick of Array.isArray(models) ? models : []) {
      const id = String(pick.id ?? '').toLowerCase()
      const name = String(pick.name ?? '').toLowerCase()
      if ((id.includes('flash') || name.includes('flash')) && !id.includes('pro')) {
        return { provider: entry.id, model: pick.id }
      }
    }
  }
  return null
}

export async function resolveModel(ctx, wanted, preferFast = false) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new TranslatorUnavailable('宿主没有 llm 服务')
  let provider = ''
  let model = ''
  // An explicit choice from the panel wins over the profile default: the whole
  // point of the selector is to override what DSH happens to be using.
  if (wanted !== null && wanted !== undefined) {
    provider = String(wanted.provider ?? '')
    model = String(wanted.model ?? '')
  }
  // Live drafting is latency-critical: when nobody chose a model, prefer a
  // flash-tier one over whatever slow default the profile happens to use.
  if ((provider === '' || model === '') && preferFast) {
    const fast = await pickFlash(llm)
    if (fast !== null) {
      provider = fast.provider
      model = fast.model
    }
  }
  if (provider === '' || model === '') {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      provider = String(selection?.provider ?? '')
      model = String(selection?.model ?? '')
    } catch {
      // fall through to discovery
    }
  }
  if (provider !== '' && model !== '') return { llm, provider, model }
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch {
    providers = []
  }
  for (const entry of Array.isArray(providers) ? providers : []) {
    let models = []
    try {
      models = await llm.listModels(entry.id)
    } catch {
      models = []
    }
    const pick = Array.isArray(models) ? models[0] : undefined
    if (pick !== undefined) return { llm, provider: entry.id, model: pick.id }
  }
  throw new TranslatorUnavailable('DSH 里没有可用的对话模型，请先在设置里登录或配置模型')
}

function langName(lang) {
  return lang === 'zh' ? 'Chinese (simplified)' : 'English'
}

function glossaryBlock(glossary) {
  if (!Array.isArray(glossary) || glossary.length === 0) return ''
  const rows = glossary
    .filter((item) => item !== null && typeof item === 'object' && item.source && item.target)
    .slice(0, 60)
    .map((item) => `${item.source} => ${item.target}`)
  if (rows.length === 0) return ''
  return `\nGlossary (must be respected):\n${rows.join('\n')}\n`
}

/**
 * Run one translation request and stream text deltas back to the caller.
 * @returns {Promise<string>} the full translation
 */
export async function translateText(ctx, options) {
  const {
    text,
    source,
    target,
    mode = 'draft',
    context = [],
    glossary = [],
    previous = '',
    sentences = [],
    route = null,
    system: systemOverride,
    maxTokens: maxTokensOverride,
    temperature: temperatureOverride,
    signal,
    onDelta,
    preferFast = false,
  } = options
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  const { llm, provider, model } = await resolveModel(ctx, route, preferFast)

  const minutesMode = mode === 'minutes' || mode === 'minutes-merge'
  const repairMode = mode === 'repair'
  const alignedMode = mode === 'aligned' && Array.isArray(sentences) && sentences.length > 1
  const refineMode = mode === 'refine'
  const segmentMode = mode === 'segment' || mode === 'refine' || alignedMode
  const system =
    systemOverride ??
    (minutesMode
      ? MINUTES_SYSTEM
      : repairMode
        ? SYSTEM_REPAIR
        : alignedMode
          ? SYSTEM_ALIGNED.replace('{target}', langName(target))
          : (refineMode
              ? SYSTEM_REFINE
              : mode === 'revise'
                ? SYSTEM_REVISE
                : segmentMode
                  ? SYSTEM_SEGMENT
                  : SYSTEM_DRAFT
            ).replace('{target}', langName(target)))
  const parts = []
  if (minutesMode) {
    parts.push(trimmed)
  } else {
    if (context.length > 0) {
      parts.push(
        `Previous turns (for terminology and tone continuity):\n${context
          .map((line) => `- ${line}`)
          .join('\n')}\n`,
      )
    }
    parts.push(glossaryBlock(glossary))
    parts.push(`Source language: ${langName(source)}`)
    if (alignedMode) {
      // One output line per input sentence. The numbering is purely positional on
      // our side and the prompt forbids echoing it, so the caller can map line N
      // back to sentence N and keep the two columns visibly in step.
      parts.push(`Sentences:\n${sentences.map((line, index) => `${index + 1}. ${line}`).join('\n')}`)
    } else if (refineMode && String(previous ?? '').trim() !== '') {
      parts.push(
        `Your previous translation (keep its wording wherever the source is unchanged):\n${String(previous).trim()}`,
      )
    }
    if (!alignedMode) parts.push(`Text to translate:\n${trimmed}`)
  }

  let out = ''
  let failure = ''
  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: parts.join('\n') }] }],
    temperature:
      temperatureOverride ??
      (minutesMode ? 0.3 : repairMode ? 0.1 : refineMode ? 0.15 : mode === 'revise' ? 0.2 : segmentMode ? 0.25 : 0.1),
    maxTokens:
      maxTokensOverride ??
      (minutesMode ? 2400 : segmentMode ? 4000 : mode === 'revise' ? 1600 : repairMode ? 1600 : 1600),
    signal,
    purpose: 'live-interpreter',
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
      onDelta?.(chunk.text, out)
      continue
    }
    if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind !== undefined && kind !== 'stop' && kind !== 'success') {
        failure = chunk.reason?.failure?.message ?? `模型返回 ${kind}`
      }
    }
  }
  const result = cleanTranslation(out)
  if (result === '' && failure !== '') throw new Error(failure)
  return result
}

export function cleanTranslation(text) {
  let value = String(text ?? '').trim()
  if (value === '') return ''
  value = value.replace(/^```[a-zA-Z]*\n?/u, '').replace(/\n?```$/u, '')
  value = value.replace(/^(translation|译文|翻译)\s*[:：]\s*/iu, '')
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith('“') && value.endsWith('”') && value.length > 1)
  ) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * Local agreement between two consecutive hypotheses: the leading part they
 * share is what the recognizer has stopped changing, so it is safe to
 * translate; the tail is still volatile and stays dimmed.
 *
 * `previous` is the PREVIOUS hypothesis of the same utterance (not the already
 * committed prefix) — comparing against the committed prefix can only ever
 * shrink, because the committed prefix is by construction a prefix of the
 * previous hypothesis, so the shared part never grows.
 */
export function agreedPrefix(previous, current, lang) {
  const a = String(previous ?? '')
  const b = String(current ?? '')
  if (a === '' || b === '') return ''
  let index = 0
  const limit = Math.min(a.length, b.length)
  while (index < limit && a[index] === b[index]) index += 1
  let stable = b.slice(0, index)
  if (lang === 'en') {
    // Do not cut an English word in half: back off to the last boundary.
    const boundary = Math.max(stable.lastIndexOf(' '), stable.lastIndexOf(','), stable.lastIndexOf('.'))
    if (boundary > 0 && boundary < stable.length - 1) stable = stable.slice(0, boundary + 1)
  }
  return stable
}

/**
 * Fold the newly agreed prefix into the committed one. Growth is monotone
 * while hypotheses keep extending, but a genuine revision (the recognizer
 * rewriting the middle of the sentence) is allowed to pull it back, so the
 * dimmed tail never lies about what was actually heard.
 */
export function foldCommitted(committed, agreed, current) {
  const text = String(current ?? '')
  const next = String(agreed ?? '')
  const old = String(committed ?? '')
  if (next.length >= old.length) return next
  // Shrinking is only allowed when the old prefix no longer matches what the
  // recognizer now says, and never past a still-valid longer prefix.
  return text.startsWith(old) ? old : next
}

/**
 * Split a sentence-aligned reply into one line per source sentence.
 *
 * Returns `null` when the count does not match, and the caller must then fall
 * back to the paragraph translation: a mis-split answer would silently attach
 * sentence 2's translation to sentence 1, which is worse than no alignment.
 * Blank lines and stray numbering are dropped before counting.
 */
export function parseAligned(reply, count) {
  const lines = String(reply ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/u, '').trim())
    .filter((line) => line !== '')
  if (lines.length !== count) return null
  return lines
}

/**
 * Clean a transcript repair. The model is told to return only the paragraph,
 * but wrappers and prefixes are common enough to strip defensively.
 */
export function cleanRepair(text) {
  let value = String(text ?? '').trim()
  if (value === '') return ''
  value = value.replace(/^```[a-zA-Z]*\n?/u, '').replace(/\n?```$/u, '')
  value = value.replace(/^(corrected|repaired|transcript|原文|修正后)\s*[:：]\s*/iu, '')
  return value.replace(/\s*\n+\s*/gu, ' ').trim()
}

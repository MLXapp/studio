/*
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License.
 * (packages/compaction/compaction-basic: summarizer.ts, region.ts, config.ts)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: the above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND.
 */

/**
 * Automatic context compaction for the chat agent loop.
 *
 * When a request reaches 80% of the model's context window, the older part of
 * the history is replaced by one structured checkpoint (a user message) and the
 * most recent ~16% is kept verbatim. A tool call is never separated from its
 * result.
 *
 * The summary itself is produced by the SAME model with the SAME request
 * prefix: system prompt, tool schemas (same order) and the leading messages
 * are replayed unchanged and the summarization instruction is appended as the
 * final user message. That makes the auxiliary request a genuine prefix of the
 * conversation, so the engine's prefix/paged cache is reused instead of
 * re-prefilling everything.
 *
 * Everything here is pure (no Electron, no network) so it can be unit tested;
 * chat.ts supplies the transport and persistence.
 */

/** Request-pressure fraction of the context window that triggers compaction. */
export const COMPACTION_THRESHOLD_RATIO = 0.8

/** Fraction of the context window kept verbatim as the recent tail. */
export const COMPACTION_RETAIN_RATIO = 0.16

/** Used when neither the engine nor the model config reports a window. */
export const DEFAULT_CONTEXT_WINDOW = 32_768

/** Output cap for the summary request (also bounded by the window). */
export const SUMMARY_MAX_TOKENS = 8_192

/** Tags wrapping the structured summary inside the checkpoint message. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a separate summarizer system prompt.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** The 8 section headings every checkpoint must carry, in order. */
export const SUMMARY_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code',
  'Errors and Fixes',
  'Pending Jobs',
  'Current Work',
  'Next Step',
  'Critical Context',
] as const

// ─── Persisted state ─────────────────────────────────────────────────────────

/**
 * What a chat remembers between turns. Every persisted message up to and
 * including `throughMessageId` is replaced by `summary` when history is
 * replayed. If that message no longer exists (deleted, regenerated), the state
 * is stale and the full history is used again.
 */
export interface ChatCompactionState {
  version: 1
  summary: string
  throughMessageId: string
  createdAt: number
  /** How many times this chat has been compacted (merges count too). */
  compactions: number
}

export function parseCompactionState(raw: string | null | undefined): ChatCompactionState | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (
      value && value.version === 1 &&
      typeof value.summary === 'string' && value.summary.trim() &&
      typeof value.throughMessageId === 'string' && value.throughMessageId
    ) {
      return {
        version: 1,
        summary: value.summary,
        throughMessageId: value.throughMessageId,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        compactions: typeof value.compactions === 'number' ? value.compactions : 1,
      }
    }
  } catch {}
  return null
}

/**
 * Split persisted history at the compaction boundary.
 * @returns the messages that follow the boundary, or null when the boundary
 *   message is gone (the state is stale and must be ignored).
 */
export function messagesAfterCompaction<T extends { id: string }>(
  messages: readonly T[],
  state: ChatCompactionState,
): T[] | null {
  const index = messages.findIndex(m => m.id === state.throughMessageId)
  if (index < 0) return null
  return messages.slice(index + 1)
}

// ─── History source tags ─────────────────────────────────────────────────────

/**
 * Request messages built from persisted rows carry the id of the row they came
 * from under this symbol. JSON.stringify ignores symbol keys, so the tag never
 * reaches the wire; object spread copies it, so merged copies keep it.
 */
export const HISTORY_SOURCE_ID = Symbol.for('mlx.harness.historySourceId')

export function tagHistoryMessage<T extends object>(message: T, sourceId: string | undefined): T {
  if (sourceId) (message as any)[HISTORY_SOURCE_ID] = sourceId
  return message
}

export function historySourceId(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const value = (message as any)[HISTORY_SOURCE_ID]
  return typeof value === 'string' ? value : undefined
}

// ─── Checkpoint framing ──────────────────────────────────────────────────────

export function frameSummary(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary.trim()}\n${SUMMARY_CLOSE_TAG}`
}

export function checkpointMessage(summary: string, sourceId?: string): { role: 'user'; content: string } {
  return tagHistoryMessage({ role: 'user' as const, content: frameSummary(summary) }, sourceId)
}

export function isCheckpointMessage(message: any): boolean {
  return !!message && message.role === 'user' && typeof message.content === 'string' &&
    message.content.startsWith(CHECKPOINT_PREAMBLE) && message.content.includes(SUMMARY_OPEN_TAG)
}

/**
 * Clean the model's summary text: drop leaked reasoning, a copied checkpoint
 * frame, and surrounding code fences. Returns '' when nothing usable remains.
 */
export function cleanSummaryText(text: string): string {
  let out = String(text || '')
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // A template-opened reasoning block leaves only its closing tag in content.
  const orphanClose = out.search(/<\/think>/i)
  if (orphanClose >= 0) out = out.slice(orphanClose + '</think>'.length)
  // An unterminated reasoning block means the answer never started.
  const unterminated = out.search(/<think>/i)
  if (unterminated >= 0) out = out.slice(0, unterminated)
  out = out.split(CHECKPOINT_PREAMBLE).join('')
  out = out.split(SUMMARY_OPEN_TAG).join('').split(SUMMARY_CLOSE_TAG).join('')
  out = out.trim()
  const fenced = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) out = fenced[1].trim()
  return out
}

/** Sections of the 8-part template that the summary is missing. */
export function missingSummarySections(summary: string): string[] {
  return SUMMARY_SECTIONS.filter(section => !summary.includes(`## ${section}`))
}

// ─── Token estimation ────────────────────────────────────────────────────────

/** Heuristic chars per token for mixed code/prose (deliberately conservative). */
const CHARS_PER_TOKEN = 3.5
const PER_MESSAGE_OVERHEAD = 4
const IMAGE_TOKENS = 768
const VIDEO_TOKENS = 4096
const AUDIO_TOKENS = 1024

/**
 * Chinese, Japanese and Korean run about one token per character (often more),
 * not 3.5 characters per token: counted separately so a CJK chat is not
 * underestimated threefold.
 */
function isCjk(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)
}

function textTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) if (isCjk(text.charCodeAt(i))) cjk += 1
  return Math.ceil((text.length - cjk) / CHARS_PER_TOKEN + cjk)
}

function contentTokens(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return textTokens(content)
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        if (typeof part === 'string') total += textTokens(part)
        continue
      }
      const type = (part as any).type
      if (type === 'image_url' || type === 'input_image' || type === 'image') total += IMAGE_TOKENS
      else if (type === 'video_url' || type === 'input_video' || type === 'video') total += VIDEO_TOKENS
      else if (type === 'input_audio' || type === 'audio') total += AUDIO_TOKENS
      else if (typeof (part as any).text === 'string') total += textTokens((part as any).text)
      else total += contentTokens((part as any).content)
    }
    return total
  }
  if (typeof content === 'object') return textTokens(JSON.stringify(content))
  return textTokens(String(content))
}

/**
 * Estimate one request message: Chat Completions messages (content,
 * tool_calls, reasoning_content) and Responses items (function_call,
 * function_call_output, reasoning, output_text). Media counts as a fixed cost,
 * never by its base64 length.
 */
export function estimateMessageTokens(message: any): number {
  if (!message || typeof message !== 'object') return 0
  let total = PER_MESSAGE_OVERHEAD
  total += contentTokens(message.content)
  if (typeof message.reasoning_content === 'string') total += textTokens(message.reasoning_content)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      total += textTokens(String(call?.function?.name ?? '')) +
        textTokens(typeof call?.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call?.function?.arguments ?? {}))
    }
  }
  if (typeof message.arguments === 'string') total += textTokens(message.arguments)
  if (typeof message.name === 'string') total += textTokens(message.name)
  if (message.output !== undefined) {
    total += typeof message.output === 'string' ? textTokens(message.output) : contentTokens(message.output)
  }
  if (typeof message.text === 'string') total += textTokens(message.text)
  return total
}

export function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
  if (!tools || tools.length === 0) return 0
  return textTokens(JSON.stringify(tools))
}

export function estimateRequestTokens(messages: readonly unknown[], tools?: readonly unknown[]): number {
  let total = estimateToolsTokens(tools)
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/**
 * Calibrates the heuristic against the server's measured prompt tokens. The
 * gap between the two is mostly a fixed overhead the heuristic cannot see
 * (chat-template tokens, tool schemas the engine merges in, media), so the
 * correction is ADDITIVE: estimate = heuristic + (measured − heuristic) of the
 * last pass that reported usage. It never drops below half the heuristic.
 */
export class TokenCalibrator {
  private first: { h: number; m: number } | null = null
  private last: { h: number; m: number } | null = null

  observe(heuristicTokens: number, measuredPromptTokens: number): void {
    if (!(heuristicTokens > 0) || !(measuredPromptTokens > 0)) return
    const point = { h: heuristicTokens, m: measuredPromptTokens }
    this.first ??= point
    this.last = point
  }

  /**
   * measured ≈ overhead + density × heuristic. One observation gives the
   * overhead alone (density 1); two far enough apart also give the density, so
   * a chat whose text tokenizes denser than the heuristic (code, JSON, other
   * scripts) is not underestimated more and more as it grows, while a short
   * chat with large tool schemas is not overestimated.
   */
  private fit(): { overhead: number; density: number } {
    const { first, last } = this
    if (!last) return { overhead: 0, density: 1 }
    if (first && last.h - first.h >= Math.max(2000, last.h * 0.2)) {
      const density = Math.min(4, Math.max(0.5, (last.m - first.m) / (last.h - first.h)))
      return { overhead: last.m - density * last.h, density }
    }
    return { overhead: last.m - last.h, density: 1 }
  }

  estimate(heuristicTokens: number): number {
    const { overhead, density } = this.fit()
    return Math.max(Math.ceil(heuristicTokens * 0.5), Math.ceil(overhead + density * heuristicTokens))
  }

  /** Real tokens per heuristic token at this size. */
  scale(heuristicTokens: number): number {
    return heuristicTokens > 0 ? this.estimate(heuristicTokens) / heuristicTokens : this.fit().density
  }

  get correction(): number {
    return this.last ? Math.round(this.last.m - this.last.h) : 0
  }
}

/**
 * The token counts in a "prompt too long" rejection, when it states them:
 * vMLX ("has 274320 tokens, max prompt/context tokens is 262144"), OpenAI
 * ("maximum context length is 128000 tokens. However, your messages resulted
 * in 130512 tokens"), Anthropic ("prompt is too long: 210000 tokens > 200000
 * maximum") and llama.cpp-style ("(4500 tokens) exceeds the available context
 * size (4096 tokens)").
 */
export function parseOverflowTokens(detail: string): { promptTokens?: number; maxTokens?: number } {
  const text = String(detail || '').replace(/,(?=\d{3})/g, '')
  const num = (re: RegExp) => {
    const m = text.match(re)
    const v = m ? Number(m[1]) : NaN
    return Number.isFinite(v) && v > 0 ? v : undefined
  }
  const promptTokens =
    num(/has (\d+) tokens/i) ??
    num(/resulted in (\d+) tokens/i) ??
    num(/too long:\s*(\d+) tokens/i) ??
    num(/\((\d+) tokens\) exceeds/i) ??
    num(/(\d+) (?:input |prompt )?tokens? (?:>|exceeds)/i)
  const maxTokens =
    num(/max(?:imum)? (?:prompt\/context |prompt |context )?(?:length |tokens )?(?:is |of )?(\d+)/i) ??
    num(/>\s*(\d+) maximum/i) ??
    num(/context size \((\d+) tokens\)/i) ??
    num(/limit (?:is |of )?(\d+)/i)
  return { ...(promptTokens ? { promptTokens } : {}), ...(maxTokens ? { maxTokens } : {}) }
}

// ─── Context window ──────────────────────────────────────────────────────────

export interface ContextWindowSources {
  /** Engine /health max_prompt_tokens (0 = no limit enforced). */
  engineMaxPromptTokens?: unknown
  /** Session setting "max context" (--max-prompt-tokens). */
  sessionMaxContextLength?: unknown
  /** Model config max_position_embeddings (local) or capability report (remote). */
  modelMaxContextLength?: unknown
}

export interface ResolvedContextWindow {
  tokens: number
  source: 'engine' | 'session' | 'model' | 'default'
  /** False when only the default is known (remote endpoints then compact only on overflow). */
  known: boolean
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** The smallest positive limit MLX Harness knows about wins. */
export function resolveContextWindow(sources: ContextWindowSources): ResolvedContextWindow {
  const candidates: Array<[number | undefined, ResolvedContextWindow['source']]> = [
    [positiveInt(sources.engineMaxPromptTokens), 'engine'],
    [positiveInt(sources.sessionMaxContextLength), 'session'],
    [positiveInt(sources.modelMaxContextLength), 'model'],
  ]
  let best: ResolvedContextWindow | undefined
  for (const [tokens, source] of candidates) {
    if (tokens === undefined) continue
    if (!best || tokens < best.tokens) best = { tokens, source, known: true }
  }
  return best ?? { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default', known: false }
}

export function compactionThresholdTokens(contextWindow: number): number {
  return Math.floor(contextWindow * COMPACTION_THRESHOLD_RATIO)
}

export function compactionRetainTokens(contextWindow: number): number {
  return Math.floor(contextWindow * COMPACTION_RETAIN_RATIO)
}

export function summaryMaxTokens(contextWindow: number): number {
  return Math.max(512, Math.min(SUMMARY_MAX_TOKENS, Math.floor(contextWindow * 0.15)))
}

export function shouldCompact(estimatedTokens: number, contextWindow: number): boolean {
  return estimatedTokens >= compactionThresholdTokens(contextWindow)
}

// ─── Error classification ────────────────────────────────────────────────────

const OVERFLOW_PATTERNS = [
  /prompt[_\s-]?too[_\s-]?long/i,
  /context[_\s-]?length[_\s-]?exceeded/i,
  /maximum context length/i,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context/i,
  /too many (?:input )?tokens/i,
  /input (?:is )?too long/i,
  /reduce the length of the messages/i,
]

/**
 * Whether a provider/engine rejection means "the prompt does not fit". The
 * engine's prefill-admission decline is deliberately NOT included: its remedy
 * is a restart, not a shorter prompt.
 */
export function isPromptOverflowError(status: number | undefined, detail: string): boolean {
  const text = String(detail || '')
  if (/prefill_admission_declined|turn-peak admission declined|prefill admission rejected/i.test(text)) {
    return false
  }
  if (OVERFLOW_PATTERNS.some(re => re.test(text))) return true
  return status === 413
}

// ─── Range selection ─────────────────────────────────────────────────────────

/** Call ids issued by one request message (assistant tool_calls or a Responses function_call). */
function issuedCallIds(message: any): string[] {
  if (!message || typeof message !== 'object') return []
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((c: any) => c?.id).filter((id: unknown): id is string => typeof id === 'string')
  }
  if (message.type === 'function_call' && typeof message.call_id === 'string') return [message.call_id]
  return []
}

/** Call ids answered by one request message (tool result / function_call_output). */
function answeredCallIds(message: any): string[] {
  if (!message || typeof message !== 'object') return []
  if (message.role === 'tool' && typeof message.tool_call_id === 'string') return [message.tool_call_id]
  if (message.type === 'function_call_output' && typeof message.call_id === 'string') return [message.call_id]
  return []
}

function isSystemMessage(message: any): boolean {
  return !!message && (message.role === 'system' || message.role === 'developer')
}

/** Index of the first message after the leading system/developer block. */
export function firstCompactableIndex(messages: readonly unknown[]): number {
  let index = 0
  while (index < messages.length && isSystemMessage(messages[index])) index += 1
  return index
}

/**
 * A cut before `index` is balanced when no tool call id has its call on one
 * side and its result on the other, and when the cut does not fall between a
 * tool call and the multimodal user message that carries its media.
 */
export function isBalancedCut(messages: readonly unknown[], index: number): boolean {
  if (index <= 0 || index >= messages.length) return true
  const head = messages[index] as any
  if (head && (head.type === 'function_call_output' || head.role === 'tool')) return false
  // Responses splits one assistant step into reasoning/output_text/function_call
  // items; keep the step together.
  const previous = messages[index - 1] as any
  if (
    head?.type === 'function_call' &&
    (previous?.type === 'reasoning' || previous?.type === 'output_text' || previous?.type === 'function_call')
  ) return false
  const issued = new Set<string>()
  const answered = new Set<string>()
  for (let i = 0; i < index; i += 1) {
    for (const id of issuedCallIds(messages[i])) issued.add(id)
    for (const id of answeredCallIds(messages[i])) answered.add(id)
  }
  // Every call issued before the cut must also be answered before it ...
  for (const id of issued) if (!answered.has(id)) return false
  // ... and nothing after the cut may refer to a call id from before it.
  for (let i = index; i < messages.length; i += 1) {
    for (const id of answeredCallIds(messages[i])) if (issued.has(id) || answered.has(id)) return false
    for (const id of issuedCallIds(messages[i])) if (issued.has(id)) return false
  }
  return true
}

export interface CompactionRange {
  /** Inclusive first index replaced by the checkpoint. */
  start: number
  /** Inclusive last index replaced by the checkpoint. */
  end: number
}

/**
 * Choose the span to summarize: from the first non-system message up to the
 * point where the most recent `retainTokens` (at least) stay verbatim, never
 * splitting a tool call from its result. Returns null when nothing would be
 * gained (empty span, or a span that is only the previous checkpoint).
 */
export function selectCompactionRange(
  messages: readonly unknown[],
  retainTokens: number,
  estimate: (message: unknown) => number = estimateMessageTokens,
  maxSpanTokens = Infinity,
): CompactionRange | null {
  const start = firstCompactableIndex(messages)
  if (messages.length - start < 2) return null

  let accumulated = 0
  let keepFrom = messages.length
  for (let index = messages.length - 1; index >= start; index -= 1) {
    accumulated += estimate(messages[index])
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  // The span is replayed to the model to be summarized, so it must fit in one
  // request: when it would not, summarize the oldest part that fits now and
  // the rest in a following round (the next span starts with this checkpoint).
  if (Number.isFinite(maxSpanTokens)) {
    let span = 0
    for (let index = start; index < keepFrom; index += 1) {
      span += estimate(messages[index])
      if (span > maxSpanTokens) {
        keepFrom = Math.max(start + 1, index)
        break
      }
    }
  }
  while (keepFrom > start && !isBalancedCut(messages, keepFrom)) keepFrom -= 1
  if (keepFrom <= start) return null

  const end = keepFrom - 1
  if (end === start && isCheckpointMessage(messages[start])) return null
  return { start, end }
}

/**
 * The checkpoint used when a summary cannot be made (the model failed or ran
 * out of room) and the chat would otherwise not fit at all: the older span is
 * dropped, and the model is told so, instead of the message not being sent.
 */
export function trimmedCheckpointSummary(droppedMessages: number, previousSummary?: string): string {
  const note = `## Critical Context\n- ${droppedMessages} earlier message${droppedMessages === 1 ? ' was' : 's were'} removed to fit the model's context window, without a summary. If something from earlier is needed, ask the user.`
  return previousSummary ? `${previousSummary.trim()}\n\n${note}` : note
}

/**
 * The replayed prefix for the summary request: the leading system messages,
 * the span to condense, then the compaction instruction as the final user
 * message. When the span itself ends in a user message, the instruction is
 * appended to a copy of it instead (strict-alternation templates reject two
 * consecutive user turns; the shared token prefix is unchanged).
 */
export function buildSummarizationMessages(messages: readonly any[], range: CompactionRange): any[] {
  const leading = messages.slice(0, range.start)
  const span = messages.slice(range.start, range.end + 1)
  const last = span[span.length - 1]
  if (last && last.role === 'user' && !last.type) {
    const merged = { ...last }
    if (typeof merged.content === 'string') {
      merged.content = `${merged.content}\n\n${COMPACTION_INSTRUCTION}`
    } else if (Array.isArray(merged.content)) {
      merged.content = [...merged.content, { type: 'text', text: COMPACTION_INSTRUCTION }]
    } else {
      merged.content = COMPACTION_INSTRUCTION
    }
    return [...leading, ...span.slice(0, -1), merged]
  }
  return [...leading, ...span, { role: 'user', content: COMPACTION_INSTRUCTION }]
}

/**
 * The persisted row id of the newest message that is COMPLETELY inside the
 * range (a row expanded into several request items counts only when all of
 * its items are covered). Undefined when no persisted row is covered.
 */
export function persistedBoundaryForRange(messages: readonly unknown[], range: CompactionRange): string | undefined {
  const after = new Set<string>()
  for (let i = range.end + 1; i < messages.length; i += 1) {
    const id = historySourceId(messages[i])
    if (id) after.add(id)
  }
  for (let i = range.end; i >= range.start; i -= 1) {
    const id = historySourceId(messages[i])
    if (id && !after.has(id)) return id
  }
  return undefined
}

/** Replace the range with one checkpoint message; everything else is kept as is. */
export function applyCompaction(
  messages: readonly any[],
  range: CompactionRange,
  summary: string,
  boundaryId?: string,
): any[] {
  return [
    ...messages.slice(0, range.start),
    checkpointMessage(summary, boundaryId),
    ...messages.slice(range.end + 1),
  ]
}

/**
 * Where a "current turn starts here" index moves after the range was replaced
 * by a single checkpoint message.
 */
export function shiftIndexAfterCompaction(index: number, range: CompactionRange): number {
  const removed = range.end - range.start + 1
  if (index > range.end) return index - removed + 1
  if (index >= range.start) return range.start + 1
  return index
}

// ─── Summary stream parsing ──────────────────────────────────────────────────

export interface SummaryStreamResult {
  text: string
  finishReason?: string
  error?: string
}

/**
 * Incremental collector for the summary request's SSE stream. Understands
 * Chat Completions chunks and Responses events; reasoning deltas are ignored.
 */
export class SummaryStreamCollector {
  private buffer = ''
  private eventType = ''
  private text = ''
  private finalText = ''
  private finishReason: string | undefined
  private error: string | undefined

  push(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.line(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  finish(): SummaryStreamResult {
    if (this.buffer) {
      this.line(this.buffer)
      this.buffer = ''
    }
    return {
      text: this.text || this.finalText,
      ...(this.finishReason ? { finishReason: this.finishReason } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  private line(raw: string): void {
    const line = raw.replace(/\r$/, '').trim()
    if (!line) {
      this.eventType = ''
      return
    }
    if (line.startsWith('event:')) {
      this.eventType = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (parsed?.error) {
      const err = parsed.error
      this.error = typeof err === 'string' ? err : err?.message || JSON.stringify(err)
      return
    }
    const type: string = typeof parsed?.type === 'string' ? parsed.type : this.eventType
    if (type && type.startsWith('response.')) {
      if (type === 'response.output_text.delta' && typeof (parsed.delta ?? parsed.text) === 'string') {
        this.text += parsed.delta ?? parsed.text
      } else if (type === 'response.output_text.done' && typeof parsed.text === 'string') {
        this.finalText = parsed.text
      } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        const response = parsed.response ?? parsed
        if (!this.text && !this.finalText) this.finalText = responsesOutputText(response)
        if (type === 'response.incomplete') this.finishReason = 'length'
        else if (type === 'response.failed') {
          this.finishReason = 'error'
          this.error = response?.error?.message || 'summary request failed'
        } else this.finishReason = this.finishReason ?? 'stop'
      }
      return
    }
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined
    if (!choice) return
    const delta = choice.delta ?? choice.message
    if (delta && typeof delta.content === 'string') this.text += delta.content
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      this.finishReason = choice.finish_reason
    }
  }
}

function responsesOutputText(response: any): string {
  if (!response || typeof response !== 'object') return ''
  if (typeof response.output_text === 'string') return response.output_text
  const parts: string[] = []
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type !== 'message') continue
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('')
}

/**
 * Turn a finished summary stream into checkpoint text, failing closed: an
 * error, a truncated summary, an empty one, or one that is not smaller than
 * the span it replaces is rejected (the caller then keeps the history).
 */
export function acceptSummary(result: SummaryStreamResult, replacedTokens: number): string {
  if (result.error) throw new Error(`summary request failed: ${result.error}`)
  const summary = cleanSummaryText(result.text)
  if (result.finishReason === 'length') {
    throw new Error('summary was truncated at the token cap (incomplete checkpoint)')
  }
  if (!summary) throw new Error('summary request produced no text')
  const framedTokens = estimateMessageTokens(checkpointMessage(summary))
  if (framedTokens >= replacedTokens) {
    throw new Error(`summary is not smaller than the history it replaces (${framedTokens} >= ${replacedTokens} estimated tokens)`)
  }
  return summary
}

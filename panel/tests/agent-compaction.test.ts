import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  COMPACTION_INSTRUCTION,
  CHECKPOINT_PREAMBLE,
  SUMMARY_OPEN_TAG,
  SUMMARY_SECTIONS,
  SummaryStreamCollector,
  TokenCalibrator,
  acceptSummary,
  applyCompaction,
  buildSummarizationMessages,
  checkpointMessage,
  cleanSummaryText,
  compactionRetainTokens,
  compactionThresholdTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  historySourceId,
  isBalancedCut,
  isCheckpointMessage,
  isPromptOverflowError,
  messagesAfterCompaction,
  missingSummarySections,
  parseCompactionState,
  parseOverflowTokens,
  trimmedCheckpointSummary,
  persistedBoundaryForRange,
  resolveContextWindow,
  selectCompactionRange,
  shiftIndexAfterCompaction,
  shouldCompact,
  tagHistoryMessage,
} from '../src/main/agent/compaction'

const big = (n: number) => 'x'.repeat(n)

function chatHistory() {
  return [
    { role: 'system', content: 'You are a coder.' },
    tagHistoryMessage({ role: 'user', content: `first ${big(4000)}` }, 'u1'),
    tagHistoryMessage({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    }, 'a1'),
    tagHistoryMessage({ role: 'tool', tool_call_id: 'c1', content: big(4000) }, 'a1'),
    tagHistoryMessage({ role: 'assistant', content: `done ${big(400)}` }, 'a1'),
    tagHistoryMessage({ role: 'user', content: `second ${big(4000)}` }, 'u2'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: big(400) },
  ]
}

describe('compaction thresholds and window', () => {
  it('triggers at 80% and keeps 16% of the window', () => {
    expect(compactionThresholdTokens(32768)).toBe(26214)
    expect(compactionRetainTokens(32768)).toBe(5242)
    expect(shouldCompact(26213, 32768)).toBe(false)
    expect(shouldCompact(26214, 32768)).toBe(true)
  })

  it('uses the smallest known limit and falls back to a default', () => {
    expect(resolveContextWindow({ engineMaxPromptTokens: 0, sessionMaxContextLength: 0, modelMaxContextLength: 131072 }))
      .toEqual({ tokens: 131072, source: 'model', known: true })
    expect(resolveContextWindow({ engineMaxPromptTokens: 40000, modelMaxContextLength: 131072 }))
      .toEqual({ tokens: 40000, source: 'engine', known: true })
    expect(resolveContextWindow({ sessionMaxContextLength: 16384, modelMaxContextLength: 131072 }).source).toBe('session')
    expect(resolveContextWindow({})).toEqual({ tokens: 32768, source: 'default', known: false })
  })

  it('classifies overflow errors but not the restart-only admission decline', () => {
    expect(isPromptOverflowError(400, 'prompt_too_long: 40000 tokens > 32768')).toBe(true)
    expect(isPromptOverflowError(400, "This model's maximum context length is 8192 tokens")).toBe(true)
    expect(isPromptOverflowError(400, 'context_length_exceeded')).toBe(true)
    expect(isPromptOverflowError(413, 'Payload Too Large')).toBe(true)
    expect(isPromptOverflowError(413, 'prefill_admission_declined: turn-peak admission declined')).toBe(false)
    expect(isPromptOverflowError(500, 'internal error')).toBe(false)
  })
})

describe('token estimation', () => {
  it('counts media as a fixed cost, never by base64 length', () => {
    const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${big(2_000_000)}` } }] }
    expect(estimateMessageTokens(image)).toBeLessThan(2000)
  })

  it('counts tool calls, Responses items and tool schemas', () => {
    expect(estimateMessageTokens({ type: 'function_call', call_id: 'x', name: 'read_file', arguments: big(350) })).toBeGreaterThan(100)
    expect(estimateMessageTokens({ type: 'function_call_output', call_id: 'x', output: big(3500) })).toBeGreaterThan(1000)
    expect(estimateRequestTokens([], [{ type: 'function', function: { name: 'a', description: big(700) } }])).toBeGreaterThan(200)
  })

  it('calibrates the heuristic with the measured overhead of the last pass', () => {
    const calibrator = new TokenCalibrator()
    expect(calibrator.estimate(1000)).toBe(1000)
    // 3,000 tokens of template + merged MCP schemas the heuristic cannot see.
    calibrator.observe(1000, 4000)
    expect(calibrator.correction).toBe(3000)
    expect(calibrator.estimate(20000)).toBe(23000)
    // A conservative heuristic (measured below estimate) lowers it, but never under half.
    calibrator.observe(10000, 8000)
    expect(calibrator.estimate(10000)).toBe(8000)
    calibrator.observe(10000, 1)
    expect(calibrator.estimate(10000)).toBe(5000)
    calibrator.observe(0, 5000)
    expect(calibrator.estimate(10000)).toBe(5000)
  })
})

describe('range selection', () => {
  it('never splits a tool call from its result', () => {
    const messages = chatHistory()
    expect(isBalancedCut(messages, 3)).toBe(false) // between call c1 and its result
    expect(isBalancedCut(messages, 4)).toBe(true)
    expect(isBalancedCut(messages, 7)).toBe(false)
    for (let retain = 0; retain < 6000; retain += 97) {
      const range = selectCompactionRange(messages, retain)
      if (!range) continue
      expect(range.start).toBe(1)
      expect(isBalancedCut(messages, range.end + 1)).toBe(true)
    }
  })

  it('keeps at least the requested recent tail verbatim', () => {
    const messages = chatHistory()
    const range = selectCompactionRange(messages, 200)!
    // The c2 call and its result are not enough for 200 tokens, so the
    // second user turn stays verbatim too.
    expect(range).toEqual({ start: 1, end: 4 })
    const tail = messages.slice(range.end + 1)
    expect(tail.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(selectCompactionRange(messages, 100)).toEqual({ start: 1, end: 5 })
  })

  it('moves the cut earlier rather than splitting a Responses step', () => {
    const items = [
      { role: 'system', content: 's' },
      { role: 'user', content: big(4000) },
      { type: 'reasoning', content: [{ type: 'reasoning', text: big(100) }] },
      { type: 'function_call', call_id: 'f1', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'f1', output: big(4000) },
      { role: 'user', content: 'next' },
    ]
    expect(isBalancedCut(items, 3)).toBe(false)
    expect(isBalancedCut(items, 4)).toBe(false)
    const range = selectCompactionRange(items, 1150)!
    expect(range).toEqual({ start: 1, end: 1 })
  })

  it('returns null when there is nothing to gain', () => {
    expect(selectCompactionRange([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], 0)).toBeNull()
    const onlyCheckpoint = [{ role: 'system', content: 's' }, checkpointMessage('## Primary Request and Intent\n- x'), { role: 'user', content: big(9000) }]
    expect(selectCompactionRange(onlyCheckpoint, 100)).toBeNull()
  })
})

describe('summary request (prefix-cache alignment)', () => {
  it('replays the exact prefix and appends the instruction last', () => {
    const messages = chatHistory()
    const range = { start: 1, end: 4 }
    const request = buildSummarizationMessages(messages, range)
    expect(request.slice(0, 5)).toEqual(messages.slice(0, 5))
    // Same object identity: nothing in the replayed prefix is rewritten.
    for (let i = 0; i < 5; i++) expect(request[i]).toBe(messages[i])
    expect(request[5]).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION })
  })

  it('merges the instruction into a trailing user turn instead of adding a second one', () => {
    const messages = chatHistory()
    const request = buildSummarizationMessages(messages, { start: 1, end: 5 })
    expect(request).toHaveLength(6)
    expect(request[5].content.startsWith((messages[5] as any).content)).toBe(true)
    expect(request[5].content.endsWith(COMPACTION_INSTRUCTION)).toBe(true)
    expect((messages[5] as any).content).not.toContain(COMPACTION_INSTRUCTION)
  })

  it('ports the 8-section template and the merge rule', () => {
    for (const section of SUMMARY_SECTIONS) expect(COMPACTION_INSTRUCTION).toContain(`## ${section}`)
    expect(COMPACTION_INSTRUCTION).toContain('PRIOR checkpoint')
    expect(COMPACTION_INSTRUCTION).toContain('Do not copy it forward verbatim')
    const source = readFileSync('src/main/agent/compaction.ts', 'utf8')
    expect(source.split('\n')[1]).toContain('Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License')
  })

  it('reports missing sections', () => {
    expect(missingSummarySections('## Primary Request and Intent\n- a')).toHaveLength(7)
  })
})

describe('applying a checkpoint', () => {
  it('replaces the range with one tagged checkpoint and shifts indices', () => {
    const messages = chatHistory()
    const range = { start: 1, end: 4 }
    const boundary = persistedBoundaryForRange(messages, range)
    expect(boundary).toBe('a1')
    const next = applyCompaction(messages, range, '## Primary Request and Intent\n- build it', boundary)
    expect(next).toHaveLength(messages.length - 3)
    expect(next[0]).toBe(messages[0])
    expect(isCheckpointMessage(next[1])).toBe(true)
    expect(next[1].content.startsWith(CHECKPOINT_PREAMBLE)).toBe(true)
    expect(next[1].content).toContain(SUMMARY_OPEN_TAG)
    expect(historySourceId(next[1])).toBe('a1')
    expect(JSON.stringify(next[1])).not.toContain('a1')
    expect(shiftIndexAfterCompaction(6, range)).toBe(3)
    expect(shiftIndexAfterCompaction(3, range)).toBe(2)
    expect(shiftIndexAfterCompaction(0, range)).toBe(0)
  })

  it('only counts a persisted row as covered when all of its items are inside the range', () => {
    const messages = chatHistory()
    // Range ends at c1's result; the a1 row continues after it.
    expect(persistedBoundaryForRange(messages, { start: 1, end: 3 })).toBe('u1')
    expect(persistedBoundaryForRange(messages, { start: 6, end: 7 })).toBeUndefined()
  })

  it('round-trips persisted state and detects stale boundaries', () => {
    const state = parseCompactionState(JSON.stringify({ version: 1, summary: 's', throughMessageId: 'm2', createdAt: 1, compactions: 2 }))!
    expect(state.compactions).toBe(2)
    const rows = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
    expect(messagesAfterCompaction(rows, state)).toEqual([{ id: 'm3' }])
    expect(messagesAfterCompaction([{ id: 'm3' }], state)).toBeNull()
    expect(parseCompactionState('{"version":1,"summary":"","throughMessageId":"x"}')).toBeNull()
    expect(parseCompactionState('not json')).toBeNull()
  })
})

describe('summary stream parsing', () => {
  it('collects Chat Completions deltas across chunk boundaries', () => {
    const collector = new SummaryStreamCollector()
    collector.push('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\ndata: {"choices":[{"delta":{"content":"## Pri')
    collector.push('mary"}}]}\n\ndata: {"choices":[{"delta":{"content":" ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n')
    expect(collector.finish()).toEqual({ text: '## Primary ok', finishReason: 'stop' })
  })

  it('collects Responses events and the terminal fallback text', () => {
    const collector = new SummaryStreamCollector()
    collector.push('event: response.output_text.delta\ndata: {"delta":"abc"}\n\n')
    collector.push('data: {"type":"response.completed","response":{"output":[]}}\n\n')
    expect(collector.finish()).toEqual({ text: 'abc', finishReason: 'stop' })

    const fallback = new SummaryStreamCollector()
    fallback.push('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"final"}]}]}}\n')
    expect(fallback.finish().text).toBe('final')

    const truncated = new SummaryStreamCollector()
    truncated.push('data: {"type":"response.output_text.delta","delta":"x"}\ndata: {"type":"response.incomplete","response":{}}\n')
    expect(truncated.finish().finishReason).toBe('length')
  })

  it('fails closed on errors, truncation, empty or non-shrinking summaries', () => {
    expect(() => acceptSummary({ text: 'x', error: 'boom' }, 1000)).toThrow(/boom/)
    expect(() => acceptSummary({ text: 'x', finishReason: 'length' }, 1000)).toThrow(/truncated/)
    expect(() => acceptSummary({ text: '<think>only thinking</think>' }, 1000)).toThrow(/no text/)
    expect(() => acceptSummary({ text: big(20000) }, 100)).toThrow(/not smaller/)
    expect(acceptSummary({ text: '<think>plan</think>\n## Primary Request and Intent\n- x' }, 10000))
      .toBe('## Primary Request and Intent\n- x')
  })

  it('cleans leaked frames, fences and orphan reasoning tags', () => {
    expect(cleanSummaryText('reasoning here</think>\n## Next Step\n- go')).toBe('## Next Step\n- go')
    expect(cleanSummaryText('```markdown\n## Next Step\n- go\n```')).toBe('## Next Step\n- go')
    expect(cleanSummaryText(`${CHECKPOINT_PREAMBLE}\n${SUMMARY_OPEN_TAG}\n## A\n</compacted-summary>`)).toBe('## A')
    expect(cleanSummaryText('## A\n<think>never closed')).toBe('## A')
  })
})


describe('long chats that outgrow the window (prompt_too_long)', () => {
  it('reads the real counts from the rejection', () => {
    expect(parseOverflowTokens('prompt_too_long: text prompt (tokenized) has 274320 tokens, max prompt/context tokens is 262144'))
      .toEqual({ promptTokens: 274320, maxTokens: 262144 })
    expect(parseOverflowTokens("This model's maximum context length is 128000 tokens. However, your messages resulted in 130,512 tokens."))
      .toEqual({ promptTokens: 130512, maxTokens: 128000 })
    expect(parseOverflowTokens('prompt is too long: 210000 tokens > 200000 maximum'))
      .toEqual({ promptTokens: 210000, maxTokens: 200000 })
    expect(parseOverflowTokens('the request exceeds the available context size (4096 tokens), try increasing it')).toEqual({ maxTokens: 4096 })
    expect(parseOverflowTokens('something else')).toEqual({})
  })

  it('counts Chinese, Japanese and Korean at about a token per character', () => {
    const en = estimateMessageTokens({ role: 'user', content: 'a'.repeat(3500) })
    const zh = estimateMessageTokens({ role: 'user', content: '你'.repeat(3500) })
    const ko = estimateMessageTokens({ role: 'user', content: '한'.repeat(1000) })
    expect(en).toBeLessThan(1100)
    expect(zh).toBeGreaterThanOrEqual(3500)
    expect(ko).toBeGreaterThanOrEqual(1000)
  })

  it('learns density from two passes, so a growing chat is not underestimated', () => {
    const c = new TokenCalibrator()
    c.observe(20_000, 40_000)
    c.observe(100_000, 200_000) // tokenizes twice as dense as the heuristic
    expect(c.estimate(130_000)).toBe(260_000)
    expect(c.scale(130_000)).toBeCloseTo(2)
    // A short chat with large tool schemas: the overhead stays fixed.
    const t = new TokenCalibrator()
    t.observe(1_000, 9_000)
    t.observe(5_000, 13_000)
    expect(t.estimate(50_000)).toBe(58_000)
  })

  it('summarizes only as much as fits in one request, the rest in the next round', () => {
    const msgs = [
      { role: 'system', content: 's' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(350) })),
    ]
    const every = selectCompactionRange(msgs, 200)
    expect(every).toEqual({ start: 1, end: 8 })
    const capped = selectCompactionRange(msgs, 200, estimateMessageTokens, 350)
    expect(capped!.start).toBe(1)
    expect(capped!.end).toBeLessThan(4)
  })

  it('says what was dropped when no summary could be made', () => {
    expect(trimmedCheckpointSummary(12)).toContain('12 earlier messages were removed')
    expect(trimmedCheckpointSummary(1, '## Current Work\n- x')).toMatch(/^## Current Work[\s\S]*1 earlier message was removed/)
  })
})

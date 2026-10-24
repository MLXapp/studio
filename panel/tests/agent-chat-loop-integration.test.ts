/**
 * Drives the real chat:sendMessage / chat:compact IPC handlers against a fake
 * OpenAI-compatible engine on 127.0.0.1 (no internet). Electron, SQLite and
 * the session manager are replaced by small in-memory doubles; everything in
 * src/main/ipc/chat.ts and src/main/agent/* runs for real.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const state = {
    userData: '',
    port: 0,
    maxPromptTokens: 4096,
    overrides: {} as Record<string, any>,
    messages: [] as any[],
    agentState: new Map<string, { compactionJson: string | null; todosJson: string | null }>(),
    events: [] as Array<[string, any]>,
    windowGone: false,
  }
  return { handlers, state }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn),
    on: () => undefined,
  },
  BrowserWindow: class {},
  net: { fetch: (...args: any[]) => (globalThis.fetch as any)(...args) },
  app: { getPath: () => h.state.userData },
  clipboard: { readText: () => '', writeText: () => undefined },
}))

vi.mock('../src/main/database', () => {
  const chat = { id: 'chat-1', title: 't', modelPath: '/models/test', modelId: 'test-model', createdAt: 0, updatedAt: 0 }
  const session = () => ({
    id: 'sess-1', status: 'running', host: '127.0.0.1', port: h.state.port, type: 'local',
    modelPath: '/models/test', config: JSON.stringify({}),
  })
  const agent = (id: string) => h.state.agentState.get(id) ?? { compactionJson: null, todosJson: null }
  return {
    db: {
      getChat: (id: string) => (id === chat.id ? chat : undefined),
      getMessages: () => [...h.state.messages].sort((a, b) => a.timestamp - b.timestamp).map(m => ({ ...m })),
      addMessage: (m: any) => {
        const i = h.state.messages.findIndex(x => x.id === m.id)
        if (i >= 0) h.state.messages[i] = { ...m }
        else h.state.messages.push({ ...m })
      },
      deleteMessage: (id: string) => { h.state.messages = h.state.messages.filter(m => m.id !== id) },
      updateMessageContent: () => undefined,
      updateMessageGenerationRecord: () => undefined,
      getChatOverrides: () => ({ ...h.state.overrides }),
      getSetting: () => undefined,
      getSession: () => session(),
      getChatAgentState: (id: string) => agent(id),
      setChatCompactionState: (id: string, json: string | null) => h.state.agentState.set(id, { ...agent(id), compactionJson: json }),
      setChatTodos: (id: string, json: string | null) => h.state.agentState.set(id, { ...agent(id), todosJson: json }),
      deleteChat: () => undefined,
    },
  }
})

vi.mock('../src/main/sessions', () => {
  const session = () => ({
    id: 'sess-1', status: 'running', host: '127.0.0.1', port: h.state.port, type: 'local',
    modelPath: '/models/test', config: JSON.stringify({}),
  })
  return {
    sessionManager: {
      getSessionByModelPath: () => session(),
      getSessions: () => [session()],
      detect: async () => [],
      touchSession: () => undefined,
      getLastHealthyAt: () => Date.now(),
      pushLog: () => undefined,
      emit: () => undefined,
      wakeSession: async () => ({ success: true }),
      waitForSessionLifecycleSettled: async () => 'running',
    },
    resolveUrl: async (url: string) => url,
    connectHost: (host: string) => host,
  }
})

vi.mock('../src/main/ipc/models', () => ({
  readDetectedModelConfig: async () => ({ family: 'qwen3', maxContextLength: 131072 }),
  readGenerationDefaults: async () => ({}),
}))
vi.mock('../src/main/ipc/utils', () => ({ getAuthHeaders: () => ({}) }))

// ── Fake engine ─────────────────────────────────────────────────────────────

type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { kind: 'error'; status: number; message: string }

const requests: any[] = []
let replies: Array<(body: any) => Reply> = []

function sse(res: ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'healthy', model_loaded: true, model_name: 'test-model', max_prompt_tokens: h.state.maxPromptTokens }))
    return
  }
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    requests.push(body)
    const next = replies.shift()
    if (!next) {
      res.writeHead(500)
      res.end('no scripted reply')
      return
    }
    const reply = next(body)
    if (reply.kind === 'error') {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.message } }))
      return
    }
    if (reply.kind === 'text' && req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events: Array<[string, unknown]> = [
        ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', delta: reply.text }],
        ['response.output_text.done', { type: 'response.output_text.done', text: reply.text }],
        ['response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_1', status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply.text }] }],
            usage: { input_tokens: 100, output_tokens: 5 },
          },
        }],
      ]
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
      return
    }
    if (reply.kind === 'text') {
      sse(res, [
        { choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } },
      ])
      return
    }
    sse(res, [
      {
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: reply.calls.map((c, index) => ({
              index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
  })
}

const SUMMARY = '## Primary Request and Intent\n- keep going\n## Key Technical Concepts\n- (none)\n## Files and Code\n- (none)\n## Errors and Fixes\n- (none)\n## Pending Jobs\n- (none)\n## Current Work\n- (none)\n## Next Step\n- (none)\n## Critical Context\n- (none)'

let server: Server
let workDir: string

// One stable window: approval answers are accepted only from its webContents.
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, data: any) => h.state.events.push([channel, data]) },
}

function seedHistory(pairs: number, chars = 4000) {
  h.state.messages = []
  let t = 1000
  for (let i = 0; i < pairs; i++) {
    h.state.messages.push({ id: `u${i}`, chatId: 'chat-1', role: 'user', content: `question ${i} ${'q'.repeat(chars)}`, timestamp: t++ })
    h.state.messages.push({ id: `a${i}`, chatId: 'chat-1', role: 'assistant', content: `answer ${i} ${'a'.repeat(chars)}`, timestamp: t++ })
  }
}

const isSummaryRequest = (body: any) =>
  typeof body.messages?.at(-1)?.content === 'string' && body.messages.at(-1).content.includes('compaction engine')

let send: (content: string) => Promise<any>

beforeAll(async () => {
  h.state.userData = mkdtempSync(join(tmpdir(), 'mlx-userdata-'))
  server = createServer(handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  h.state.port = (server.address() as any).port
  const { registerChatHandlers } = await import('../src/main/ipc/chat')
  registerChatHandlers(() => (h.state.windowGone ? null : fakeWindow) as any)
  send = (content: string) =>
    h.handlers.get('chat:sendMessage')!({}, 'chat-1', content, { host: '127.0.0.1', port: h.state.port })
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

beforeEach(() => {
  requests.length = 0
  replies = []
  h.state.events = []
  h.state.agentState.clear()
  workDir = mkdtempSync(join(tmpdir(), 'mlx-agent-work-'))
  // Full access: these suites test the loop, not permissions (see below).
  h.state.overrides = { wireApi: 'completions', builtinToolsEnabled: true, workingDirectory: workDir, permissionPreset: 'full' }
  h.state.maxPromptTokens = 4096
  h.state.windowGone = false
})

describe('automatic compaction in the chat loop', () => {
  it('compacts at 80% before the request, with a cache-aligned summary call, and persists the checkpoint', async () => {
    seedHistory(4) // ~9k estimated tokens against a 4,096-token window
    replies = [() => ({ kind: 'text', text: SUMMARY }), () => ({ kind: 'text', text: 'Final answer.' })]

    const result = await send('next question')
    expect(result.content).toBe('Final answer.')
    expect(requests).toHaveLength(2)

    const [summary, main] = requests
    expect(isSummaryRequest(summary)).toBe(true)
    // Same model, same tools in the same order, same system prompt.
    expect(summary.model).toBe(main.model)
    expect(summary.tools.map((t: any) => t.function.name)).toEqual(main.tools.map((t: any) => t.function.name))
    expect(summary.messages[0]).toEqual(main.messages[0])
    expect(summary.messages[0].role).toBe('system')
    // The summary request replays the original history (a prefix of what the
    // un-compacted request would have been) and appends the instruction last.
    expect(summary.messages[1].content.startsWith('question 0')).toBe(true)
    expect(summary.tool_choice).toBeUndefined()
    expect(summary.max_tokens).toBeGreaterThan(0)

    // Main request: system, checkpoint, recent tail, new user message.
    expect(main.messages[1].role).toBe('user')
    expect(main.messages[1].content).toContain('<compacted-summary>')
    expect(main.messages[1].content).toContain('## Primary Request and Intent')
    expect(main.messages.at(-1).content).toBe('next question')
    expect(JSON.stringify(main.messages)).not.toContain('question 0 ')

    const state = JSON.parse(h.state.agentState.get('chat-1')!.compactionJson!)
    expect(state.summary).toContain('## Next Step')
    expect(state.throughMessageId).toMatch(/^[ua]\d$/)
    expect(h.state.events.some(([ch, d]) => ch === 'chat:compaction' && d.phase === 'done')).toBe(true)

    // Next turn replays the checkpoint instead of the covered rows.
    replies = [() => ({ kind: 'text', text: 'Second answer.' })]
    requests.length = 0
    await send('and then?')
    expect(requests).toHaveLength(1)
    expect(requests[0].messages[1].content).toContain('<compacted-summary>')
    expect(JSON.stringify(requests[0].messages)).not.toContain('question 0 ')
    expect(requests[0].messages.at(-1).content).toBe('and then?')
  })

  it('compacts once and retries when the engine says the prompt is too long', async () => {
    h.state.maxPromptTokens = 0 // window from the model config (131k): no threshold trigger
    seedHistory(3, 2000)
    replies = [
      () => ({ kind: 'error', status: 400, message: 'prompt_too_long: 9000 tokens exceeds the limit' }),
      () => ({ kind: 'text', text: SUMMARY }),
      () => ({ kind: 'text', text: 'Recovered.' }),
    ]
    const result = await send('go')
    expect(result.content).toBe('Recovered.')
    expect(requests).toHaveLength(3)
    expect(isSummaryRequest(requests[1])).toBe(true)
    expect(requests[2].messages[1].content).toContain('<compacted-summary>')
  })

  it('keeps the full history when the summary is unusable, and still answers', async () => {
    seedHistory(4)
    replies = [() => ({ kind: 'text', text: '' }), () => ({ kind: 'text', text: 'Answer without compaction.' })]
    const result = await send('hi')
    expect(result.content).toBe('Answer without compaction.')
    expect(JSON.stringify(requests[1].messages)).toContain('question 0 ')
    expect(h.state.agentState.get('chat-1')?.compactionJson ?? null).toBeNull()
    expect(h.state.events.some(([ch, d]) => ch === 'chat:compaction' && d.phase === 'failed')).toBe(true)
  })
})

describe('a chat far past the window (prompt_too_long with real counts)', () => {
  // One scripted engine for every request of the turn: summaries are answered
  // by `summary`, the first real request is rejected with the engine's exact
  // wording, later real requests answer.
  const engine = (summary: (body: any) => Reply) => {
    let rejected = false
    return Array.from({ length: 12 }, () => (body: any): Reply => {
      if (isSummaryRequest(body)) return summary(body)
      if (!rejected) {
        rejected = true
        return { kind: 'error', status: 400, message: 'prompt_too_long: text prompt (tokenized) has 350000 tokens, max prompt/context tokens is 131072' }
      }
      return { kind: 'text', text: 'Sent.' }
    })
  }
  const heuristicTokens = (body: any) => Math.ceil(JSON.stringify(body.messages).length / 3.5)

  it('summarizes in parts that each fit, without thinking, and sends the message', async () => {
    h.state.maxPromptTokens = 0 // window from the model config (131k): no threshold trigger
    seedHistory(30, 20_000) // ~350k tokens
    replies = engine(() => ({ kind: 'text', text: SUMMARY }))
    const result = await send('one more thing')
    expect(result.content).toBe('Sent.')
    const summaries = requests.filter(isSummaryRequest)
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    for (const s of summaries) {
      // Each summary request fits the window, and the model answers it directly.
      expect(heuristicTokens(s)).toBeLessThan(131072)
      expect(s.chat_template_kwargs?.enable_thinking).toBe(false)
    }
    const last = requests.at(-1)
    expect(isSummaryRequest(last)).toBe(false)
    expect(heuristicTokens(last)).toBeLessThan(131072 * 0.7)
    expect(last.messages.at(-1).content).toBe('one more thing')
  })

  it('drops the oldest messages (and says so) when no summary can be made, instead of not sending', async () => {
    h.state.maxPromptTokens = 0
    seedHistory(30, 20_000)
    replies = engine(() => ({ kind: 'text', text: '' }))
    const result = await send('still there?')
    expect(result.content).toBe('Sent.')
    const last = requests.at(-1)
    expect(last.messages[1].content).toContain('removed to fit the model\'s context window')
    expect(heuristicTokens(last)).toBeLessThan(131072)
    expect(h.state.events.some(([ch, d]) => ch === 'chat:compaction' && d.phase === 'done' && d.trimmed)).toBe(true)
  })
})

describe('compaction inside a tool loop', () => {
  it('compacts between tool rounds and still persists every tool call of the turn', async () => {
    h.state.maxPromptTokens = 18000 // fits the full built-in catalog (memory, tasks, browser tools included)
    h.state.messages = []
    h.state.overrides = { ...h.state.overrides, toolResultMaxChars: 40000 }
    writeFileSync(join(workDir, 'big.log'), 'start\n' + 'x'.repeat(60_000) + '\nTHE END\n')
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'c1', name: 'run_command', args: { command: 'cat big.log' } }] }),
      () => ({ kind: 'tool', calls: [{ id: 'c2', name: 'run_command', args: { command: 'cat big.log | head -c 70000' } }] }),
      () => ({ kind: 'text', text: SUMMARY }),
      () => ({ kind: 'text', text: 'Both logs read.' }),
    ]
    const result = await send('read the logs')
    expect(result.content).toBe('Both logs read.')
    expect(requests).toHaveLength(4)
    expect(isSummaryRequest(requests[2])).toBe(true)
    const final = requests[3].messages
    expect(final[1].content).toContain('<compacted-summary>')
    // c1 was summarized; c2 and its result stay verbatim and paired.
    expect(final.some((m: any) => m.tool_call_id === 'c1')).toBe(false)
    expect(final.some((m: any) => m.tool_call_id === 'c2')).toBe(true)
    expect(final.some((m: any) => m.tool_calls?.[0]?.id === 'c2')).toBe(true)
    // The persisted assistant row still records the whole turn.
    const row = h.state.messages.find(m => m.id === result.id)
    expect(JSON.parse(row.toolCallsOaiJson).map((c: any) => c.id)).toEqual(['c1', 'c2'])
    expect(JSON.parse(row.toolResultsOaiJson).map((c: any) => c.tool_call_id)).toEqual(['c1', 'c2'])
  })

  it('compacts and retries when a follow-up after a tool result is too long', async () => {
    h.state.maxPromptTokens = 0
    seedHistory(3, 2000)
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'd1', name: 'get_current_datetime', args: {} }] }),
      () => ({ kind: 'error', status: 413, message: 'Request too large' }),
      () => ({ kind: 'text', text: SUMMARY }),
      () => ({ kind: 'text', text: 'It is late.' }),
    ]
    const result = await send('what time is it?')
    expect(result.content).toBe('It is late.')
    expect(isSummaryRequest(requests[2])).toBe(true)
    expect(requests[3].messages.some((m: any) => m.tool_call_id === 'd1')).toBe(true)
  })
})

describe('compaction over the Responses API (local default wire)', () => {
  it('sends the same instructions and tools, with the instruction as the last input item', async () => {
    h.state.overrides = { ...h.state.overrides, wireApi: 'responses' }
    seedHistory(4)
    replies = [() => ({ kind: 'text', text: SUMMARY }), () => ({ kind: 'text', text: 'Responses answer.' })]
    const result = await send('next')
    expect(result.content).toBe('Responses answer.')
    const [summary, main] = requests
    expect(summary.input.at(-1).content).toContain('compaction engine')
    expect(summary.instructions).toBe(main.instructions)
    expect(summary.tools.map((t: any) => t.name)).toEqual(main.tools.map((t: any) => t.name))
    expect(summary.max_output_tokens).toBeGreaterThan(0)
    expect(main.input[0].content).toContain('<compacted-summary>')
    expect(main.input.at(-1).content).toBe('next')
  })
})

describe('/compact', () => {
  it('compacts on demand without adding a user turn', async () => {
    h.state.maxPromptTokens = 0
    seedHistory(3, 1500)
    const before = h.state.messages.length
    replies = [() => ({ kind: 'text', text: SUMMARY })]
    const result = await h.handlers.get('chat:compact')!({}, 'chat-1', { host: '127.0.0.1', port: h.state.port })
    expect(result).toMatchObject({ success: true, compacted: true })
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    expect(h.state.messages).toHaveLength(before)
    expect(isSummaryRequest(requests[0])).toBe(true)
    expect(JSON.parse(h.state.agentState.get('chat-1')!.compactionJson!).throughMessageId).toBeTruthy()
  })

  it('reports nothing to compact on an empty chat', async () => {
    h.state.messages = []
    const result = await h.handlers.get('chat:compact')!({}, 'chat-1', { host: '127.0.0.1', port: h.state.port })
    expect(result).toMatchObject({ success: true, compacted: false })
    expect(requests).toHaveLength(0)
  })
})

describe('tool loop guards', () => {
  it('refuses an unread edit, prunes + spills a huge result, reminds on repeats, stores todos', async () => {
    h.state.maxPromptTokens = 0
    h.state.messages = []
    writeFileSync(join(workDir, 'a.txt'), 'hello world\n')
    writeFileSync(join(workDir, 'big.log'), 'start\n' + 'x'.repeat(60_000) + '\nTHE END\n')
    const listCall = { id: 'l', name: 'list_directory', args: { path: '.' } }
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'e1', name: 'edit_file', args: { path: 'a.txt', search_text: 'hello', replacement_text: 'bye' } }] }),
      () => ({ kind: 'tool', calls: [{ id: 'r1', name: 'read_file', args: { path: 'a.txt' } }] }),
      () => ({ kind: 'tool', calls: [{ id: 'e2', name: 'edit_file', args: { path: 'a.txt', search_text: 'hello', replacement_text: 'bye' } }] }),
      () => ({ kind: 'tool', calls: [{ id: 'c1', name: 'run_command', args: { command: 'cat big.log' } }] }),
      () => ({ kind: 'tool', calls: [{ ...listCall, id: 'l1' }] }),
      () => ({ kind: 'tool', calls: [{ ...listCall, id: 'l2' }, { ...listCall, id: 'l3' }] }),
      () => ({ kind: 'tool', calls: [{ id: 't1', name: 'todo_write', args: { todos: [{ content: 'Edit a.txt', status: 'completed' }, { content: 'Report', status: 'in_progress' }] } }] }),
      () => ({ kind: 'text', text: 'Done.' }),
    ]
    const result = await send('edit a.txt')
    expect(result.content).toBe('Done.')
    const toolResults = requests.at(-1).messages.filter((m: any) => m.role === 'tool')
    const byId = Object.fromEntries(toolResults.map((m: any) => [m.tool_call_id, m.content]))

    expect(byId.e1).toContain('has not been read in this session')
    expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('bye world\n')
    expect(byId.e2).toContain('Edited a.txt')

    expect(byId.c1).toContain('characters cut from the middle')
    const spill = byId.c1.match(/saved at: (\S+\.txt)/)?.[1]
    expect(spill).toBeTruthy()
    expect(spill.startsWith(join(h.state.userData, 'agent-spill', 'chat-1'))).toBe(true)
    expect(readFileSync(spill, 'utf8')).toContain('THE END')
    expect(byId.c1.trimEnd().endsWith('THE END')).toBe(true)

    // list_directory x3 with identical args: the 3rd carries the note.
    expect(byId.l1).not.toContain('[Note:')
    expect(byId.l3).toContain('[Note: this is call #3 of list_directory')

    expect(byId.t1).toContain('Todo list updated (1/2 completed)')
    expect(JSON.parse(h.state.agentState.get('chat-1')!.todosJson!)).toHaveLength(2)
    expect(await h.handlers.get('chat:getTodos')!({}, 'chat-1')).toHaveLength(2)
  })

  it('offers only the Lean tool set when the preset is Lean', async () => {
    h.state.maxPromptTokens = 0
    h.state.messages = []
    h.state.overrides = { ...h.state.overrides, toolPreset: 'lean' }
    replies = [() => ({ kind: 'text', text: 'ok' })]
    await send('hello')
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual([
      'read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'run_command', 'ask_user',
    ])
    expect(requests[0].messages[0].content).toContain('Tools: read_file, write_file, edit_file')
  })

  it('appends AGENTS.md from the working directory to the system prompt', async () => {
    h.state.maxPromptTokens = 0
    h.state.messages = []
    writeFileSync(join(workDir, 'AGENTS.md'), 'Always run the tests with npm test.')
    replies = [() => ({ kind: 'text', text: 'ok' })]
    await send('hello')
    expect(requests[0].messages[0].role).toBe('system')
    expect(requests[0].messages[0].content).toContain('# Project instructions')
    expect(requests[0].messages[0].content).toContain('Always run the tests with npm test.')
  })
})

// ── Permission presets, approval cards and the sandbox escalation ─────────

async function waitFor<T>(probe: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== null) return value
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}
const cards = () => h.state.events.filter(([ch]) => ch === 'chat:approvalRequest').map(([, d]) => d)
const settled = () => h.state.events.filter(([ch]) => ch === 'chat:approvalSettled').map(([, d]) => d)
const answer = (id: string, value: string, sender: unknown = fakeWindow.webContents) =>
  h.handlers.get('chat:answerApproval')!({ sender }, id, value)
const toolResultsOf = (body: any) =>
  Object.fromEntries(body.messages.filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, m.content]))

describe('permission presets in the chat loop', () => {
  beforeEach(() => {
    h.state.maxPromptTokens = 0
    h.state.messages = []
  })

  it('Read only: shows a card, refuses a foreign sender, runs once allowed', async () => {
    h.state.overrides = { ...h.state.overrides, permissionPreset: 'read-only' }
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'c1', name: 'run_command', args: { command: 'echo hi > out.txt' } }] }),
      () => ({ kind: 'text', text: 'done' }),
    ]
    const pending = send('go')
    const card = await waitFor(() => cards()[0])
    expect(card).toMatchObject({
      chatId: 'chat-1', toolCallId: 'c1', toolName: 'run_command', kind: 'shell',
      subject: 'echo hi > out.txt', why: 'read-only', allowAlways: true,
    })
    expect(await h.handlers.get('chat:pendingApprovals')!({}, 'chat-1')).toHaveLength(1)
    expect(existsSync(join(workDir, 'out.txt'))).toBe(false) // nothing runs before the grant
    expect(await answer(card.id, 'allow-once', {})).toEqual({ accepted: false })
    expect(await answer(card.id, 'allow-once')).toEqual({ accepted: true })
    expect(await answer(card.id, 'deny')).toEqual({ accepted: false }) // one-shot
    const result = await pending
    expect(result.content).toBe('done')
    expect(readFileSync(join(workDir, 'out.txt'), 'utf8')).toBe('hi\n')
    expect(settled()).toEqual([{ id: card.id, chatId: 'chat-1', outcome: 'allow-once' }])
    expect(await h.handlers.get('chat:pendingApprovals')!({}, 'chat-1')).toHaveLength(0)
  })

  it('Read only: a denied write is not performed and the model is told so', async () => {
    h.state.overrides = { ...h.state.overrides, permissionPreset: 'read-only' }
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'w1', name: 'write_file', args: { path: 'new.txt', content: 'x' } }] }),
      () => ({ kind: 'text', text: 'ok' }),
    ]
    const pending = send('write it')
    const card = await waitFor(() => cards()[0])
    expect(card).toMatchObject({ kind: 'write', subject: 'new.txt', allowAlways: false })
    expect(await answer(card.id, 'allow-always')).toEqual({ accepted: false }) // not offered
    await answer(card.id, 'deny')
    await pending
    expect(existsSync(join(workDir, 'new.txt'))).toBe(false)
    expect(toolResultsOf(requests.at(-1)).w1).toMatch(/^Permission denied: .*not run\. Do not retry/)
  })

  it('"Always allow this command in this chat" skips the card next time for the exact command', async () => {
    h.state.overrides = { ...h.state.overrides, permissionPreset: 'read-only' }
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'a1', name: 'run_command', args: { command: 'echo always' } }] }),
      () => ({ kind: 'tool', calls: [{ id: 'a2', name: 'run_command', args: { command: 'echo always' } }] }),
      () => ({ kind: 'tool', calls: [{ id: 'a3', name: 'run_command', args: { command: 'echo other' } }] }),
      () => ({ kind: 'text', text: 'ok' }),
    ]
    const pending = send('go')
    const first = await waitFor(() => cards()[0])
    await answer(first.id, 'allow-always')
    const second = await waitFor(() => cards()[1])
    expect(second.subject).toBe('echo other') // a2 ran without a card
    await answer(second.id, 'deny')
    await pending
    const results = toolResultsOf(requests.at(-1))
    expect(results.a1).toContain('always')
    expect(results.a2).toContain('always')
    expect(results.a3).toMatch(/Permission denied/)
  })

  it('fails closed when there is no window to ask in', async () => {
    h.state.overrides = { ...h.state.overrides, permissionPreset: 'read-only' }
    h.state.windowGone = true
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'g1', name: 'run_command', args: { command: 'echo nope > gone.txt' } }] }),
      () => ({ kind: 'text', text: 'ok' }),
    ]
    await send('go')
    expect(existsSync(join(workDir, 'gone.txt'))).toBe(false)
    expect(toolResultsOf(requests.at(-1)).g1).toMatch(/could not be shown .* not run/)
  })

  it('Stop while a card is open settles it as aborted and runs nothing', async () => {
    h.state.overrides = { ...h.state.overrides, permissionPreset: 'read-only' }
    replies = [() => ({ kind: 'tool', calls: [{ id: 's1', name: 'run_command', args: { command: 'echo x > stopped.txt' } }] })]
    const pending = send('go')
    const card = await waitFor(() => cards()[0])
    await h.handlers.get('chat:abort')!({}, 'chat-1')
    await pending.catch(() => undefined)
    expect(settled()).toEqual([{ id: card.id, chatId: 'chat-1', outcome: 'aborted' }])
    expect(existsSync(join(workDir, 'stopped.txt'))).toBe(false)
  })

  it('a window reload clears only stale locks: a running turn and its card survive', async () => {
    h.state.overrides = { ...h.state.overrides, permissionPreset: 'read-only' }
    replies = [
      () => ({ kind: 'tool', calls: [{ id: 'r1', name: 'run_command', args: { command: 'echo kept' } }] }),
      () => ({ kind: 'text', text: 'still here' }),
    ]
    const pending = send('go')
    const card = await waitFor(() => cards()[0])
    expect(await h.handlers.get('chat:clearStaleLocks')!({})).toEqual({ cleared: 0, running: 1 })
    expect(await h.handlers.get('chat:isStreaming')!({}, 'chat-1')).toBe(true)
    expect((await h.handlers.get('chat:pendingApprovals')!({}, 'chat-1'))[0].id).toBe(card.id)
    await answer(card.id, 'allow-once')
    expect((await pending).content).toBe('still here')
  })

  it('Workspace without a usable sandbox asks before every command', async () => {
    const { resetSeatbeltProbeForTests } = await import('../src/main/agent/seatbelt')
    resetSeatbeltProbeForTests({ available: false, network: false })
    try {
      h.state.overrides = { ...h.state.overrides, permissionPreset: 'workspace' }
      replies = [
        () => ({ kind: 'tool', calls: [{ id: 'n1', name: 'run_command', args: { command: 'echo hi' } }] }),
        () => ({ kind: 'text', text: 'ok' }),
      ]
      const pending = send('go')
      const card = await waitFor(() => cards()[0])
      expect(card).toMatchObject({ kind: 'shell', why: 'no-sandbox' })
      await answer(card.id, 'allow-once')
      await pending
      expect(toolResultsOf(requests.at(-1)).n1).toContain('Exit code: 0')
    } finally {
      resetSeatbeltProbeForTests(undefined)
    }
  })

  it('Workspace: sandboxed failure gets the escalation marker; the retry asks once, a refusal sticks', async () => {
    const seatbelt = await import('../src/main/agent/seatbelt')
    const bin = mkdtempSync(join(tmpdir(), 'mlx-fake-sbx-'))
    const log = join(bin, 'calls.log')
    const fake = join(bin, 'sandbox-exec')
    // Stand-in for /usr/bin/sandbox-exec: record the call, drop "-p <profile>", run the rest.
    writeFileSync(fake, `#!/bin/sh\necho "$1 $3 $4" >> ${JSON.stringify(log)}\nshift 2\nexec "$@"\n`)
    chmodSync(fake, 0o755)
    seatbelt.resetSeatbeltProbeForTests({ available: true, network: true })
    seatbelt.setSandboxExecForTests(fake)
    try {
      h.state.overrides = { ...h.state.overrides, permissionPreset: 'workspace' }
      const blocked = 'echo "touch: /etc/mlx-probe: Operation not permitted" >&2; exit 1'
      const escalate = { command: blocked, sandbox_permissions: 'full_access', justification: 'It must write /etc/mlx-probe.' }
      replies = [
        () => ({ kind: 'tool', calls: [{ id: 'x1', name: 'run_command', args: { command: blocked } }] }),
        () => ({ kind: 'tool', calls: [{ id: 'x2', name: 'run_command', args: escalate }] }),
        () => ({ kind: 'tool', calls: [{ id: 'x3', name: 'run_command', args: escalate }] }),
        () => ({ kind: 'text', text: 'I could not write it.' }),
      ]
      const pending = send('write /etc/mlx-probe')
      const card = await waitFor(() => cards()[0])
      expect(card).toMatchObject({ kind: 'escalation', why: 'escalation', reason: 'It must write /etc/mlx-probe.', subject: blocked, allowAlways: false })
      await answer(card.id, 'deny')
      const result = await pending
      expect(result.content).toBe('I could not write it.')
      expect(cards()).toHaveLength(1) // x3 was refused without a second card

      // The shell tools advertise the escalation fields in Workspace.
      const run = requests[0].tools.find((t: any) => t.function.name === 'run_command')
      expect(run.function.parameters.properties.sandbox_permissions.enum).toEqual(['full_access'])

      const results = toolResultsOf(requests.at(-1))
      expect(results.x1).toContain('Operation not permitted')
      expect(results.x1).toContain('[sandbox: if the failure above is the sandbox, you may retry this exact command ONCE')
      expect(results.x2).toMatch(/Permission denied/)
      expect(results.x3).toMatch(/already refused/)
      // Only the first, sandboxed run went through sandbox-exec, as "-p <profile> /bin/bash -c".
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls).toEqual(['-p /bin/bash -c'])
    } finally {
      seatbelt.resetSeatbeltProbeForTests(undefined)
      seatbelt.setSandboxExecForTests(undefined)
    }
  })

  it('Workspace: an approved escalation runs outside the sandbox', async () => {
    const seatbelt = await import('../src/main/agent/seatbelt')
    const bin = mkdtempSync(join(tmpdir(), 'mlx-fake-sbx-'))
    const fake = join(bin, 'sandbox-exec')
    writeFileSync(fake, '#!/bin/sh\necho "should not run" >&2\nexit 99\n')
    chmodSync(fake, 0o755)
    seatbelt.resetSeatbeltProbeForTests({ available: true, network: true })
    seatbelt.setSandboxExecForTests(fake)
    try {
      h.state.overrides = { ...h.state.overrides, permissionPreset: 'workspace' }
      replies = [
        () => ({ kind: 'tool', calls: [{ id: 'y1', name: 'run_command', args: { command: 'echo free > free.txt', sandbox_permissions: 'full_access', justification: 'Needs the network.' } }] }),
        () => ({ kind: 'text', text: 'ok' }),
      ]
      const pending = send('go')
      const card = await waitFor(() => cards()[0])
      await answer(card.id, 'allow-once')
      await pending
      expect(readFileSync(join(workDir, 'free.txt'), 'utf8')).toBe('free\n')
    } finally {
      seatbelt.resetSeatbeltProbeForTests(undefined)
      seatbelt.setSandboxExecForTests(undefined)
    }
  })
})

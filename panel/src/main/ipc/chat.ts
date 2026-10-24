// vMLX panel chat IPC — authored by Jinho Jang
import { app, ipcMain, BrowserWindow, Notification, net } from "electron";
import { v4 as uuidv4 } from "uuid";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { ClientRequest } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, Chat, Message, Folder } from "../database";
import { captureGenerationPass, type GenerationRecord } from "../session-export";
import { AssistantDisplayTimelineRecorder } from "../../shared/assistantDisplayTimeline";
import { sessionManager, resolveUrl, connectHost } from "../sessions";
import {
  readDetectedModelConfig,
  readGenerationDefaults,
} from "./models";
import type { RemoteDetectedConfig } from "../../shared/remoteModelCapabilities";
import { remoteServerBaseUrl } from "../../shared/remoteApiUrl";
import { accumulateChatToolCallDelta } from "../../shared/chatToolCallDeltas";
import { boundToolResultText, formatMcpToolResult } from "../../shared/mcpToolResult";
import {
  BUILTIN_TOOLS,
  isBuiltinTool,
  AGENTIC_SYSTEM_PROMPT,
} from "../tools/registry";
import {
  executeBuiltinTool,
  registerReadOnlyRoot,
  WORKING_DIR_INDEPENDENT_TOOLS,
} from "../tools/executor";
import {
  MAX_RAW_TOOL_RESULT_CHARS,
  pruneOldSpillFiles,
  pruneToolResult,
  resolvePruneBudget,
  writeSpillFile,
} from "../agent/toolResultPruning";
import { FileReadTracker } from "../agent/readGuard";
import { RepeatCallTracker, appendReminder } from "../agent/repeatCallReminder";
import { parseStoredTodos, parseTodoWriteArgs, renderTodoList } from "../agent/todos";
import {
  LEAN_AGENTIC_SYSTEM_PROMPT,
  applyToolPreset,
  normalizeToolPreset,
  orderToolsForPrefixCache,
} from "../agent/toolPresets";
import { loadProjectInstructions } from "../agent/projectInstructions";
import {
  alwaysAllowKey,
  applyPermissionPresetToTools,
  approvalRefusalMessage,
  decideToolPermission,
  normalizePermissionPreset,
  PLAN_MODE_NOTE,
  sandboxEscalationMarker,
} from "../agent/permissions";
import { ApprovalBroker, type ApprovalCard } from "../agent/approvals";
import { asideMessages } from "../agent/aside";
import { appsService } from "./apps";
import { appsInCall, decideAppCall, wrapUntrusted } from "../apps/composioPolicy";
import { discoverSkills, renderSkillIndex } from "../agent/skills";
import { looksSecret, renderMemoryBlock } from "../memory/store";
import { joinSteer } from "../agent/steer";
import { forgetChatMemoryBlock, frozenMemoryBlock, thawMemoryBlocks } from "../memory/freeze";
import { createTaskFromChat } from "./tasks";
import { describeSchedule, parseSchedule } from "../../shared/schedule";
import { AgentBrowser } from "../browser/agentBrowser";
import { appWindows, createElectronDriver } from "../browser/electronDriver";
import { revealMainWindow } from "../mainWindowRef";
import { turnChanges } from "./changes";
import { BROWSER_TOOL_NAME, describeBrowserAction } from "../browser/toolDefinition";
import { t as tMain } from "../i18n";
import {
  looksLikeSandboxDenial,
  seatbeltSupport,
  workspaceSandboxProfile,
} from "../agent/seatbelt";
import {
  SummaryStreamCollector,
  TokenCalibrator,
  acceptSummary,
  applyCompaction,
  buildSummarizationMessages,
  checkpointMessage,
  cleanSummaryText,
  compactionRetainTokens,
  compactionThresholdTokens,
  firstCompactableIndex,
  parseOverflowTokens,
  trimmedCheckpointSummary,
  estimateMessageTokens,
  estimateRequestTokens,
  historySourceId,
  isCheckpointMessage,
  isPromptOverflowError,
  messagesAfterCompaction,
  parseCompactionState,
  persistedBoundaryForRange,
  resolveContextWindow,
  selectCompactionRange,
  shiftIndexAfterCompaction,
  shouldCompact,
  summaryMaxTokens,
  tagHistoryMessage,
  type ChatCompactionState,
  type SummaryStreamResult,
} from "../agent/compaction";
import { detectModelConfigFromDir } from "../model-config-registry";
import { localEngineReadyFromHealthBody } from "../engineReadiness";
import { getAuthHeaders } from "./utils";
import { resolveProviderRoute, type ProviderRoute } from "../providers/transport";
import { providerErrorMessage } from "../providers/errors";
import type { PipelineFetch } from "../providers/anthropic";
import {
  appendResponseTerminalWarning,
  contextExhaustionNotice,
  dropSupersededRecoveryWarnings,
  effortSubstitutionNotice,
  extractResponsesWarnings,
  responsesTerminalFinishReason,
} from "../../shared/responsesWarnings";
import {
  appendReasoningDelta,
  joinReasoningSegments,
  markReasoningToolBoundary,
  reconcileReasoningSummaryDone,
  visibleReasoningSegments,
} from "../../shared/interleavedReasoning";
import {
  applyPostToolRequestFields,
  captureToolRequestFields,
  DEFAULT_MAX_TOOL_ITERATIONS,
  isToolAuthorizedForCurrentTurn,
  noVisibleToolAnswerWarning,
  requiredToolChoiceNamesForCurrentTurn,
  requestedExactFinalToolNames,
  requestedOnceToolNames,
  requestedScopedToolNames,
  repeatsOnlyCompletedExactlyOnceTools,
  replaySafeToolCallKey,
  requestsExactTextOnlyWithoutToolUse,
  requestsNoToolCalls,
  requestsPrivateReasoningWithoutToolUse,
  scopeToolDefinitionsByName,
  shouldAutoContinueAfterToolUse,
  shouldFinishZayaAppleScriptToolRound,
  shouldPlanCompletedToolAnswerPass,
  toolChoiceForCurrentTurn,
  type ToolRequestFields,
  unavailableRequestedToolNames,
} from "../../shared/toolAutoContinue";
import { buildToolMediaFollowupContent } from "../../shared/toolMediaFollowup";
import { dsv4OutputBudget } from "../../shared/dsv4RequestBudget";
import {
  applyReasoningRequestFields,
  remoteReasoningFormatForUrl,
  type RemoteReasoningFormat,
  type ReasoningEffort,
} from "../../shared/reasoningEffortPolicy";
import {
  isMetalHeadroomBubbleContent,
  nativeMtpChatErrorWarning,
  isPromptTooLongBubbleContent,
  projectedMetalHeadroomChatErrorContent,
  promptTooLongChatErrorContent,
} from "../../shared/chatErrorDisplay";
import {
  reconcileResponsesToolBufferAtStreamEnd,
  resolveNeverEmptyAssistantAnswer,
  TOOL_CALL_MARKER_LINE_START,
} from "../../shared/responsesStreamRecovery";
import {
  stripLeakedToolMarkup,
  stripStreamingToolTags,
  toolMarkupHoldbackLength,
} from "../../shared/toolMarkupSanitizer";
import { appendVisibleToolContent, visibleToolStreamContent } from "../../shared/toolContent";
import { mergeCacheDetails } from "../../shared/cacheMetrics";
import { replayPersistedUserContentParts } from "../../shared/mediaHistoryReplay";
import { hasPersistedUserMedia, resolveChatMediaPolicy } from "../../shared/chatMediaPolicy";
import {
  calculateCachedPromptTps,
  calculatePrefillTps,
  estimateColdPrefillTps,
  summarizePrefillPasses,
  ExchangeFirstTokenClock,
  parseServerDecodeUsage,
  selectFinalDecodeTps,
  type ServerDecodePass,
  summarizeServerDecodePasses,
} from "../../shared/chatMetrics";
import { RemoteRequestMetrics } from "../../shared/remoteRequestMetrics";
import { stripRedundantNamespacedToolPreview } from "../../shared/namespacedToolScaffold";
import { replayPersistedAssistantHistory } from "../../shared/toolHistoryReplay";
import {
  historyIsStableAcrossToolAuthorization,
  shouldReplayHistoricalReasoning,
} from "../../shared/nativeReasoningHistory";
import { orderComposerContentParts } from "../../shared/composerContentOrder";
import { splitResponsesSystemMessages } from "../../shared/responsesSystemMessages";
import {
  ChatStreamServerEventError,
  chatStreamServerEventErrorDetail,
  shouldRethrowChatStreamLineError,
} from "../../shared/chatStreamErrors";
import {
  buildNewChatInheritedOverrides,
  sanitizeChatOverrides,
  sanitizeChatProfileOverrides,
} from "../chat-override-policy";
import {
  reasoningParserIsEnabled,
  resolveEffectiveReasoningParser,
} from "../../shared/reasoningParserAliases";
import {
  historicalUnavailableToolNames,
  latestUserMessageText,
  toolCapabilityFingerprint,
  toolCapabilityEpochInstruction,
  toolCapabilityNames,
} from "../tool-capability-epoch";
import { resolveSlowFamilyTimeoutSeconds } from '../../shared/slowFamilyTimeouts';

// Default connection config (fallback values)
const DEFAULT_PORT = 8000;
const configuredToolStreamStallTimeoutMs = Number(
  process.env.VMLX_TOOL_STREAM_STALL_TIMEOUT_MS,
);
const TOOL_STREAM_STALL_TIMEOUT_MS = Number.isFinite(
  configuredToolStreamStallTimeoutMs,
)
  ? Math.max(5_000, configuredToolStreamStallTimeoutMs)
  : 30_000;


function effectiveFamilyRequestTimeoutSeconds(
  timeoutSeconds: number,
  detectedFamily?: string,
): number {
  // Shared table — see panel/src/shared/slowFamilyTimeouts.ts. This is the
  // timer that actually fails an in-app chat, so a divergence here is
  // immediately user-visible.
  return resolveSlowFamilyTimeoutSeconds(timeoutSeconds, detectedFamily);
}

function shouldSuppressGenericAgenticPromptForNativeTools(
  detectedFamily?: string,
  modelNameOrPath?: string,
): boolean {
  const modelName = String(modelNameOrPath || "").toLowerCase();
  return (
    detectedFamily === "deepseek-v4" ||
    detectedFamily === "lfm2" ||
    detectedFamily === "zaya" ||
    detectedFamily === "zaya1-vl" ||
    detectedFamily === "zaya1_vl" ||
    modelName.includes("zaya") ||
    modelName.includes("lfm2")
  );
}

function isZayaAppleScriptToolBundle(
  detectedFamily?: string,
  modelPath?: string,
): boolean {
  if (detectedFamily !== "zaya" || !modelPath) return false;
  try {
    // The AppleScript fine-tune intentionally keeps the generic ZAYA model
    // type/path. Its local model card is the only stable bundle-owned signal:
    // it names run_applescript and documents raw AppleScript when tools are
    // omitted. Restrict the schema only for that explicit model contract.
    const readme = readFileSync(join(modelPath, "README.md"), "utf8").slice(0, 32_768);
    return /\brun_applescript\b/i.test(readme) && /\bAppleScript\b/i.test(readme);
  } catch {
    return false;
  }
}

function isExpectedChatBackendDisconnectError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException | undefined;
  const code = String(err?.code || "");
  const message = String(err?.message || error || "");
  const cause = (err as any)?.cause;
  const wrappedDisconnects = [
    cause,
    (err as any)?.reason,
    (err as any)?.error,
    (err as any)?.detail,
  ].filter(Boolean);
  const nestedErrors = Array.isArray((err as any)?.errors)
    ? (err as any).errors
    : [];
  return (
    code === "EPIPE" ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    /EPIPE|write EPIPE|broken pipe|socket hang up|connection reset|premature close|stream.*destroyed|write after end/i.test(message) ||
    wrappedDisconnects.some((nested) => isExpectedChatBackendDisconnectError(nested)) ||
    nestedErrors.some((nested) => isExpectedChatBackendDisconnectError(nested))
  );
}

function expectedChatBackendDisconnectError(): NodeJS.ErrnoException {
  const error = new Error(
    "Backend connection closed while streaming response.",
  ) as NodeJS.ErrnoException;
  error.code = "EPIPE";
  return error;
}

function chatBackendRequestWritable(req: ClientRequest): boolean {
  const anyReq = req as ClientRequest & {
    closed?: boolean;
    writableDestroyed?: boolean;
    socket?: { destroyed?: boolean } | null;
  };
  return (
    !anyReq.closed &&
    !anyReq.destroyed &&
    !anyReq.writableEnded &&
    !anyReq.writableDestroyed &&
    !anyReq.socket?.destroyed
  );
}

function endChatBackendRequest(
  req: ClientRequest,
  bodyBuf: Buffer,
  reject: (reason?: unknown) => void,
): void {
  if (!chatBackendRequestWritable(req)) {
    const error = new Error("Backend connection closed before request completed.") as NodeJS.ErrnoException;
    error.code = "EPIPE";
    reject(error);
    return;
  }
  try {
    req.end(bodyBuf);
  } catch (error) {
    if (isExpectedChatBackendDisconnectError(error)) {
      reject(error);
      return;
    }
    throw error;
  }
}

type ComposerAttachment = {
  dataUrl: string;
  name: string;
  kind?: "image" | "video" | "audio" | "text";
  type?: string;
  size?: number;
  text?: string;
};

function inferKind(a: ComposerAttachment): "image" | "video" | "audio" | "text" {
  if (a.kind) return a.kind;
  if (a.text !== undefined) return "text";
  if (a.dataUrl.startsWith("data:audio/")) return "audio";
  if (a.dataUrl.startsWith("data:video/")) return "video";
  if (a.dataUrl.startsWith("data:text/")) return "text";
  return "image";
}

function mimeFromDataUrl(dataUrl?: string): string | undefined {
  return dataUrl?.match(/^data:([^;,]+)[;,]/)?.[1]?.toLowerCase();
}

function redactContentForLog(content: any): any {
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (!part || typeof part !== "object") return { type: typeof part };
      if (part.type === "text") {
        return { type: "text", chars: String(part.text || "").length };
      }
      if (part.type === "image_url") {
        const url = part.image_url?.url || part.image_url;
        return {
          type: "image_url",
          mime: mimeFromDataUrl(typeof url === "string" ? url : undefined),
          data_url_chars: typeof url === "string" && url.startsWith("data:") ? url.length : undefined,
          url: "<redacted>",
        };
      }
      if (part.type === "video_url") {
        const url = part.video_url?.url || part.video_url;
        return {
          type: "video_url",
          mime: mimeFromDataUrl(typeof url === "string" ? url : undefined),
          data_url_chars: typeof url === "string" && url.startsWith("data:") ? url.length : undefined,
          url: "<redacted>",
        };
      }
      if (part.type === "input_audio") {
        return {
          type: "input_audio",
          format: part.input_audio?.format,
          data_chars:
            typeof part.input_audio?.data === "string"
              ? part.input_audio.data.length
              : undefined,
        };
      }
      return { type: part.type || "unknown", keys: Object.keys(part).sort() };
    });
  }
  if (typeof content === "string") return { type: "text", chars: content.length };
  if (content == null) return null;
  return { type: typeof content };
}

function summarizeRequestForLog(bodyJson: string, useResponsesApi: boolean): Record<string, any> {
  try {
    const body = JSON.parse(bodyJson);
    const items = useResponsesApi ? body.input : body.messages;
    return {
      route: useResponsesApi ? "/v1/responses" : "/v1/chat/completions",
      model: body.model,
      stream: body.stream === true,
      max_tokens: body.max_output_tokens ?? body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      min_p: body.min_p,
      repetition_penalty: body.repetition_penalty,
      enable_thinking: body.enable_thinking,
      thinking_mode: body.thinking_mode,
      reasoning_effort: body.reasoning_effort ?? body.reasoning?.effort,
      reasoning_enabled: body.reasoning?.enabled,
      reasoning_strength: body.chat_template_kwargs?.reasoning_strength,
      max_thinking_tokens: body.max_thinking_tokens,
      image_token_budget: body.image_token_budget,
      thinking_budget: body.chat_template_kwargs?.thinking_budget,
      previous_response_id: body.previous_response_id ? "<present>" : undefined,
      has_tools: Array.isArray(body.tools) && body.tools.length > 0,
      tool_choice: body.tool_choice,
      tool_names: Array.isArray(body.tools)
        ? body.tools
            .map((tool: any) => tool?.function?.name ?? tool?.name)
            .filter((name: unknown): name is string => typeof name === "string")
        : [],
      messages: Array.isArray(items)
        ? items.slice(-8).map((m: any) => ({
            role: m.role || m.type || "item",
            content: redactContentForLog(m.content ?? m.input ?? m.output ?? m.text),
          }))
        : redactContentForLog(items),
    };
  } catch (e: any) {
    return { error: `request summary failed: ${e?.message || String(e)}` };
  }
}

function summarizeAttachmentsForLog(attachments?: ComposerAttachment[]): Record<string, any> {
  const counts = { image: 0, video: 0, audio: 0, text: 0 };
  const files: Array<Record<string, any>> = [];
  for (const attachment of attachments || []) {
    const kind = inferKind(attachment);
    counts[kind] += 1;
    files.push({
      kind,
      name: attachment.name,
      mime: attachment.type || mimeFromDataUrl(attachment.dataUrl),
      size: attachment.size,
      data_url_chars: attachment.dataUrl?.startsWith("data:")
        ? attachment.dataUrl.length
        : undefined,
      text_chars: attachment.text?.length,
    });
  }
  return { total: attachments?.length || 0, counts, files };
}

/**
 * SSE-streaming fetch using Node.js http/https directly.
 * Electron 28's global fetch() uses Chromium's net module which buffers
 * SSE chunks instead of delivering them immediately. Node.js http/https
 * streams data as it arrives from the socket.
 */
async function streamingFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const bodyBuf = Buffer.from(init.body, "utf-8");

  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(
        Object.assign(new Error("The operation was aborted."), {
          name: "AbortError",
        }),
      );
      return;
    }

    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = reqFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: init.method,
        // Disable connection pooling — each SSE stream gets a fresh TCP connection.
        // Prevents stale keep-alive connections from causing ECONNRESET/"aborted" errors.
        agent: false,
        headers: {
          ...init.headers,
          "Content-Length": bodyBuf.length.toString(),
        },
      },
      (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;

        if (!ok) {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            settle(() =>
              resolve({
                ok,
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                body: null,
                text: () => Promise.resolve(data),
              }),
            );
          });
          res.on("error", () => {
            settle(() =>
              resolve({
                ok,
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                body: null,
                text: () => Promise.resolve(data),
              }),
            );
          });
          return;
        }

        // Wrap Node.js stream in Web ReadableStream for compatibility with streamSSE
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on("end", () => {
              try {
                controller.close();
              } catch (_) {}
            });
            res.on("error", (err) => {
              if (isExpectedChatBackendDisconnectError(err)) {
                try {
                  controller.error(err);
                } catch (_) {}
                return;
              }
              console.error(
                `[streamingFetch] stream error: message="${(err as any)?.message}" code="${(err as any)?.code}"`,
              );
              try {
                controller.error(err);
              } catch (_) {}
            });
            // Handle premature close (server drops connection before response completes)
            res.on("close", () => {
              if (!res.complete) {
                try {
                  controller.error(
                    new Error("Connection closed before response completed"),
                  );
                } catch (_) {}
              }
            });
          },
          cancel() {
            res.destroy();
          },
        });

        settle(() =>
          resolve({
            ok: true,
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? "OK",
            body: stream,
            text: () =>
              Promise.reject(
                new Error("Cannot read text from streaming response"),
              ),
          }),
        );
      },
    );

    req.on("error", (err) => {
      settle(() => reject(err));
    });

    if (init.signal) {
      const onAbort = () => {
        req.destroy();
        settle(() =>
          reject(
            Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            }),
          ),
        );
      };
      init.signal.addEventListener("abort", onAbort, { once: true });
    }

    endChatBackendRequest(req, bodyBuf, reject);
  });
}

// Common chat template stop tokens that models may generate
const TEMPLATE_STOP_TOKENS = [
  "<|im_end|>",
  "<|im_start|>", // ChatML (Qwen, etc.)
  "<|eot_id|>",
  "<|start_header_id|>", // Llama 3
  "<|end|>",
  "<|user|>",
  "<|assistant|>", // Phi-3
  "</s>",
  "<s>", // Llama 2, Mistral
  "<|endoftext|>", // GPT-NeoX, StableLM
  "[/INST]",
  "[INST]", // Mistral instruct
  "<end_of_turn>", // Gemma
  "<minimax:tool_call>", // MiniMax tool call open tag
  "</minimax:tool_call>", // MiniMax tool call close tag
  "<|start|>",
  "<|channel|>",
  "<|message|>", // Harmony/GPT-OSS protocol (GLM-4.7, GPT-OSS)
];

// Regex to strip any leaked template tokens from output
const TEMPLATE_TOKEN_REGEX = new RegExp(
  TEMPLATE_STOP_TOKENS.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|"),
  "g",
);

/**
 * Use Electron's net.fetch for remote sessions — Chromium's network stack handles
 * HTTPS certificates, system proxies, and SSE streaming properly.
 * Local sessions use streamingFetch (Node.js http/https) to avoid Electron 28's
 * global fetch buffering SSE chunks.
 */
const remoteFetch: typeof globalThis.fetch = (input, init?) =>
  net.fetch(input as any, init as any);

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch (_) {
    return false;
  }
}

const DIRECT_MEDIA_ATTACHMENT_TOOL_RULE =
  "\n\nIMPORTANT: When a user message includes media attachments as chat content, inspect those images, video, or audio directly through the model's multimodal input. Do not call read_image, read_video, or list_directory to find attached media unless the user explicitly gives a local filesystem path.";

/**
 * Oversized tool results are saved in full under <userData>/agent-spill/<chatId>
 * so the model can page through them with read_file instead of re-running the
 * tool. The folder is registered as read-only for the read tools.
 */
function agentSpillRoot(): string {
  return join(app.getPath("userData"), "agent-spill");
}

/**
 * Per-chat agent session state that lives as long as the app: which files the
 * model has read (read-before-edit guard) and how often it repeated a call.
 */
const fileReadTracker = new FileReadTracker();
const repeatCallTracker = new RepeatCallTracker();
/** Heuristic→measured prompt-token ratio per chat (feeds auto compaction). */
const tokenCalibrators = new Map<string, TokenCalibrator>();
function tokenCalibratorFor(chatId: string): TokenCalibrator {
  let calibrator = tokenCalibrators.get(chatId);
  if (!calibrator) {
    calibrator = new TokenCalibrator();
    tokenCalibrators.set(chatId, calibrator);
  }
  return calibrator;
}

/**
 * Exact shell commands the user chose "Always allow this command in this
 * chat" for (in memory: the grant lasts until MLX Harness quits).
 */
const alwaysAllowedCommands = new Map<string, Set<string>>();
/** Code sessions in Plan mode (reading tools only), until switched off. */
const planModeChats = new Set<string>();
/**
 * One agent browser per chat (and so per scheduled task, which has its own
 * chat): its own in-memory session and hidden window, so one chat's sign-ins
 * and pages never reach another. The least recently used closes past 4.
 */
const agentBrowsers = new Map<string, AgentBrowser>();
const MAX_AGENT_BROWSERS = 4;
function agentBrowser(chatId: string): AgentBrowser {
  let b = agentBrowsers.get(chatId);
  if (b) {
    agentBrowsers.delete(chatId);
    agentBrowsers.set(chatId, b);
    return b;
  }
  b = new AgentBrowser(createElectronDriver(undefined, { allowLocal: false }), { allowLocal: false });
  agentBrowsers.set(chatId, b);
  while (agentBrowsers.size > MAX_AGENT_BROWSERS) {
    const [oldest, ob] = agentBrowsers.entries().next().value as [string, AgentBrowser];
    agentBrowsers.delete(oldest);
    void ob.close().then(() => ob.dispose());
  }
  return b;
}
/** Chats whose context holds web pages or MCP results in this app run. */
const chatsWithExternalData = new Set<string>();
/** Chats whose context holds data read from an app (Composio) in this app run. */
const chatsWithAppData = new Set<string>();
/**
 * Steering: text the user sent while a turn runs. It joins the turn at the
 * next tool step (after the tool results, before the model continues). What
 * a turn never picks up goes back to the renderer as queued messages.
 */
const steerQueues = new Map<string, Array<{ id: string; text: string }>>();
const STEER_NOTE = "[The user added this while you were working. Take it into account from here on:]";
/** U+2063 (invisible) marks the real additions, so typed text never splits. */
const STEER_ADDED_PREFIX = "\u2063[Added while working]";

/** Running side questions, by chat, so closing the card stops the model. */
const asideControllers = new Map<string, AbortController>();

/** A Deny the user explained: the model gets their words with the refusal. */
function withDenyNote(message: string, note: string): string {
  const text = note.trim();
  if (!text) return message;
  return `${message}\n\nThe user said instead: ${JSON.stringify(text)}. Do what they asked.`;
}

/** Steers a turn never picked up go back to the renderer's queue for that chat. */
function returnUnusedSteers(chatId: string, _getWindow?: () => BrowserWindow | null): void {
  const unused = steerQueues.get(chatId);
  steerQueues.delete(chatId);
  const items = unused ?? [];
  // Always sent (also when empty): the renderer clears its "Joining…" chips.
  try {
    for (const w of appWindows()) w.webContents.send("chat:steerUnused", { chatId, items });
  } catch (_) {}
}

/** Add the Plan mode note to the end of this turn's user message (request only). */
function withPlanModeNote(messages: any[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") {
      messages[i] = { ...m, content: `${m.content}\n\n${PLAN_MODE_NOTE}` };
    } else if (Array.isArray(m.content)) {
      messages[i] = { ...m, content: [...m.content, { type: "text", text: PLAN_MODE_NOTE }] };
    }
    return;
  }
}

/** Approval cards between the agent loop and the chat window (set up in registerChatHandlers). */
let approvalBroker: ApprovalBroker | null = null;

/**
 * Chats whose agent turn is running right now (used by the quit
 * confirmation to name what quitting would interrupt).
 */
export function activeAgentChatIds(): string[] {
  return [...activeRequests.entries()]
    .filter(([, entry]) => !entry.controller.signal.aborted)
    .map(([chatId]) => chatId);
}

/** The model's stated intent for the pending call: its text before the tool call, last paragraph. */
function statedIntent(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!cleaned) return undefined;
  const paragraphs = cleaned.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].replace(/\s+/g, " ").trim();
  if (!last) return undefined;
  return last.length > 280 ? `…${last.slice(-279)}` : last;
}

/** Forget a deleted chat's agent session state and spilled tool results. */
function clearChatAgentRuntime(chatId: string): void {
  alwaysAllowedCommands.delete(chatId);
  fileReadTracker.clear(chatId);
  repeatCallTracker.clear(chatId);
  tokenCalibrators.delete(chatId);
  // Everything else this app run keeps per chat.
  steerQueues.delete(chatId);
  planModeChats.delete(chatId);
  chatsWithAppData.delete(chatId);
  chatsWithExternalData.delete(chatId);
  forgetChatMemoryBlock(chatId);
  turnChanges.forget(chatId);
  const browser = agentBrowsers.get(chatId);
  if (browser) {
    agentBrowsers.delete(chatId);
    void browser.close().then(() => browser.dispose());
  }
  if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]+$/.test(chatId)) return;
  try {
    rmSync(join(agentSpillRoot(), chatId), { recursive: true, force: true });
  } catch (_) {}
}

/** Canonical tool order for the cached prompt prefix (registry order). */
const BUILTIN_TOOL_ORDER: readonly string[] = BUILTIN_TOOLS.map(
  (tool) => tool.function.name,
);

// Tool category definitions for per-category filtering
const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "patch_file",
  "batch_edit",
  "copy_file",
  "move_file",
  "delete_file",
  "restore_file",
  "create_directory",
  "list_directory",
  "insert_text",
  "replace_lines",
  "apply_regex",
  "read_image",
  "read_video",
]);
const SEARCH_TOOLS = new Set([
  "search_files",
  "find_files",
  "file_info",
  "get_diagnostics",
  "get_tree",
  "diff_files",
]);
const SHELL_TOOLS = new Set([
  "run_command",
  "run_applescript",
  "spawn_process",
  "get_process_output",
]);
const DDG_SEARCH_TOOLS = new Set(["ddg_search"]);
const FETCH_TOOLS = new Set(["fetch_url", "browser"]);
/** Tools whose results are text from outside (pages, search results). */
const EXTERNAL_DATA_TOOLS = new Set(["fetch_url", "browser", "web_search", "ddg_search"]);
const GIT_TOOLS = new Set(["git"]);
const UTILITY_TOOLS = new Set([
  "count_tokens",
  "clipboard_read",
  "clipboard_write",
  "get_current_datetime",
]);
// ask_user is intentionally excluded from UTILITY_TOOLS — it's a core IPC tool that should
// always be available regardless of the utilityToolsEnabled toggle.

/** Build set of disabled tool names based on per-category toggle overrides */
/** Memory on (Preferences → Memory). Default on. */
function memoryEnabled(): boolean {
  try { return db.getSetting("memory_enabled") !== "0"; } catch { return false; }
}

/** remember / recall / forget against the app's memory store. */
function runMemoryTool(name: string, args: Record<string, any>, chatId: string): { text: string; isError: boolean } {
  if (!memoryEnabled()) return { text: "Memory is off in Preferences → Memory.", isError: true };
  const store = db.memory;
  const notify = () => {
    for (const w of appWindows()) w.webContents.send("memory:changed");
  };
  try {
    if (name === "remember") {
      const text = String(args.text ?? "").trim();
      if (!text) return { text: "Nothing to remember: pass text.", isError: true };
      if (looksSecret(text)) return { text: "Not saved: that looks like a password, key or card number. Memory never stores secrets.", isError: true };
      const { entry, duplicate } = store.add(text, chatId);
      notify();
      return { text: duplicate ? `Already remembered [${entry.id}]: ${entry.text}` : `Remembered [${entry.id}]: ${entry.text}`, isError: false };
    }
    if (name === "recall") {
      const found = store.search(String(args.query ?? ""), 8);
      return { text: found.length ? found.map((e) => `[${e.id}] ${e.text}`).join("\n") : "Nothing saved matches that.", isError: false };
    }
    const id = String(args.id ?? "").trim();
    const entry = store.get(id);
    if (!entry) return { text: `No memory with id ${id}. Use recall to find it.`, isError: true };
    store.delete(id);
    thawMemoryBlocks();
    notify();
    return { text: `Forgot [${id}]: ${entry.text}`, isError: false };
  } catch (err: any) {
    return { text: `Memory error: ${err?.message ?? err}`, isError: true };
  }
}

function getDisabledTools(overrides: any): Set<string> {
  const disabled = new Set<string>();
  if (!memoryEnabled()) ["remember", "recall", "forget"].forEach((t) => disabled.add(t));
  // use_skill only when there are skills to load (catalog stays stable while
  // the skill folders are unchanged).
  if (discoverSkills(overrides?.workingDirectory || undefined).length === 0) disabled.add("use_skill");
  if (overrides.fileToolsEnabled === false)
    FILE_TOOLS.forEach((t) => disabled.add(t));
  if (overrides.searchToolsEnabled === false)
    SEARCH_TOOLS.forEach((t) => disabled.add(t));
  if (overrides.shellEnabled === false)
    SHELL_TOOLS.forEach((t) => disabled.add(t));
  if (overrides.webSearchEnabled === false)
    DDG_SEARCH_TOOLS.forEach((t) => disabled.add(t));
  if (overrides.fetchUrlEnabled === false)
    FETCH_TOOLS.forEach((t) => disabled.add(t));
  if (overrides.gitEnabled === false) GIT_TOOLS.forEach((t) => disabled.add(t));
  if (overrides.utilityToolsEnabled === false)
    UTILITY_TOOLS.forEach((t) => disabled.add(t));
  // Brave web_search requires API key — always disable if no key configured
  // (user must explicitly enable Brave search via braveSearchEnabled toggle)
  if (overrides.braveSearchEnabled === false) {
    disabled.add("web_search");
  } else {
    const braveKey = db.getSetting("braveApiKey");
    if (!braveKey && !process.env.BRAVE_API_KEY) {
      disabled.add("web_search");
    }
  }
  return disabled;
}

/** Filter BUILTIN_TOOLS based on per-category toggle overrides */
function filterTools(
  overrides: any,
  context: {
    zayaAppleScriptToolBundle?: boolean;
  } = {},
): any[] {
  const availableTools = context.zayaAppleScriptToolBundle
    ? BUILTIN_TOOLS.filter((t: any) => t.function.name === "run_applescript")
    : BUILTIN_TOOLS;
  const disabled = getDisabledTools(overrides);
  if (disabled.size === 0) return availableTools;
  return availableTools.filter((t: any) => !disabled.has(t.function.name));
}

// Track active requests per chat for abort/concurrency (B5/B6)
const activeRequests = new Map<
  string,
  {
    controller: AbortController;
    /** Last activity (reset by every streamed chunk: the stale-lock clock). */
    startedAt: number;
    /** When the turn began (for "the reply finished" notifications). */
    turnStartedAt?: number;
    timeoutMs: number;
    responseId?: string;
    endpoint?: { host: string; port: number };
    baseUrl?: string;
    authHeaders?: Record<string, string>;
  }
>();
// Stale lock: each request stores its timeoutMs; stale check uses timeoutMs + 30s buffer

// ask_user: single global listener with Map-based resolver (prevents listener accumulation)
const askUserResolvers = new Map<string, (answer: string) => void>();
ipcMain.on("chat:answerUser", (_, chatId: string, answer: string) => {
  const resolve = askUserResolvers.get(chatId);
  if (resolve) {
    askUserResolvers.delete(chatId);
    resolve(answer);
  }
});

/**
 * Ask the engine to cancel one request, then abort its local stream (the
 * same lifecycle ordering as chat:abort), so the turn saves what it has.
 */
function cancelAndAbortEntry(
  chatId: string,
  entry: { controller: AbortController; responseId?: string; endpoint?: { host: string; port: number }; baseUrl?: string; authHeaders?: Record<string, string> },
): void {
  // Start server-side cancellation before closing the local stream, for
  // the same lifecycle ordering used by chat:abort.
  if (entry.responseId && (entry.endpoint || entry.baseUrl)) {
    try {
      const cancelPath = entry.responseId.startsWith("resp_")
        ? `/v1/responses/${entry.responseId}/cancel`
        : `/v1/chat/completions/${entry.responseId}/cancel`;
      const cancelBase =
        entry.baseUrl ||
        `http://${connectHost(entry.endpoint!.host)}:${entry.endpoint!.port}`;
      fetch(`${cancelBase}${cancelPath}`, {
        method: "POST",
        headers: entry.authHeaders || {},
        signal: AbortSignal.timeout(2000),
      }).catch(() => {}); // Fire-and-forget, don't block window close
      console.log(
        `[CHAT] Cancel sent for ${chatId} (${entry.responseId})`,
      );
    } catch (_) {}
  }
  try {
    entry.controller.abort();
  } catch (_) {}
}

/**
 * Stop every running chat turn (explicit reset, or a confirmed Quit).
 * Pending approval cards resolve as stopped.
 */
export function abortAllChatRequests(): number {
  const count = activeRequests.size;
  for (const [chatId, entry] of activeRequests) cancelAndAbortEntry(chatId, entry);
  activeRequests.clear();
  approvalBroker?.cancelAll("aborted");
  return count;
}

/** Abort all active chat requests targeting a specific endpoint (called when session stops) */
export function abortByEndpoint(host: string, port: number): number {
  let count = 0;
  for (const [chatId, entry] of activeRequests) {
    if (entry.endpoint?.host === host && entry.endpoint?.port === port) {
      console.log(
        `[CHAT] Aborting chat ${chatId} — session endpoint ${host}:${port} stopped`,
      );
      // Send server cancel if we have a response ID (fire-and-forget)
      if (entry.responseId && (entry.baseUrl || entry.endpoint)) {
        const cancelPath = entry.responseId.startsWith("resp_")
          ? `/v1/responses/${entry.responseId}/cancel`
          : `/v1/chat/completions/${entry.responseId}/cancel`;
        const cancelBase = entry.baseUrl || `http://${host}:${port}`;
        fetch(`${cancelBase}${cancelPath}`, {
          method: "POST",
          headers: entry.authHeaders || {},
          signal: AbortSignal.timeout(1000),
        }).catch(() => {
          /* server may already be stopped */
        });
      }
      try {
        entry.controller.abort();
      } catch (_) {}
      activeRequests.delete(chatId);
      returnUnusedSteers(chatId);
      count++;
    }
  }
  return count;
}

/** Resolved endpoint info including optional session reference */
interface ResolvedEndpoint {
  host: string;
  port: number;
  session?: import("../database").Session;
}

/** Resolve endpoint for a chat: use modelPath to find session, fallback to detection */
async function resolveServerEndpoint(
  modelPath?: string,
): Promise<ResolvedEndpoint> {
  // 1. If chat has modelPath, find its session (normalize to handle trailing slash)
  if (modelPath) {
    const session = sessionManager.getSessionByModelPath(
      modelPath.replace(/\/+$/, ""),
    );
    // loading/standby resolve too: a message sent mid-load queues against
    // this session (exactly once, Stop cancels) and a sleeping one wakes it.
    if (
      session &&
      (session.status === "running" ||
        session.status === "loading" ||
        session.status === "standby")
    ) {
      return { host: session.host, port: session.port, session };
    }
  }

  // 2. Detect any running processes
  const processes = await sessionManager.detect();
  const healthy = processes.find((p) => p.healthy);
  if (healthy) {
    // Use 127.0.0.1 for connection (0.0.0.0 is a bind address, not connectable)
    return { host: "127.0.0.1", port: healthy.port };
  }

  return { host: "127.0.0.1", port: DEFAULT_PORT };
}

/**
 * Send a prompt as a new turn in a chat, from main (scheduled tasks). Set by
 * registerChatHandlers. A local model must be running: a task never falls
 * back to whatever other model happens to be up.
 */
export let runChatTurnFromMain: (chatId: string, prompt: string) => Promise<{ ok: boolean; error?: string; retry?: boolean; code?: string }> =
  async () => ({ ok: false, error: "Chat is not ready yet." });

/** Successful turns shorter than this never notify (the user was probably watching). */
const TURN_NOTIFY_MIN_SECONDS = 20;
let notifyTurnEnded: (chatId: string, outcome: "done" | "failed", startedAt?: number) => void = () => {};
/** Chats whose current turn was started by a scheduled task. */
const unattendedTurns = new Set<string>();

export function registerChatHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  try {
    registerReadOnlyRoot(agentSpillRoot());
    pruneOldSpillFiles(agentSpillRoot());
  } catch (err) {
    console.warn("[CHAT] Could not prepare the tool-result spill folder", err);
  }

  // Approval cards. A request is shown in the current window; with no window
  // it fails closed at once, and if that window is destroyed while cards are
  // pending they all resolve as refused. A reloaded window re-reads pending
  // cards (chat:pendingApprovals), so a reload does not lose them.
  const watchedContents = new WeakSet<object>();
  const watchWindowGone = (win: BrowserWindow) => {
    const wc: any = win.webContents;
    if (!wc || watchedContents.has(wc) || typeof wc.once !== "function") return;
    watchedContents.add(wc);
    wc.once("destroyed", () => {
      const n = approvalBroker?.cancelAll("unavailable") ?? 0;
      if (n > 0) console.log(`[CHAT] Window closed: ${n} pending approval(s) refused`);
    });
  };
  const notifyIfAway = (win: BrowserWindow, card: ApprovalCard) => {
    try {
      const visible = typeof win.isVisible === "function" ? win.isVisible() : true;
      const focused = typeof win.isFocused === "function" ? win.isFocused() : true;
      if (visible && focused) return;
      if (typeof Notification !== "function" || !Notification.isSupported()) return;
      const subject = card.subject.replace(/\s+/g, " ").trim();
      const note = new Notification({
        title: tMain("main.notify.approvalTitle"),
        body: `${card.toolName}: ${subject.length > 120 ? `${subject.slice(0, 119)}…` : subject}`,
      });
      note.on("click", () => {
        const w = getWindow();
        if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      });
      note.show();
    } catch (_) {
      /* notifications are a convenience */
    }
  };
  // End-of-turn notification (Atomic Agent pattern): when the window is in
  // the background, say the answer is ready, but only for turns long enough
  // that the user likely switched away; a failed turn always says so.
  notifyTurnEnded = (chatId: string, outcome: "done" | "failed", startedAt?: number) => {
    try {
      // Scheduled tasks notify on their own (once per run).
      if (unattendedTurns.has(chatId)) return;
      // A closed window (the turn keeps running) still gets the notice.
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        const visible = typeof win.isVisible === "function" ? win.isVisible() : true;
        const focused = typeof win.isFocused === "function" ? win.isFocused() : true;
        if (visible && focused) return;
      }
      const seconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
      if (outcome === "done" && seconds < TURN_NOTIFY_MIN_SECONDS) return;
      if (typeof Notification !== "function" || !Notification.isSupported()) return;
      const title = String(db.getChat(chatId)?.title || "").replace(/\s+/g, " ").trim();
      const note = new Notification({
        title: tMain(outcome === "done" ? "main.notify.turnDone" : "main.notify.turnFailed"),
        body: title.length > 120 ? `${title.slice(0, 119)}…` : title,
        silent: outcome === "done",
      });
      note.on("click", () => revealMainWindow("chat:openFromNotification", { chatId }));
      note.show();
    } catch (_) {
      /* notifications are a convenience */
    }
  };
  /** The Dock shows how many requests wait for your OK (any chat). */
  const updateNeedsYouBadge = () => {
    try {
      if (process.platform !== "darwin" || !app.dock) return;
      const n = approvalBroker?.size ?? 0;
      app.dock.setBadge(n > 0 ? String(n) : "");
    } catch (_) { /* no Dock (tests) */ }
  };
  approvalBroker = new ApprovalBroker({
    show: (card) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return false;
      watchWindowGone(win);
      win.webContents.send("chat:approvalRequest", card);
      notifyIfAway(win, card);
      // Registered before show(): the count already includes this card.
      setTimeout(updateNeedsYouBadge, 0);
      return true;
    },
    settled: (card, outcome) => {
      setTimeout(updateNeedsYouBadge, 0);
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("chat:approvalSettled", {
          id: card.id,
          chatId: card.chatId,
          outcome,
        });
      }
    },
  });
  ipcMain.handle(
    "chat:answerApproval",
    (event: any, id: string, answer: string, note?: string) => {
      // Only the chat window may answer (not another BrowserWindow).
      const win = getWindow();
      if (!win || win.isDestroyed() || event?.sender !== win.webContents) {
        return { accepted: false };
      }
      return { accepted: approvalBroker?.answer(id, answer, note) ?? false };
    },
  );
  ipcMain.handle("chat:pendingApprovals", (_, chatId: string) =>
    approvalBroker?.list(typeof chatId === "string" ? chatId : undefined) ?? [],
  );
  ipcMain.handle("chat:sandboxStatus", () => seatbeltSupport());
  const pushChatSessionLog = (sessionId: string | undefined, line: string) => {
    if (!sessionId) return;
    const data = line.endsWith("\n") ? line : `${line}\n`;
    sessionManager.pushLog(sessionId, data);
    sessionManager.emit("session:log", { sessionId, data });
  };

  // Folders
  ipcMain.handle(
    "chat:createFolder",
    async (_, name: string, parentId?: string) => {
      const folder: Folder = {
        id: uuidv4(),
        name,
        parentId,
        createdAt: Date.now(),
      };
      db.createFolder(folder);
      return folder;
    },
  );

  ipcMain.handle("chat:getFolders", async () => {
    return db.getFolders();
  });

  ipcMain.handle("chat:deleteFolder", async (_, id: string) => {
    db.deleteFolder(id);
    return { success: true };
  });

  // Chats
  const createChatRecord = (
    title: string,
    modelId: string,
    folderId?: string,
    modelPath?: string,
    kind?: "chat" | "code",
  ): Chat => {
    const chat: Chat = {
      id: uuidv4(),
      title,
      folderId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId,
      modelPath,
    };
    db.createChat(chat);

      // Do not seed new chats from per-model settings or sibling chats. A
      // clean chat starts with no overrides; the engine resolves bundle
      // defaults and explicit chat/API settings are stored only per chat.
      // Default profiles / sibling chats may carry tool and workspace
      // ergonomics into a clean chat, but sampling/reasoning/system prompts are
      // intentionally excluded so bundle generation defaults stay authoritative.
      try {
        const defaultProfile = db.getDefaultChatProfile();
        if (defaultProfile) {
          const existing = db.getChatOverrides(chat.id) || { chatId: chat.id };
          // Default profiles are auto-applied at chat creation time, so treat
          // them as coding/tool presets. Manual profile loads can still apply
          // full sampler/reasoning/prompt settings after the user chooses them.
          const merged = buildNewChatInheritedOverrides(
            existing as any,
            sanitizeChatProfileOverrides(defaultProfile) as any,
          );
          db.setChatOverrides(merged as any);
          console.log(
            `[CHAT] Applied default profile coding/tool settings to new chat ${chat.id}; generation/reasoning defaults stayed model-derived`,
          );
        } else {
          // No starred profile — honor the visible "last chat" contract across
          // model switches. Skip this newly inserted row and any older chat
          // without an override record instead of stopping at an empty sibling.
          // The inheritance policy still copies only tool/workspace ergonomics;
          // sampling, prompts, and reasoning remain model-derived.
          const lastInherited = db
            .getRecentChats(100)
            .filter((candidate) => candidate.id !== chat.id)
            .map((candidate) => ({
              chat: candidate,
              overrides: db.getChatOverrides(candidate.id),
            }))
            .find((candidate) => candidate.overrides !== undefined);
          if (lastInherited?.overrides) {
            const existing = db.getChatOverrides(chat.id) || {
              chatId: chat.id,
            };
            const merged = buildNewChatInheritedOverrides(
              existing as any,
              lastInherited.overrides as any,
            );
            db.setChatOverrides(merged);
            console.log(
              `[CHAT] Inherited coding/tool settings from last chat ${lastInherited.chat.id.slice(0, 8)}; generation/reasoning defaults stayed model-derived`,
            );
          }
        }
      } catch (e) {
        console.error("[CHAT] Failed to apply default profile:", e);
      }

    // The Chat tab's chats never pick up a project folder from an earlier
    // chat: a working directory makes a chat a Code session, which is chosen
    // explicitly in the Code tab. Other inherited tool settings stay.
    if (kind === "chat") {
      try {
        const inherited = db.getChatOverrides(chat.id);
        if (inherited?.workingDirectory) {
          db.setChatOverrides({ ...inherited, workingDirectory: undefined } as any);
        }
      } catch (e) {
        console.error("[CHAT] Failed to keep the new chat out of Code:", e);
      }
    }

    return chat;
  };

  ipcMain.handle(
    "chat:create",
    async (
      _,
      title: string,
      modelId: string,
      folderId?: string,
      modelPath?: string,
      kind?: "chat" | "code",
    ) => createChatRecord(title, modelId, folderId, modelPath, kind === "chat" || kind === "code" ? kind : undefined),
  );

  // SessionView effects can be replayed in development. Keep the initial
  // chat lookup and insert in one main-process turn so replay cannot create
  // two empty chats for the same newly launched model.
  ipcMain.handle(
    "chat:ensureForModel",
    async (_, title: string, modelPath: string) => {
      const existing = db.getChatsByModelPath(modelPath)[0];
      return existing ?? createChatRecord(title, "default", undefined, modelPath);
    },
  );

  ipcMain.handle("chat:getByModel", async (_, modelPath: string) => {
    return db.getChatsByModelPath(modelPath);
  });

  ipcMain.handle("chat:getRecent", async (_, limit: number) => {
    return db.getRecentChats(limit);
  });

  ipcMain.handle("chat:getAll", async (_, folderId?: string) => {
    return db.getChats(folderId);
  });

  ipcMain.handle("chat:get", async (_, id: string) => {
    return db.getChat(id);
  });

  ipcMain.handle(
    "chat:update",
    async (_, id: string, updates: Partial<Chat>) => {
      db.updateChat(id, updates);
      return { success: true };
    },
  );

  ipcMain.handle("chat:delete", async (_, id: string) => {
    db.deleteChat(id);
    clearChatAgentRuntime(id);
    return { success: true };
  });

  // vmlx#70: bulk-delete. Reporter wanted "mass delete or wipe chat
  // history" instead of one-by-one. This single handler covers:
  //   - wipe everything:               {}
  //   - wipe unfiled:                  { folderId: "unfiled" }
  //   - wipe one folder:               { folderId: "<id>" }
  //   - wipe all chats for a model:    { modelPath: "<path>" }
  // Returns the count so the UI can confirm "N chats deleted".
  ipcMain.handle(
    "chat:deleteAll",
    async (_, scope?: { folderId?: string; modelPath?: string }) => {
      try {
        const before = db.getChats().map((c) => c.id);
        const deleted = db.deleteAllChats(scope);
        // Same cleanup as deleting one chat: browsers, queues, flags, and the
        // Changes checkpoints (copies of the files those chats edited).
        const left = new Set(db.getChats().map((c) => c.id));
        for (const id of before) if (!left.has(id)) clearChatAgentRuntime(id);
        turnChanges.prune(left);
        return { success: true, deleted };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle("chat:deleteMessage", async (_, messageId: string) => {
    db.deleteMessage(messageId);
    return { success: true };
  });

  ipcMain.handle("chat:deleteMessagesFrom", async (_, chatId: string, fromTimestamp: number) => {
    db.deleteMessagesFrom(chatId, fromTimestamp);
    return { success: true };
  });

  ipcMain.handle("chat:search", async (_, query: string) => {
    return db.searchChats(query);
  });

  // Messages
  ipcMain.handle("chat:getMessages", async (_, chatId: string) => {
    return db.getMessages(chatId);
  });

  ipcMain.handle(
    "chat:addMessage",
    async (_, chatId: string, role: string, content: string) => {
      // Ensure chat exists (FK constraint on messages.chat_id)
      const chat = db.getChat(chatId);
      if (!chat) {
        throw new Error(`Cannot add message: chat ${chatId} not found`);
      }
      const message: Message = {
        id: uuidv4(),
        chatId,
        role: role as "system" | "user" | "assistant",
        content,
        timestamp: Date.now(),
      };
      db.addMessage(message);
      return message;
    },
  );

  // Send message and get streaming response
  // Optional 4th arg: endpoint override { host, port } for multi-server support
  // Optional 5th arg: attachments from the chat composer. Media attachments
  // force multimodal routing; text files are inlined as text context.
  // `kind` distinguishes image, video, audio, and text so we emit the right
  // OpenAI content part. Back-compat: undefined `kind` falls back to detection
  // via the data URL mime prefix below.
  //
  // mode "compact" (chat:compact, the /compact command) runs the same setup —
  // endpoint, wake, health, system prompt, tools, history replay — and then
  // only compacts the history instead of sending a new user turn.
  const handleSendMessage = async (
      _: unknown,
      chatId: string,
      content: string,
      endpoint?: { host: string; port: number },
      attachments?: Array<{
        dataUrl: string;
        name: string;
        kind?: "image" | "video" | "audio" | "text";
        type?: string;
        size?: number;
        text?: string;
      }>,
      mode: "send" | "compact" | "aside" = "send",
    ): Promise<any> => {
      // B6: Concurrency guard — reject if a request is already active for this chat
      // B6: Concurrency guard with stale lock recovery
      // A side question ("aside") runs next to a running reply and leaves it alone.
      const existing = mode === "aside" ? undefined : activeRequests.get(chatId);
      if (existing) {
        const age = Date.now() - existing.startedAt;
        // Use the timeout configured when that request started, plus 30s buffer
        // Cap at 30 minutes to prevent indefinite lock (e.g. serverTimeout=86400s)
        const staleLockMs = Math.min(
          existing.timeoutMs + 30_000,
          30 * 60 * 1000,
        );
        // An ALREADY-ABORTED controller can never produce a response, so it
        // must never hold the chat hostage for the full stale window. Every
        // abort path (session down, explicit Stop, window reload) deletes the
        // entry itself; this is the backstop for the one that forgets. Without
        // it a single missed delete makes the chat silently unusable for up to
        // 30 minutes — the user sends, sees their message appear, and gets a
        // toast that vanishes.
        const abandoned = existing.controller.signal.aborted;
        if (abandoned || age > staleLockMs) {
          // Lock is stale or abandoned — abort and clear it
          console.log(
            `[CHAT] Clearing ${abandoned ? "abandoned" : "stale"} lock for ${chatId} ` +
              `(${Math.round(age / 1000)}s old, limit ${Math.round(staleLockMs / 1000)}s)`,
          );
          try {
            existing.controller.abort();
          } catch (_) {}
          activeRequests.delete(chatId);
        } else {
          throw new Error("A message is already being generated for this chat");
        }
      }

      // B5: Create AbortController for this request
      const abortController = new AbortController();
      let timedOut = false;
      if (mode === "aside") {
        // One side question per chat: a new one replaces (stops) the last.
        asideControllers.get(chatId)?.abort();
        asideControllers.set(chatId, abortController);
      }

      const chat = db.getChat(chatId);
      if (!chat) {
        throw new Error("Chat not found");
      }

      // A chat bound to a provider model (Preferences → Models: a cloud API, a
      // compatible endpoint, or Ollama / LM Studio) runs through the remote
      // code path with that provider's endpoint, credential and protocol.
      // The binding wins over the renderer endpoint and the chat's local
      // model path; switching the model mid-chat applies here, next request.
      const providerRoute: ProviderRoute | undefined = (() => {
        let binding;
        try {
          binding = db.providers.getChatBinding(chatId);
        } catch {
          return undefined;
        }
        if (!binding) return undefined;
        return resolveProviderRoute(binding, {
          getProvider: (id) => db.providers.get(id),
          resolveCredential: (id) => db.providers.resolveCredential(id),
          nodeFetch: streamingFetch as PipelineFetch,
          netFetch: remoteFetch as unknown as PipelineFetch,
        });
      })();

      // Look up session for this chat — needed for timeout, reasoning parser,
      // AND for endpoint resolution (remote sessions need remoteUrl/apiKey/type)
      let timeoutSeconds = 300;
      let sessionHasReasoningParser = false;
      let isHarmonyModel = false;
      let chatIsMultimodal = false;
      let chatModelForceTextOnly = false;
      let chatDetectedFamily: string | undefined;
      let chatModelMaxContextLength: number | undefined;
      let chatUsesZayaAppleScriptToolBundle = false;
      let thinkingBudgetSupported: boolean | undefined;
      let supportsThinkingBudget: boolean | undefined;
      let supportsInstructMode: boolean | undefined;
      let supportsAdaptiveThinking: boolean | undefined;
      let supportsThinking: boolean | undefined;
      let supportedReasoningEfforts: ReasoningEffort[] | undefined;
      let remoteReasoningFormat: RemoteReasoningFormat | undefined;
      let defaultReasoningEffort: ReasoningEffort | undefined;
      let chatSessionConfig: Record<string, unknown> = {};
      let sessionImageTokenBudget: number | undefined;
      // VLM video sampling (Qwen 3.6, Qwen3.5-VL, etc.) — forwarded as
      // video_fps / video_max_frames on the request body when present.
      // Default undefined = engine default (2.0 fps, 8 max frames).
      let sessionVideoFps: number | undefined;
      let sessionVideoMaxFrames: number | undefined;
      let sessionVideoMaxPixels: number | undefined;
      let sessionVideoTokenBudget: number | undefined;
      let chatSession: import("../database").Session | undefined;
      if (providerRoute) {
        // Not a stored session: a remote-shaped description of the provider
        // route (see providers/transport.ts). Capabilities come from the
        // model row the user configured in Preferences → Models.
        chatSession = providerRoute.session;
        timeoutSeconds = 600;
        const providerModel = providerRoute.model;
        chatModelMaxContextLength = providerModel?.contextWindow;
        chatIsMultimodal = providerModel ? providerModel.input.includes("image") : false;
        const levels = providerModel?.reasoningEfforts?.filter(
          (level): level is ReasoningEffort => level !== "off",
        );
        supportedReasoningEfforts = levels && levels.length > 0 ? levels : undefined;
      } else if (chat.modelPath) {
        chatSession = sessionManager.getSessionByModelPath(
          chat.modelPath.replace(/\/+$/, ""),
        );
        if (!chatSession) {
          // Path mismatch fallback: HF repo ID vs resolved local path can differ
          // (e.g., "org/Model-CRACKED-MLX" resolves to directory "org/Model-CRACK").
          // Try matching by basename as a last resort.
          const basename = chat.modelPath.replace(/\/+$/, "").split("/").pop();
          if (basename) {
            const allSessions = sessionManager.getSessions();
            chatSession = allSessions.find(
              (s) =>
                (s.status === "running" ||
                  s.status === "loading" ||
                  s.status === "standby") &&
                s.modelPath.split("/").pop()?.replace(/\/+$/, "") === basename,
            );
            if (chatSession) {
              console.log(
                `[CHAT] Session found by basename fallback: ${basename} → ${chatSession.id.slice(0, 8)}`,
              );
            } else {
              console.warn(
                `[CHAT] No session found for modelPath=${chat.modelPath} — timeout will use default 300s`,
              );
            }
          }
        }
        if (chatSession) {
          // Touch session to reset idle timer — prevents premature sleep during active chat
          sessionManager.touchSession(chatSession.id);
          try {
            const sessionConfig = JSON.parse(chatSession.config);
            chatSessionConfig = sessionConfig;
            if (sessionConfig.timeout === 0) {
              // "No limit" — match the 86400s (24h) that sessions.ts sends via --timeout
              timeoutSeconds = 86400;
            } else if (sessionConfig.timeout && sessionConfig.timeout > 0) {
              timeoutSeconds = sessionConfig.timeout;
            }
            // Check if model has a reasoning parser (for enable_thinking default)
            // Remote sessions have no readable local bundle directory. Hydrate
            // the exact live family/parser/cache contract from the model's
            // capability endpoint instead of guessing from its display alias.
            const detected =
              (await readDetectedModelConfig(chat.modelPath)) ??
              ({} as RemoteDetectedConfig);
            try {
              const generationDefaults = await readGenerationDefaults(chat.modelPath);
              thinkingBudgetSupported = generationDefaults?.thinkingBudgetSupported;
            } catch {
              thinkingBudgetSupported = undefined;
            }
            chatDetectedFamily = detected.family;
            chatModelMaxContextLength = detected.maxContextLength;
            chatModelForceTextOnly = detected.forceTextOnly === true;
            chatUsesZayaAppleScriptToolBundle = isZayaAppleScriptToolBundle(
              chatDetectedFamily,
              chat.modelPath,
            );
            supportsThinkingBudget = detected.supportsThinkingBudget;
            supportsInstructMode = detected.supportsInstructMode;
            supportsAdaptiveThinking = detected.supportsAdaptiveThinking;
            supportsThinking = detected.supportsThinking;
            supportedReasoningEfforts = detected.supportedReasoningEfforts;
            remoteReasoningFormat = detected.remoteReasoningFormat;
            defaultReasoningEffort = detected.defaultReasoningEffort;
            timeoutSeconds = effectiveFamilyRequestTimeoutSeconds(
              timeoutSeconds,
              chatDetectedFamily,
            );
            const smeltActive = !!sessionConfig.smelt;
            chatIsMultimodal = resolveChatMediaPolicy({
              smelt: smeltActive,
              forceTextOnly: detected.forceTextOnly,
              detectedMultimodal: detected.isMultimodal,
              configuredMode: sessionConfig.isMultimodal,
            }).multimodal;

            const effectiveReasoningParser = resolveEffectiveReasoningParser({
              configuredParser: sessionConfig.reasoningParser,
              detectedParser: detected.reasoningParser,
              supportsThinking: detected.supportsThinking,
            });
            sessionHasReasoningParser = reasoningParserIsEnabled(
              effectiveReasoningParser,
            );
            isHarmonyModel = effectiveReasoningParser === "openai_gptoss";
            // VLM video sampling knobs (undefined → engine default)
            if (
              chatDetectedFamily === "gemma4" &&
              typeof sessionConfig.imageTokenBudget === "number" &&
              sessionConfig.imageTokenBudget > 0
            )
              sessionImageTokenBudget = sessionConfig.imageTokenBudget;
            if (typeof sessionConfig.videoFps === "number" && sessionConfig.videoFps > 0)
              sessionVideoFps = sessionConfig.videoFps;
            if (typeof sessionConfig.videoMaxFrames === "number" && sessionConfig.videoMaxFrames > 0)
              sessionVideoMaxFrames = sessionConfig.videoMaxFrames;
            if (typeof sessionConfig.videoMaxPixels === "number" && sessionConfig.videoMaxPixels > 0)
              sessionVideoMaxPixels = sessionConfig.videoMaxPixels;
            if (typeof sessionConfig.videoTokenBudget === "number" && sessionConfig.videoTokenBudget > 0)
              sessionVideoTokenBudget = sessionConfig.videoTokenBudget;
          } catch (_) {}
        }
      }
      // Session timeout is an INACTIVITY guard for the app. The local engine
      // sends SSE keep-alive comments while a long prefill is advancing, so
      // every received byte re-arms this timer below. A single wall-clock
      // timer discarded valid near-context work at exactly 900s even though
      // the engine was still sending keep-alives and processing prompt chunks.
      //
      // The engine's SSE contract emits a keep-alive every 15 seconds. A saved
      // timeout can be as low as 10 seconds, so using it directly here races
      // the first keep-alive and aborts a healthy prefill before the server can
      // report liveness. Give local SSE two keep-alive intervals; the engine
      // still enforces the configured progress-aware timeout itself. Remote
      // endpoints retain their configured client-side inactivity budget.
      // chatSession is the same known session later returned by endpoint
      // resolution (non-local renderer endpoints are rejected unless they
      // match it), so establish this before the watchdog is armed.
      const isRemote = chatSession?.type === "remote";
      const fetchInactivitySeconds = isRemote
        ? timeoutSeconds
        : Math.max(timeoutSeconds, 30);
      let fetchTimeout: ReturnType<typeof setTimeout> | undefined;
      const armFetchInactivityTimeout = () => {
        if (fetchTimeout) clearTimeout(fetchTimeout);
        if (abortController.signal.aborted) return;
        // The concurrency guard uses startedAt to decide whether an existing
        // lock is abandoned. Keep that liveness clock on the same definition
        // as the fetch watchdog, or a second send can abort a healthy request
        // merely because its total wall time exceeded the stale-lock cap.
        const active = activeRequests.get(chatId);
        if (active && active.controller === abortController) {
          active.startedAt = Date.now();
        }
        fetchTimeout = setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, fetchInactivitySeconds * 1000);
      };
      // Deliberately NOT armed here: the watchdog is an INFERENCE inactivity
      // guard. Arming it at entry made load/wake queue waiting consume the
      // generation timeout — exactly the premature timeout the user hit. It
      // is armed immediately before the inference fetch below.
      if (mode !== "aside") {
        repeatCallTracker.newTurn(chatId);
        // Left over from a turn that was cleared as stale: back to the queue.
        returnUnusedSteers(chatId, getWindow);
      }
      /** Set when this turn checkpoints files for the Changes review. */
      let turnChangeMessageId: string | null = null;
      if (mode !== "aside") activeRequests.set(chatId, {
        controller: abortController,
        startedAt: Date.now(),
        turnStartedAt: Date.now(),
        timeoutMs: fetchInactivitySeconds * 1000,
        endpoint: undefined,
        responseId: undefined,
      });
      // The entry above must be removed on EVERY exit path. Setup below can
      // throw (endpoint validation/resolution, health-check exhaustion while
      // an engine is still loading); without this try/finally those throws
      // leaked the entry, leaving the chat locked in "streaming" state until
      // the stale-lock window expired.
      try {

      // Resolve actual server endpoint: explicit endpoint > session by modelPath > detect > default
      // CRITICAL: When endpoint is passed from the renderer, attach the chatSession
      // so remote sessions get proper remoteUrl, auth headers, and health check path.
      // SECURITY: Validate renderer-provided endpoint is localhost or matches a known session
      if (endpoint && !providerRoute) {
        const isLocalhost =
          endpoint.host === "127.0.0.1" ||
          endpoint.host === "localhost" ||
          endpoint.host === "::1" ||
          endpoint.host === "0.0.0.0";
        const isKnownSession =
          chatSession &&
          chatSession.host === endpoint.host &&
          chatSession.port === endpoint.port;
        if (!isLocalhost && !isKnownSession) {
          throw new Error(
            `Endpoint ${endpoint.host}:${endpoint.port} not allowed — must be localhost or match a configured session`,
          );
        }
      }
      const resolved = providerRoute
        ? ({
            host: providerRoute.session.host,
            port: providerRoute.session.port,
            session: chatSession,
          } as ResolvedEndpoint)
        : endpoint
        ? ({
            host: endpoint.host,
            port: endpoint.port,
            session: chatSession,
          } as ResolvedEndpoint)
        : await resolveServerEndpoint(chat.modelPath);

      // Detect remote session and compute base URL + auth headers
      const resolvedSession = resolved.session;

      // Register the endpoint BEFORE the wake/queue waits below: Stop cancels
      // chats via abortByEndpoint(), which can only match entries whose
      // endpoint is populated. Without this, a queued message survived Stop.
      {
        const queuedEntry = activeRequests.get(chatId);
        if (queuedEntry) {
          queuedEntry.endpoint = { host: resolved.host, port: resolved.port };
        }
      }

      // A sleeping local engine answers /health immediately, so the generic
      // health check below previously declared it ready and let Python perform
      // a hidden JIT wake inside the inference request.  Electron remained
      // labelled Deep Sleep for the whole reload and could not show resident
      // progress.  Wake through SessionManager first: it owns the visible
      // loading state, progress monitor, failure rollback, and idle clock.
      const settleTimeoutMsFor = (session?: { config?: string }) => {
        let configured = 300;
        try {
          configured = Number(JSON.parse(session?.config || "{}").timeout) || 300;
        } catch {}
        return Math.max(configured * 1000, 120_000) + 60_000;
      };

      if (!isRemote && resolvedSession?.status === "standby") {
        console.log(`[CHAT] Waking standby session ${resolvedSession.id} before inference`);
        const wake = await sessionManager.wakeSession(resolvedSession.id);
        if (!wake.success) {
          const currentStatus = db.getSession(resolvedSession.id)?.status;
          if (currentStatus !== "loading" && currentStatus !== "running") {
            throw new Error(wake.error || "Failed to wake sleeping model");
          }
        }
      }

      // A message sent while the model is LOADING (cold start, Save & Restart,
      // or the wake above still finishing) queues exactly once until the
      // lifecycle settles. The blind 30s health poll below used to fail these
      // messages while a legitimate multi-minute load was in progress; the
      // user watches live load progress instead, and Stop/cancel aborts the
      // queued message immediately.
      if (!isRemote && resolvedSession?.id) {
        const liveStatus = db.getSession(resolvedSession.id)?.status;
        if (liveStatus === "loading") {
          const settleTimeoutMs = settleTimeoutMsFor(resolvedSession);
          console.log(
            `[CHAT] Session ${resolvedSession.id.slice(0, 8)} is loading — queueing message until ready (up to ${Math.round(settleTimeoutMs / 1000)}s)`,
          );
          const settled = await sessionManager.waitForSessionLifecycleSettled(
            resolvedSession.id,
            { timeoutMs: settleTimeoutMs, signal: abortController.signal },
          );
          if (settled !== "running") {
            throw new Error(
              settled === "loading"
                ? "Model is still loading — try again once the status indicator turns green"
                : `Model did not become ready (status: ${settled})`,
            );
          }
        }
      }

      const rawBaseUrl =
        isRemote && resolvedSession?.remoteUrl
          ? remoteServerBaseUrl(resolvedSession.remoteUrl)
          : `http://${connectHost(resolved.host)}:${resolved.port}`;
      // Resolve .local mDNS hostnames to IPv4 — Node.js fetch resolves them to
      // unreachable IPv6 link-local addresses (fe80::...) causing "fetch failed"
      const baseUrl = await resolveUrl(rawBaseUrl);
      console.log(
        `[CHAT] Endpoint resolution: isRemote=${isRemote}, rawBaseUrl=${rawBaseUrl}, baseUrl=${baseUrl}, session=${resolvedSession?.id ?? "none"}, type=${resolvedSession?.type ?? "none"}`,
      );
      const authHeaders: Record<string, string> = providerRoute
        ? {} // the provider fetch adds the credential (main process only)
        : resolvedSession?.id
          ? getAuthHeaders(resolvedSession.id)
          : {};
      // Update active request entry with resolved baseUrl and auth for cancel support
      const activeEntry = activeRequests.get(chatId);
      if (activeEntry) {
        activeEntry.endpoint = { host: resolved.host, port: resolved.port };
        activeEntry.baseUrl = baseUrl;
        if (Object.keys(authHeaders).length > 0)
          activeEntry.authHeaders = authHeaders;
      }

      // Health check with retry — wait for server to become ready instead of
      // failing immediately. This prevents orphaned user messages and allows
      // chatting as soon as the server finishes loading.
      //
      // OPTIMIZATION: If the global health monitor confirmed this session healthy
      // within the last 15 seconds, skip the per-message health check entirely.
      // The global monitor runs every 5s, so 15s gives a generous window.
      // This avoids adding 100-500ms+ RTT on every single message for remote sessions.
      const recentlyHealthy = providerRoute
        ? true
        : resolvedSession?.id
          ? Date.now() - sessionManager.getLastHealthyAt(resolvedSession.id) <
            15_000
          : false;

      // Remote sessions: 1 quick attempt then proceed (the request itself has a timeout).
      // Local sessions: 15 retries with 2s delays (30s total — JANG models need longer to dequantize).
      const maxHealthRetries = isRemote ? 1 : 15;
      const healthRetryDelay = isRemote ? 500 : 2000;
      let healthOk = recentlyHealthy;
      if (recentlyHealthy) {
        console.log(
          `[CHAT] Skipping health check — global monitor confirmed healthy within 15s`,
        );
      } else {
        const healthUrl = isRemote
          ? `${baseUrl}/v1/models`
          : `${baseUrl}/health`;
        console.log(
          `[CHAT] Health check URL: ${healthUrl} (${isRemote ? "remote" : "local"}, max ${maxHealthRetries} attempts)`,
        );
        for (let attempt = 0; attempt < maxHealthRetries; attempt++) {
          try {
            const healthRes = await fetch(healthUrl, {
              headers: authHeaders,
              signal: AbortSignal.timeout(isRemote ? 3000 : 5000),
            });
            if (healthRes.ok) {
              // Local /health answers 200 in EVERY state (no_model, standby,
              // waking). HTTP 200 alone is not inference readiness — the
              // body must say healthy + model_loaded + contract-ready.
              let bodyReady = isRemote;
              if (!isRemote) {
                try {
                  bodyReady = localEngineReadyFromHealthBody(await healthRes.json());
                } catch {
                  bodyReady = false;
                }
              }
              if (bodyReady) {
                healthOk = true;
                console.log(
                  `[CHAT] Health check passed on attempt ${attempt + 1}`,
                );
                break;
              }
              console.log(
                `[CHAT] Server up but not inference-ready (attempt ${attempt + 1}/${maxHealthRetries})`,
              );
              const live = resolvedSession?.id
                ? db.getSession(resolvedSession.id)
                : undefined;
              if (live?.status === "standby") {
                // The engine was slept externally and the monitor synced the
                // row after this send began. Wake through SessionManager (the
                // visible progress owner) and queue until readiness.
                console.log(
                  `[CHAT] Engine asleep mid-poll — waking session ${live.id.slice(0, 8)} and queueing`,
                );
                const wake = await sessionManager.wakeSession(live.id);
                if (wake.success) {
                  const settled = await sessionManager.waitForSessionLifecycleSettled(
                    live.id,
                    { timeoutMs: settleTimeoutMsFor(live), signal: abortController.signal },
                  );
                  if (settled === "running") continue;
                }
              }
              if (attempt < maxHealthRetries - 1) {
                await new Promise((r) => setTimeout(r, healthRetryDelay));
              }
              continue;
            }
            if (attempt < maxHealthRetries - 1) {
              console.log(
                `[CHAT] Server not ready (HTTP ${healthRes.status}), retrying in ${healthRetryDelay}ms...`,
              );
              await new Promise((r) => setTimeout(r, healthRetryDelay));
            }
          } catch (healthErr: any) {
            console.log(
              `[CHAT] Health check failed (attempt ${attempt + 1}/${maxHealthRetries}): ${healthErr.message || healthErr.cause?.message || healthErr}`,
            );
            if (attempt < maxHealthRetries - 1) {
              await new Promise((r) => setTimeout(r, healthRetryDelay));
            }
          }
        }
      }
      // For remote sessions: proceed even if health check failed — the request has
      // its own timeout and the server may just be busy with another generation.
      if (!healthOk && isRemote) {
        console.log(
          `[CHAT] Remote health check failed but proceeding anyway — request will use its own timeout`,
        );
        healthOk = true;
      }
      if (!healthOk) {
        // Entry + timer cleanup handled by the enclosing finally.
        throw new Error(
          `Cannot reach server on port ${resolved.port} after ${maxHealthRetries} attempts (${(maxHealthRetries * healthRetryDelay) / 1000}s). The model may still be loading — wait for the status indicator to turn green, then try again.`,
        );
      }

      // Add user message AFTER health check passes — this prevents orphaned
      // user messages when the server isn't ready yet.
      // When attachments are present, store content as JSON array of content parts.
      const hasAttachments = attachments && attachments.length > 0;
      // Explicit media may be forwarded when capability detection is unknown;
      // the server still validates the real runtime. It must never override
      // Force Off or a text-only route, or be silently dropped. Text files are
      // ordinary text context and do not require multimodal routing.
      const hasMediaAttachments =
        hasAttachments && attachments!.some((a) => inferKind(a) !== "text");
      if (
        providerRoute?.model &&
        hasMediaAttachments &&
        !providerRoute.model.input.includes("image")
      ) {
        throw new Error(
          `${providerRoute.model.name || providerRoute.modelId} is set to text input only. Remove the attachment, or turn on Image input for this model in Preferences → Models.`,
        );
      }
      const modelForceTextOnly = chatModelForceTextOnly || (() => {
        try {
          return !providerRoute && !!chat.modelPath &&
            detectModelConfigFromDir(chat.modelPath).forceTextOnly === true;
        } catch (_) {
          return false;
        }
      })();
      const mediaPolicy = resolveChatMediaPolicy({
        smelt: !!chatSessionConfig.smelt,
        forceTextOnly: modelForceTextOnly,
        detectedMultimodal: chatIsMultimodal,
        configuredMode: typeof chatSessionConfig.isMultimodal === "boolean"
          ? chatSessionConfig.isMultimodal : undefined,
        hasMediaAttachments: !!hasMediaAttachments,
        // Reject before persisting a new turn: text-only replay must not
        // silently remove media already present in this conversation.
        hasMediaHistory: chatSessionConfig.isMultimodal === false
          && hasPersistedUserMedia(db.getMessages(chatId)),
      });
      if (mediaPolicy.attachmentError) throw new Error(mediaPolicy.attachmentError);
      chatIsMultimodal = mediaPolicy.multimodal;
      if (hasAttachments || chatIsMultimodal) {
        pushChatSessionLog(
          chatSession?.id || resolvedSession?.id,
          `[CHAT_DIAG] attachment_route=${JSON.stringify({
            chatId: chatId.slice(0, 8),
            modelPath: chat.modelPath,
            detectedFamily: chatDetectedFamily,
            modelForceTextOnly,
            chatIsMultimodal,
            attachments: summarizeAttachmentsForLog(attachments),
          })}`,
        );
      }
      const audioFormatFromDataUrl = (dataUrl: string): string => {
        const mime = dataUrl.match(/^data:([^;,]+)[;,]/)?.[1]?.toLowerCase() || "";
        if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
        if (mime === "audio/wave" || mime === "audio/x-wav" || mime === "audio/wav") return "wav";
        if (mime === "audio/mp4" || mime === "audio/x-m4a") return "m4a";
        if (mime.startsWith("audio/")) return mime.slice("audio/".length);
        return "wav";
      };
      const audioDataFromDataUrl = (dataUrl: string): string =>
        dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : dataUrl;
      const userContentForDb = hasAttachments
        ? JSON.stringify(
            orderComposerContentParts(
              content,
              attachments.map((a) => {
                const kind = inferKind(a);
                if (kind === "audio") {
                  return {
                    type: "input_audio",
                    input_audio: {
                      data: audioDataFromDataUrl(a.dataUrl),
                      format: audioFormatFromDataUrl(a.dataUrl),
                    },
                  };
                }
                if (kind === "text") {
                  return {
                    type: "text",
                    text: `[Attached file: ${a.name}]\n${a.text || ""}`.trim(),
                  };
                }
                return kind === "video"
                  ? { type: "video_url", video_url: { url: a.dataUrl } }
                  : { type: "image_url", image_url: { url: a.dataUrl } };
              }),
              chatDetectedFamily,
            ),
          )
        : content;
      const userMessage: Message = {
        id: uuidv4(),
        chatId,
        role: "user",
        content: userContentForDb,
        timestamp: Date.now(),
      };
      if (mode === "send") db.addMessage(userMessage);

      // Generate assistant message ID upfront so typing indicator can reference it
      const assistantMessageId = uuidv4();
      // Local proof correlation is carried out-of-band so it cannot perturb the
      // model request body or remote-provider contracts. One visible user turn
      // owns one proof/message identity; every initial/tool-continuation HTTP
      // request gets its own request ID.
      const proofRequestId = userMessage.id;
      const wireRequestIds: string[] = [];
      const nextLocalRequestCorrelationHeaders = (): Record<string, string> => {
        if (isRemote) return {};
        const requestId = uuidv4();
        wireRequestIds.push(requestId);
        return {
          "X-vMLX-Proof-Request-ID": proofRequestId,
          "X-vMLX-Request-ID": requestId,
          "X-vMLX-Message-ID": assistantMessageId,
        };
      };

      // Signal to renderer that the model is processing (typing indicator during TTFT)
      try {
        const win = mode === "send" ? getWindow() : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send("chat:typing", {
            chatId,
            messageId: assistantMessageId,
            // A turn the window didn't start (a scheduled task) shows its prompt
            // too; a turn the window sent already shows its own copy.
            ...(unattendedTurns.has(chatId)
              ? { userMessage: { id: userMessage.id, content: userMessage.content, timestamp: userMessage.timestamp } }
              : {}),
          });
        }
      } catch (_) {}

      // Get messages for context
      const messages = db.getMessages(chatId);

      // Re-validate persisted values at the request boundary. Older database
      // rows and imported profiles can predate the current Chat/Responses
      // schema domains; forwarding one of those rows verbatim turns a valid UI
      // action into a backend 422. Invalid legacy fields revert to inheritance,
      // exactly like an unset override, rather than being silently clamped to a
      // different sampler value.
      const overrides = sanitizeChatOverrides({
        ...(db.getChatOverrides(chatId) || {}),
        chatId,
      });
      if (providerRoute) {
        // The model picker owns reasoning for provider chats.
        delete overrides.reasoningEffort;
        delete overrides.enableThinking;
        delete overrides.thinkingMode;
        if (providerRoute.reasoningEffort === "off") overrides.enableThinking = false;
        else if (providerRoute.reasoningEffort) overrides.reasoningEffort = providerRoute.reasoningEffort;
        overrides.wireApi = providerRoute.wireApi;
      }
      // Adaptive MTP never rewrites the sampler (compatible-only: greedy
      // requests verify by identity, sampled requests by rejection sampling),
      // so the request boundary forwards the user's overrides untouched.
      const effectiveSamplerOverrides = overrides;
      // Changes review: checkpoint what this turn's file tools touch.
      if (mode === "send" && overrides?.builtinToolsEnabled === true && overrides?.workingDirectory) {
        turnChanges.begin(chatId, assistantMessageId, overrides.workingDirectory);
        turnChangeMessageId = assistantMessageId;
      }
      if (supportsInstructMode === false && overrides?.enableThinking === false) {
        throw new Error(
          "This model has no native Thinking Off/Instruct mode. Open Chat Settings and choose Auto or On.",
        );
      }
      if (isRemote && supportsThinking === false &&
          (overrides.enableThinking === true || (overrides.enableThinking !== false && overrides.reasoningEffort))) {
        throw new Error('This remote model advertises no reasoning support. Open Chat Settings and choose Auto.');
      }

      // Build request messages with system prompt if set
      // Using any[] to support tool_calls and tool_call_id fields
      const requestMessages: any[] = [];
      // Boundary marker: index into requestMessages where THIS turn's fresh tool
      // exchange begins (set right after history replay is assembled). The
      // tool-call/result harvest that persists into this assistant row must only
      // scan from here — scanning the whole array re-harvests every prior turn's
      // replayed tool calls/results into this row, so each turn stores the union
      // of all prior tool exchanges and the payload grows super-linearly across
      // turns (measured 3.3k→12.5k→21.3k tokens), starving the answer budget.
      let currentTurnToolStart = 0;

      // Add system prompt from overrides if available, or agentic prompt when built-in tools enabled
      const hasSystemPrompt = !!overrides?.systemPrompt;
      // The persisted content of a media turn is an array containing its text
      // and attachment parts. Always bind authorization to the newest user
      // message; falling back to an older string turn can silently re-enable a
      // tool that the current image/video/audio prompt explicitly prohibited.
      const latestUserText = latestUserMessageText(messages);
      const suppressAgenticToolPromptForExactOutput =
        overrides?.builtinToolsEnabled === true &&
        // Exact-output probes usually say "reply exactly MARKER" without a
        // colon. Injecting the broad coding-agent prompt in that case repeats
        // the final-response instruction and made Nemotron emit the requested
        // marker twice after a correct tool result.
        /\breply exactly\b/i.test(latestUserText);
      // These are current-user authorization constraints, not built-in-tool
      // preferences. The local engine auto-merges MCP schemas even when the
      // Electron built-in catalog is disabled, so recognize a no-tools turn
      // independently of the persistent built-in-tools toggle.
      const userForbidsToolCalls = requestsNoToolCalls(latestUserText);
      const exactTextOnlyNoToolTurn =
        requestsExactTextOnlyWithoutToolUse(latestUserText);
      const privateReasoningNoToolTurn =
        requestsPrivateReasoningWithoutToolUse(latestUserText);
      const attachBuiltinToolsForCurrentTurn =
        overrides?.builtinToolsEnabled === true &&
        !userForbidsToolCalls &&
        !exactTextOnlyNoToolTurn &&
        !privateReasoningNoToolTurn;
      // Parse explicit built-in contracts even when the catalog or one of its
      // categories is disabled. Otherwise the request can silently ignore the
      // user's tool requirement, or (with a category disabled) send a required
      // tool_choice without the matching schema.
      const exactlyOnceToolNames = requestedOnceToolNames(latestUserText);
      const exactlyOnceBuiltinToolNames =
        exactlyOnceToolNames.filter((name) => isBuiltinTool(name));
      const completedExactFinalTools = new Set<string>();
      const completedExactlyOnceTools = new Set<string>();
      // Permission preset (Read only / Workspace / Full access) for this turn.
      const permissionPreset = normalizePermissionPreset(overrides?.permissionPreset);
      // Plan mode (Code sessions): reading tools only, and a note asking for a plan.
      const planMode = planModeChats.has(chatId) && overrides?.builtinToolsEnabled === true;
      // Set once an app's data is in this chat (it stays in the context for
      // later turns too): web and MCP tools then ask first, and app sends ask
      // even with "Always", so text inside an email cannot quietly send data.
      let appDataInTurn = chatsWithAppData.has(chatId);
      /** Web pages or MCP results came into this turn (memory writes ask). */
      let externalDataInTurn = appDataInTurn || chatsWithExternalData.has(chatId);
      // Escalations the user refused this turn: the same one is not asked twice.
      const refusedEscalations = new Set<string>();
      /**
       * Decide whether a tool call may run, asking the user when the preset
       * says so. Resolves with whether to sandbox the shell, or with the
       * model-directed refusal text. Throws AbortError when Stop is pressed
       * while the card is open.
       */
      const refusalOf = (gate: { ok: true } | { ok: false; message: string }): string | null =>
        gate.ok ? null : gate.message;
      const gateToolCall = async (
        toolName: string,
        toolArgs: Record<string, any>,
        toolCallId: string | undefined,
        isBuiltin: boolean,
        modelText: string,
        /** A clearer line for the approval card than the raw arguments. */
        subjectOverride?: string,
      ): Promise<{ ok: true; sandboxProfile: string | null } | { ok: false; message: string }> => {
        const decision = decideToolPermission({
          preset: permissionPreset,
          toolName,
          args: toolArgs,
          isBuiltin,
          sandboxAvailable: seatbeltSupport().available,
          alwaysAllowed: alwaysAllowedCommands.get(chatId),
          refusedEscalations,
          plan: planMode,
          untrustedData: appDataInTurn,
          externalData: externalDataInTurn,
        });
        // From here on the turn holds what this tool brings back.
        if (!isBuiltin || EXTERNAL_DATA_TOOLS.has(toolName)) {
          externalDataInTurn = true;
          chatsWithExternalData.add(chatId);
        }
        if (decision.action === "deny") return { ok: false, message: decision.message };
        if (decision.action === "allow") {
          if (!decision.sandbox) return { ok: true, sandboxProfile: null };
          const profile = workspaceSandboxProfile(
            overrides?.workingDirectory ?? "",
            join(agentSpillRoot(), chatId),
          );
          if (profile) return { ok: true, sandboxProfile: profile };
          // The probe passed but no profile: never run unconfined silently.
          return { ok: false, message: approvalRefusalMessage("unavailable", toolName) };
        }
        const broker = approvalBroker;
        let denyNote = "";
        const outcome = broker
          ? await broker.request({
              chatId,
              toolCallId,
              toolName,
              kind: decision.kind,
              subject: (() => {
                const subject = subjectOverride || decision.subject;
                return subject.length > 10000 ? `${subject.slice(0, 10000)}…` : subject;
              })(),
              reason: decision.justification ?? statedIntent(modelText),
              why: decision.why,
              allowAlways: decision.allowAlways,
              signal: abortController.signal,
              onNote: (n) => { denyNote = n; },
            })
          : "unavailable";
        const key = alwaysAllowKey(toolName, toolArgs.command);
        console.log(`[CHAT] Approval for ${toolName} (${decision.kind}): ${outcome}`);
        if (outcome === "allow-once" || outcome === "allow-always") {
          if (outcome === "allow-always") {
            let set = alwaysAllowedCommands.get(chatId);
            if (!set) alwaysAllowedCommands.set(chatId, (set = new Set()));
            set.add(key);
          }
          // Approved as shown: runs outside the sandbox.
          return { ok: true, sandboxProfile: null };
        }
        if (outcome === "aborted") {
          throw Object.assign(new Error("AbortError"), { name: "AbortError" });
        }
        if (decision.kind === "escalation") refusedEscalations.add(key);
        return {
          ok: false,
          message: withDenyNote(approvalRefusalMessage(
            outcome,
            toolName,
            Math.round((broker?.timeoutMs ?? 300000) / 60000),
          ), outcome === "deny" ? denyNote : ""),
        };
      };
      let lastReplaySafeToolResultKey: string | null = null;
      const suppressGenericAgenticToolPromptForNativeTools =
        overrides?.builtinToolsEnabled === true &&
        shouldSuppressGenericAgenticPromptForNativeTools(
          chatDetectedFamily,
          chat.modelPath || resolvedSession?.remoteModel || chat.modelId,
        );
      const directMediaAttachmentRule =
        // Attachment presence is not a tool-capability change. Keep both the
        // catalog and this conditional instruction stable across media/text
        // turns so historical media prefixes remain reusable. Explicit tool
        // restrictions and category toggles still control the catalog below.
        (chatIsMultimodal || isRemote) && attachBuiltinToolsForCurrentTurn
          ? DIRECT_MEDIA_ATTACHMENT_TOOL_RULE
          : "";
      // Lean preset: a minimal tool set (and a shorter system prompt) for
      // small models. The AppleScript specialist keeps its bundle-owned
      // single-tool catalog either way.
      const leanToolPreset =
        normalizeToolPreset(overrides?.toolPreset) === "lean" &&
        !chatUsesZayaAppleScriptToolBundle;
      // Prefix-cache discipline: the catalog depends only on chat settings
      // and is always emitted in the registry's canonical order.
      const unscopedCurrentTurnToolDefinitions =
        attachBuiltinToolsForCurrentTurn
          ? orderToolsForPrefixCache(
              // Workspace adds the sandbox escalation fields to the shell
              // tools: a function of the chat's preset only (cache-stable).
              applyPermissionPresetToTools(
                applyToolPreset(
                  filterTools(overrides || {}, {
                    zayaAppleScriptToolBundle: chatUsesZayaAppleScriptToolBundle,
                  }),
                  leanToolPreset ? "lean" : "full",
                ),
                overrides?.permissionPreset,
              ),
              BUILTIN_TOOL_ORDER,
            )
          : [];
      const exactFinalToolNames =
        overrides?.builtinToolsEnabled === true
          ? requestedExactFinalToolNames(
              latestUserText,
              toolCapabilityNames(unscopedCurrentTurnToolDefinitions),
            )
          : [];
      const exactFinalBuiltinToolNames =
        exactFinalToolNames.filter((name) => isBuiltinTool(name));
      const scopedCurrentTurnToolNames =
        overrides?.builtinToolsEnabled === true
          ? requestedScopedToolNames(
              latestUserText,
              toolCapabilityNames(unscopedCurrentTurnToolDefinitions),
            )
          : [];
      const scopedCurrentTurnBuiltinToolNames =
        scopedCurrentTurnToolNames.filter((name) => isBuiltinTool(name));
      const restrictedToolNamesForCurrentTurn =
        exactFinalBuiltinToolNames.length > 0
          ? exactFinalBuiltinToolNames
          : scopedCurrentTurnBuiltinToolNames;
      const directAnswerAfterSingleTool =
        exactFinalBuiltinToolNames.length === 1;
      // Apps (Composio): the chat's Apps switch adds the meta tools, for
      // every model. Not on a no-tools turn or a turn scoped to named tools.
      const appToolsForTurn =
        !userForbidsToolCalls &&
        !exactTextOnlyNoToolTurn &&
        restrictedToolNamesForCurrentTurn.length === 0 &&
        appsService().chatEnabled(chatId)
          ? await Promise.race([
              // Small local models get the connected apps' real actions
              // (direct tools); cloud models the Composio meta tools.
              (!isRemote && !providerRoute
                ? appsService().directTools().then((d) => (d.length > 0 ? d : appsService().listTools()))
                : appsService().listTools()
              ).catch(() => appsService().cachedTools()),
              // Never hold a turn on the network: after 4 s use what is cached.
              new Promise<ReturnType<ReturnType<typeof appsService>["cachedTools"]>>((resolve) =>
                setTimeout(() => resolve(appsService().cachedTools()), 4000),
              ),
            ])
          : [];
      const attachToolsForCurrentTurn =
        attachBuiltinToolsForCurrentTurn || appToolsForTurn.length > 0;
      const currentTurnToolDefinitions = [
        ...(attachBuiltinToolsForCurrentTurn
          ? scopeToolDefinitionsByName(
              unscopedCurrentTurnToolDefinitions,
              exactFinalBuiltinToolNames.length > 0
                ? exactFinalBuiltinToolNames
                : scopedCurrentTurnBuiltinToolNames,
            )
          : []),
        ...appToolsForTurn,
      ];
      const currentToolCapabilityFingerprint = toolCapabilityFingerprint(
        currentTurnToolDefinitions,
      );
      const priorAssistantToolFingerprints = messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.toolCapabilityFingerprint);
      const currentToolNames = toolCapabilityNames(currentTurnToolDefinitions);
      const unavailableExactlyOnceBuiltinToolNames =
        unavailableRequestedToolNames(
          exactlyOnceBuiltinToolNames,
          currentToolNames,
        );
      const historicallyUnavailableTools = historicalUnavailableToolNames(
        messages,
        currentToolCapabilityFingerprint,
        currentToolNames,
      );
      // Only an explicit current-user prohibition is a hard authorization
      // boundary. Exact-output and private-reasoning heuristics may omit the
      // Electron built-in catalog to avoid prompt contamination, but the local
      // engine can still expose MCP tools that the request genuinely needs
      // (for example, "check weather and reply exactly RAIN or DRY").
      const currentPromptAlreadyForbidsTools = userForbidsToolCalls;
      // The epoch note is a leading system message: for history-stable families its presence must not follow the
      // current message's wording, or a "without tools" turn re-prefills the whole chat.
      const toolCapabilityEpoch = toolCapabilityEpochInstruction(
        priorAssistantToolFingerprints,
        currentToolCapabilityFingerprint,
        currentToolNames,
        historicallyUnavailableTools,
        currentPromptAlreadyForbidsTools &&
          !historyIsStableAcrossToolAuthorization(chatDetectedFamily),
      );
      if (hasSystemPrompt && overrides?.builtinToolsEnabled) {
        const toolRule =
          "\n\nIMPORTANT: After using any tools, provide a final response. If the user explicitly requested exact final wording or a strict output format, follow that format exactly; otherwise provide a substantive response explaining what you found or did. Never stop after just executing tools.";
        requestMessages.push({
          role: "system",
          content:
            overrides!.systemPrompt! +
            (userForbidsToolCalls ||
            suppressAgenticToolPromptForExactOutput ||
            suppressGenericAgenticToolPromptForNativeTools
              ? ""
              : toolRule) +
            directMediaAttachmentRule,
        });
      } else if (hasSystemPrompt) {
        requestMessages.push({
          role: "system",
          content: overrides!.systemPrompt!,
        });
      } else if (
        attachBuiltinToolsForCurrentTurn &&
        !userForbidsToolCalls &&
        !suppressAgenticToolPromptForExactOutput &&
        !suppressGenericAgenticToolPromptForNativeTools
      ) {
        requestMessages.push({
          role: "system",
          content: leanToolPreset
            ? LEAN_AGENTIC_SYSTEM_PROMPT + directMediaAttachmentRule
            : AGENTIC_SYSTEM_PROMPT + directMediaAttachmentRule,
        });
      } else if (directMediaAttachmentRule) {
        requestMessages.push({
          role: "system",
          content: directMediaAttachmentRule.trim(),
        });
      }
      // Project instructions (AGENTS.md / CLAUDE.md and *.local.md from the
      // working directory up to the workspace root, 64 KB budget). They follow
      // the persistent built-in-tools setting, never this turn's wording, so
      // the system prompt — the start of the cached prefix — stays identical
      // from turn to turn while the files are unchanged.
      const projectInstructions =
        overrides?.builtinToolsEnabled === true && !chatUsesZayaAppleScriptToolBundle
          ? loadProjectInstructions(overrides.workingDirectory)
          : null;
      if (projectInstructions) {
        const head = requestMessages[0];
        if (head?.role === "system" && typeof head.content === "string") {
          head.content = `${head.content}\n\n${projectInstructions.text}`;
        } else {
          requestMessages.unshift({ role: "system", content: projectInstructions.text });
        }
        console.log(
          `[CHAT] Project instructions: ${projectInstructions.included.join(", ")} (${projectInstructions.bytes} bytes)` +
            (projectInstructions.omitted.length ? `; omitted ${projectInstructions.omitted.join(", ")}` : "") +
            (projectInstructions.truncated.length ? `; truncated ${projectInstructions.truncated.join(", ")}` : ""),
        );
      }
      // Skills: names and one-line descriptions only; bodies load on use.
      // Like project instructions, this follows the persistent settings only,
      // never this turn's wording, so the cached system prompt stays the same.
      const skillIndex =
        overrides?.builtinToolsEnabled === true && !chatUsesZayaAppleScriptToolBundle && !leanToolPreset &&
        !getDisabledTools(overrides || {}).has("use_skill")
          ? renderSkillIndex(discoverSkills(overrides?.workingDirectory || undefined))
          : null;
      if (skillIndex) {
        const head = requestMessages[0];
        if (head?.role === "system" && typeof head.content === "string") {
          head.content = `${head.content}\n\n${skillIndex}`;
        } else {
          requestMessages.unshift({ role: "system", content: skillIndex });
        }
      }
      // Memory: the newest saved facts, after the skills (follows the
      // persistent settings and the stored entries only).
      const memoryBlock =
        overrides?.builtinToolsEnabled === true && !chatUsesZayaAppleScriptToolBundle && !leanToolPreset && memoryEnabled()
          ? frozenMemoryBlock(chatId, renderMemoryBlock((() => { try { return db.memory?.list() ?? []; } catch { return []; } })()))
          : null;
      if (memoryBlock) {
        const head = requestMessages[0];
        if (head?.role === "system" && typeof head.content === "string") {
          head.content = `${head.content}\n\n${memoryBlock}`;
        } else {
          requestMessages.unshift({ role: "system", content: memoryBlock });
        }
      }
      if (toolCapabilityEpoch) {
        requestMessages.push({
          role: "system",
          content: toolCapabilityEpoch,
        });
      }
      // No default system prompt injected — let the model's native template handle defaults.
      // Injecting "You are a helpful assistant." reinforces safety behavior in abliterated/CRACK models.

      // Determine wire format before rebuilding history because persisted
      // tool-call context must be reconstructed differently for Responses
      // (`function_call` / `function_call_output` items) versus Chat
      // Completions (`assistant.tool_calls` / `role:"tool"` messages).
      const wireApi =
        overrides?.wireApi || (isRemote ? "completions" : "responses");
      const useResponsesApi = wireApi === "responses";
      // Local vmlx-engine merges MCP schemas behind the public request. An
      // explicit no-tools turn therefore needs tool_choice=none, while a
      // singular exact built-in contract needs a specific function choice so
      // the engine filters its MCP catalog to that same name. Open-ended turns
      // intentionally leave tool_choice omitted so legitimate MCP use remains
      // available. Remote providers only see the already-scoped request.tools
      // catalog and do not participate in the local MCP merge. They still need
      // a specific tool_choice for an explicit singular contract; one schema
      // by itself is only auto choice and can terminate without calling it.
      const currentTurnToolChoice = () => {
        const remainingExactBuiltinTools = exactFinalBuiltinToolNames.filter(
          (name) => !completedExactFinalTools.has(name),
        );
        const remainingExactlyOnceBuiltinTools =
          exactlyOnceBuiltinToolNames.filter(
            (name) => !completedExactlyOnceTools.has(name),
          );
        const requiredToolNames = requiredToolChoiceNamesForCurrentTurn(
          remainingExactBuiltinTools,
          remainingExactlyOnceBuiltinTools,
        );
        return toolChoiceForCurrentTurn(
          currentPromptAlreadyForbidsTools,
          requiredToolNames,
          useResponsesApi ? "responses" : "chat",
          isRemote,
        );
      };

      // A compaction checkpoint from an earlier turn replaces every row up to
      // its boundary. When that row is gone (deleted, regenerated) the
      // checkpoint is stale: drop it and replay the full history.
      let compactionState: ChatCompactionState | null = parseCompactionState(
        db.getChatAgentState(chatId).compactionJson,
      );
      let replayRows = messages;
      if (compactionState) {
        const rowsAfterCheckpoint = messagesAfterCompaction(messages, compactionState);
        if (rowsAfterCheckpoint) {
          replayRows = rowsAfterCheckpoint;
          requestMessages.push(
            checkpointMessage(compactionState.summary, compactionState.throughMessageId),
          );
        } else {
          compactionState = null;
          db.setChatCompactionState(chatId, null);
        }
      }

      // Add conversation messages (skip any existing system messages to avoid duplicates)
      // Messages with JSON content arrays (multimodal) are parsed back to content parts for the API
      // Every replayed item is tagged with its row id (never serialized) so
      // compaction knows which persisted rows a checkpoint fully covers.
      for (const m of replayRows) {
        if (
          m.role === "system" &&
          (hasSystemPrompt || overrides?.builtinToolsEnabled)
        )
          continue;
        let msgContent: any = m.content;
        // Panel-synthesized error bubbles ("Message not sent — …" /
        // "Generation blocked: …") are UI-only annotations — never replay them
        // as assistant history. For prompt-too-long, ALSO drop the user message
        // that produced the bubble: that message IS the oversized payload, and
        // replaying it re-413s every later turn in the chat.
        if (m.role === "assistant" && isPromptTooLongBubbleContent(m.content)) {
          const prev = requestMessages[requestMessages.length - 1];
          // A compaction checkpoint is not the oversized payload: keep it.
          if (prev && isCheckpointMessage(prev)) continue;
          if (prev && prev.role === "user") requestMessages.pop();
          continue;
        }
        if (m.role === "assistant" && isMetalHeadroomBubbleContent(m.content)) {
          continue;
        }
        // Strip "[Generation interrupted]" markers from previous assistant messages —
        // these are UI-only annotations saved to DB on abort, not meant for the model
        if (m.role === "assistant" && typeof msgContent === "string") {
          msgContent = msgContent
            .replace(/\n\n\[Generation interrupted\]$/, "")
            .replace(/^\[Generation interrupted\]$/, "");
          // Strip any leaked <think> blocks from prior messages when thinking is OFF.
          // These can leak if server didn't catch them or model was mid-think on abort.
          // Without stripping, the model sees prior thinking in context and mimics it.
          if (overrides?.enableThinking === false) {
            msgContent = msgContent.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
            msgContent = msgContent.replace(/<mm:think>[\s\S]*?<\/mm:think>\s*/g, "");
            msgContent = msgContent.replace(
              /\[THINK\][\s\S]*?\[\/THINK\]\s*/g,
              "",
            );
          }
          // 2026-05-03: keep empty-content assistant turns when they
          // carry tool_calls. An assistant turn that ONLY emits tool
          // calls has no visible content — but the chat template still
          // needs the message in history with `tool_calls` set so the
          // model sees prior calls + their results. Skipping it
          // collapsed the conversation into "user → user" gibberish
          // on continuation.
          const _hasOaiToolCalls =
            typeof (m as any).toolCallsOaiJson === "string" &&
            (m as any).toolCallsOaiJson.length > 0;
          // Codex 2026-05-06 B2: don't drop reasoning-only assistant
          // rows. A DSV4 turn that hits max_tokens during <think> emits
          // empty output_text (correct — see server.py B1 fix) but
          // populated reasoning_content. Dropping the row here would
          // collapse the conversation into "user → user" pairs and
          // cause the next turn to replay/merge wrong-prompt framing.
          // Treat reasoning_content as substantive content for the
          // skip-empty check.
          const _hasReasoningContent =
            typeof (m as any).reasoningContent === "string" &&
            (m as any).reasoningContent.trim().length > 0;
          if (
            !msgContent.trim()
            && !_hasOaiToolCalls
            && !_hasReasoningContent
          ) continue; // Skip entirely empty aborted messages
        }
        // Detect JSON content arrays (multimodal messages with images)
        if (
          m.role === "user" &&
          typeof msgContent === "string" &&
          msgContent.startsWith("[")
        ) {
          try {
            const parsed = JSON.parse(msgContent);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
              // Preserve every historical media item for a real multimodal
              // route. Replacing prior bytes with explanatory text rewrites
              // both the token stream and media identity, defeating causal SSD
              // prefix reuse and cold/restart reconstruction. Text-only routes
              // still strip media defensively.
              msgContent = replayPersistedUserContentParts(
                parsed,
                chatIsMultimodal || isRemote,
              );
            }
          } catch {
            /* not JSON, use as plain string */
          }
        }
        // Rebuild each persisted assistant row into its original model-visible
        // order. A tool loop is stored as one UI row, but native history must be
        // reasoning -> function_call -> result -> reasoning -> final answer.
        // This also preserves reasoning-only assistant turns instead of keeping
        // them merely as a UI display field.
        if (m.role === "assistant") {
          const replay = replayPersistedAssistantHistory(
            { ...(m as any), content: msgContent },
            useResponsesApi,
            {
              includeReasoning: shouldReplayHistoricalReasoning(
                chatDetectedFamily,
                currentPromptAlreadyForbidsTools,
              ),
            },
          );
          if (replay.length > 0) {
            requestMessages.push(...replay.map((item: any) => tagHistoryMessage(item, m.id)));
            continue;
          }
        }
        const reqMsg: any = { role: m.role, content: msgContent };
        requestMessages.push(tagHistoryMessage(reqMsg, m.id));
      }

      // Fix role alternation: merge consecutive same-role messages to prevent
      // template errors (e.g., Mistral enforces strict user/assistant alternation).
      // This can happen when an aborted assistant message is stripped empty, leaving
      // two consecutive user messages in history.
      const mergedMessages: typeof requestMessages = [];
      for (const msg of requestMessages) {
        const prev = mergedMessages[mergedMessages.length - 1];
        if (
          prev &&
          prev.role === msg.role &&
          typeof prev.content === "string" &&
          typeof msg.content === "string"
        ) {
          prev.content = prev.content + "\n\n" + msg.content;
          // The merged message now ends with msg's persisted row.
          tagHistoryMessage(prev, historySourceId(msg));
        } else {
          mergedMessages.push({ ...msg });
        }
      }
      requestMessages.length = 0;
      requestMessages.push(...mergedMessages);
      if (planMode && mode === "send") withPlanModeNote(requestMessages);
      // History replay is now fully assembled (system + all prior turns + current
      // user message). Everything pushed after this point is THIS turn's fresh
      // tool exchange (the agentic tool loop). Harvest only from here.
      currentTurnToolStart = requestMessages.length;

      // Prepare assistant message placeholder
      const assistantMessage: Message = {
        id: assistantMessageId,
        chatId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        toolCapabilityFingerprint: currentToolCapabilityFingerprint,
      };

      // Metrics tracking
      const startTime = Date.now();
      let fetchStartTime = startTime; // Updated just before the API fetch (for accurate TTFT)
      let tokenCount = 0;
      let promptTokens = 0;
      let cachedTokens = 0;
      // Exchange totals across tool-loop streams. promptTokens/cachedTokens
      // are per-stream (usage chunks are cumulative within one stream, so
      // recordCacheUsage takes a max); pairing the LAST stream's prompt with
      // the max cached across ALL streams displayed impossible stats like
      // "481 prompt (3904 cached)". Streams fold into these totals at each
      // follow-up boundary and the final metrics report coherent sums.
      let exchangePromptTokens = 0;
      let exchangeCachedTokens = 0;
      // Per-HTTP-pass provenance for prompt/cache counts. This remains in the
      // outer scope so interrupted responses can refuse client-estimated pp/s.
      let serverSendsUsage = false;
      const remoteMetrics = isRemote ? new RemoteRequestMetrics() : undefined;
      const remoteMetricFields = () => {
        if (!remoteMetrics) return {};
        const metrics = remoteMetrics.snapshot(Date.now());
        return {
          tokenCount: metrics.outputTokens ?? 0,
          tokenCountKnown: metrics.outputTokens !== undefined,
          tokensPerSecond: metrics.tokensPerSecond?.toFixed(1) ?? "—",
          decodeMetricSource: metrics.outputTokens === undefined ? "unavailable" : "remote-request",
          remoteRequestSeconds: metrics.requestSeconds,
          remotePasses: metrics.passes,
        };
      };
      let cacheDetail = "";
      const recordCacheUsage = (details: any) => {
        const nextCachedTokens = Number(details?.cached_tokens);
        if (Number.isFinite(nextCachedTokens) && nextCachedTokens > 0) {
          cachedTokens = Math.max(cachedTokens, nextCachedTokens);
        }
        if (typeof details?.cache_detail === "string") {
          cacheDetail = mergeCacheDetails(cacheDetail, details.cache_detail);
        }
      };
      const exchangeFirstTokenClock = new ExchangeFirstTokenClock();
      let firstTokenTime: number | null = null;
      // Track actual generation time (excludes PP and tool execution pauses)
      let generationMs = 0;
      let lastTokenTime: number | null = null;
      // Rolling window for live TPS: circular buffer of (timestamp, tokenCount) snapshots.
      // Uses actual token count deltas for accurate throughput — handles multi-token SSE chunks
      // correctly (e.g., reasoning batches where each chunk may contain 2+ tokens).
      const TPS_BUFFER_SIZE = 30;
      const tpsSnapshots: Array<[number, number]> = []; // [timestamp, relative tokenCount]
      let liveTps = 0;
      // Keep a bounded history across tool iterations. The last rolling value
      // can represent only a tiny final-answer tail after a long pause, while
      // the displayed token count is cumulative across every reasoning/tool
      // round. Final metrics need a representative stream rate, not merely the
      // last ten tokens of the last HTTP request.
      const liveTpsHistory: number[] = [];
      const MAX_LIVE_TPS_SAMPLES = 512;
      let tpsTokenBase = 0; // re-anchor point for tpsSnapshots after iteration reset
      // Local vMLX Chat and Responses streams negotiate exact engine-side decode
      // windows. Keep one latest cumulative snapshot per HTTP pass, then sum
      // passes across the visible agent/tool exchange. SSE arrival timing is
      // only a fallback: --stream-interval batches tokens, and tool-control
      // output can advance usage without producing a visible delta.
      const completedServerDecodePasses: Array<ServerDecodePass | undefined> = [];
      let currentServerDecodePass: ServerDecodePass | undefined;
      let currentPrefillUsage: unknown;
      const completedPrefillPasses: unknown[] = [];
      const exchangePrefillSpeed = () => summarizePrefillPasses([
        ...completedPrefillPasses, currentPrefillUsage,
      ]);
      // First HTTP pass of the visible turn. TTFT belongs to it, so the cached
      // pp/s reuse indicator pairs ITS prompt/cached counts with that TTFT.
      // Prompt/cached counts only ever come from server usage, so a pass with
      // promptTokens > 0 is server-counted. (serverSendsUsage tracks OUTPUT
      // usage and is reset by tool execution before sendFollowUp runs.)
      let firstPass: { promptTokens: number; cachedTokens: number } | undefined;
      // Footer prefill chips (REQUIRED next to t/s): cold pp/s from the engine
      // receipts, else the TTFT estimate on a turn without a cache hit; cached
      // pp/s (whole prompt over TTFT) whenever the first pass reused a prefix.
      const footerPrefillRates = (ttftSeconds: number) => {
        const first = firstPass ?? { promptTokens, cachedTokens };
        const counts = first.promptTokens > 0 ? {
          promptTokens: first.promptTokens,
          cachedTokens: Math.min(first.cachedTokens, first.promptTokens),
          ttftSeconds,
        } : undefined;
        const measured = exchangePrefillSpeed();
        const estimated = measured || !counts ? undefined : estimateColdPrefillTps(counts);
        return {
          ppSpeed: measured ?? estimated,
          ppMetricSource: measured ? "engine-prefill" : estimated ? "ttft-estimate" : undefined,
          cachedPpSpeed: counts ? calculateCachedPromptTps(counts) : undefined,
        };
      };
      const recordServerDecodeUsage = (usage: unknown) => {
        if (usage && typeof usage === "object" && "vmlx_prefill" in usage) {
          currentPrefillUsage = (usage as { vmlx_prefill?: unknown }).vmlx_prefill;
        }
        const decoded = parseServerDecodeUsage(usage);
        if (!decoded) return;
        currentServerDecodePass = decoded;
        liveTps = decoded.tokensPerSecond;
      };
      const finishServerDecodePass = () => {
        // Missing receipt coverage must remain visible; never report only
        // the last measured pass as the entire tool exchange.
        completedServerDecodePasses.push(currentServerDecodePass);
        currentServerDecodePass = undefined;
      };
      // No streaming throttle — emit every token. Renderer-side useTypewriter
      // in MessageBubble.tsx handles smooth character reveal via rAF.
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      // (thinkingTimer removed — "Thinking silently" indicator disabled)
      let fullContent = "";
      let reasoningContent = "";
      let reasoningSegments: string[] = [];
      const displayTimeline = new AssistantDisplayTimelineRecorder();
      const currentReasoningContent = () =>
        joinReasoningSegments(reasoningSegments) || reasoningContent;
      const currentReasoningSegments = () =>
        visibleReasoningSegments(reasoningSegments);
      const currentReasoningSegment = () => {
        const segments = currentReasoningSegments();
        return segments[segments.length - 1] || reasoningContent;
      };
      const responsesReasoningItem = (text: string) => ({
        type: "reasoning",
        content: [{ type: "reasoning", text }],
      });
      let responseWarnings: string[] | null = null;
      // A model can complete the first post-tool stream with reasoning but no
      // visible answer. The one recovery request is intentionally answer-only:
      // it preserves the completed tool result in history while removing tool
      // schemas and putting local models on their direct (thinking-off) rail.
      // This is scoped to the recovery request; the normal tool loop keeps the
      // user's reasoning setting and supports additional tool calls.
      let finalAnswerRecovery = false;
      // An explicit "exactly once; after the tool result, reply exactly ..."
      // contract has no valid second execution. Keep its rendered schema prefix
      // stable for SSD reuse; the local fulfilled header plus the execution
      // dedupe below prevent a second call without rewriting that prefix.
      let plannedDirectAnswerPass = false;
      let previousToolRequestFields: ToolRequestFields | undefined;
      // Accumulates content across tool iterations so abort during tool execution can recover
      // earlier content that would otherwise be lost when fullContent is reset between iterations
      let allGeneratedContent = "";
      // Per-request count. Provider usage restarts at each HTTP request;
      // never infer a restart by comparing it with the previous request size.
      let iterationTokenCount = 0;
      // Cumulative token offset: tracks total tokens from completed iterations.
      // Server restarts completion_tokens from 0 on each new HTTP request, so
      // raw tokenCount only reflects the current iteration. This offset + iterationTokenCount
      // gives the true total across all tool iterations.
      let cumulativeTokenOffset = 0;
      // Collect tool statuses for DB persistence (mirrors what's emitted to renderer)
      const collectedToolStatuses: Array<{
        timestamp: number;
        phase: string;
        toolName: string;
        toolCallId?: string;
        detail?: string;
        iteration?: number;
        contentOffset?: number;
      }> = [];
      let toolStatusNeedsFlush = false;
      // A single ReadableStream read can contain dozens of SSE events. Without
      // yielding between visible deltas, Electron queues every chat:stream IPC
      // message in one main-process turn and React coalesces the whole answer
      // into the terminal render. Reasoning appears live, then content appears
      // all at once even though the server emitted token-level deltas.
      let rendererStreamNeedsFlush = false;
      // Declared outside try so catch block can access them for error recovery
      let isReasoning = false;
      let lastFinishReason: string | undefined;
      // Periodic DB save interval — saves content every 5s so it survives navigation/crashes
      let periodicSaveInterval: ReturnType<typeof setInterval> | null = null;

      const generationRecord: GenerationRecord = { version: 1, status: 'in_progress', passes: [] };
      const saveGenerationRecord = (displayContent = assistantMessage.content) => {
        generationRecord.toolExchange = JSON.parse(JSON.stringify(requestMessages.slice(currentTurnToolStart)));
        generationRecord.displayTimeline = displayTimeline.finalize(displayContent, reasoningSegments);
        assistantMessage.generationRecordJson = JSON.stringify(generationRecord);
        db.updateMessageGenerationRecord(assistantMessage.id, assistantMessage.generationRecordJson);
      };

      // Pre-insert assistant message to DB immediately so periodic updates have a row to update.
      // Uses INSERT OR REPLACE so the final addMessage at completion overwrites cleanly.
      if (mode === "send") db.addMessage(assistantMessage);

      const startPeriodicSave = () => {
        if (periodicSaveInterval) return;
        periodicSaveInterval = setInterval(() => {
          const saveContent = allGeneratedContent
            ? fullContent.trim()
              ? allGeneratedContent + "\n\n" + fullContent.trim()
              : allGeneratedContent
            : fullContent;
          const saveReasoning = currentReasoningContent();
          try { saveGenerationRecord(saveContent); }
          catch (error) { console.warn('[CHAT] Could not checkpoint generation record', error); }
          if (saveContent || saveReasoning) {
            try {
              db.updateMessageContent(
                assistantMessage.id,
                saveContent,
                saveReasoning || undefined,
                reasoningSegments.length > 0
                  ? JSON.stringify(reasoningSegments)
                  : undefined,
              );
            } catch (_) {}
          }
        }, 5000);
      };
      const stopPeriodicSave = () => {
        if (periodicSaveInterval) {
          clearInterval(periodicSaveInterval);
          periodicSaveInterval = null;
        }
      };

      try {
        if (mode === "send" && unavailableExactlyOnceBuiltinToolNames.length > 0) {
          const quotedNames = unavailableExactlyOnceBuiltinToolNames
            .map((name) => `"${name}"`)
            .join(", ");
          const subject =
            unavailableExactlyOnceBuiltinToolNames.length === 1
              ? `tool ${quotedNames} is`
              : `tools ${quotedNames} are`;
          throw new Error(
            `Requested built-in ${subject} disabled or unavailable for this turn. Enable the relevant Chat Settings category and retry.`,
          );
        }
        // Call API (local vMLX Engine or remote OpenAI-compatible endpoint)
        const apiUrl = useResponsesApi
          ? `${baseUrl}/v1/responses`
          : `${baseUrl}/v1/chat/completions`;
        console.log(
          `[CHAT] Sending to: ${apiUrl} (wire: ${wireApi}, remote: ${isRemote})`,
        );

        let generationHealth: Record<string, any> | undefined;
        // Get model name: remote uses configured model, local reads from health endpoint
        let modelName = isRemote
          ? resolvedSession?.remoteModel || chat.modelId || "default"
          : chat.modelId || "default";
        if (!isRemote) {
          try {
            const healthRes = await fetch(`${baseUrl}/health`, {
              headers: authHeaders,
              signal: AbortSignal.timeout(1000),
            });
            if (healthRes.ok) {
              const health = await healthRes.json();
              generationHealth = health;
              if (health.model_name) modelName = health.model_name;
            }
          } catch (_) {
            /* use fallback */
          }
        }

        // Only send stop sequences when the user explicitly sets them in chat settings.
        // The server already handles stop tokens via the model's chat template — sending
        // all template tokens for every model risks false-positive stops (e.g. Qwen hitting </s>).
        const stopSequences = overrides?.stopSequences
          ? overrides.stopSequences
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
          : undefined;

        const availableToolDefinitions = () =>
          currentTurnToolDefinitions.filter(
            (tool) => {
              const name = tool.function.name.toLowerCase();
              return (
                !completedExactFinalTools.has(name) &&
                !completedExactlyOnceTools.has(name)
              );
            },
          );

        // ── Prefix-cache discipline ─────────────────────────────────────────
        // The engine (paged/memory/disk prefix caches) and remote providers
        // only reuse work for an IDENTICAL token prefix: system prompt, then
        // tool schemas, then messages in order. Within a chat session:
        //  1. The system prompt is built once per turn from chat settings
        //     (custom prompt / agentic prompt / project instructions) and is
        //     never edited afterwards.
        //  2. The tool catalog depends on chat settings only and is emitted in
        //     the registry's canonical order (orderToolsForPrefixCache).
        //  3. Per-turn additions — tool results, repeat-call notes, media
        //     follow-ups, recovery prompts — are APPENDED to requestMessages.
        //     Earlier messages are never rewritten in place.
        //  4. Compaction is the single deliberate exception: it replaces one
        //     older span with a checkpoint once, and its summary request
        //     replays the same prefix + tools with the instruction appended
        //     last, so even that call reuses the warm cache.
        // Build request body — shared between initial request and tool follow-ups
        //
        // `auxiliary` builds the compaction summary request: the SAME body
        // (model, sampler, reasoning fields, tool schemas in the same order)
        // over the given messages, with only the output cap changed and no
        // forced tool_choice. It records no generation pass.
        const buildRequestBody = (
          auxiliary?: { messages: any[]; maxTokens: number; answerOnly?: boolean },
        ): Record<string, any> => {
          const bodyMessages = auxiliary?.messages ?? requestMessages;
          const finalizeAuxiliaryBody = (obj: Record<string, any>) => {
            let maxTokens = auxiliary!.maxTokens;
            if (auxiliary!.answerOnly) {
              // The compaction summary must not spend its token cap thinking:
              // a reasoning model otherwise hits the cap mid-thought, the
              // summary is rejected as truncated, and the chat never compacts.
              // Locally thinking is switched off (only the generation prompt's
              // tail changes, so the cached prefix is still reused); a remote
              // provider gets room for its reasoning instead.
              if (!isRemote && supportsInstructMode !== false) {
                obj.enable_thinking = false;
                obj.chat_template_kwargs = { ...(obj.chat_template_kwargs || {}), enable_thinking: false };
                delete obj.reasoning_effort;
                delete obj.max_thinking_tokens;
              } else {
                maxTokens *= 2;
              }
            }
            if (useResponsesApi) obj.max_output_tokens = maxTokens;
            else obj.max_tokens = maxTokens;
            delete obj.tool_choice;
            return obj;
          };
          const resolvedOutputBudget = dsv4OutputBudget(
            overrides?.maxTokens,
            overrides?.enableThinking,
            chatDetectedFamily,
            overrides?.reasoningEffort,
          );
          const resolvedThinkingBudget =
            typeof overrides?.maxThinkingTokens === "number" &&
              Number.isFinite(overrides.maxThinkingTokens) &&
              overrides.maxThinkingTokens > 0
              ? Math.floor(overrides.maxThinkingTokens)
              : undefined;
          const effectiveEnableThinkingOverride =
            !isRemote &&
            !sessionHasReasoningParser &&
            chatDetectedFamily !== "deepseek-v4"
              ? undefined
              : overrides?.enableThinking;
          const applyThinkingBudget = (obj: Record<string, any>) => {
            // This used to be named for the LOCAL path and returned early on
            // isRemote. That was right while the capability was unknowable over
            // the wire -- but the engine now emits supports_thinking_budget in
            // /v1/capabilities, so a remote session knows it too. Without this,
            // making the control RENDER remotely just made it decorative: the
            // user set a budget and neither max_thinking_tokens nor
            // chat_template_kwargs.thinking_budget ever left the app.
            //
            // Safe against an older remote engine that does not emit the key:
            // supportsThinkingBudget stays undefined and the capability gate
            // below returns without sending anything.
            if (resolvedThinkingBudget == null || obj.enable_thinking === false) {
              return;
            }
            // Engine-level reasoning-phase cap: the server honors a top-level
            // max_thinking_tokens ONLY for the families whose answer-pass machinery
            // caps the thinking pass at the budget (registry supportsThinkingBudget),
            // or when the chat TEMPLATE itself declares a budget marker
            // (thinkingBudgetSupported). Families with a reasoning parser but NO
            // engine-side thinking-budget behavior (e.g. deepseek-v4, step-3.7-flash)
            // ignore the field — dsv4 uses reasoning_effort instead — so sending it
            // would be untruthful. Gate the whole block on either capability.
            if (!(supportsThinkingBudget === true || thinkingBudgetSupported === true)) {
              return;
            }
            obj.max_thinking_tokens = resolvedThinkingBudget;
            if (thinkingBudgetSupported !== false) {
              obj.chat_template_kwargs = {
                ...(obj.chat_template_kwargs || {}),
                thinking_budget: resolvedThinkingBudget,
              };
            }
          };
          const applyPostToolAnswerPolicy = (obj: Record<string, any>) => {
            applyPostToolRequestFields(obj, {
              finalAnswerRecovery,
              plannedDirectAnswerPass,
              isRemote,
              previous: previousToolRequestFields,
            });
            // A normal exact-final follow-up is still part of the user's
            // requested reasoning mode. It must not silently turn an explicit
            // On (or model-owned Auto) into Thinking Off. Only the bounded
            // recovery after an actually empty/incomplete post-tool pass may
            // remove schemas and request instruct mode.
            if (!finalAnswerRecovery) return;
            if (isRemote) return;
            // Some native templates (currently Step-3.7) have no truthful
            // thinking-off rail. Keep their bounded follow-up answer-only by
            // removing tools, but do not coerce an empty <think> sentinel.
            if (supportsInstructMode === false) return;
            obj.enable_thinking = false;
            obj.thinking_mode = "instruct";
            obj.chat_template_kwargs = {
              ...(obj.chat_template_kwargs || {}),
              enable_thinking: false,
            };
            delete obj.reasoning_effort;
            delete obj.max_thinking_tokens;
          };
          const finalizeRequestBody = (obj: Record<string, any>) => {
            applyPostToolAnswerPolicy(obj);
            previousToolRequestFields = captureToolRequestFields(obj);
            generationRecord.passes.push(captureGenerationPass({
              body: obj,
              modelPath: resolvedSession?.modelPath || chat.modelPath,
              family: chatDetectedFamily,
              wireApi,
              serverConfig: chatSessionConfig,
              health: generationHealth,
              toolExchange: requestMessages.slice(currentTurnToolStart),
            }));
            saveGenerationRecord();
            return obj;
          };
          if (useResponsesApi) {
            const { systemMessages, inputMessages } =
              splitResponsesSystemMessages(
                bodyMessages,
                chatDetectedFamily === "deepseek-v4",
              );
            const instructions =
              overrides?.builtinToolsEnabled && systemMessages.length > 0
                ? systemMessages.map((m: any) => m.content).join("\n")
                : overrides?.systemPrompt ||
              (systemMessages.length > 0
                ? systemMessages.map((m: any) => m.content).join("\n")
                : undefined);
            const obj: Record<string, any> = {
              model: modelName,
              input: inputMessages,
              instructions,
              // Native MTP contributes the product-enforced greedy tuple;
              // otherwise only explicit chat overrides are sent and the
              // server remains authoritative for bundle defaults.
              ...(effectiveSamplerOverrides?.temperature != null
                ? { temperature: effectiveSamplerOverrides.temperature }
                : {}),
              ...(effectiveSamplerOverrides?.topP != null
                ? { top_p: effectiveSamplerOverrides.topP }
                : {}),
              ...(resolvedOutputBudget
                ? { max_output_tokens: resolvedOutputBudget }
                : {}),
              stream: true,
            };
            if (stopSequences) obj.stop = stopSequences;
            const effectiveTopK = effectiveSamplerOverrides?.topK;
            // Zero is an explicit disable override. Omitting it would make the
            // engine re-inherit a non-zero bundle/default top_k.
            if (effectiveTopK != null) obj.top_k = effectiveTopK;
            // Explicit zero disables a non-zero bundle min_p default. Only an
            // absent override means inherit the model/server default.
            if (effectiveSamplerOverrides?.minP != null)
              obj.min_p = effectiveSamplerOverrides.minP;
            // Always send when explicitly set; 1.0 can be an intentional
            // per-chat override of a bundle repetition penalty.
            if (overrides?.repeatPenalty != null)
              obj.repetition_penalty = overrides.repeatPenalty;
            if (overrides?.frequencyPenalty != null)
              obj.frequency_penalty = overrides.frequencyPenalty;
            if (overrides?.presencePenalty != null)
              obj.presence_penalty = overrides.presencePenalty;
            // An explicit current-turn no-tool directive is stronger than the
            // chat's persistent built-in-tools toggle. Omitting the schemas is
            // API-equivalent to tool_choice="none", avoids paying for an
            // unusable catalog, and keeps the rendered prefix stable across
            // Responses history replay (some native templates otherwise add a
            // fallback schema block only on the follow-up turn).
            if (attachToolsForCurrentTurn) {
              obj.tools = availableToolDefinitions().map((t) => ({
                type: "function",
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
              }));
            }
            const requestToolChoice = currentTurnToolChoice();
            if (requestToolChoice !== undefined) {
              obj.tool_choice = requestToolChoice;
            }
            // Only explicit On/Off is serialized. Auto stays omitted so the
            // concrete bundle/family owns its native default (for example,
            // Laguna S2.1's stamped default-on, MiniMax M3 adaptive, and DSV4's
            // reasoning.default_mode). Parser seeding is resolved by the engine
            // from that same effective policy; the presence of a parser alone is
            // not permission for the panel to force thinking on.
            applyReasoningRequestFields(obj, {
              enableThinking: effectiveEnableThinkingOverride,
              thinkingMode: overrides?.thinkingMode,
              supportsAdaptiveThinking,
              reasoningEffort: overrides?.reasoningEffort,
              isRemote,
              sessionHasReasoningParser,
              detectedFamily: chatDetectedFamily,
              supportedReasoningEfforts,
              wireApi: 'responses',
              remoteReasoningFormat: isRemote ? remoteReasoningFormat ?? remoteReasoningFormatForUrl(apiUrl) : undefined,
              defaultReasoningEffort,
            });
            applyThinkingBudget(obj);
            // VLM video sampling — forward to engine only when session
            // config has non-default values. Remote OpenAI-compatible
            // providers don't support these fields, so skip there.
            if (!isRemote && sessionImageTokenBudget !== undefined)
              obj.image_token_budget = sessionImageTokenBudget;
            if (!isRemote && sessionVideoFps !== undefined)
              obj.video_fps = sessionVideoFps;
            if (!isRemote && sessionVideoMaxFrames !== undefined)
              obj.video_max_frames = sessionVideoMaxFrames;
            if (!isRemote && sessionVideoMaxPixels !== undefined)
              obj.video_max_pixels = sessionVideoMaxPixels;
            if (!isRemote && sessionVideoTokenBudget !== undefined)
              obj.video_token_budget = sessionVideoTokenBudget;
            // Do not serialize the session timeout as the API's explicit
            // per-request `timeout`. The engine deliberately defines an
            // explicit request timeout as a hard wall-clock budget, while its
            // server default is progress-aware. The app owns the saved value
            // as the inactivity watchdog armed above.
            if (auxiliary) return finalizeAuxiliaryBody(obj);
            return finalizeRequestBody(obj);
          } else {
            const obj: Record<string, any> = {
              model: modelName,
              messages: bodyMessages,
              // Same effective sampler contract as the Responses branch.
              ...(effectiveSamplerOverrides?.temperature != null
                ? { temperature: effectiveSamplerOverrides.temperature }
                : {}),
              ...(effectiveSamplerOverrides?.topP != null
                ? { top_p: effectiveSamplerOverrides.topP }
                : {}),
              ...(resolvedOutputBudget ? { max_tokens: resolvedOutputBudget } : {}),
              stream: true,
              stream_options: { include_usage: true },
            };
            if (stopSequences) obj.stop = stopSequences;
            const effectiveTopK = effectiveSamplerOverrides?.topK;
            // Preserve explicit Off across both wire APIs; only undefined means
            // inherit the current model/server default.
            if (effectiveTopK != null) obj.top_k = effectiveTopK;
            if (effectiveSamplerOverrides?.minP != null)
              obj.min_p = effectiveSamplerOverrides.minP;
            // Always send when explicitly set; 1.0 can be an intentional
            // per-chat override of a bundle repetition penalty.
            if (overrides?.repeatPenalty != null)
              obj.repetition_penalty = overrides.repeatPenalty;
            if (overrides?.frequencyPenalty != null)
              obj.frequency_penalty = overrides.frequencyPenalty;
            if (overrides?.presencePenalty != null)
              obj.presence_penalty = overrides.presencePenalty;
            if (attachToolsForCurrentTurn) {
              // Chat Completions API: tools must be in OpenAI format with "function" wrapper
              // e.g. {"type": "function", "function": {"name": ..., "parameters": ...}}
              obj.tools = availableToolDefinitions();
            }
            const requestToolChoice = currentTurnToolChoice();
            if (requestToolChoice !== undefined) {
              obj.tool_choice = requestToolChoice;
            }
            // Only explicit On/Off is serialized. Auto stays omitted so the
            // provider or local engine can apply the model's native policy.
            applyReasoningRequestFields(obj, {
              enableThinking: effectiveEnableThinkingOverride,
              thinkingMode: overrides?.thinkingMode,
              supportsAdaptiveThinking,
              reasoningEffort: overrides?.reasoningEffort,
              isRemote,
              sessionHasReasoningParser,
              detectedFamily: chatDetectedFamily,
              supportedReasoningEfforts,
              wireApi: 'completions',
              remoteReasoningFormat: isRemote ? remoteReasoningFormat ?? remoteReasoningFormatForUrl(apiUrl) : undefined,
              defaultReasoningEffort,
            });
            applyThinkingBudget(obj);
            // VLM video sampling — local engine only (strict 3rd-party APIs
            // reject unknown fields, remote OpenAI-compat doesn't support it).
            if (!isRemote && sessionImageTokenBudget !== undefined)
              obj.image_token_budget = sessionImageTokenBudget;
            if (!isRemote && sessionVideoFps !== undefined)
              obj.video_fps = sessionVideoFps;
            if (!isRemote && sessionVideoMaxFrames !== undefined)
              obj.video_max_frames = sessionVideoMaxFrames;
            if (!isRemote && sessionVideoMaxPixels !== undefined)
              obj.video_max_pixels = sessionVideoMaxPixels;
            if (!isRemote && sessionVideoTokenBudget !== undefined)
              obj.video_token_budget = sessionVideoTokenBudget;
            // Keep the local engine on its progress-aware server default. An
            // API caller that explicitly sends `timeout` still gets the
            // documented hard wall-clock behavior.
            if (auxiliary) return finalizeAuxiliaryBody(obj);
            return finalizeRequestBody(obj);
          }
        };
        const requestDiagSessionId = chatSession?.id || resolvedSession?.id;
        const logRequestShape = (
          bodyJson: string,
          phase: "initial" | "follow_up",
        ) => {
          if (!requestDiagSessionId) return;
          pushChatSessionLog(
            requestDiagSessionId,
            `[CHAT_DIAG] request_shape=${JSON.stringify({
              phase,
              chatId: chatId.slice(0, 8),
              wireApi,
              isRemote,
              baseUrl,
              chatIsMultimodal,
              historicalMediaReplay:
                chatIsMultimodal || isRemote ? "full" : "text_only",
              detectedFamily: chatDetectedFamily,
              sessionHasReasoningParser,
              plannedDirectAnswerPass,
              finalAnswerRecovery,
              body: summarizeRequestForLog(bodyJson, useResponsesApi),
            })}`,
          );
        };
        // Remote internet providers use Electron's net.fetch for certificates
        // and proxies; loopback model servers use Node streaming for SSE.
        const useNodeStreamingFetch = !isRemote || isLoopbackUrl(apiUrl);
        // Prefill timing and `response.usage` are private local telemetry.
        // Negotiate it out-of-band only with a local engine.  The public
        // Responses request body must not send Chat's non-standard
        // stream_options.include_usage to OpenAI-compatible remote providers.
        const vmlxUsageHeaders: Record<string, string> =
          !isRemote
            ? { "X-vMLX-Stream-Usage": "incremental" }
            : {};

        // ─── Context compaction ─────────────────────────────────────────────
        // At 80% of the context window the older history is replaced by one
        // structured checkpoint written by this same model; the newest ~16%
        // stays verbatim and a tool call is never split from its result. The
        // summary request replays the current prefix (system prompt, tools,
        // leading messages) and appends the instruction last, so the engine's
        // prefix cache is reused. Also runs once after a "prompt too long"
        // rejection, and on demand for /compact.
        const contextWindow = resolveContextWindow({
          engineMaxPromptTokens: generationHealth?.max_prompt_tokens,
          sessionMaxContextLength: isRemote ? undefined : chatSessionConfig.maxContextLength,
          modelMaxContextLength: chatModelMaxContextLength,
        });
        const tokenCalibrator = tokenCalibratorFor(chatId);
        let lastSentHeuristicTokens = 0;
        let autoCompactionFailures = 0;
        // This turn's tool exchange items that a checkpoint replaced. They are
        // still persisted on the assistant row (what really happened), even
        // though the model now sees them summarized.
        const compactedCurrentTurnItems: any[] = [];
        const toolsForEstimate = () =>
          attachToolsForCurrentTurn ? availableToolDefinitions() : [];
        const notePromptSent = () => {
          lastSentHeuristicTokens = estimateRequestTokens(requestMessages, toolsForEstimate());
          // Context gauge in the composer: how full the window is now.
          try {
            const win = getWindow();
            if (win && !win.isDestroyed() && contextWindow.tokens > 0) {
              win.webContents.send("chat:context", {
                chatId,
                tokens: Math.round(tokenCalibrator.estimate(lastSentHeuristicTokens)),
                window: contextWindow.tokens,
                known: contextWindow.known,
              });
            }
          } catch (_) {}
        };
        const emitCompactionEvent = (event: Record<string, unknown>) => {
          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:compaction", { chatId, ...event });
            }
          } catch (_) {}
        };
        const runSummaryRequest = async (
          summaryMessages: any[],
          maxTokens: number,
          opts: { noTools?: boolean; answerOnly?: boolean } = {},
        ): Promise<SummaryStreamResult> => {
          const summaryObj = buildRequestBody({ messages: summaryMessages, maxTokens, answerOnly: opts.answerOnly });
          // A side question must answer in words: the tools stay described
          // (same prompt as the chat) but the model may not call them.
          if (opts.noTools && (summaryObj.tools?.length ?? 0) > 0) summaryObj.tool_choice = "none";
          const summaryBody = JSON.stringify(summaryObj);
          const summaryInit = {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: summaryBody,
            signal: abortController.signal,
          };
          armFetchInactivityTimeout();
          const summaryResponse = useNodeStreamingFetch
            ? await (providerRoute?.fetch ?? streamingFetch)(apiUrl, summaryInit as any)
            : await (providerRoute?.fetch ?? remoteFetch)(apiUrl, summaryInit as any);
          if (!summaryResponse.ok) {
            const detail = await summaryResponse.text();
            return { text: "", error: `${summaryResponse.status} ${detail.slice(0, 500)}` };
          }
          const summaryReader = summaryResponse.body?.getReader();
          if (!summaryReader) return { text: "", error: "empty response body" };
          const collector = new SummaryStreamCollector();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await summaryReader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              armFetchInactivityTimeout();
              collector.push(decoder.decode(value, { stream: true }));
            }
          }
          collector.push(decoder.decode());
          return collector.finish();
        };
        const compactRequestHistory = async (
          reason: "threshold" | "overflow" | "manual",
          opts: { aggressive?: boolean } = {},
        ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number; trimmed?: boolean }> => {
          const tools = toolsForEstimate();
          const heuristicTotal = estimateRequestTokens(requestMessages, tools);
          const beforeTokens = tokenCalibrator.estimate(heuristicTotal);
          // Budgets are in real tokens; ranges are picked on the heuristic, so
          // convert with this chat's measured scale (a CJK or code-heavy chat
          // tokenizes denser than the heuristic assumes).
          const scale = tokenCalibrator.scale(heuristicTotal);
          // Automatic compaction keeps 16% of the window verbatim. After an
          // overflow (the known window was wrong) and for /compact on a short
          // chat, at most the newest quarter of the history is kept; a second
          // overflow keeps 8%.
          const historyReal = Math.ceil(estimateRequestTokens(requestMessages) * scale);
          const retainReal = opts.aggressive
            ? Math.floor(contextWindow.tokens * 0.08)
            : reason !== "threshold"
              ? Math.min(compactionRetainTokens(contextWindow.tokens), Math.floor(historyReal * 0.25))
              : compactionRetainTokens(contextWindow.tokens);
          // The span is replayed to be summarized, so it must fit in one request
          // next to the system prompt, the tool schemas and the summary itself.
          const leadingReal = tokenCalibrator.estimate(
            estimateRequestTokens(requestMessages.slice(0, firstCompactableIndex(requestMessages)), tools),
          );
          // (Only when that leaves a useful span: with a very large system
          // prompt or tool list there is no smaller span worth summarizing.)
          const spanBudgetReal =
            contextWindow.tokens - leadingReal - summaryMaxTokens(contextWindow.tokens) - 1024;
          const range = selectCompactionRange(
            requestMessages,
            Math.floor(retainReal / scale),
            estimateMessageTokens,
            spanBudgetReal >= contextWindow.tokens * 0.25 ? Math.floor(spanBudgetReal / scale) : Infinity,
          );
          if (!range) return { compacted: false, beforeTokens, afterTokens: beforeTokens };
          const replacedTokens = requestMessages
            .slice(range.start, range.end + 1)
            .reduce((total, message) => total + estimateMessageTokens(message), 0);
          console.log(
            `[CHAT] Compacting (${reason}): ~${beforeTokens} of ${contextWindow.tokens} tokens (${contextWindow.source}), summarizing items ${range.start}-${range.end}`,
          );
          if (reason !== "manual") emitCompactionEvent({ phase: "start", reason });
          let summary: string;
          let trimmed = false;
          try {
            summary = acceptSummary(
              await runSummaryRequest(
                buildSummarizationMessages(requestMessages, range),
                summaryMaxTokens(contextWindow.tokens),
                { answerOnly: true },
              ),
              replacedTokens,
            );
          } catch (err) {
            // The chat no longer fits and no summary could be made: drop the
            // older span (keeping an earlier checkpoint's facts) so the message
            // is still sent, rather than refusing it.
            if (reason !== "overflow" || abortController.signal.aborted) throw err;
            console.warn("[CHAT] Summary failed after an overflow; trimming the oldest messages instead", err);
            const first = requestMessages[range.start];
            const previous = isCheckpointMessage(first)
              ? cleanSummaryText(String((first as any).content))
              : undefined;
            summary = trimmedCheckpointSummary(range.end - range.start + 1, previous);
            trimmed = true;
          }
          if (range.end >= currentTurnToolStart) {
            compactedCurrentTurnItems.push(
              ...requestMessages.slice(Math.max(range.start, currentTurnToolStart), range.end + 1),
            );
          }
          const boundaryId = persistedBoundaryForRange(requestMessages, range);
          const compactedMessages = applyCompaction(requestMessages, range, summary, boundaryId);
          currentTurnToolStart = shiftIndexAfterCompaction(currentTurnToolStart, range);
          requestMessages.length = 0;
          requestMessages.push(...compactedMessages);
          if (boundaryId) {
            const nextState: ChatCompactionState = {
              version: 1,
              summary,
              throughMessageId: boundaryId,
              createdAt: Date.now(),
              compactions: (compactionState?.compactions ?? 0) + 1,
            };
            compactionState = nextState;
            db.setChatCompactionState(chatId, JSON.stringify(nextState));
          }
          const afterTokens = tokenCalibrator.estimate(
            estimateRequestTokens(requestMessages, tools),
          );
          pushChatSessionLog(
            requestDiagSessionId,
            `[CHAT_DIAG] compaction=${JSON.stringify({ chatId: chatId.slice(0, 8), reason, contextWindow: contextWindow.tokens, beforeTokens, afterTokens, persisted: !!boundaryId })}`,
          );
          if (reason !== "manual") {
            emitCompactionEvent({ phase: "done", reason, beforeTokens, afterTokens, ...(trimmed ? { trimmed: true } : {}) });
          }
          return { compacted: true, beforeTokens, afterTokens, ...(trimmed ? { trimmed: true } : {}) };
        };
        // Compact round after round until the request fits (a span that is too
        // big to summarize at once is done in parts), at most four rounds.
        const compactUntilFits = async (
          reason: "threshold" | "overflow",
          opts: { aggressive?: boolean } = {},
        ): Promise<boolean> => {
          const target =
            reason === "threshold"
              ? compactionThresholdTokens(contextWindow.tokens)
              : Math.floor(contextWindow.tokens * 0.7);
          let any = false;
          for (let round = 0; round < 4; round += 1) {
            const outcome = await compactRequestHistory(reason, opts);
            if (!outcome.compacted) break;
            any = true;
            if (outcome.afterTokens < target || outcome.afterTokens >= outcome.beforeTokens) break;
          }
          return any;
        };
        const maybeAutoCompact = async () => {
          // A remote endpoint that reports no window compacts only after an
          // actual "prompt too long" rejection.
          if (isRemote && !contextWindow.known) return;
          if (autoCompactionFailures >= 2) return;
          const estimate = tokenCalibrator.estimate(
            estimateRequestTokens(requestMessages, toolsForEstimate()),
          );
          if (!shouldCompact(estimate, contextWindow.tokens)) return;
          try {
            await compactUntilFits("threshold");
          } catch (err) {
            if (abortController.signal.aborted) throw err;
            autoCompactionFailures += 1;
            console.warn("[CHAT] Automatic compaction failed; continuing with the full history", err);
            emitCompactionEvent({ phase: "failed", reason: "threshold", error: (err as Error)?.message });
          }
        };
        const compactAfterOverflow = async (detail: string, attempt: number): Promise<boolean> => {
          // The rejection usually states the real counts: learn this chat's
          // token density from them, and the engine's true limit.
          const counts = parseOverflowTokens(detail);
          if (counts.promptTokens && lastSentHeuristicTokens > 0) {
            tokenCalibrator.observe(lastSentHeuristicTokens, counts.promptTokens);
          }
          if (counts.maxTokens && (!contextWindow.known || counts.maxTokens < contextWindow.tokens)) {
            contextWindow.tokens = counts.maxTokens;
            contextWindow.known = true;
          }
          try {
            return await compactUntilFits("overflow", { aggressive: attempt > 0 });
          } catch (err) {
            if (abortController.signal.aborted) throw err;
            console.warn("[CHAT] Compaction after a prompt-too-long rejection failed", err);
            emitCompactionEvent({ phase: "failed", reason: "overflow", error: (err as Error)?.message });
            return false;
          }
        };

        if (mode === "aside") {
          // Side question: the chat as the model sees it (same prefix, so a
          // local model reuses its cache), then the question, answered briefly
          // without tools. Nothing is saved.
          try {
            const asked = asideMessages(requestMessages, content);
            const res = await runSummaryRequest(asked, 1200, { noTools: true });
            if (res.error) return { success: false, error: res.error };
            return { success: true, text: (res.text || "").trim() };
          } catch (err) {
            if (abortController.signal.aborted) return { success: false, error: "aborted" };
            return { success: false, error: (err as Error)?.message || String(err) };
          }
        }
        if (mode === "compact") {
          try {
            const outcome = await compactRequestHistory("manual");
            return { success: true, ...outcome, contextWindow: contextWindow.tokens };
          } catch (err) {
            if (abortController.signal.aborted) return { success: false, error: "aborted" };
            return { success: false, error: (err as Error)?.message || String(err) };
          }
        }

        await maybeAutoCompact();
        let response!: Awaited<ReturnType<typeof streamingFetch>> | Response;
        for (let overflowRetry = 0; ; overflowRetry++) {
          const requestBody = JSON.stringify(buildRequestBody());
          logRequestShape(requestBody, "initial");
          notePromptSent();

          if (overflowRetry === 0) {
            fetchStartTime = Date.now(); // Capture just before fetch for accurate TTFT
            exchangeFirstTokenClock.beginPass(fetchStartTime);
            remoteMetrics?.beginPass(fetchStartTime);
          }
          // Inference begins HERE — arm the inactivity watchdog now, not at
          // entry, so queued load/wake waiting never counts against it.
          armFetchInactivityTimeout();
          response = providerRoute
            ? await providerRoute.fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
                signal: abortController.signal,
              })
            : useNodeStreamingFetch
            ? await streamingFetch(apiUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...authHeaders,
                  ...vmlxUsageHeaders,
                  ...nextLocalRequestCorrelationHeaders(),
                },
                body: requestBody,
                signal: abortController.signal,
              })
            : await remoteFetch(apiUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...authHeaders,
                  ...vmlxUsageHeaders,
                  ...nextLocalRequestCorrelationHeaders(),
                },
                body: requestBody,
                signal: abortController.signal,
              });

          if (!response.ok) {
            const errorText = await response.text();
            // Try to extract structured error detail from JSON responses
            let errorDetail = errorText;
            try {
              const parsed = JSON.parse(errorText);
              if (parsed.detail) {
                errorDetail =
                  typeof parsed.detail === "string"
                    ? parsed.detail
                    : Array.isArray(parsed.detail)
                      ? parsed.detail
                          .map((d: any) => d.msg || JSON.stringify(d))
                          .join("; ")
                      : JSON.stringify(parsed.detail);
              } else if (
                typeof parsed.error?.message === "string" &&
                parsed.error.message
              ) {
                // OpenAI-style envelope — what the engine actually sends for
                // 4xx rejections like prompt_too_long
                errorDetail = parsed.error.message;
              }
            } catch {
              /* use raw text */
            }
            // "Prompt too long": compact and retry instead of failing (twice,
            // the second time keeping less of the recent history).
            if (
              overflowRetry < 2 &&
              isPromptOverflowError(response.status, errorDetail) &&
              (await compactAfterOverflow(errorDetail, overflowRetry))
            ) {
              continue;
            }
            throw new Error(
              providerRoute
                ? providerErrorMessage(response.status, errorText, providerRoute.providerName)
                : `API error: ${response.status} - ${errorDetail}`,
            );
          }
          break;
        }

        // Stream response
        reader = response.body?.getReader();
        if (!reader) throw new Error("Response body is null");

        fullContent = "";
        reasoningContent = "";
        isReasoning = false;
        let currentEventType = ""; // Track SSE event type for Responses API
        // The server deliberately emits the error signal before its terminal
        // usage event (Chat: usage chunk + [DONE], Responses: response.failed).
        // Keep reading long enough to consume authoritative partial usage, then
        // throw through the normal partial-response persistence path.
        let pendingStreamServerError: ChatStreamServerEventError | null = null;
        const seenResponsesApiEvents = new Set<string>();
        const responsesFunctionCallArgsByKey = new Map<
          string,
          { value: string }
        >();
        const responsesFunctionCallItemKey = (
          itemId: unknown,
          outputIndex: unknown,
        ): string => {
          if (typeof itemId === "string" && itemId.length > 0) {
            return `item:${itemId}`;
          }
          if (typeof outputIndex === "number") {
            return `output:${outputIndex}`;
          }
          return "";
        };
        const responsesFunctionCallArgsBuffer = (
          itemId: unknown,
          outputIndex: unknown,
        ): { value: string } | undefined => {
          const itemKey = responsesFunctionCallItemKey(itemId, undefined);
          const outputKey = responsesFunctionCallItemKey(undefined, outputIndex);
          const key = itemKey || outputKey;
          if (!key) return undefined;
          let argsBuffer =
            responsesFunctionCallArgsByKey.get(itemKey) ||
            responsesFunctionCallArgsByKey.get(outputKey);
          if (!argsBuffer) {
            argsBuffer = { value: "" };
          }
          if (itemKey) responsesFunctionCallArgsByKey.set(itemKey, argsBuffer);
          if (outputKey) {
            responsesFunctionCallArgsByKey.set(outputKey, argsBuffer);
          }
          return argsBuffer;
        };

        // Codex 2026-05-06 #2: track if Responses-API stream emitted any
        // text-delta. When the server sends final text via .done events
        // only (no deltas), we fall back to consuming those — otherwise
        // assistant message is blank and history rebuilds skip it,
        // causing wrong-prompt replay on next turn.
        let _sawResponsesTextDelta = false;
        let responsesFinalText = "";

        // Track tool calls received during streaming for MCP auto-execution
        let receivedToolCalls: Array<{
          id: string;
          function: { name: string; arguments: string };
        }> = [];
        // Track finish_reason from server to detect truncation (length), content filter, etc.
        // (declared outside try block so catch can access it for abort recovery)
        // Track tool iteration count (declared here so processLine closure can access it)
        const MAX_TOOL_ITERATIONS =
          overrides?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
        let toolIteration = 0;

        // Track the length of content last emitted to renderer (for inline tool call positioning)
        let lastEmittedContentLength = 0;

        // Helper: emit tool call status to renderer (separate from content stream)
        const emitToolStatus = (
          phase: string,
          toolName: string,
          detail?: string,
          iteration?: number,
          toolCallId?: string,
        ) => {
          const timestamp = Date.now();
          if (phase === "calling") displayTimeline.tool(toolCallId);
          const contentOffset =
            phase === "calling" ? lastEmittedContentLength : undefined;
          // Collect for persistence — include detail for calling, result, and error phases
          // so tool results are visible after reload (truncate large results to 4KB)
          const persistDetail =
            phase === "calling" || phase === "result" || phase === "error"
              ? detail && detail.length > 4096
                ? detail.slice(0, 4096) + "..."
                : detail
              : undefined;
          collectedToolStatuses.push({
            timestamp,
            phase,
            toolName,
            toolCallId,
            iteration,
            contentOffset,
            detail: persistDetail,
          });
          toolStatusNeedsFlush = true;
          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:toolStatus", {
                timestamp,
                chatId,
                messageId: assistantMessage.id,
                phase,
                toolName,
                toolCallId,
                // The live card shows the raw tool output; bound it (50k
                // chars) so a multi-megabyte result cannot stall the renderer.
                detail:
                  detail && detail.length > 50_000
                    ? detail.slice(0, 50_000) + "\n…"
                    : detail,
                iteration,
                contentOffset,
                displayTimeline: displayTimeline.snapshot(),
              });
            }
          } catch (_) {}
        };
        const flushToolStatusToRenderer = async () => {
          if (!toolStatusNeedsFlush) return;
          toolStatusNeedsFlush = false;
          await new Promise<void>((resolve) => setImmediate(resolve));
        };
        const flushStreamDeltaToRenderer = async () => {
          if (!rendererStreamNeedsFlush) return;
          rendererStreamNeedsFlush = false;
          await new Promise<void>((resolve) => setImmediate(resolve));
        };

        const beginAnswerPass = () => {
          // The bounded answer pass is a second model generation. Its prompt
          // prefill is real end-to-end latency, but it is not decode time. Keep
          // totalTime honest while starting a fresh physical decode window so
          // the UI does not report a healthy ~50 t/s model as ~3 t/s during
          // the silent second prefill.
          lastTokenTime = null;
          tpsSnapshots.length = 0;
          tpsTokenBase = tokenCount;
          liveTps = 0;
          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:answerPass", {
                chatId,
                messageId: assistantMessage.id,
              });
            }
          } catch (_) {}
        };

        // Client-side tool call buffering: suppress content when leaked tool call XML detected.
        // Must check RAW content before template token stripping, since markers like
        // <minimax:tool_call> get stripped by TEMPLATE_TOKEN_REGEX and never reach fullContent.
        let clientToolCallBuffering = false;
        // Set when the Responses reconciler rejects an all-markup terminal
        // payload. Never rendered; drives the never-empty notice at finalize.
        let rejectedControlMarkupText = "";
        let rawAccumulated = ""; // Tracks unstripped content for tool call detection
        // Client-side <think> tag extraction: tracks whether we're inside a <think> block
        // when the server doesn't provide reasoning_content (fallback for all parser types)
        let clientSideThinkParsing = false;
        let clientSideThinkHoldback = "";
        // Trailing characters withheld from the renderer because they could
        // still grow into a tool tag (models tokenize "</parameter>" as several
        // tokens). Flushed at every iteration boundary and before finalize, so
        // ordinary prose that merely ends in "<" is never lost.
        let toolTagHoldback = "";

        const normalizeThinkingMarkers = (content: string) =>
          content
            .replace(/<mm:think>/g, "<think>")
            .replace(/<\/mm:think>/g, "</think>")
            .replace(/\[THINK\]/g, "<think>")
            .replace(/\[\/THINK\]/g, "</think>");

        const thinkMarkerHoldbackLength = (content: string) => {
          const markers = ["<think>", "</think>"];
          let hold = 0;
          for (const marker of markers) {
            const max = Math.min(marker.length - 1, content.length);
            for (let len = 1; len <= max; len++) {
              if (content.endsWith(marker.slice(0, len))) {
                hold = Math.max(hold, len);
              }
            }
          }
          return hold;
        };

        // Helper: emit streaming delta to renderer
        // skipClientCount: when true, skip client-side token counting/TPS (used when
        // a single SSE chunk is split into multiple emitDelta calls by think-tag extraction,
        // so we only count once per SSE chunk, not once per emitDelta call)
        const emitDelta = (
          delta: string,
          isReasoningDelta: boolean,
          skipClientCount = false,
          bypassToolMarkerDetection = false,
        ) => {
          // Skip emission if abort already fired — prevents stale tokens from reaching renderer
          if (abortController.signal.aborted) return;
          // Track raw content BEFORE stripping for tool call marker detection
          let suppressVisibleToolDelta = false;
          if (!isReasoningDelta && !bypassToolMarkerDetection) {
            rawAccumulated += delta;
            // Only activate buffering when tool call markers appear at the start of a line,
            // not when the model is explaining tool syntax in prose (e.g., "I'll use <tool_call>...")
            if (!clientToolCallBuffering) {
              // Catch real tool call formats and common hallucinated tool-call tags.
              // Use trailing window (last 200 chars) to avoid O(n) regex on full response
              const lineStartPattern = TOOL_CALL_MARKER_LINE_START;
              const searchWindow =
                rawAccumulated.length > 200
                  ? rawAccumulated.slice(-200)
                  : rawAccumulated;
              if (lineStartPattern.test(searchWindow)) {
                clientToolCallBuffering = true;
                console.log(`[CHAT] Client-side tool call buffering activated`);
                emitToolStatus(
                  "generating",
                  "",
                  "Generating tool call...",
                  toolIteration,
                );
              }
            }
            suppressVisibleToolDelta = clientToolCallBuffering;
          }

          // Strip any leaked chat template tokens from the delta
          delta = delta.replace(TEMPLATE_TOKEN_REGEX, "");
          if (!delta) return;
          // Strip Harmony protocol residue — only for GLM/GPT-OSS models that use the
          // Harmony <|start|><|channel|><|message|> protocol. Without this guard, these
          // regexes would strip legitimate prose like "assistant analysis" from all models.
          if (isHarmonyModel) {
            delta = delta.replace(/<\/?(?:assistant|analysis|final)+/gi, "");
            delta = delta.replace(
              /(?:assistant\s*){1,3}(?:analysis|final)/gi,
              "",
            );
            delta = delta.replace(
              /(?:analysis|final)\s*(?:assistant\s*){1,3}/gi,
              "",
            );
            if (!delta) return;
          }
          // Strip U+FFFD replacement characters
          delta = delta.replace(/\uFFFD/g, "");
          if (!delta) return;

          // Complete orphan tool tags must never reach the renderer, or the
          // user watches </parameter> stream into the answer and the live view
          // disagrees with what gets persisted. Withhold any trailing fragment
          // that could still become a tag; bypassed emissions are our own
          // notices and are already clean.
          if (!isReasoningDelta && !bypassToolMarkerDetection) {
            const merged = toolTagHoldback + delta;
            const hold = toolMarkupHoldbackLength(merged);
            toolTagHoldback = hold > 0 ? merged.slice(merged.length - hold) : "";
            const emittable = hold > 0
              ? merged.slice(0, merged.length - hold)
              : merged;
            delta = stripStreamingToolTags(emittable);
            if (!delta) return;
          }

          // === State updates (always, no throttle) ===
          const now = Date.now();
          if (firstTokenTime === null) {
            firstTokenTime = now;
            exchangeFirstTokenClock.recordToken(now);
            startPeriodicSave();
          }
          // Track generation time between consecutive streamed deltas. Tool
          // execution and follow-up prefill are excluded by resetting
          // lastTokenTime at each HTTP stream boundary. Do not discard long
          // intra-stream gaps: buffered answer passes and slow models still
          // spent that time generating, and dropping it inflates final TPS.
          if (lastTokenTime !== null) {
            const gap = now - lastTokenTime;
            if (gap > 0) generationMs += gap;
          }
          lastTokenTime = now;

          if (isReasoningDelta) {
            isReasoning = true;
            reasoningSegments = appendReasoningDelta(reasoningSegments, delta);
            const visibleSegments = currentReasoningSegments();
            reasoningContent =
              visibleSegments.length > 0
                ? visibleSegments[visibleSegments.length - 1]
                : "";
          } else {
            if (isReasoning) {
              isReasoning = false;
              try {
                const win = getWindow();
                if (win && !win.isDestroyed()) {
                  win.webContents.send("chat:reasoningDone", {
                    chatId,
                    messageId: assistantMessage.id,
                    reasoningContent: currentReasoningContent(),
                    reasoningSegments: [...reasoningSegments],
                    displayTimeline: displayTimeline.snapshot(),
                  });
                }
              } catch (_) {}
            }
            if (!suppressVisibleToolDelta) {
              fullContent += delta;
            }
          }
          // Client-side counting (fallback when server doesn't send usage in each chunk).
          // Must happen BEFORE TPS snapshot so the rolling window uses accurate counts.
          // skipClientCount prevents inflation when think-tag splitting calls emitDelta
          // multiple times for a single SSE chunk.
          if (!serverSendsUsage && !skipClientCount) {
            tokenCount++;
            iterationTokenCount++;
          }

          // Rolling TPS: snapshot (timestamp, relative tokenCount) for accurate throughput.
          // Uses tpsTokenBase-relative count to avoid negative deltas at iteration boundaries
          // (server restarts completion_tokens from 0 on each new HTTP request).
          tpsSnapshots.push([now, tokenCount - tpsTokenBase]);
          if (tpsSnapshots.length > TPS_BUFFER_SIZE) tpsSnapshots.shift();
          if (tpsSnapshots.length >= 2) {
            const [oldT, oldN] = tpsSnapshots[0];
            const [newT, newN] = tpsSnapshots[tpsSnapshots.length - 1];
            const span = (newT - oldT) / 1000;
            const tpsDelta = newN - oldN;
            liveTps =
              span > 0.01 && tpsDelta > 0
                ? tpsDelta / span
                : tpsDelta <= 0
                  ? 0
                  : liveTps;
            if (Number.isFinite(liveTps) && liveTps > 0) {
              liveTpsHistory.push(liveTps);
              if (liveTpsHistory.length > MAX_LIVE_TPS_SAMPLES) {
                liveTpsHistory.shift();
              }
            }
          }

          // Suppress rendering (but not counting/TPS) when tool call content is detected
          if (!isReasoningDelta && suppressVisibleToolDelta) return;

          const displayContent = isReasoningDelta
            ? currentReasoningContent()
            : visibleToolStreamContent(allGeneratedContent, fullContent);
          // Keep token/TPS accounting above, but do not publish whitespace that
          // a tool-only pass will discard. Preserve meaningful leading whitespace
          // once the first visible character arrives, including code indentation.
          if (displayContent === null) return;
          if (isReasoningDelta) displayTimeline.observeReasoning(reasoningSegments);
          else displayTimeline.observeContent(displayContent);
          if (!isReasoningDelta) lastEmittedContentLength = displayContent.length;

          // === IPC emission — every token emitted immediately ===
          // Renderer-side useTypewriter handles smooth character reveal via rAF.

          // Live generation TPS from rolling window (real-time speed of incoming tokens).
          // Cumulative TPS (tokenCount / generationMs) is used for final saved metrics only.
          const streamTps = liveTps;
          // Elapsed display shares the final whole-turn clock. Generation-only
          // timing remains separate for TPS; follow-up fetches do not reset it.
          const elapsed = Math.max(0, (now - startTime) / 1000);
          // First exchange token, excluding initial health/message preparation.
          const ttft = Math.max(
            0,
            exchangeFirstTokenClock.seconds(),
          );
          const prefillRates = footerPrefillRates(ttft);

          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:stream", {
                chatId,
                messageId: assistantMessage.id,
                fullContent: displayContent,
                isReasoning: isReasoningDelta,
                displayTimeline: displayTimeline.snapshot(),
                reasoningSegments: isReasoningDelta
                  ? [...reasoningSegments]
                  : undefined,
                metrics: {
                  tokenCount: cumulativeTokenOffset + iterationTokenCount,
                  promptTokens,
                  cachedTokens,
                  cacheDetail,
                  tokensPerSecond: streamTps.toFixed(1),
                  ...prefillRates,
                  ttft: ttft.toFixed(2),
                  elapsed: elapsed.toFixed(1),
                  ...remoteMetricFields(),
                },
              });
              rendererStreamNeedsFlush = true;
            }
          } catch (_) {}
        };

        // Process a single SSE data line (with event type context)
        const processLine = (trimmed: string) => {
          // Standards-safe vMLX phase signal. The server emits this as an SSE
          // comment, so generic OpenAI clients ignore it. The local panel uses
          // it to distinguish answer synthesis from a stalled stream.
          if (trimmed === ": vmlx-answer-pass-start") {
            beginAnswerPass();
            return;
          }
          // Track SSE event type (Responses API uses "event:" lines)
          if (trimmed.startsWith("event: ")) {
            currentEventType = trimmed.slice(7);
            return;
          }
          if (!trimmed) {
            currentEventType = "";
            return;
          } // Blank line = SSE event boundary, reset type
          if (!trimmed.startsWith("data: ")) return;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            currentEventType = "";
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const responsesEventType =
              typeof parsed.type === "string" ? parsed.type : currentEventType;
            const isResponsesTerminalEvent =
              responsesEventType === "response.completed" ||
              responsesEventType === "response.incomplete" ||
              responsesEventType === "response.failed";

            if (useResponsesApi && responsesEventType) {
              const seq = parsed.sequence_number;
              if (typeof seq === "number") {
                const key = `${responsesEventType}:${seq}`;
                if (seenResponsesApiEvents.has(key)) return;
                seenResponsesApiEvents.add(key);
              }
            }

            if (useResponsesApi) {
              // ── Responses API SSE parsing ──
              // Track response ID from response.created event
              // Server wraps in { response: { id: "resp_..." } }
              const respId = parsed.response?.id || parsed.id;
              if (responsesEventType === "response.created" && respId) {
                const entry = activeRequests.get(chatId);
                if (entry && !providerRoute) {
                  // A single visible UI turn can issue more than one HTTP
                  // response (for example, after a tool result). Always retain
                  // the newest response identity so cancellation and terminal
                  // telemetry bind to the request whose final metrics are
                  // displayed.
                  entry.responseId = respId;
                  entry.endpoint = { host: resolved.host, port: resolved.port };
                }
              }

              if (
                responsesEventType === "response.heartbeat" &&
                parsed.tool_call_generating
              ) {
                if (!clientToolCallBuffering) {
                  clientToolCallBuffering = true;
                  emitToolStatus(
                    "generating",
                    "",
                    "Generating tool call...",
                    toolIteration,
                  );
                }
              }

              // Reasoning delta from OpenAI Responses reasoning-summary events.
              // Keep the legacy vMLX event accepted so older installed engines
              // still display reasoning in the panel.
              if (
                (responsesEventType === "response.reasoning_summary_text.delta" ||
                  responsesEventType === "response.reasoning.delta") &&
                parsed.delta
              ) {
                emitDelta(parsed.delta, true);
              }

              // Reasoning done — triggers reasoningDone event in emitDelta (isReasoning=true→false transition)
              if (
                responsesEventType === "response.reasoning_summary_text.done" ||
                responsesEventType === "response.reasoning.done"
              ) {
                reasoningSegments = reconcileReasoningSummaryDone(
                  reasoningSegments,
                  parsed.text,
                );
                displayTimeline.observeReasoning(reasoningSegments);
                const visibleSegments = currentReasoningSegments();
                reasoningContent =
                  visibleSegments.length > 0
                    ? visibleSegments[visibleSegments.length - 1]
                    : "";
                // Force the reasoning→content transition so reasoningDone fires
                if (isReasoning) {
                  isReasoning = false;
                  try {
                    const win = getWindow();
                    if (win && !win.isDestroyed()) {
                      win.webContents.send("chat:reasoningDone", {
                        chatId,
                        messageId: assistantMessage.id,
                        reasoningContent: currentReasoningContent(),
                        reasoningSegments: [...reasoningSegments],
                        displayTimeline: displayTimeline.snapshot(),
                      });
                    }
                  } catch (_) {}
                }
              }

              // Delta text from response.output_text.delta
              // Server sends { delta: "text" }, not { text: "..." }
              if (
                responsesEventType === "response.output_text.delta" &&
                (parsed.delta || parsed.text)
              ) {
                emitDelta(parsed.delta || parsed.text, false);
                _sawResponsesTextDelta = true;
              }

              // Codex 2026-05-06 #2: SSE final-text fallback. If a stream
              // never emitted any response.output_text.delta events but
              // the server sends final text via response.output_text.done
              // or response.content_part.done or a terminal Responses event
              // wrapping output[*].content[*].text, we MUST consume that
              // final text — otherwise the assistant message is blank,
              // gets skipped on next-turn rebuild (empty skip in
              // buildMessagesForApi), consecutive user messages merge
              // → new user prompt becomes invisible to the model and
              // it replays the LAST coherent user turn (e.g. "testing").
              if (
                responsesEventType === "response.output_text.done" &&
                typeof parsed.text === "string"
              ) {
                responsesFinalText = parsed.text;
                if (parsed.text.length > 0 && !_sawResponsesTextDelta) {
                  emitDelta(parsed.text, false);
                  _sawResponsesTextDelta = true;
                }
              }
              if (
                responsesEventType === "response.content_part.done" &&
                parsed.part?.type === "output_text" &&
                typeof parsed.part?.text === "string"
              ) {
                responsesFinalText = parsed.part.text;
                if (parsed.part.text.length > 0 && !_sawResponsesTextDelta) {
                  emitDelta(parsed.part.text, false);
                  _sawResponsesTextDelta = true;
                }
              }
              if (
                isResponsesTerminalEvent && !_sawResponsesTextDelta
              ) {
                // Walk parsed.response.output[*].content[*].text and
                // emit any output_text we find.
                const outputs = parsed.response?.output || [];
                const completedTextParts: string[] = [];
                for (const item of outputs) {
                  if (item?.type !== "message") continue;
                  for (const part of item?.content || []) {
                    if (
                      part?.type === "output_text" &&
                      typeof part.text === "string" &&
                      part.text.length > 0
                    ) {
                      completedTextParts.push(part.text);
                      emitDelta(part.text, false);
                      _sawResponsesTextDelta = true;
                    }
                  }
                }
                if (completedTextParts.length > 0) {
                  responsesFinalText = completedTextParts.join("");
                }
              }

              // Tool-only generation also establishes exchange TTFT. Ignore
              // empty argument heartbeats and generic response-created events.
              if (
                ((responsesEventType === "response.output_item.added" ||
                  responsesEventType === "response.output_item.done") &&
                  parsed.item?.type === "function_call" && parsed.item.name) ||
                (responsesEventType === "response.function_call_arguments.delta" &&
                  typeof parsed.delta === "string" && parsed.delta.length > 0) ||
                (responsesEventType === "response.function_call_arguments.done" &&
                  typeof parsed.arguments === "string" && parsed.arguments.length > 0)
              ) exchangeFirstTokenClock.recordToken(Date.now());

              // Handle function_call items (tool calls) from Responses API
              // response.output_item.done carries the complete tool call: { item: { type, call_id, name, arguments } }
              if (
                responsesEventType === "response.function_call_arguments.delta" &&
                typeof parsed.delta === "string"
              ) {
                const argsBuffer = responsesFunctionCallArgsBuffer(
                  parsed.item_id,
                  parsed.output_index,
                );
                if (argsBuffer) argsBuffer.value += parsed.delta;
              }
              if (
                responsesEventType === "response.function_call_arguments.done" &&
                typeof parsed.arguments === "string"
              ) {
                const argsBuffer = responsesFunctionCallArgsBuffer(
                  parsed.item_id,
                  parsed.output_index,
                );
                if (argsBuffer) argsBuffer.value = parsed.arguments;
              }
              if (
                responsesEventType === "response.output_item.done" &&
                parsed.item?.type === "function_call"
              ) {
                const item = parsed.item;
                const argsBuffer = responsesFunctionCallArgsBuffer(
                  item.id,
                  parsed.output_index,
                );
                const finalArguments = item.arguments || argsBuffer?.value || "{}";
                const toolCallId =
                  item.call_id ||
                  `call_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
                receivedToolCalls.push({
                  id: toolCallId,
                  function: {
                    name: item.name,
                    arguments: finalArguments,
                  },
                });
              }

              // Real-time usage from the explicitly negotiated local vMLX
              // response.usage extension (never part of a standard remote stream).
              if (responsesEventType === "response.usage" && parsed.usage) {
                recordServerDecodeUsage(parsed.usage);
                remoteMetrics?.recordUsage(parsed.usage);
                if (parsed.usage.output_tokens != null) {
                  tokenCount = parsed.usage.output_tokens;
                  iterationTokenCount = Math.max(0, tokenCount);
                  // Clear contaminated client-counted entries when transitioning to server usage
                  if (!serverSendsUsage) {
                    tpsSnapshots.length = 0;
                    tpsTokenBase = tokenCount;
                  }
                  serverSendsUsage = true;
                }
                if (parsed.usage.input_tokens != null)
                  promptTokens = parsed.usage.input_tokens;
                recordCacheUsage(parsed.usage.input_tokens_details);
              }

              // Defer Responses failures until the response.failed terminal has
              // supplied partial usage. Throwing on the preceding error event
              // cancels the reader and loses the authoritative token counts.
              const responsesErrorDetail = chatStreamServerEventErrorDetail(
                parsed,
                responsesEventType,
              );
              if (responsesErrorDetail) {
                const errDetail = responsesErrorDetail;
                if (isExpectedChatBackendDisconnectError(errDetail)) {
                  throw expectedChatBackendDisconnectError();
                }
                console.error(`[CHAT] Responses API error event: ${errDetail}`);
                pendingStreamServerError = new ChatStreamServerEventError(
                  `Server error: ${errDetail}`,
                );
              }

              if (responsesEventType === "response.warning") {
                const eventWarnings = extractResponsesWarnings(parsed);
                if (eventWarnings) {
                  responseWarnings = Array.from(
                    new Set([...(responseWarnings || []), ...eventWarnings]),
                  );
                }
              }

              // Final usage from response.completed / response.incomplete.
              // Server wraps in { response: { usage: { input_tokens, output_tokens } } }
              const respUsage = parsed.response?.usage || parsed.usage;
              if (isResponsesTerminalEvent) {
                const completedWarnings = extractResponsesWarnings(
                  parsed.response || parsed,
                );
                if (completedWarnings) {
                  responseWarnings = Array.from(
                    new Set([...(responseWarnings || []), ...completedWarnings]),
                  );
                }
                // Structured engine notices (#175): effort substitution rides
                // the terminal snapshot; context exhaustion rides
                // incomplete_details on a length terminal. Rendered through
                // the same persisted warnings rail.
                const structuredNotices = [
                  effortSubstitutionNotice(parsed.response?.effort_substitution),
                  contextExhaustionNotice(
                    parsed.response?.incomplete_details?.context_exhaustion,
                  ),
                ].filter((n): n is string => !!n);
                if (structuredNotices.length > 0) {
                  responseWarnings = Array.from(
                    new Set([...(responseWarnings || []), ...structuredNotices]),
                  );
                }
                // Track status for truncation detection
                const respStatus = parsed.response?.status;
                lastFinishReason =
                  responsesTerminalFinishReason(
                    respStatus,
                    parsed.response?.incomplete_details,
                  ) ?? lastFinishReason;
              }
              if (isResponsesTerminalEvent && respUsage) {
                recordServerDecodeUsage(respUsage);
                remoteMetrics?.recordUsage(respUsage);
                if (respUsage.output_tokens != null) {
                  tokenCount = respUsage.output_tokens;
                  iterationTokenCount = Math.max(0, tokenCount);
                  if (!serverSendsUsage) {
                    tpsSnapshots.length = 0;
                    tpsTokenBase = tokenCount;
                  }
                  serverSendsUsage = true;
                }
                if (respUsage.input_tokens != null)
                  promptTokens = respUsage.input_tokens;
                recordCacheUsage(respUsage.input_tokens_details);
              }
            } else {
              // ── Chat Completions SSE parsing ──
              const chatWarnings = extractResponsesWarnings(parsed);
              if (chatWarnings) {
                responseWarnings = Array.from(
                  new Set([...(responseWarnings || []), ...chatWarnings]),
                );
              }
              const choice = parsed.choices?.[0]?.delta;

              // Track response ID for server-side cancel
              if (parsed.id) {
                const entry = activeRequests.get(chatId);
                if (entry && !providerRoute) {
                  // Tool/result continuation requests receive a new response
                  // ID. Keeping only the first ID makes Stop target a completed
                  // request and misattributes final cache/usage telemetry.
                  entry.responseId = parsed.id;
                  entry.endpoint = { host: resolved.host, port: resolved.port };
                }
              }

              // Update usage BEFORE emitting delta so metrics use real server counts
              if (parsed.usage) {
                recordServerDecodeUsage(parsed.usage);
                remoteMetrics?.recordUsage(parsed.usage);
                if (parsed.usage.completion_tokens != null) {
                  tokenCount = parsed.usage.completion_tokens;
                  iterationTokenCount = Math.max(0, tokenCount);
                  // Clear contaminated client-counted entries when transitioning to server usage
                  if (!serverSendsUsage) {
                    tpsSnapshots.length = 0;
                    tpsTokenBase = tokenCount;
                  }
                  serverSendsUsage = true;
                }
                if (parsed.usage.prompt_tokens != null)
                  promptTokens = parsed.usage.prompt_tokens;
                recordCacheUsage(parsed.usage.prompt_tokens_details);
              }

              // Structured engine notices (#175): the chat-dialect terminal
              // chunk carries effort_substitution / context_exhaustion
              // top-level (popped at _dump_chat_chunk terminal_usage).
              const chatStructuredNotices = [
                effortSubstitutionNotice(parsed.effort_substitution),
                contextExhaustionNotice(parsed.context_exhaustion),
              ].filter((n): n is string => !!n);
              if (chatStructuredNotices.length > 0) {
                responseWarnings = Array.from(
                  new Set([...(responseWarnings || []), ...chatStructuredNotices]),
                );
              }

              // Track finish_reason (length = truncated, content_filter = filtered)
              const finishReason = parsed.choices?.[0]?.finish_reason;
              if (finishReason) lastFinishReason = finishReason;

              // Chat Completions sends partial usage after its error chunk.
              // Preserve the failure now and throw only after the stream closes.
              const chatErrorDetail = chatStreamServerEventErrorDetail(parsed);
              if (chatErrorDetail) {
                const errDetail = chatErrorDetail;
                if (isExpectedChatBackendDisconnectError(errDetail)) {
                  throw expectedChatBackendDisconnectError();
                }
                console.error(
                  `[CHAT] Chat completions error chunk: ${errDetail}`,
                );
                pendingStreamServerError = new ChatStreamServerEventError(
                  `Server error: ${errDetail}`,
                );
              }

              // Handle reasoning_content from reasoning parser
              const reasoning = choice?.reasoning_content || choice?.reasoning;
              if (reasoning) {
                emitDelta(reasoning, true);
              }

              // Suppressed-reasoning heartbeat: server emits a chunk with
              // usage but no content and no reasoning when the model's
              // template ignored enable_thinking=false and is generating
              // reasoning tokens internally (e.g., MiniMax M2.5). Without
              // this branch the UI sees no stream updates for many seconds
              // and appears hung. Update the stale message metrics so the
              // user at least sees a live token counter while reasoning
              // finishes internally.
              const _hasContent = !!choice?.content;
              const _hasFinish = !!finishReason;
              if (
                !_hasContent &&
                !reasoning &&
                !_hasFinish &&
                parsed.usage &&
                fullContent === "" &&
                reasoningContent === ""
              ) {
                try {
                  const win = getWindow();
                  if (win && !win.isDestroyed()) {
                    const now = Date.now();
                    if (firstTokenTime === null) firstTokenTime = now;
                    exchangeFirstTokenClock.recordToken(now);
                    const ttft = Math.max(
                      0,
                      exchangeFirstTokenClock.seconds(),
                    );
                    // 2026-05-02: derive tps from server's usage instead of
                    // hard-coded "0.0". Suppressed-reasoning heartbeats fire
                    // throughout the internal thinking phase on models like
                    // MiniMax M2.5; "0.0 t/s" was misleading users to think
                    // generation had stalled. server's usage.completion_tokens
                    // increments correctly per the SSE stream — use that.
                    const _hbToks =
                      parsed.usage.completion_tokens ||
                      parsed.usage.output_tokens ||
                      0;
                    const _hbElapsed =
                      firstTokenTime !== null
                        ? (now - firstTokenTime) / 1000
                        : 0;
                    const _hbTps =
                      _hbElapsed > 0.1 && _hbToks > 0
                        ? (_hbToks / _hbElapsed).toFixed(1)
                        : "0.0";
                    win.webContents.send("chat:stream", {
                      chatId,
                      messageId: assistantMessage.id,
                      fullContent: "",
                      isReasoning: false,
                      metrics: {
                        tokenCount: _hbToks || tokenCount,
                        promptTokens,
                        cachedTokens,
                        cacheDetail,
                        tokensPerSecond: _hbTps,
                        ttft: ttft.toFixed(2),
                        elapsed: Math.max(0, (now - startTime) / 1000).toFixed(1),
                        ...remoteMetricFields(),
                      },
                    });
                  }
                } catch (_) {}
              }

              if (choice?.content) {
                // Client-side fallback: if server didn't provide reasoning_content
                // but content contains <think> tags, extract them client-side.
                // This handles servers without a reasoning parser, remote endpoints,
                // and older server versions.
                // chunkCounted tracks whether we've already counted this SSE chunk's token
                // to prevent inflation from think-tag splitting into multiple emitDelta calls.
                if (!reasoning) {
                  let content =
                    clientSideThinkHoldback + (choice.content as string);
                  clientSideThinkHoldback = "";
                  let chunkCounted = !!reasoning; // if reasoning was emitted above, counting already happened
                  const emitWithCount = (text: string, isR: boolean) => {
                    emitDelta(text, isR, chunkCounted);
                    chunkCounted = true; // subsequent calls skip counting
                  };
                  // Normalize [THINK]/[/THINK] (Mistral 4) and
                  // <mm:think>...</mm:think> (MiniMax-M3) to
                  // <think>...</think> for unified fallback parsing when an
                  // older/misconfigured server streams reasoning tags in
                  // content instead of reasoning_content.
                  content = normalizeThinkingMarkers(content);
                  const holdback = thinkMarkerHoldbackLength(content);
                  if (holdback > 0) {
                    clientSideThinkHoldback = content.slice(-holdback);
                    content = content.slice(0, -holdback);
                  }

                  while (content) {
                    if (clientSideThinkParsing) {
                      const endIdx = content.indexOf("</think>");
                      if (endIdx >= 0) {
                        const reasoningPart = content.slice(0, endIdx);
                        content = content.slice(endIdx + 8); // 8 = '</think>'.length
                        clientSideThinkParsing = false;
                        if (reasoningPart) emitWithCount(reasoningPart, true);
                      } else {
                        emitWithCount(content, true);
                        content = "";
                      }
                    } else {
                      const startIdx = content.indexOf("<think>");
                      if (startIdx >= 0) {
                        const preContent = content.slice(0, startIdx);
                        content = content.slice(startIdx + 7); // 7 = '<think>'.length
                        if (preContent) emitWithCount(preContent, false);
                        clientSideThinkParsing = true;
                      } else {
                        emitWithCount(content, false);
                        content = "";
                      }
                    }
                  }
                } else {
                  emitDelta(choice.content, false, !!reasoning);
                }
              }

              // Detect server-side tool call buffering signal (TPS keeps counting, show status)
              if (!useResponsesApi && parsed.tool_call_generating) {
                if (!clientToolCallBuffering) {
                  clientToolCallBuffering = true;
                  console.log(
                    `[CHAT] Server signaled tool call generation in progress`,
                  );
                  emitToolStatus(
                    "generating",
                    "",
                    "Generating tool call...",
                    toolIteration,
                  );
                }
              }

              // Handle tool_calls from streaming response
              // Supports both complete tool calls (vmlx-engine default) and incremental argument
              // streaming (OpenAI-style: first chunk has name, subsequent chunks append arguments)
              if (choice?.tool_calls && Array.isArray(choice.tool_calls)) {
                for (const tc of choice.tool_calls) {
                  if ((typeof tc.function?.name === "string" && tc.function.name) ||
                      (typeof tc.function?.arguments === "string" && tc.function.arguments)) {
                    exchangeFirstTokenClock.recordToken(Date.now());
                  }
                  accumulateChatToolCallDelta(receivedToolCalls, tc, () =>
                    `call_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
                  );
                  if (typeof tc.function?.name === 'string' && tc.function.name) {
                    console.log(
                      `[CHAT] Tool call detected: ${tc.function.name}(${(tc.function.arguments || "").slice(0, 100)})`,
                    );
                  }
                }
              }
            }
          } catch (e) {
            // Error events are valid SSE JSON, not malformed lines. Propagate
            // them to the outer request catch so the empty assistant placeholder
            // is removed and the renderer receives the real server failure.
            // The previous catch logged and swallowed these intentional throws,
            // turning prefill failures into a false zero-token completion.
            if (
              shouldRethrowChatStreamLineError(
                e,
                isExpectedChatBackendDisconnectError(e),
              )
            ) {
              throw e;
            }
            // Skip malformed JSON lines — log at debug level for troubleshooting
            if (e instanceof SyntaxError) {
              // Expected: malformed SSE data line
            } else {
              console.warn(
                "[CHAT] Error processing SSE line:",
                (e as Error).message,
              );
            }
          }
        };

        // ─── Helper: stream SSE response through processLine ──────────────
        const streamSSE = async (
          rdr: ReadableStreamDefaultReader<Uint8Array>,
        ) => {
          const dec = new TextDecoder();
          let buf = "";
          const readNext = async (): Promise<
            ReadableStreamReadResult<Uint8Array>
          > => {
            if (!clientToolCallBuffering) return rdr.read();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                rdr.read(),
                new Promise<ReadableStreamReadResult<Uint8Array>>(
                  (resolve) => {
                    timer = setTimeout(async () => {
                      console.warn(
                        `[CHAT] Tool call generation stalled for ${TOOL_STREAM_STALL_TIMEOUT_MS}ms; cancelling stalled stream`,
                      );
                      emitToolStatus(
                        "error",
                        "",
                        "Tool call generation stalled; cancelled stalled stream.",
                        toolIteration,
                      );
                      clientToolCallBuffering = false;
                      try {
                        await rdr.cancel();
                      } catch (_) {}
                      resolve({ value: undefined, done: true });
                    }, TOOL_STREAM_STALL_TIMEOUT_MS);
                  },
                ),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          };
          while (true) {
            // Check abort before each read — fast models can buffer many chunks
            if (abortController.signal.aborted) break;
            const { value, done } = await readNext();
            if (done) break;
            // Includes SSE comments (`: keep-alive`) emitted during prefill.
            // Receipt of bytes proves that the request path is alive even
            // before the model can produce its first token.
            if (value && value.byteLength > 0) armFetchInactivityTimeout();
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (let li = 0; li < lines.length; li++) {
              if (abortController.signal.aborted) break;
              processLine(lines[li].trim());
              if (toolStatusNeedsFlush) {
                await flushToolStatusToRenderer();
              }
              if (rendererStreamNeedsFlush) {
                await flushStreamDeltaToRenderer();
              }
            }
          }
          if (abortController.signal.aborted) return;
          const rem = dec.decode(); // flush TextDecoder streaming buffer
          if (rem) buf += rem;
          // Process remaining lines (may contain multiple newline-separated events)
          if (buf.trim()) {
            for (const line of buf.split("\n")) {
              if (abortController.signal.aborted) break;
              if (line.trim()) {
                processLine(line.trim());
                if (toolStatusNeedsFlush) {
                  await flushToolStatusToRenderer();
                }
                if (rendererStreamNeedsFlush) {
                  await flushStreamDeltaToRenderer();
                }
              }
            }
          }
        };

        // Release whatever is still withheld. A fragment that never grew into a
        // tag is ordinary prose (an answer ending in "<" holds back one char),
        // so it must be emitted, not dropped - and it has to reach the renderer
        // as well as fullContent or the live view and the saved record diverge.
        const flushToolTagHoldback = () => {
          if (!toolTagHoldback) return;
          const pending = toolTagHoldback;
          toolTagHoldback = "";
          emitDelta(pending, false, true, true);
        };

        const reconcileResponsesToolBuffer = () => {
          const reconciliation = reconcileResponsesToolBufferAtStreamEnd({
            useResponsesApi,
            clientToolCallBuffering,
            receivedToolCallCount: receivedToolCalls.filter(Boolean).length,
            finalText: responsesFinalText,
          });
          if (!reconciliation.clearSpeculativeBuffering) return;

          clientToolCallBuffering = false;
          if (reconciliation.rejectedControlMarkup) {
            // Retained (never rendered as prose) so the finalizer can tell the
            // user why this turn has no answer instead of leaving it blank.
            rejectedControlMarkupText = reconciliation.rejectedText || "";
            const warning =
              "The model emitted parser-rejected tool control markup. It was hidden instead of being shown as assistant content.";
            console.warn(`[CHAT] ${warning}`);
            responseWarnings = Array.from(
              new Set([...(responseWarnings || []), warning]),
            );
            emitToolStatus(
              "error",
              "",
              warning,
              toolIteration,
            );
            return;
          }
          if (reconciliation.authoritativeText === null) return;

          console.log(
            `[CHAT] Restoring ${reconciliation.authoritativeText.length} authoritative Responses text chars after zero-tool speculative buffering`,
          );
          // Replace only the current iteration. allGeneratedContent owns text
          // from completed tool iterations and emitDelta will prepend it for UI.
          fullContent = "";
          rawAccumulated = "";
          // The shared reconciliation helper has already rejected tool
          // control markup. Bypass speculative marker detection only for the
          // remaining authoritative prose so a false-positive heartbeat
          // cannot swallow the completed answer.
          emitDelta(reconciliation.authoritativeText, false, false, true);
          _sawResponsesTextDelta = true;
        };

        await streamSSE(reader);
        remoteMetrics?.endPass(Date.now());
        if (pendingStreamServerError) throw pendingStreamServerError;
        reconcileResponsesToolBuffer();

        // ─── Helper: send follow-up request and stream response ────────────
        const sendFollowUp = async (): Promise<boolean> => {
          // Steering: anything the user sent meanwhile joins here, after the
          // tool results and before the model continues.
          const steers = steerQueues.get(chatId);
          if (steers && steers.length > 0) {
            steerQueues.delete(chatId);
            const text = steers.map((m) => m.text).join("\n\n");
            joinSteer(requestMessages, `${STEER_NOTE}\n${text}`, isRemote);
            // Kept with the turn's own message, so the history and the
            // transcript show it after a restart too.
            const addition = `${STEER_ADDED_PREFIX} ${text}`;
            let updated: string | null = null;
            if (mode === "send") {
              try { updated = db.appendToUserMessage(userMessage.id, addition); } catch (_) {}
            }
            try {
              const win = getWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send("chat:steered", { chatId, ids: steers.map((m) => m.id), messageId: userMessage.id, content: updated });
              }
            } catch (_) {}
            console.log(`[CHAT] Steer: ${steers.length} message(s) joined the running turn`);
          }
          // Calibrate the token heuristic with the pass that just finished,
          // then compact before this pass if the history reached 80%.
          tokenCalibrator.observe(lastSentHeuristicTokens, promptTokens);
          await maybeAutoCompact();
          finishServerDecodePass();
          completedPrefillPasses.push(currentPrefillUsage);
          currentPrefillUsage = undefined;
          firstPass ??= { promptTokens, cachedTokens };
          // Fold the finished stream's prompt/cached counts into the exchange
          // totals so the final metrics pair coherently (cached <= prompt).
          exchangePromptTokens += promptTokens;
          exchangeCachedTokens += Math.min(cachedTokens, promptTokens);
          promptTokens = 0;
          cachedTokens = 0;
          // Reset SSE parser state from previous stream
          currentEventType = "";
          pendingStreamServerError = null;
          seenResponsesApiEvents.clear();
          _sawResponsesTextDelta = false;
          responsesFinalText = "";
          // Keep per-pass request timing while preserving the first exchange token.
          fetchStartTime = Date.now();
          exchangeFirstTokenClock.beginPass(fetchStartTime);
          remoteMetrics?.beginPass(fetchStartTime);
          firstTokenTime = null;
          lastTokenTime = null;
          // Use the same wire API format as the initial request
          const url = useResponsesApi
            ? `${baseUrl}/v1/responses`
            : `${baseUrl}/v1/chat/completions`;
          // Remote internet providers use Electron net.fetch; loopback model
          // servers use Node streaming so SSE tool events are not buffered.
          const postFollowUp = async () => {
            const followUpBody = JSON.stringify(buildRequestBody());
            logRequestShape(followUpBody, "follow_up");
            notePromptSent();
            const followUpInit = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...authHeaders,
                // Every local Responses HTTP pass needs the same private usage
                // negotiation. Omitting it only on tool follow-ups left the
                // final footer with first-pass token/decode counts paired to
                // final-pass TTFT/prefill throughput.
                ...vmlxUsageHeaders,
                ...nextLocalRequestCorrelationHeaders(),
                ...(!isRemote && plannedDirectAnswerPass && !finalAnswerRecovery
                  ? { "X-vMLX-Tool-Choice-Fulfilled": "1" }
                  : {}),
              },
              body: followUpBody,
              signal: abortController.signal,
            };
            const useNodeStreamingFetch = !isRemote || isLoopbackUrl(url);
            if (providerRoute) return await providerRoute.fetch(url, followUpInit as any);
            return useNodeStreamingFetch
              ? await streamingFetch(url, followUpInit as any)
              : await remoteFetch(url, followUpInit);
          };
          let res = await postFollowUp();
          let followUpErrorText = "";
          if (!res.ok) {
            followUpErrorText = await res.text();
            // "Prompt too long" after the tool results: compact and retry (twice).
            for (
              let attempt = 0;
              attempt < 2 &&
              !res.ok &&
              isPromptOverflowError(res.status, followUpErrorText) &&
              (await compactAfterOverflow(followUpErrorText, attempt));
              attempt += 1
            ) {
              res = await postFollowUp();
              followUpErrorText = res.ok ? "" : await res.text();
            }
          }
          if (!res.ok) {
            const errText = followUpErrorText;
            console.log(`[CHAT] Follow-up failed: ${res.status} ${errText}`);
            emitToolStatus(
              "error",
              "",
              providerRoute
                ? `Follow-up error: ${providerErrorMessage(res.status, errText, providerRoute.providerName)}`
                : `Follow-up error: ${res.status} ${errText}`,
              toolIteration,
            );
            return false;
          }
          const followUpReader = res.body?.getReader();
          if (!followUpReader) return false;
          await streamSSE(followUpReader);
          remoteMetrics?.endPass(Date.now());
          if (pendingStreamServerError) throw pendingStreamServerError;
          reconcileResponsesToolBuffer();
          return true;
        };

        // ─── Helper: prune a tool result for the model (spill the full text) ─
        const toolPruneBudget = resolvePruneBudget(overrides?.toolResultMaxChars);
        const prepareToolResultForModel = (toolName: string, text: string): string => {
          const pruned = pruneToolResult(text, {
            toolName,
            budget: toolPruneBudget,
            spill: (full) =>
              writeSpillFile(join(agentSpillRoot(), chatId), toolName, full),
          });
          if (pruned.pruned) {
            console.log(
              `[CHAT] Pruned ${toolName} result for the model: ${pruned.omittedChars} chars cut${pruned.spillPath ? `, full text at ${pruned.spillPath}` : ""}`,
            );
          }
          return pruned.text;
        };

        // ─── Helper: execute tool calls and push results to messages ───────
        const executeToolCalls = async () => {
          const toolReasoning = currentReasoningSegment();
          if (useResponsesApi) {
            // Responses API: push individual output items (not Chat Completions format)
            if (toolReasoning.trim()) {
              requestMessages.push(responsesReasoningItem(toolReasoning));
            }
            if (fullContent) {
              requestMessages.push({ type: "output_text", text: fullContent });
            }
            for (const tc of receivedToolCalls) {
              requestMessages.push({
                type: "function_call",
                call_id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              });
            }
          } else {
            // Chat Completions: push assistant message with tool_calls array
            const assistantToolTurn: any = {
              role: "assistant",
              content: fullContent || null,
              tool_calls: receivedToolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              })),
            };
            if (toolReasoning.trim()) {
              assistantToolTurn.reasoning_content = toolReasoning;
            }
            requestMessages.push(assistantToolTurn);
          }

          const pendingImageDataUrls: string[] = [];
          const pendingVideoDataUrls: string[] = [];
          for (const tc of receivedToolCalls) {
            // Check abort between each tool — don't make user wait for all tools to finish
            if (abortController.signal.aborted)
              throw Object.assign(new Error("AbortError"), {
                name: "AbortError",
              });
            let resultText = "";
            const normalizedToolName = tc.function.name.toLowerCase();
            const isExactlyOnceTool =
              exactlyOnceToolNames.includes(normalizedToolName);
            if (
              isExactlyOnceTool &&
              completedExactlyOnceTools.has(normalizedToolName)
            ) {
              // A rejected tool call is still an intervening action in the
              // model transcript, so it ends any replay-safe read chain.
              lastReplaySafeToolResultKey = null;
              resultText = `Duplicate ${tc.function.name} call was not executed because the user requested it exactly once.`;
              emitToolStatus(
                "calling",
                tc.function.name,
                tc.function.arguments,
                toolIteration,
                tc.id,
              );
              emitToolStatus(
                "error",
                tc.function.name,
                resultText,
                toolIteration,
                tc.id,
              );
              requestMessages.push(
                useResponsesApi
                  ? {
                      type: "function_call_output",
                      call_id: tc.id,
                      output: resultText,
                    }
                  : {
                      role: "tool",
                      tool_call_id: tc.id,
                      content: resultText,
                    },
              );
              continue;
            }
            // Loop guard: the 5th identical call is not run (small local
            // models otherwise burn the tool budget retrying one failure).
            const repeatVeto = repeatCallTracker.veto(chatId, tc.function.name, tc.function.arguments);
            if (repeatVeto) {
              lastReplaySafeToolResultKey = null;
              resultText = repeatVeto.text;
              emitToolStatus("calling", tc.function.name, tc.function.arguments, toolIteration, tc.id);
              emitToolStatus("error", tc.function.name, resultText, toolIteration, tc.id);
              requestMessages.push(
                useResponsesApi
                  ? { type: "function_call_output", call_id: tc.id, output: resultText }
                  : { role: "tool", tool_call_id: tc.id, content: resultText },
              );
              continue;
            }
            // A parsed stream item is still speculative until the complete
            // pass reaches loop control. Emit the concrete card only when this
            // call is actually handed to execution/validation. That lets a
            // replay-only exactly-once pass be discarded without leaving an
            // orphaned "interrupted" card in the live UI or persisted history.
            emitToolStatus(
              "calling",
              tc.function.name,
              tc.function.arguments,
              toolIteration,
              tc.id,
            );
            try {
              let toolArgs: Record<string, any>;
              try {
                toolArgs = JSON.parse(tc.function.arguments || "{}");
              } catch (parseErr) {
                // Invalid arguments cannot be compared safely and therefore
                // break consecutiveness before the model is allowed to retry.
                lastReplaySafeToolResultKey = null;
                resultText = `Invalid tool arguments: ${(parseErr as Error).message}`;
                emitToolStatus(
                  "error",
                  tc.function.name,
                  resultText,
                  toolIteration,
                  tc.id,
                );
                requestMessages.push(
                  useResponsesApi
                    ? {
                        type: "function_call_output",
                        call_id: tc.id,
                        output: resultText,
                      }
                    : {
                        role: "tool",
                        tool_call_id: tc.id,
                        content: resultText,
                      },
                );
                continue;
              }
              const toolAuthorized = isToolAuthorizedForCurrentTurn(
                normalizedToolName,
                // Authorize against the immutable catalog provided for this
                // user turn. The filtered follow-up catalog intentionally
                // drops a just-completed exactly-once tool; consulting it
                // here would reject that tool's first real execution.
                currentToolNames,
                currentPromptAlreadyForbidsTools,
                restrictedToolNamesForCurrentTurn,
              );
              const replaySafeKey = toolAuthorized
                ? replaySafeToolCallKey(normalizedToolName, toolArgs)
                : undefined;
              if (
                replaySafeKey &&
                lastReplaySafeToolResultKey === replaySafeKey
              ) {
                resultText =
                  `Duplicate ${tc.function.name} call was deduplicated: ` +
                  `the immediately preceding call used identical arguments and ` +
                  `completed successfully. Use its real result above.`;
                console.log(
                  `[CHAT] Deduplicated consecutive replay-safe tool call: ${tc.function.name}`,
                );
                emitToolStatus(
                  "result",
                  tc.function.name,
                  resultText,
                  toolIteration,
                  tc.id,
                );
                await flushToolStatusToRenderer();
                requestMessages.push(
                  useResponsesApi
                    ? {
                        type: "function_call_output",
                        call_id: tc.id,
                        output: resultText,
                      }
                    : {
                        role: "tool",
                        tool_call_id: tc.id,
                        content: resultText,
                      },
                );
                continue;
              }
              // Only consecutive successful replay-safe reads qualify. Any
              // different, rejected, failed, mutating, command, or MCP call
              // breaks the chain before execution.
              lastReplaySafeToolResultKey = null;
              if (toolAuthorized) {
                if (isExactlyOnceTool) {
                  // Mark only after schema-valid arguments and current-turn
                  // authorization. A malformed first emission may retry on the
                  // follow-up; once one valid call reaches execution, any
                  // second call in the same model pass is rejected at the loop
                  // head.
                  completedExactlyOnceTools.add(normalizedToolName);
                }
                // Do not display or persist an "executing" phase for a call
                // rejected by current-turn authorization.
                emitToolStatus(
                  "executing",
                  tc.function.name,
                  undefined,
                  toolIteration,
                  tc.id,
                );
                await flushToolStatusToRenderer();
              }

              let mcpRefusal: string | null = null;
              if (!toolAuthorized) {
                // A model may emit a built-in or MCP name from training or
                // history even when that schema was not authorized for this
                // request. A scoped "file_info exactly once" turn must not
                // execute write_file or an unrelated MCP function, and a
                // no-tools turn must execute nothing. Preserve the rejected
                // call/result in the transcript, but never perform the side
                // effect.
                resultText = `Tool "${tc.function.name}" was not provided for this request and was not executed.`;
                emitToolStatus(
                  "error",
                  tc.function.name,
                  resultText,
                  toolIteration,
                  tc.id,
                );
              } else if (tc.function.name === "ask_user") {
                // Special handling: ask_user needs IPC to renderer, not executor
                const question =
                  toolArgs.question || "What would you like to do?";
                emitToolStatus("asking", "ask_user", question, toolIteration, tc.id);
                resultText = await new Promise<string>((resolve) => {
                  const win = getWindow();
                  if (!win || win.isDestroyed()) {
                    resolve("(User interface not available)");
                    return;
                  }
                  if (abortController.signal.aborted) {
                    resolve("(Generation was stopped)");
                    return;
                  }
                  win.webContents.send("chat:askUser", { chatId, question });
                  // Use Map-based resolver (single global listener, no per-call listener accumulation)
                  const cleanup = () => {
                    askUserResolvers.delete(chatId);
                    clearTimeout(askTimeout);
                    abortController.signal.removeEventListener(
                      "abort",
                      onAbort,
                    );
                  };
                  askUserResolvers.set(chatId, (answer: string) => {
                    cleanup();
                    resolve(answer);
                  });
                  const onAbort = () => {
                    cleanup();
                    resolve("(Generation was stopped)");
                  };
                  abortController.signal.addEventListener("abort", onAbort, {
                    once: true,
                  });
                  const askTimeout = setTimeout(() => {
                    cleanup();
                    resolve("(User did not respond within 5 minutes)");
                  }, 300000);
                });
                emitToolStatus("result", "ask_user", resultText, toolIteration, tc.id);
              } else if (tc.function.name === BROWSER_TOOL_NAME && !getDisabledTools(overrides || {}).has(BROWSER_TOOL_NAME)) {
                // Browser: looking runs (asks once app data is in the chat);
                // clicking, typing and choosing ask unless Full access.
                const browser = agentBrowser(chatId);
                const refusal = refusalOf(
                  await gateToolCall(tc.function.name, toolArgs, tc.id, true, fullContent, describeBrowserAction(toolArgs, browser.lastSnapshotText)),
                );
                if (refusal) {
                  resultText = refusal;
                  emitToolStatus("error", tc.function.name, resultText, toolIteration, tc.id);
                } else {
                  const r = await browser.execute(toolArgs);
                  resultText = boundToolResultText(r.text, MAX_RAW_TOOL_RESULT_CHARS);
                  // Live view: a picture of the page after each action.
                  void browser.frame().then((frame) => {
                    const win = getWindow();
                    if (win && !win.isDestroyed()) {
                      win.webContents.send("browser:frame", { chatId, url: browser.lastUrl, frame, open: browser.isOpen });
                    }
                  });
                  if (r.imageDataUrl) {
                    if (chatIsMultimodal || isRemote) pendingImageDataUrls.push(r.imageDataUrl);
                    else resultText += "\n\n[The screenshot was not sent because this local model is text-only.]";
                  }
                  emitToolStatus(r.isError ? "error" : "result", tc.function.name, resultText, toolIteration, tc.id);
                }
              } else if (tc.function.name === "schedule_task") {
                // A lasting change: always asks (Full access too), refused in
                // Plan mode. The card shows the prompt word for word.
                const parsedSchedule = parseSchedule(toolArgs.schedule);
                const scheduleSubject = `${String(toolArgs.title ?? "Scheduled task").slice(0, 80)} · ${parsedSchedule.ok ? describeSchedule(parsedSchedule.schedule) : "invalid schedule"}\n\n${String(toolArgs.prompt ?? "").trim().slice(0, 8000)}`;
                const refusal = refusalOf(await gateToolCall(tc.function.name, toolArgs, tc.id, true, fullContent, scheduleSubject));
                if (refusal) {
                  resultText = refusal;
                  emitToolStatus("error", tc.function.name, resultText, toolIteration, tc.id);
                } else {
                  const created = createTaskFromChat(chatId, {
                    title: String(toolArgs.title ?? ""),
                    prompt: String(toolArgs.prompt ?? ""),
                    schedule: toolArgs.schedule,
                  });
                  if (created.ok) {
                    const next = created.task.nextRun ? new Date(created.task.nextRun).toLocaleString() : "never";
                    resultText = `Scheduled "${created.task.title}" (${describeSchedule(created.task.schedule)}). Next run: ${next}. It runs in its own chat; the user can pause or delete it in Preferences → Tasks.`;
                    emitToolStatus("result", tc.function.name, resultText, toolIteration, tc.id);
                  } else {
                    resultText = `Not scheduled: ${created.error}`;
                    emitToolStatus("error", tc.function.name, resultText, toolIteration, tc.id);
                  }
                }
              } else if (tc.function.name === "remember" || tc.function.name === "recall" || tc.function.name === "forget") {
                // Saving and forgetting reach every chat: refused in Plan mode,
                // asked once web pages, apps or MCP tools are in the turn.
                let subject: string | undefined;
                if (tc.function.name === "remember") subject = `Remember: ${String(toolArgs.text ?? "").slice(0, 300)}`;
                else if (tc.function.name === "forget") {
                  const e = (() => { try { return db.memory?.get(String(toolArgs.id ?? "")); } catch { return null; } })();
                  subject = `Forget: ${e ? e.text : String(toolArgs.id ?? "")}`;
                }
                const refusal = tc.function.name === "recall"
                  ? null
                  : refusalOf(await gateToolCall(tc.function.name, toolArgs, tc.id, true, fullContent, subject));
                const r = refusal ? { text: refusal, isError: true } : runMemoryTool(tc.function.name, toolArgs, chatId);
                resultText = r.text;
                emitToolStatus(r.isError ? "error" : "result", tc.function.name, resultText, toolIteration, tc.id);
              } else if (tc.function.name === "todo_write") {
                // Whole-list replacement, stored per chat (needs the chat id,
                // so it runs here rather than in the executor).
                try {
                  const todos = parseTodoWriteArgs(toolArgs);
                  db.setChatTodos(chatId, JSON.stringify(todos));
                  resultText = renderTodoList(todos);
                  emitToolStatus("result", tc.function.name, resultText, toolIteration, tc.id);
                  try {
                    const win = getWindow();
                    if (win && !win.isDestroyed()) {
                      win.webContents.send("chat:todos", { chatId, todos });
                    }
                  } catch (_) {}
                } catch (todoErr: any) {
                  resultText = `Error: ${todoErr?.message || String(todoErr)} The list was not changed.`;
                  emitToolStatus("error", tc.function.name, resultText, toolIteration, tc.id);
                }
              } else if (appsService().owns(tc.function.name)) {
                const apps = appsService();
                // Only in a chat whose Apps switch is on and whose request
                // offered this tool: a name in a web page or a file must not
                // reach the user's apps from another chat.
                const offeredThisTurn = appToolsForTurn.some((t) => t.function.name === tc.function.name);
                // A direct tool (gmail_send_email) is one COMPOSIO_MULTI_EXECUTE_TOOL call.
                const directArgs = apps.asExecute(tc.function.name, toolArgs);
                const appToolName = directArgs ? "COMPOSIO_MULTI_EXECUTE_TOOL" : tc.function.name;
                const appArgs = directArgs ?? toolArgs;
                const decision = offeredThisTurn
                  ? decideAppCall(appToolName, appArgs, apps.rules(), { plan: planMode, untrusted: appDataInTurn })
                  : { action: "deny" as const, message: `Apps are off in this chat, so ${tc.function.name} was not run.` };
                const appsHere = appsInCall(appToolName, appArgs);
                const alwaysKey = alwaysAllowKey(`app:${decision.action === "ask" ? decision.apps.slice().sort().join(",") : ""}`, "");
                let appRefusal: string | null = null;
                if (decision.action === "deny") {
                  appRefusal = decision.message;
                } else if (
                  decision.action === "ask" &&
                  !(decision.allowAlways && alwaysAllowedCommands.get(chatId)?.has(alwaysKey))
                ) {
                  const broker = approvalBroker;
                  let appDenyNote = "";
                  const outcome = broker
                    ? await broker.request({
                        chatId,
                        toolCallId: tc.id,
                        toolName: tc.function.name,
                        kind: "app",
                        subject: decision.summary.length > 8000 ? `${decision.summary.slice(0, 8000)}…` : decision.summary,
                        reason: statedIntent(fullContent),
                        why: "app-write",
                        allowAlways: decision.allowAlways,
                        signal: abortController.signal,
                        onNote: (n) => { appDenyNote = n; },
                      })
                    : "unavailable";
                  console.log(`[CHAT] Approval for app action (${decision.apps.join(",")}): ${outcome}`);
                  if (outcome === "aborted") throw Object.assign(new Error("AbortError"), { name: "AbortError" });
                  if (outcome === "allow-always") {
                    let set = alwaysAllowedCommands.get(chatId);
                    if (!set) alwaysAllowedCommands.set(chatId, (set = new Set()));
                    set.add(alwaysKey);
                  }
                  if (outcome !== "allow-once" && outcome !== "allow-always") {
                    appRefusal = withDenyNote(approvalRefusalMessage(outcome, tc.function.name, Math.round((broker?.timeoutMs ?? 300000) / 60000)), outcome === "deny" ? appDenyNote : "");
                  }
                }
                if (appRefusal) {
                  resultText = appRefusal;
                  emitToolStatus("error", tc.function.name, resultText, toolIteration, tc.id);
                } else {
                  const appResult = await apps.call(appToolName, appArgs, abortController.signal);
                  appDataInTurn = true;
                  chatsWithAppData.add(chatId);
                  resultText = wrapUntrusted(appResult.text, appsHere.join(", ") || undefined);
                  emitToolStatus(appResult.isError ? "error" : "result", tc.function.name, appResult.text, toolIteration, tc.id);
                }
              } else if (isBuiltinTool(tc.function.name)) {
                // Enforce tool category toggles at execution time (defense-in-depth:
                // filterTools removes disabled tools from definitions sent to model,
                // but models can hallucinate tool calls not in the provided list)
                const disabledSet = getDisabledTools(overrides || {});
                if (disabledSet.has(tc.function.name)) {
                  resultText = `Tool "${tc.function.name}" is disabled in chat settings.`;
                  emitToolStatus(
                    "error",
                    tc.function.name,
                    resultText,
                    toolIteration,
                    tc.id,
                  );
                } else if (
                  !overrides?.workingDirectory &&
                  !WORKING_DIR_INDEPENDENT_TOOLS.has(tc.function.name)
                ) {
                  // The SAME exemption the executor applies, from the same set.
                  // Without it here this gate rejected EVERY tool before
                  // executeBuiltinTool ever ran, so the executor's exemption was
                  // unreachable whenever the directory was UNSET -- it only
                  // helped a configured-but-broken one. Searching the web,
                  // fetching a URL, reading the clipboard or the clock need no
                  // folder.
                  resultText =
                    "Error: Working directory not set. Configure it in Chat Settings.";
                  emitToolStatus(
                    "error",
                    tc.function.name,
                    resultText,
                    toolIteration,
                    tc.id,
                  );
                } else {
                  // Undefined only for the working-dir-independent tools the
                  // guard above lets through; executeBuiltinTool never reads it
                  // for those, and for every other tool the guard proves it set.
                  const workDir = overrides?.workingDirectory ?? "";
                  // Read-before-edit: an edit to an existing file must follow
                  // a read of its current content in this chat session.
                  const readGuardRefusal = fileReadTracker.checkTool(
                    chatId,
                    tc.function.name,
                    toolArgs,
                    workDir,
                  );
                  if (readGuardRefusal) {
                    resultText = readGuardRefusal;
                    emitToolStatus(
                      "error",
                      tc.function.name,
                      resultText,
                      toolIteration,
                      tc.id,
                    );
                  } else {
                    const gate = await gateToolCall(
                      tc.function.name,
                      toolArgs,
                      tc.id,
                      true,
                      fullContent,
                    );
                    if (!gate.ok) {
                      resultText = gate.message;
                      emitToolStatus(
                        "error",
                        tc.function.name,
                        resultText,
                        toolIteration,
                        tc.id,
                      );
                    } else {
                      console.log(
                        `[CHAT] Builtin tool: ${tc.function.name}${gate.sandboxProfile ? " (sandboxed)" : ""}`,
                      );
                      const result = await executeBuiltinTool(
                        tc.function.name,
                        toolArgs,
                        workDir,
                        undefined,
                        {
                          sandboxProfile: gate.sandboxProfile,
                          // Changes review: the file's state before this turn first touched it.
                          beforeChange: (fullPath) => turnChanges.noteBefore(chatId, fullPath),
                        },
                      );
                      // The sandbox may be why it failed: offer the one-shot
                      // escalation (DeepSeek Harness flow).
                      if (
                        result.sandboxed &&
                        result.is_error &&
                        looksLikeSandboxDenial(result.content)
                      ) {
                        result.content += sandboxEscalationMarker(seatbeltSupport().network);
                      }
                      fileReadTracker.afterTool(
                        chatId,
                        tc.function.name,
                        toolArgs,
                        workDir,
                        !result.is_error,
                      );
                      resultText = result.content;
                      if (replaySafeKey && !result.is_error) {
                        lastReplaySafeToolResultKey = replaySafeKey;
                      }
                      // For read_image/read_video: inject media as multimodal
                      // content for VLM follow-ups. Tool result text is not enough
                      // for vision models to actually inspect local media bytes.
                      // Keep local text-only models on text; vmlx-engine will
                      // reject image_url/video_url content when the loaded runtime
                      // is not multimodal. Remote endpoints may be multimodal even
                      // when the local session registry cannot infer it.
                      if ((result.imageDataUrl || result.videoDataUrl) && !(chatIsMultimodal || isRemote)) {
                        resultText += "\n\n[Media bytes were not sent because this local session is text-only. Use a VL-compatible model/session to inspect the file visually.]";
                        console.log(
                          `[CHAT] Skipping tool media bytes for text-only local session (${tc.function.name})`,
                        );
                      } else {
                        if (result.imageDataUrl) {
                          pendingImageDataUrls.push(result.imageDataUrl);
                        }
                        if (result.videoDataUrl) {
                          pendingVideoDataUrls.push(result.videoDataUrl);
                        }
                      }
                      emitToolStatus(
                        result.is_error ? "error" : "result",
                        tc.function.name,
                        resultText,
                        toolIteration,
                        tc.id,
                      );
                    }
                  }
                }
              } else if (isRemote) {
                // MCP tool passthrough is only available on local vmlx-engine servers
                resultText = `MCP tool "${tc.function.name}" is only available with local vmlx-engine sessions.`;
                emitToolStatus(
                  "error",
                  tc.function.name,
                  resultText,
                  toolIteration,
                  tc.id,
                );
              } else if (
                (mcpRefusal = refusalOf(
                  await gateToolCall(tc.function.name, toolArgs, tc.id, false, fullContent),
                )) !== null
              ) {
                // Permission preset: Read only asks before an MCP tool runs.
                resultText = mcpRefusal;
                emitToolStatus(
                  "error",
                  tc.function.name,
                  resultText,
                  toolIteration,
                  tc.id,
                );
              } else {
                const execRes = await fetch(`${baseUrl}/v1/mcp/execute`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...authHeaders,
                  },
                  body: JSON.stringify({
                    tool_name: tc.function.name,
                    arguments: toolArgs,
                  }),
                  signal: abortController.signal,
                });
                if (!execRes.ok) {
                  const errText = await execRes.text();
                  resultText = boundToolResultText(
                    `Error (${execRes.status}): ${errText}`,
                    MAX_RAW_TOOL_RESULT_CHARS,
                  );
                  emitToolStatus(
                    "error",
                    tc.function.name,
                    resultText,
                    toolIteration,
                    tc.id,
                  );
                } else {
                  const result = await execRes.json();
                  resultText = formatMcpToolResult(
                    result,
                    MAX_RAW_TOOL_RESULT_CHARS,
                  );
                  if (result.is_error) {
                    emitToolStatus(
                      "error",
                      tc.function.name,
                      resultText,
                      toolIteration,
                      tc.id,
                    );
                  } else {
                    emitToolStatus(
                      "result",
                      tc.function.name,
                      resultText,
                      toolIteration,
                      tc.id,
                    );
                  }
                }
              }
            } catch (err: any) {
              if (err?.name === "AbortError") throw err;
              resultText = boundToolResultText(
                `Tool execution error: ${err.message}`,
                MAX_RAW_TOOL_RESULT_CHARS,
              );
              emitToolStatus(
                "error",
                tc.function.name,
                resultText,
                toolIteration,
                tc.id,
              );
            }
            await flushToolStatusToRenderer();

            // What the MODEL sees: head + tail of a large result, with the
            // full text spilled to a file it can read (the card above keeps
            // the raw output).
            resultText = prepareToolResultForModel(tc.function.name, resultText);
            // Advisory only (3rd/5th/8th identical call): appended to the
            // END of the newest result so the cached prefix is untouched.
            resultText = appendReminder(
              resultText,
              repeatCallTracker.record(chatId, tc.function.name, tc.function.arguments),
            );
            requestMessages.push(
              useResponsesApi
                ? {
                    type: "function_call_output",
                    call_id: tc.id,
                    output: resultText,
                  }
                : { role: "tool", tool_call_id: tc.id, content: resultText },
            );
            if (exactFinalToolNames.includes(normalizedToolName)) {
              completedExactFinalTools.add(normalizedToolName);
            }
          }

          // Inject media from read_image/read_video tool results as multimodal
          // content parts. VL models can only process media in content arrays,
          // not in tool result strings. Text FIRST, then media — Qwen VL
          // expects this order.
          const contentParts = buildToolMediaFollowupContent(
            pendingImageDataUrls,
            pendingVideoDataUrls,
          );
          if (contentParts) {
            requestMessages.push({ role: "user", content: contentParts });
            console.log(
              `[CHAT] Injected ${pendingImageDataUrls.length} image(s), ${pendingVideoDataUrls.length} video(s) as multimodal content for VLM`,
            );
          }
        };

        console.log(
          `[CHAT] Stream ended — content: ${fullContent.length} chars, reasoning: ${reasoningContent.length} chars, tool calls: ${receivedToolCalls.length}, buffered: ${clientToolCallBuffering}`,
        );

        // ─── Unified Tool Execution + Auto-Continue Loop ───────────────────
        // Handles both tool call execution and auto-continuation for models
        // that stop after tool use without providing a response.
        // A reasoning-only/empty post-tool completion gets one direct-answer
        // recovery. Repeating the same generic prompt three times created
        // duplicate partial reasoning cards and misleading cumulative metrics.
        const AUTO_CONTINUE_TOKEN_THRESHOLD = 100;
        const MAX_AUTO_CONTINUES = 1;
        let autoContinueCount = 0;
        while (toolIteration < MAX_TOOL_ITERATIONS) {
          // Compact sparse array: parallel tool calls at non-contiguous indices create holes
          // that for...of silently skips. Filter to only real entries.
          if (receivedToolCalls.length > 0) {
            receivedToolCalls = receivedToolCalls.filter(Boolean);
          }
          if (
            repeatsOnlyCompletedExactlyOnceTools(
              receivedToolCalls.map((tc) => tc.function.name),
              exactlyOnceToolNames,
              completedExactlyOnceTools,
            )
          ) {
            // The prior pass already executed the user's exactly-once contract.
            // Treat a replay-only model pass as a failed answer pass, not as
            // progress through another tool iteration. Counting it as progress
            // resets autoContinueCount and lets a stubborn model repeat the
            // same rejected call until MAX_TOOL_ITERATIONS. Drop the replayed
            // control output and enter the existing one-shot answer-only
            // recovery below; the real tool result is already in history.
            console.warn(
              "[CHAT] Completed exactly-once tool was replayed; using bounded answer-only recovery",
            );
            receivedToolCalls = [];
            fullContent = "";
            rawAccumulated = "";
            lastFinishReason = "stop";
          }
          if (receivedToolCalls.length > 0) {
            // ── Model made tool calls: execute and send follow-up ──
            toolIteration++;
            autoContinueCount = 0; // reset — model is making progress
            console.log(
              `[CHAT] Tool execution iteration ${toolIteration} (${receivedToolCalls.length} tool calls)`,
            );
            const contentBeforeToolPreviewCleanup = fullContent;
            fullContent = stripRedundantNamespacedToolPreview(
              fullContent,
              receivedToolCalls,
            );
            const clearedRedundantToolPreview =
              contentBeforeToolPreviewCleanup !== fullContent;
            if (clearedRedundantToolPreview) {
              console.log(
                `[CHAT] Removed redundant namespaced tool preview before Responses continuation`,
              );
            }
            // Preserve content before tool execution so abort can recover it
            flushToolTagHoldback();
            if (fullContent.trim()) {
              allGeneratedContent = appendVisibleToolContent(allGeneratedContent, fullContent);
            }
            // Flush accumulated content to renderer before blocking on tool execution
            try {
              const win = getWindow();
              if (
                win &&
                !win.isDestroyed() &&
                (allGeneratedContent.trim() || clearedRedundantToolPreview)
              ) {
                displayTimeline.observeContent(allGeneratedContent);
                win.webContents.send("chat:stream", {
                  chatId,
                  messageId: assistantMessage.id,
                  displayTimeline: displayTimeline.snapshot(),
                  fullContent: allGeneratedContent,
                  isReasoning: false,
                  metrics: {
                    tokenCount: cumulativeTokenOffset + iterationTokenCount,
                    promptTokens,
                    cachedTokens,
                    cacheDetail,
                    tokensPerSecond: liveTps.toFixed(1),
                    ttft: exchangeFirstTokenClock.seconds().toFixed(2),
                    elapsed: Math.max(0, (Date.now() - startTime) / 1000).toFixed(1),
                    ...remoteMetricFields(),
                  },
                });
              }
            } catch (_) {}
            // Reset idle timer before tool execution — builtin tools run locally
            // without server contact, so the model could sleep during long tool runs
            if (chatSession && !providerRoute) sessionManager.touchSession(chatSession.id);
            const touchInterval = chatSession && !providerRoute
              ? setInterval(() => {
                  sessionManager.touchSession(chatSession.id);
                }, 30000)
              : null; // Ping every 30s during tool execution

            // AppleScript-8B is a single native-action specialist: its model
            // card defines one run_applescript call and explicitly says the
            // agent executes that result. Live Electron follow-ups showed the
            // fine-tune re-emits the same call indefinitely when the tool
            // schema remains available after a successful result. Treat that
            // bundle-owned one-call contract as terminal while leaving every
            // general ZAYA/tool bundle on the normal multi-tool loop.
            const finishAfterNativeToolResult =
              shouldFinishZayaAppleScriptToolRound(
                chatUsesZayaAppleScriptToolBundle,
                receivedToolCalls.map((tc) => tc.function.name),
              );

            try {
              await executeToolCalls();
            } finally {
              if (touchInterval) clearInterval(touchInterval);
            }
            receivedToolCalls = [];
            fullContent = "";
            rawAccumulated = "";
            currentEventType = "";
            seenResponsesApiEvents.clear();
            lastFinishReason = undefined; // Reset for next iteration
            // Reset content offset tracker to match the accumulated content position
            lastEmittedContentLength = allGeneratedContent.length
              ? allGeneratedContent.length + 2
              : 0;
            clientToolCallBuffering = false;
            clientSideThinkParsing = false;
            clientSideThinkHoldback = "";
            cumulativeTokenOffset += iterationTokenCount; // Save completed iteration tokens for cumulative total
            iterationTokenCount = 0;
            tpsSnapshots.length = 0;
            liveTps = 0;
            tpsTokenBase = tokenCount; // Reset rolling TPS for fresh generation phase
            serverSendsUsage = false; // Re-detect for new HTTP request (server restarts completion_tokens from 1)
            // Fire reasoningDone if model was still in reasoning mode when tool calls appeared
            if (isReasoning && reasoningContent) {
              try {
                const win = getWindow();
                if (win && !win.isDestroyed()) {
                  win.webContents.send("chat:reasoningDone", {
                    chatId,
                    messageId: assistantMessage.id,
                    reasoningContent: currentReasoningContent(),
                    reasoningSegments: [...reasoningSegments],
                    displayTimeline: displayTimeline.snapshot(),
                  });
                }
              } catch (_) {}
            }
            // chat:reasoningDone emitted above before resetting for the next segment.
            isReasoning = false; // Reset reasoning state for new iteration
            reasoningSegments = markReasoningToolBoundary(reasoningSegments, toolIteration);
            reasoningContent = ""; // Start a fresh reasoning segment for the next iteration
            // (thinking indicator removed)
            if (finishAfterNativeToolResult) {
              console.log(
                "[CHAT] ZAYA AppleScript native tool result completed the one-call bundle contract",
              );
              break;
            }
            emitToolStatus("processing", "", undefined, toolIteration);
            const exactFinalToolsComplete =
              exactFinalToolNames.length > 0 &&
              exactFinalToolNames.every((name) =>
                completedExactFinalTools.has(name),
              );
            const exactlyOnceToolsComplete =
              exactlyOnceToolNames.length > 0 &&
              exactlyOnceToolNames.every((name) =>
                completedExactlyOnceTools.has(name),
              );
            plannedDirectAnswerPass = shouldPlanCompletedToolAnswerPass({
              directAnswerAfterSingleTool,
              exactFinalToolCount: exactFinalToolNames.length,
              exactFinalToolsComplete,
              exactlyOnceToolCount: exactlyOnceToolNames.length,
              exactlyOnceToolsComplete,
            });
            // Reset idle timer before follow-up — tools may have consumed minutes
            if (chatSession && !providerRoute) sessionManager.touchSession(chatSession.id);
            if (!(await sendFollowUp())) break;
          } else if (
            toolIteration > 0 &&
            autoContinueCount < MAX_AUTO_CONTINUES &&
            shouldAutoContinueAfterToolUse({
              content: fullContent,
              iterationTokenCount,
              finishReason: lastFinishReason,
              thresholdTokens: AUTO_CONTINUE_TOKEN_THRESHOLD,
            })
          ) {
            // ── Auto-continue: model stopped without a substantive response after tool use ──
            // This handles two cases:
            // 1. Model generated ZERO content after tool results (just stopped)
            // 2. Model hit the length limit with a brief/incomplete response
            autoContinueCount++;
            finalAnswerRecovery = true;
            flushToolTagHoldback();
            const hasContent = fullContent.trim().length > 0;
            console.log(
              `[CHAT] Auto-continue ${autoContinueCount}/${MAX_AUTO_CONTINUES}: model stopped with ${iterationTokenCount} tokens (iteration), content=${hasContent}`,
            );
            if (hasContent) {
              allGeneratedContent = appendVisibleToolContent(allGeneratedContent, fullContent);
              if (useResponsesApi) {
                requestMessages.push({
                  type: "output_text",
                  text: fullContent,
                });
              } else {
                requestMessages.push({
                  role: "assistant",
                  content: fullContent,
                });
              }
            }
            const continuePrompt =
              "The tool already ran and its real result is above. Complete the original request now. Return only the requested final answer; do not call another tool or summarize these instructions.";
            if (useResponsesApi) {
              requestMessages.push({
                type: "message",
                role: "user",
                content: continuePrompt,
              });
            } else {
              requestMessages.push({ role: "user", content: continuePrompt });
            }
            fullContent = "";
            rawAccumulated = "";
            currentEventType = "";
            seenResponsesApiEvents.clear();
            lastFinishReason = undefined; // Reset for next iteration
            clientToolCallBuffering = false;
            clientSideThinkParsing = false;
            clientSideThinkHoldback = "";
            receivedToolCalls = [];
            // Reset content offset tracker to match the accumulated content position
            lastEmittedContentLength = allGeneratedContent.length
              ? allGeneratedContent.length + 2
              : 0;
            cumulativeTokenOffset += iterationTokenCount; // Save completed iteration tokens for cumulative total
            iterationTokenCount = 0;
            tpsSnapshots.length = 0;
            liveTps = 0;
            tpsTokenBase = tokenCount; // Reset rolling TPS for fresh generation phase
            serverSendsUsage = false; // Re-detect for new HTTP request (server restarts completion_tokens from 1)
            // Fire reasoningDone if model was still in reasoning mode at auto-continue boundary
            if (isReasoning && reasoningContent) {
              try {
                const win = getWindow();
                if (win && !win.isDestroyed()) {
                  win.webContents.send("chat:reasoningDone", {
                    chatId,
                    messageId: assistantMessage.id,
                    reasoningContent: currentReasoningContent(),
                    reasoningSegments: [...reasoningSegments],
                    displayTimeline: displayTimeline.snapshot(),
                  });
                }
              } catch (_) {}
            }
            // chat:reasoningDone emitted above before resetting for the next segment.
            isReasoning = false; // Reset reasoning state for new iteration
            reasoningSegments = markReasoningToolBoundary(reasoningSegments);
            reasoningContent = ""; // Start a fresh reasoning segment for the next iteration
            // (thinking indicator removed)
            emitToolStatus(
              "processing",
              "",
              "Generating response...",
              toolIteration,
            );
            // Reset idle timer before auto-continue follow-up
            if (chatSession && !providerRoute) sessionManager.touchSession(chatSession.id);
            if (!(await sendFollowUp())) break;
          } else {
            break;
          }
        }

        if (
          finalAnswerRecovery &&
          (allGeneratedContent.trim() || fullContent.trim())
        ) {
          // A successful bounded recovery supersedes only the intermediate
          // empty/reasoning-only diagnostic. Preserve parser, schema, cache,
          // tool-drop, and previous_response_id warnings.
          responseWarnings = dropSupersededRecoveryWarnings(responseWarnings);
        }

        if (
          toolIteration > 0 &&
          !allGeneratedContent.trim() &&
          !fullContent.trim()
        ) {
          const noVisibleAnswerWarning = noVisibleToolAnswerWarning({
            toolIteration,
            maxToolIterations: MAX_TOOL_ITERATIONS,
            recoveryAttempted: finalAnswerRecovery,
          });
          responseWarnings = Array.from(
            new Set([...(responseWarnings || []), noVisibleAnswerWarning]),
          );
          emitToolStatus(
            "error",
            "",
            noVisibleAnswerWarning,
            toolIteration,
          );
        }

        if (toolIteration > 0 || collectedToolStatuses.length > 0) {
          if (toolIteration > 0) {
            console.log(
              `[CHAT] Tool loop completed after ${toolIteration} iteration(s)`,
            );
          }
          emitToolStatus("done", "", undefined, toolIteration);
        }

        // Fire reasoningDone if stream ended while still in reasoning mode
        // (e.g., model only produced analysis channel, never transitioned to final)
        if (isReasoning) {
          isReasoning = false;
          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:reasoningDone", {
                chatId,
                messageId: assistantMessage.id,
                reasoningContent: currentReasoningContent(),
                reasoningSegments: [...reasoningSegments],
                displayTimeline: displayTimeline.snapshot(),
              });
            }
          } catch (_) {}
        }

        // Calculate final metrics — use generation-only time for t/s, fallback to wall clock
        const totalTime = (Date.now() - startTime) / 1000;
        const genTimeSec = generationMs > 0 ? generationMs / 1000 : 0;
        const wallTimeSec =
          firstTokenTime && lastTokenTime && lastTokenTime > firstTokenTime
            ? (lastTokenTime - firstTokenTime) / 1000
            : firstTokenTime
              ? (Date.now() - firstTokenTime) / 1000
              : totalTime;
        const finalGenSec = genTimeSec > 0.05 ? genTimeSec : wallTimeSec;
        // Use cumulative total across all tool iterations (server restarts completion_tokens per request)
        const serverDecodeSummary = summarizeServerDecodePasses([
          ...completedServerDecodePasses,
          currentServerDecodePass,
        ]);
        const remoteSummary = remoteMetrics?.snapshot(Date.now());
        const totalTokenCount =
          remoteSummary ? (remoteSummary.outputTokens ?? 0) :
          serverDecodeSummary?.outputTokens ??
          (cumulativeTokenOffset + iterationTokenCount);
        const cumulativeDecodeTps =
          finalGenSec > 0 ? totalTokenCount / finalGenSec : 0;
        // Progressive streams have credible cumulative delta timing even when
        // the last rolling window covers only a short post-tool answer tail.
        // Buffered answer passes are the opposite: their cumulative rate is an
        // impossible burst, so selectFinalDecodeTps falls back to the median
        // observed rolling stream rate.
        const finalTps =
          remoteSummary ? (remoteSummary.tokensPerSecond ?? 0) :
          serverDecodeSummary?.tokensPerSecond ??
          selectFinalDecodeTps({
            cumulativeTps: cumulativeDecodeTps,
            rollingTps: liveTpsHistory,
            lastRollingTps: liveTps,
          });
        const decodeMetricSource = remoteSummary
          ? remoteSummary.outputTokens === undefined ? "unavailable" : "remote-request"
          : serverDecodeSummary ? "server" : "client";
        const finalTpsLabel = remoteSummary?.outputTokens === undefined && isRemote
          ? "—" : finalTps.toFixed(1);
        // First exchange token, excluding initial health/message preparation.
        const ttft = Math.max(
          0,
          exchangeFirstTokenClock.seconds(),
        );
        // Preserve final-pass counts separately from exchange-wide tool usage.
        // Footer prefill aggregates engine receipts; preserve final-pass diagnostics.
        const finalStreamPromptTokens = promptTokens;
        const finalStreamCachedTokens = Math.min(
          cachedTokens,
          finalStreamPromptTokens,
        );
        const finalPrefillRates = footerPrefillRates(ttft);
        const finalPassPpSpeed = calculatePrefillTps({ prefillUsage: currentPrefillUsage });

        // Release any withheld tail before the final content is assembled.
        flushToolTagHoldback();
        if (chatDetectedFamily === "naive_n05_flash") {
          // Native template replays the post-think separator verbatim. Keep
          // wire history independent of the display sanitization below.
          generationRecord.nativeFinalContent = fullContent;
        }

        // Combine content from all tool iterations into the final message
        if (allGeneratedContent && fullContent.trim()) {
          fullContent = allGeneratedContent + "\n\n" + fullContent;
        } else if (allGeneratedContent && !fullContent.trim()) {
          fullContent = allGeneratedContent;
        }

        // Strip any remaining template tokens and leaked tool call XML.
        // preSanitizeContent backs the never-empty guard below: sanitizing a
        // non-empty answer down to nothing hides the model's real output
        // (e.g. an unparsed textual tool-call dialect) behind a blank turn.
        const preSanitizeContent = fullContent.trim();
        fullContent = fullContent.replace(TEMPLATE_TOKEN_REGEX, "");
        // Strip Harmony protocol residue (concatenated protocol words after template token removal)
        fullContent = fullContent.replace(
          /<\/?(?:assistant|analysis|final)+/gi,
          "",
        );
        fullContent = fullContent.replace(
          /(?:assistant\s*){1,3}(?:analysis|final)/gi,
          "",
        );
        fullContent = fullContent.replace(
          /(?:analysis|final)\s*(?:assistant\s*){1,3}/gi,
          "",
        );
        // Strip leaked tool call blocks that server didn't parse (various model
        // formats), including orphan closing tags with no opening tag — those
        // were reaching the screen as visible prose.
        fullContent = stripLeakedToolMarkup(fullContent);
        // Strip leaked Harmony protocol channel markers (GLM, GPT-OSS)
        fullContent = fullContent.replace(/<\|start\|>assistant/g, "");
        fullContent = fullContent.replace(
          /<\|channel\|>(?:analysis|final)<\|message\|>/g,
          "",
        );
        stopPeriodicSave(); // Stop periodic saves — final save below overwrites with complete content
        fullContent = fullContent.trim();
        // Never-empty sanitize guard: if stripping leaked tool-call markup
        // emptied an answer that had real text (and no tool actually ran this
        // turn to justify hiding it), surface the original verbatim in a fence
        // instead of persisting a blank assistant turn. Fencing renders the
        // raw dialect visibly instead of as invisible HTML tags.
        const visibleAfterSanitize = fullContent
          .replace(/```[^\n`]*\n?/g, "")
          .trim();
        // "No executed tool" must key on REAL tool calls / completed tool
        // iterations — the speculative buffering "Generating tool call..."
        // status also lands in collectedToolStatuses and would mask the guard.
        const neverEmptyAnswer = resolveNeverEmptyAssistantAnswer({
          visibleAfterSanitize,
          preSanitizeContent,
          rejectedControlMarkupText,
          executedToolCallCount: receivedToolCalls.filter(Boolean).length,
          priorIterationContent: allGeneratedContent,
          toolIterations: toolIteration,
          // A reasoning-only turn (reasoning rail fills, answer never starts)
          // otherwise falls through every case above and persists blank.
          reasoningContent: currentReasoningContent(),
        });
        if (neverEmptyAnswer) {
          console.log(
            `[CHAT] Never-empty guard (${neverEmptyAnswer.reason}): turn would have persisted blank; ` +
              `preSanitize=${preSanitizeContent.length}ch rejectedMarkup=${rejectedControlMarkupText.length}ch ` +
              `toolIterations=${toolIteration}`,
          );
          // Emit it, don't just persist it: a notice that only appears after the
          // final save leaves the live turn blank and makes the wire trace
          // disagree with the persisted record. skipClientCount keeps it out of
          // the token count (it is not model output); bypass keeps the marker
          // detector from re-suppressing it.
          fullContent = "";
          rawAccumulated = "";
          emitDelta(neverEmptyAnswer.content, false, true, true);
          // emitDelta restarts periodic saving when nothing had streamed yet.
          stopPeriodicSave();
        }
        // If no main content but reasoning was produced, keep them separate.
        // Reasoning stays in reasoningContent for the reasoning box; content stays empty.
        // (Previously this did fullContent = reasoningContent which triggered the anti-dup
        // check in MessageBubble, hiding the reasoning box.)
        const rawFinalReasoningContent = currentReasoningContent();
        const rawFinalReasoningSegments = currentReasoningSegments();
        const normalizeRailForPersistence = (value: string) =>
          value.replace(/\r\n/g, "\n").trim();
        const reasoningDuplicatesVisibleContent =
          !!fullContent &&
          !!rawFinalReasoningContent &&
          normalizeRailForPersistence(fullContent) ===
            normalizeRailForPersistence(rawFinalReasoningContent);
        if (reasoningDuplicatesVisibleContent) {
          console.warn(
            "[CHAT] Dropping content-identical reasoning rail before persistence",
          );
        }
        const finalReasoningContent = reasoningDuplicatesVisibleContent
          ? ""
          : rawFinalReasoningContent;
        const finalReasoningSegments = reasoningDuplicatesVisibleContent
          ? []
          : rawFinalReasoningSegments;
        // Preserve empty tool-boundary slots in SQLite for exact model-history
        // replay and display. An empty
        // slot records that a tool iteration produced no reasoning and prevents
        // later segments from being attached to the wrong assistant turn.
        const replayReasoningSegments = reasoningDuplicatesVisibleContent
          ? []
          : [...reasoningSegments];
        if (!fullContent && finalReasoningContent) {
          console.log(
            `[CHAT] No main content — reasoning only (${finalReasoningContent.length} chars)`,
          );
        }
        assistantMessage.content = fullContent;
        assistantMessage.tokens = totalTokenCount;
        // Fold the final stream into the exchange totals so persisted metrics
        // and the completion log report coherent prompt/cached pairs across
        // tool-loop streams (cached can never exceed prompt).
        promptTokens = exchangePromptTokens + finalStreamPromptTokens;
        cachedTokens =
          exchangeCachedTokens +
          finalStreamCachedTokens;
        assistantMessage.metricsJson = JSON.stringify({
          tokenCount: totalTokenCount,
          promptTokens: promptTokens || undefined,
          promptTokensScope: exchangePromptTokens > 0 ? "exchange" : undefined,
          cachedTokens: cachedTokens || undefined,
          cacheDetail: cacheDetail || undefined,
          tokensPerSecond: finalTpsLabel,
          decodeMetricSource,
          ...finalPrefillRates,
          ttft: ttft.toFixed(2),
          totalTime: totalTime.toFixed(1),
          ...remoteMetricFields(),
        });
        if (collectedToolStatuses.length > 0) {
          assistantMessage.toolCallsJson = JSON.stringify(
            collectedToolStatuses,
          );
        }
        if (finalReasoningContent) {
          assistantMessage.reasoningContent = finalReasoningContent;
        }
        if (replayReasoningSegments.length > 0) {
          assistantMessage.reasoningSegmentsJson = JSON.stringify(
            replayReasoningSegments,
          );
        }
        const finalResponseWarnings = appendResponseTerminalWarning(
          responseWarnings as string[] | null,
          lastFinishReason,
        );
        if (finalResponseWarnings && finalResponseWarnings.length > 0) {
          assistantMessage.warningsJson = JSON.stringify(finalResponseWarnings);
          console.warn(
            `[CHAT] Responses warning(s): ${finalResponseWarnings.join(" | ")}`,
          );
        }
        const mediaWarningWithoutVisibleActivity =
          hasMediaAttachments &&
          !fullContent &&
          !finalReasoningContent &&
          finalReasoningSegments.length === 0 &&
          collectedToolStatuses.length === 0 &&
          finalResponseWarnings &&
          finalResponseWarnings.length > 0;
        if (mediaWarningWithoutVisibleActivity) {
          // Responses can complete with an empty-warning payload instead of
          // throwing when a VLM image prefill guard rejects before generation.
          // Do not persist the failed media user turn; otherwise the next
          // text-only prompt replays the same image and repeats the guard until
          // the user manually rolls back.
          try {
            db.deleteMessage(userMessage.id);
            pushChatSessionLog(
              chatSession?.id || resolvedSession?.id,
              `[CHAT_DIAG] rolled_back_empty_warning_media_user_message=${JSON.stringify({
                chatId: chatId.slice(0, 8),
                messageId: userMessage.id.slice(0, 8),
                warnings: finalResponseWarnings,
              })}`,
            );
          } catch (_) {}
          throw new Error(
            `Media request failed before visible output: ${finalResponseWarnings.join(" | ")}`,
          );
        }

        // 2026-05-03: persist model-visible tool context separately from
        // the UI-display tool_calls_json. Without this, history replay drops
        // tool_calls and the model's chat template can't render `<tool_call>`
        // XML on continuation — Qwen3 was observed to improvise
        // `{"tool_name": ..., "arguments": ...}` JSON after an interrupted
        // tool round.
        //
        // Keep the data on the visible assistant row as JSON context, not as
        // hidden role="tool" DB rows. Older SQLite schemas CHECK message.role
        // to system/user/assistant, and renderer message lists would display
        // hidden tool rows. Request reconstruction expands this JSON back into
        // Responses or Chat-Completions-native history.
        try {
          const harvestedCalls: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }> = [];
          const harvestedResults: Array<{
            tool_call_id: string;
            content: string;
          }> = [];
          // Only THIS turn's fresh tool exchange (from currentTurnToolStart) —
          // never the replayed prior-turn tool calls/results, which would
          // otherwise be re-persisted into this row and multiply on each replay.
          for (const m of [
            ...compactedCurrentTurnItems,
            ...requestMessages.slice(currentTurnToolStart),
          ]) {
            if (
              m &&
              m.role === "assistant" &&
              Array.isArray(m.tool_calls) && m.tool_calls.length > 0
            ) {
              for (const tc of m.tool_calls) {
                if (
                  tc &&
                  tc.id &&
                  tc.function &&
                  typeof tc.function.name === "string"
                ) {
                  harvestedCalls.push({
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.function.name,
                      arguments:
                        typeof tc.function.arguments === "string"
                          ? tc.function.arguments
                          : JSON.stringify(tc.function.arguments ?? {}),
                    },
                  });
                }
              }
            } else if (
              m &&
              m.type === "function_call" &&
              typeof m.call_id === "string"
            ) {
              harvestedCalls.push({
                id: m.call_id,
                type: "function",
                function: {
                  name: typeof m.name === "string" ? m.name : "",
                  arguments:
                    typeof m.arguments === "string"
                      ? m.arguments
                      : JSON.stringify(m.arguments ?? {}),
                },
              });
            } else if (
              m &&
              m.role === "tool" &&
              typeof m.tool_call_id === "string"
            ) {
              harvestedResults.push({
                tool_call_id: m.tool_call_id,
                content:
                  typeof m.content === "string"
                    ? m.content
                    : JSON.stringify(m.content),
              });
            } else if (
              m &&
              m.type === "function_call_output" &&
              typeof m.call_id === "string"
            ) {
              harvestedResults.push({
                tool_call_id: m.call_id,
                content:
                  typeof m.output === "string"
                    ? m.output
                    : JSON.stringify(m.output),
              });
            }
          }
          if (harvestedCalls.length > 0) {
            assistantMessage.toolCallsOaiJson = JSON.stringify(
              harvestedCalls,
            );
          }
          if (harvestedResults.length > 0) {
            assistantMessage.toolResultsOaiJson = JSON.stringify(
              harvestedResults,
            );
          }
        } catch (_persistErr) {
          /* Non-fatal: persistence is best-effort; UI still works without it. */
        }
        generationRecord.status = 'completed';
        generationRecord.finishReason = lastFinishReason;
        saveGenerationRecord();
        if (reasoningDuplicatesVisibleContent && generationRecord.displayTimeline) {
          // The dropped rail must not survive in the display order either (a natural-EOS answer the engine
          // reclassified from the template-open think rail streams as reasoning first, then as content).
          generationRecord.displayTimeline = {
            ...generationRecord.displayTimeline,
            items: generationRecord.displayTimeline.items.filter(item => item.kind !== 'reasoning'),
          };
          assistantMessage.generationRecordJson = JSON.stringify(generationRecord);
          db.updateMessageGenerationRecord(assistantMessage.id, assistantMessage.generationRecordJson);
        }
        db.addMessage(assistantMessage);

        notifyTurnEnded(chatId, "done", activeRequests.get(chatId)?.turnStartedAt);
        // Send final metrics
        try {
          const win = getWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("chat:complete", {
              chatId,
              messageId: assistantMessage.id,
              proofRequestId,
              requestIds: [...wireRequestIds],
              responseId: activeRequests.get(chatId)?.responseId,
              content: fullContent,
              reasoningContent: finalReasoningContent || undefined,
              // Tells the renderer to clear the rail it streamed for this message (persistence already dropped it).
              reasoningDropped: reasoningDuplicatesVisibleContent || undefined,
              reasoningSegments:
                replayReasoningSegments.length > 0
                  ? replayReasoningSegments
                  : undefined,
              displayTimeline: generationRecord.displayTimeline,
              warnings: finalResponseWarnings || undefined,
              finishReason: lastFinishReason,
              metrics: {
                tokenCount: totalTokenCount,
                promptTokens,
                promptTokensScope: exchangePromptTokens > 0 ? "exchange" : undefined,
                cachedTokens,
                cacheDetail,
                tokensPerSecond: finalTpsLabel,
                decodeMetricSource,
          ...finalPrefillRates,
                ttft: ttft.toFixed(2),
                totalTime: totalTime.toFixed(1),
                ...remoteMetricFields(),
              },
            });
          }
        } catch (_) {}

        console.log(
          `[CHAT] Response complete: ${remoteSummary?.outputTokens === undefined && isRemote ? "unknown" : totalTokenCount} tokens in ${totalTime.toFixed(1)}s (${finalTpsLabel} t/s, decode=${decodeMetricSource}${remoteSummary ? `:${remoteSummary.outputTokens ?? "unknown"}/${remoteSummary.requestSeconds.toFixed(3)}s/${remoteSummary.passes}passes` : serverDecodeSummary ? `:${serverDecodeSummary.decodeTokens}/${serverDecodeSummary.decodeSeconds.toFixed(3)}s` : ""}, live=${isRemote ? "request-window" : liveTps.toFixed(1)} t/s, TTFT: ${ttft.toFixed(2)}s${finalStreamPromptTokens ? `, final-pass pp: ${finalStreamPromptTokens} tokens${finalStreamCachedTokens ? ` (${finalStreamCachedTokens} cached)` : ""}${finalPassPpSpeed ? `, ${finalPassPpSpeed} pp/s` : ", rate unavailable"}` : ""}, exchange prompt: ${promptTokens} tokens${cachedTokens ? ` (${cachedTokens} cached)` : ""}, usage=${serverSendsUsage ? "server" : "client"})`,
        );

        return assistantMessage;
      } catch (error) {
        stopPeriodicSave();
        remoteMetrics?.endPass(Date.now());
        // Release the SSE reader if it was acquired
        try {
          reader?.cancel();
        } catch (_) {}

        const _err = error as any;
        const errMsg = (error as Error).message || "";
        const projectedMetalHeadroomErrorContent =
          projectedMetalHeadroomChatErrorContent(errMsg);
        // GH #253: honest engine 413 (prompt_too_long) must render as a
        // graceful in-chat message, not a raw IPC error dialog.
        const promptTooLongErrorContent = promptTooLongChatErrorContent(errMsg);
        const nativeMtpErrorWarning = abortController.signal.aborted
          ? null
          : nativeMtpChatErrorWarning(errMsg);
        const abortWarnings = Array.from(new Set([
          ...(responseWarnings || []),
          ...(nativeMtpErrorWarning ? [nativeMtpErrorWarning] : []),
        ]));
        if (
          !projectedMetalHeadroomErrorContent &&
          !promptTooLongErrorContent &&
          !isExpectedChatBackendDisconnectError(error)
        ) {
          console.error("[CHAT] Error caught:", {
            message: _err?.message,
            name: _err?.name,
            code: _err?.code,
            type: _err?.constructor?.name,
            stack: _err?.stack?.split("\n").slice(0, 5).join("\n"),
            abortSignal: abortController.signal.aborted,
            timedOut,
            fullContentLen: fullContent?.length,
            readerAcquired: !!reader,
          });
        }
        pushChatSessionLog(
          chatSession?.id || resolvedSession?.id,
          `[CHAT_DIAG] request_error=${JSON.stringify({
            chatId: chatId.slice(0, 8),
            message: _err?.message,
            name: _err?.name,
            code: _err?.code,
            timedOut,
            fullContentLen: fullContent?.length || 0,
            readerAcquired: !!reader,
          })}`,
        );

        // Fire reasoningDone if interrupted during reasoning mode
        if (isReasoning) {
          isReasoning = false;
          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:reasoningDone", {
                chatId,
                messageId: assistantMessage.id,
                reasoningContent: currentReasoningContent(),
                reasoningSegments: [...reasoningSegments],
                displayTimeline: displayTimeline.snapshot(),
              });
            }
          } catch (_) {}
        }

        // Save partial response: combine all content from previous tool iterations + current.
        // allGeneratedContent holds text from completed iterations; fullContent has current iteration.
        const abortFinishReason = lastFinishReason ?? null;
        let partialContent = "";
        if (allGeneratedContent.trim() && fullContent.trim()) {
          partialContent =
            allGeneratedContent.trim() + "\n\n" + fullContent.trim();
        } else if (allGeneratedContent.trim()) {
          partialContent = allGeneratedContent.trim();
        } else {
          partialContent = fullContent.trim();
        }
        if (partialContent) {
          partialContent = partialContent.replace(TEMPLATE_TOKEN_REGEX, "");
          partialContent = stripLeakedToolMarkup(partialContent);
          partialContent = partialContent.replace(/<\|start\|>assistant/g, "");
          partialContent = partialContent.replace(
            /<\|channel\|>(?:analysis|final)<\|message\|>/g,
            "",
          );
          partialContent = partialContent.trim();
        }
        // Check abort status BEFORE save/delete decision — needed to preserve
        // tool call displays that the user already saw on screen.
        const wasAborted = abortController.signal.aborted;
        const abortTotalTokens = remoteMetrics
          ? (remoteMetrics.snapshot(Date.now()).outputTokens ?? 0)
          : cumulativeTokenOffset + iterationTokenCount;
        const abortReasoningContent = currentReasoningContent();
        const abortReasoningSegments = [...reasoningSegments];
        const hadVisibleActivity =
          partialContent ||
          abortReasoningContent.trim() ||
          projectedMetalHeadroomErrorContent ||
          promptTooLongErrorContent ||
          nativeMtpErrorWarning ||
          collectedToolStatuses.length > 0 ||
          abortTotalTokens > 0;
        // True when the ONLY thing to show is the prompt-too-long bubble — no
        // generated content existed. Used below to keep the failed-media
        // rollback intact (the oversized payload must not replay next turn).
        const promptTooLongOnlyBubble =
          Boolean(promptTooLongErrorContent) &&
          !partialContent &&
          !abortReasoningContent.trim() &&
          collectedToolStatuses.length === 0 &&
          abortTotalTokens === 0;

        // Save message if we have any content, reasoning, or visible tool activity
        if (hadVisibleActivity) {
          assistantMessage.content = partialContent
            ? partialContent + "\n\n[Generation interrupted]"
            : projectedMetalHeadroomErrorContent ||
              promptTooLongErrorContent ||
              "[Generation interrupted]";
          assistantMessage.tokens = abortTotalTokens;
          if (abortWarnings.length > 0) {
            assistantMessage.warningsJson = JSON.stringify(abortWarnings);
          }

          // Calculate real metrics for the partial generation (not hardcoded zeros)
          const abortTotalTime = (Date.now() - startTime) / 1000;
          const abortGenSec =
            generationMs > 50
              ? generationMs / 1000
              : firstTokenTime
                ? (Date.now() - firstTokenTime) / 1000
                : abortTotalTime;
          const abortTps =
            abortGenSec > 0 && abortTotalTokens > 0
              ? abortTotalTokens / abortGenSec
              : 0;
          // Preserve first exchange TTFT even when interrupted during a later pass.
          const abortTtft = exchangeFirstTokenClock.seconds();
          const abortPrefillRates = footerPrefillRates(abortTtft);

          const abortMetrics = {
            tokenCount: abortTotalTokens,
            promptTokens: promptTokens || undefined,
            cachedTokens: cachedTokens || undefined,
            cacheDetail: cacheDetail || undefined,
            tokensPerSecond: abortTps.toFixed(1),
            ...abortPrefillRates,
            ttft: abortTtft.toFixed(2),
            totalTime: abortTotalTime.toFixed(1),
            ...remoteMetricFields(),
          };

          // Persist metricsJson to DB so reloading the chat shows real stats
          assistantMessage.metricsJson = JSON.stringify(abortMetrics);
          if (collectedToolStatuses.length > 0) {
            assistantMessage.toolCallsJson = JSON.stringify(
              collectedToolStatuses,
            );
          }
          if (abortReasoningContent) {
            assistantMessage.reasoningContent = abortReasoningContent;
          }
          if (abortReasoningSegments.length > 0) {
            assistantMessage.reasoningSegmentsJson = JSON.stringify(
              abortReasoningSegments,
            );
          }
          generationRecord.status = 'interrupted';
          generationRecord.finishReason = lastFinishReason;
          saveGenerationRecord();
          db.addMessage(assistantMessage);

          try {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("chat:complete", {
                chatId,
                messageId: assistantMessage.id,
                proofRequestId,
                requestIds: [...wireRequestIds],
                responseId: activeRequests.get(chatId)?.responseId,
                content: assistantMessage.content,
                reasoningContent: abortReasoningContent || undefined,
                reasoningSegments:
                  abortReasoningSegments.length > 0
                    ? abortReasoningSegments
                    : undefined,
                displayTimeline: generationRecord.displayTimeline,
                finishReason: abortFinishReason,
                warnings: abortWarnings.length > 0 ? abortWarnings : undefined,
                metrics: abortMetrics,
              });
            }
          } catch (_) {}
        } else {
          // No content generated — remove the pre-inserted empty placeholder row
          try {
            db.deleteMessage(assistantMessage.id);
          } catch (_) {}
        }

        if (
          hasMediaAttachments &&
          (!hadVisibleActivity || promptTooLongOnlyBubble) &&
          !wasAborted
        ) {
          // A failed oversized media turn must not remain in local history.
          // Otherwise the next text-only prompt replays the same image payload and
          // hits the same VLM image prefill guard until the user manually rolls back.
          try {
            db.deleteMessage(userMessage.id);
            pushChatSessionLog(
              chatSession?.id || resolvedSession?.id,
              `[CHAT_DIAG] rolled_back_failed_media_user_message=${JSON.stringify({
                chatId: chatId.slice(0, 8),
                messageId: userMessage.id.slice(0, 8),
              })}`,
            );
          } catch (_) {}
        }

        // Distinguish timeout from user-initiated abort for better error messages.
        // CRITICAL: Check abortController.signal.aborted FIRST — when abort fires during
        // reader.read(), the error message can be 'terminated' instead of 'AbortError',
        // which would be misclassified as "server connection lost".
        if (timedOut) {
          throw new Error(
            `No response bytes received for ${fetchInactivitySeconds}s. The local engine may be stalled or the remote endpoint may be unavailable.`,
          );
        }
        if (wasAborted) {
          // User-initiated abort: return normally so the renderer's success path handles it.
          // Content (if any) was already saved to DB and chat:complete event sent above.
          console.log(
            `[CHAT] Abort complete — saved ${partialContent ? partialContent.length : 0} chars, ${collectedToolStatuses.length} tool statuses`,
          );
          return hadVisibleActivity ? assistantMessage : null;
        }
        // A failed turn (not a user stop) is worth a notification when away.
        notifyTurnEnded(chatId, "failed", activeRequests.get(chatId)?.turnStartedAt);
        if (projectedMetalHeadroomErrorContent) {
          return assistantMessage;
        }
        if (promptTooLongErrorContent) {
          // Graceful in-chat bubble already persisted + chat:complete sent —
          // return like a normal turn so no raw IPC error dialog appears.
          return assistantMessage;
        }
        // Check both error message AND error code — Node.js ConnResetException has
        // message "aborted" but code "ECONNRESET", which the message-only check missed.
        const errCode = (error as any)?.code || "";
        if (
          errMsg === "terminated" ||
          errMsg === "aborted" ||
          errMsg.includes("ECONNREFUSED") ||
          errMsg.includes("ECONNRESET") ||
          errCode === "ECONNRESET" ||
          errCode === "ECONNREFUSED" ||
          errCode === "EPIPE" ||
          errCode === "ERR_STREAM_DESTROYED" ||
          errMsg.includes("write EPIPE") ||
          errMsg.includes("Connection closed before response completed") ||
          errMsg.includes("socket hang up") ||
          isExpectedChatBackendDisconnectError(error)
        ) {
          throw new Error(
            `Server connection lost. The model server may have crashed or stopped. Try restarting the session.`,
          );
        }
        throw new Error(`Failed to send message: ${errMsg}`);
      } finally {
        // stopPeriodicSave is scoped to this block; entry/timer cleanup lives
        // in the outer finally so setup-phase throws are covered too.
        stopPeriodicSave();
      }

      } finally {
        if (fetchTimeout) clearTimeout(fetchTimeout);
        if (mode === "aside" && asideControllers.get(chatId) === abortController) asideControllers.delete(chatId);
        // What this turn's file tools changed, under the reply ("2 files changed").
        if (turnChangeMessageId) {
          try {
            const set = turnChanges.finish(chatId, turnChangeMessageId);
            if (set) for (const w of appWindows()) w.webContents.send("changes:turn", set);
          } catch (err) {
            console.warn("[CHAT] Changes checkpoint failed:", err);
          }
        }
        // Only delete our own entry — after an abort or stale-lock recovery,
        // a newer request may have already registered a replacement.
        const current = activeRequests.get(chatId);
        if (current && current.controller === abortController) {
          activeRequests.delete(chatId);
          // Steers this turn never reached go back as queued messages.
          returnUnusedSteers(chatId, getWindow);
        }
      }
    };
  ipcMain.handle(
    "chat:sendMessage",
    (
      event,
      chatId: string,
      content: string,
      endpoint?: { host: string; port: number },
      attachments?: Parameters<typeof handleSendMessage>[4],
    ) => handleSendMessage(event, chatId, content, endpoint, attachments, "send"),
  );
  runChatTurnFromMain = async (chatId: string, prompt: string): Promise<{ ok: boolean; error?: string; retry?: boolean; code?: string }> => {
    const chat = db.getChat(chatId);
    if (!chat) return { ok: false, code: "chat-deleted", error: "The task's chat was deleted." };
    const modelPath = String(chat.modelPath || chat.modelId || "");
    if (!modelPath) return { ok: false, code: "no-model", error: "The task's chat has no model." };
    let endpoint: { host: string; port: number } | undefined;
    if (modelPath.startsWith("provider://")) {
      // A cloud model needs its provider binding; never fall back to whatever runs locally.
      let bound = false;
      try { bound = !!db.providers.getChatBinding(chatId); } catch { bound = false; }
      if (!bound) return { ok: false, code: "cloud-lost", error: "The task's chat lost its cloud model. Open the chat and pick a model." };
    } else {
      const session = sessionManager.getSessionByModelPath(modelPath.replace(/\/+$/, ""));
      if (!session || !["running", "loading", "standby"].includes(session.status)) {
        return { ok: false, retry: true, code: "model-not-running", error: "Its model was not running. Start the model (or switch the task's chat to a cloud model)." };
      }
      endpoint = { host: session.host, port: session.port };
    }
    unattendedTurns.add(chatId);
    try {
      const res = await handleSendMessage(null, chatId, prompt, endpoint);
      if (res && res.success === false) return { ok: false, error: String(res.error || "Failed") };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      unattendedTurns.delete(chatId);
    }
  };
  // Ask aside (⌘;): a side question about this chat, answered outside it.
  ipcMain.handle(
    "chat:aside",
    async (event, chatId: string, question: string, endpoint?: { host: string; port: number }) => {
      const q = typeof question === "string" ? question.trim().slice(0, 4000) : "";
      if (!q || typeof chatId !== "string") return { success: false, error: "empty" };
      try {
        return await handleSendMessage(event, chatId, q, endpoint, undefined, "aside");
      } catch (err) {
        return { success: false, error: (err as Error)?.message || String(err) };
      }
    },
  );
  ipcMain.handle("chat:asideCancel", (_event, chatId: string) => {
    if (typeof chatId !== "string") return false;
    const c = asideControllers.get(chatId);
    if (!c) return false;
    c.abort();
    asideControllers.delete(chatId);
    return true;
  });
  // Manual compaction (/compact): summarize the older history now.
  ipcMain.handle(
    "chat:compact",
    (event, chatId: string, endpoint?: { host: string; port: number }) =>
      handleSendMessage(event, chatId, "", endpoint, undefined, "compact"),
  );

  // B5: Abort active generation for a chat
  ipcMain.handle("chat:abort", async (_, chatId: string) => {
    const entry = activeRequests.get(chatId);
    if (entry) {
      console.log(`[CHAT] Aborting generation for chat ${chatId}`);
      // Tell the server to cancel inference before closing the SSE stream.
      // Closing the stream first lets the disconnect cleanup remove engine
      // bookkeeping before this explicit cancellation arrives, producing a
      // misleading 404 and leaving no deterministic cancellation receipt.
      if (entry.responseId && (entry.endpoint || entry.baseUrl)) {
        try {
          // Route to correct cancel endpoint based on response ID prefix
          const cancelPath = entry.responseId.startsWith("resp_")
            ? `/v1/responses/${entry.responseId}/cancel`
            : `/v1/chat/completions/${entry.responseId}/cancel`;
          const cancelBase =
            entry.baseUrl ||
            `http://${connectHost(entry.endpoint!.host)}:${entry.endpoint!.port}`;
          const cancelRes = await fetch(`${cancelBase}${cancelPath}`, {
            method: "POST",
            headers: entry.authHeaders || {},
            signal: AbortSignal.timeout(2000),
          });
          console.log(
            `[CHAT] Server cancel sent for ${entry.responseId} — status ${cancelRes.status}`,
          );
        } catch (cancelErr: any) {
          console.log(
            `[CHAT] Server cancel failed for ${entry.responseId}: ${cancelErr.message || cancelErr}`,
          );
        }
      } else if (!entry.responseId) {
        // Abort during prefill: responseId not assigned yet. The fetch abort
        // closes the connection; the server will detect disconnect via is_disconnected()
        // on the next token yield. No explicit cancel needed — prefill is typically <2s.
        console.log(
          `[CHAT] Abort during prefill (no responseId yet) — connection closed, server will detect disconnect`,
        );
      }

      try {
        entry.controller.abort();
      } catch (_) {}

      activeRequests.delete(chatId);
      // The turn's own cleanup no longer sees itself as current: hand the
      // additions it never picked up back to the queue here.
      returnUnusedSteers(chatId);
      return { success: true };
    }
    return { success: false, error: "No active request for this chat" };
  });

  // Check if a chat has an active streaming generation (used for re-sync on tab switch)
  ipcMain.handle("chat:isStreaming", (_, chatId: string) => {
    return activeRequests.has(chatId);
  });

  // Clear all active locks (explicit reset; quitting uses abortAllChatRequests)
  ipcMain.handle("chat:clearAllLocks", async () => ({
    cleared: abortAllChatRequests(),
  }));

  // On window (re)load: clear only locks that can no longer finish (aborted
  // or past their stale limit). A turn that is still running keeps running,
  // so closing and reopening the window does not stop the agent.
  ipcMain.handle("chat:clearStaleLocks", async () => {
    let cleared = 0;
    const now = Date.now();
    for (const [chatId, entry] of [...activeRequests]) {
      const staleLockMs = Math.min(entry.timeoutMs + 30_000, 30 * 60 * 1000);
      if (entry.controller.signal.aborted || now - entry.startedAt > staleLockMs) {
        cancelAndAbortEntry(chatId, entry);
        activeRequests.delete(chatId);
        returnUnusedSteers(chatId);
        cleared++;
      }
    }
    return { cleared, running: activeRequests.size };
  });


  // Overrides — validate numeric bounds to prevent garbage values from reaching the engine
  ipcMain.handle(
    "chat:setOverrides",
    async (_, chatId: string, overrides: any) => {
      const sanitized = sanitizeChatOverrides({ ...overrides, chatId });
      db.setChatOverrides({ ...sanitized, chatId });

      return { success: true };
    },
  );

  // The coding agent's current todo list for a chat (written by todo_write).
  ipcMain.handle("chat:getTodos", async (_, chatId: string) => {
    return parseStoredTodos(db.getChatAgentState(chatId).todosJson);
  });

  ipcMain.handle("chat:steer", (_, chatId: string, id: string, text: string) => {
    if (typeof chatId !== "string" || typeof text !== "string" || !text.trim()) return { accepted: false };
    if (!activeRequests.has(chatId)) return { accepted: false };
    const list = steerQueues.get(chatId) ?? [];
    if (list.length >= 10) return { accepted: false };
    list.push({ id: typeof id === "string" ? id : String(Date.now()), text: text.slice(0, 20000) });
    steerQueues.set(chatId, list);
    return { accepted: true };
  });
  ipcMain.handle("chat:setPlanMode", (_, chatId: string, on: boolean) => {
    if (typeof chatId !== "string" || !chatId) return false;
    if (on) planModeChats.add(chatId);
    else planModeChats.delete(chatId);
    return planModeChats.has(chatId);
  });
  ipcMain.handle("chat:getPlanMode", (_, chatId: string) => planModeChats.has(chatId));
  ipcMain.handle("chat:getOverrides", async (_, chatId: string) => {
    return sanitizeChatOverrides({
      ...(db.getChatOverrides(chatId) || {}),
      chatId,
    });
  });

  ipcMain.handle("chat:clearOverrides", async (_, chatId: string) => {
    db.clearChatOverrides(chatId);
    return { success: true };
  });

  // Chat Profiles (named presets for chat settings)
  ipcMain.handle(
    "chat:saveProfile",
    async (_, name: string, overrides: any, isDefault?: boolean) => {
      const id = db.saveChatProfile(
        name,
        sanitizeChatProfileOverrides(overrides),
        isDefault,
      );
      return { id };
    },
  );

  ipcMain.handle(
    "chat:updateProfile",
    async (
      _,
      id: string,
      name: string,
      overrides: any,
      isDefault?: boolean,
    ) => {
      db.updateChatProfile(
        id,
        name,
        sanitizeChatProfileOverrides(overrides),
        isDefault,
      );
      return { success: true };
    },
  );

  ipcMain.handle("chat:getProfiles", async () => {
    return db.getChatProfiles().map((profile) => ({
      ...profile,
      overrides: sanitizeChatProfileOverrides(profile.overrides),
    }));
  });

  ipcMain.handle("chat:getDefaultProfile", async () => {
    const profile = db.getDefaultChatProfile();
    return profile ? sanitizeChatProfileOverrides(profile) : undefined;
  });

  ipcMain.handle("chat:deleteProfile", async (_, id: string) => {
    db.deleteChatProfile(id);
    return { success: true };
  });
}

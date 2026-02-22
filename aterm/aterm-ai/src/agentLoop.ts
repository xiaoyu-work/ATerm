/**
 * Agent React Loop — drives the stream → tools → continue cycle.
 *
 * Mirrors gemini-cli's useGeminiStream hook:
 *   submitQuery() → processGeminiStreamEvents() → scheduleToolCalls()
 *   → handleCompletedTools() → submitQuery(continuation)
 *
 * Reference: packages/cli/src/ui/hooks/useGeminiStream.ts
 *
 * This is a thin orchestrator — tool definitions, execution, and scheduling
 * are delegated to the ToolRegistry, Scheduler, and MessageBus.
 */

import { IAIService, ChatMessage } from './ai.service'
import { ContextCollector } from './contextCollector'
import { EventType, ToolCallRequest, TokensSummary } from './streamEvents'
import { ToolRegistry } from './tools/toolRegistry'
import { AgentCallbacks, ToolCallStatus, ToolContext } from './tools/types'
import { PathApprovalTracker } from './tools/pathApprovals'
import { Scheduler } from './scheduler/scheduler'
import {
    MessageBus,
    MessageBusEvent,
    ToolConfirmationRequest,
    ToolConfirmationResponse,
    AskUserRequest,
    AskUserResponse,
} from './messageBus'
import { createDefaultRegistry } from './tools/definitions'
import { ChatCompressionService, CompressionStatus } from './services/chatCompressionService'

// Re-export for external consumers
export type { AgentCallbacks } from './tools/types'

/** Result from AgentLoop.run() */
export interface AgentResult {
    messages: ChatMessage[]
    usage: TokensSummary
}

/** Tools available in plan mode — read-only only */
const PLAN_MODE_TOOL_NAMES = new Set([
    'glob', 'grep_search', 'read_file', 'list_directory',
    'google_web_search', 'ask_user', 'activate_skill', 'exit_plan_mode',
])

/**
 * Simple loop detector — mirrors gemini-cli's LoopDetectionService
 * (packages/core/src/services/loopDetectionService.ts)
 *
 * Detects when identical tool call sequences repeat.
 */
class LoopDetector {
    private recentToolSignatures: string[] = []
    private readonly threshold = 4

    /** Record a set of tool calls for this turn. Returns true if a loop is detected. */
    recordTurn (toolCalls: ToolCallRequest[]): boolean {
        if (toolCalls.length === 0) return false

        const sig = toolCalls.map(tc => `${tc.function.name}:${tc.function.arguments}`).join('|')
        this.recentToolSignatures.push(sig)

        if (this.recentToolSignatures.length > this.threshold * 2) {
            this.recentToolSignatures = this.recentToolSignatures.slice(-this.threshold * 2)
        }

        if (this.recentToolSignatures.length >= this.threshold) {
            const last = this.recentToolSignatures.slice(-this.threshold)
            if (last.every(s => s === last[0])) {
                return true
            }
        }
        return false
    }
}

export class AgentLoop {
    private messages: ChatMessage[] = []
    /** Max turns — mirrors gemini-cli's MAX_TURNS (100) in client.ts */
    private maxTurns = 100
    /** Accumulated token usage across all turns */
    private usage: TokensSummary = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }
    private loopDetector = new LoopDetector()
    /** Plan mode — restricts tools to read-only subset */
    private planMode = false

    private registry: ToolRegistry
    private scheduler: Scheduler
    private bus: MessageBus
    private compressionService: ChatCompressionService
    private subscriptions: { unsubscribe: () => void }[] = []
    /** Last prompt token count from API response — used for compression decisions */
    private lastPromptTokens = 0
    constructor (
        private ai: IAIService,
        private collector: ContextCollector,
        private callbacks: AgentCallbacks,
        private signal: AbortSignal,
        private pathApprovals: PathApprovalTracker = new PathApprovalTracker(),
    ) {
        this.registry = createDefaultRegistry()
        this.bus = new MessageBus()
        this.scheduler = new Scheduler(this.registry, this.bus)
        this.compressionService = new ChatCompressionService(ai)

        // Wire MessageBus events to AIMiddleware callbacks
        this.wireMessageBus()
    }

    /**
     * Wire MessageBus events to the UI layer (AIMiddleware) callbacks.
     *
     * This bridges the decoupled tool system to the terminal UI:
     * - TOOL_CONFIRMATION_REQUEST → callbacks.onConfirmCommand → waitForApproval → TOOL_CONFIRMATION_RESPONSE
     * - ASK_USER_REQUEST → callbacks.onAskUser → waitForUserResponse → ASK_USER_RESPONSE
     */
    private wireMessageBus (): void {
        // Tool confirmation: scheduler sends structured details → UI shows prompt → user responds
        // Mirrors gemini-cli's confirmation bus wiring
        const confirmSub = this.bus.on<ToolConfirmationRequest>(
            MessageBusEvent.TOOL_CONFIRMATION_REQUEST,
            async (req) => {
                const { details } = req
                // Extract display description from structured details
                const description = details.type === 'exec' ? details.command
                    : details.type === 'path_access' ? details.resolvedPath
                    : details.filePath
                this.callbacks.onConfirmCommand(description, details.type)
                const outcome = await this.callbacks.waitForApproval()
                this.bus.emit<ToolConfirmationResponse>(
                    MessageBusEvent.TOOL_CONFIRMATION_RESPONSE,
                    {
                        callId: req.callId,
                        outcome,
                    },
                )
            },
        )

        // Ask user: tool requests → UI shows question → user responds
        const askSub = this.bus.on<AskUserRequest>(
            MessageBusEvent.ASK_USER_REQUEST,
            async (req) => {
                this.callbacks.onAskUser(req.question)
                const response = await this.callbacks.waitForUserResponse()
                this.bus.emit<AskUserResponse>(
                    MessageBusEvent.ASK_USER_RESPONSE,
                    {
                        requestId: req.requestId,
                        response,
                    },
                )
            },
        )

        this.subscriptions.push(confirmSub, askSub)
    }

    /**
     * Main loop — mirrors gemini-cli's submitQuery → processGeminiStreamEvents
     * → scheduleToolCalls → handleCompletedTools → submitQuery(continuation)
     *
     * Accepts pre-built messages (system + history + user query).
     * Returns only the messages produced during this run.
     */
    async run (messages: ChatMessage[]): Promise<AgentResult> {
        this.messages = messages
        const startIndex = messages.length
        let invalidStreamRetries = 0

        try {
            for (let turn = 0; turn < this.maxTurns; turn++) {
                if (this.signal.aborted) break

                // === Context window management — compression ===
                // Mirrors gemini-cli's ChatCompressionService trigger
                if (turn > 0 && this.messages.length > 10) {
                    const { messages: compressed, result } = await this.compressionService.compress(
                        this.messages, this.lastPromptTokens, this.signal,
                    )
                    if (result.status === CompressionStatus.COMPRESSED) {
                        this.messages = compressed
                        this.callbacks.onContent(
                            `\r\n(Context compressed: ${result.originalTokenEstimate.toLocaleString()} → ${result.newTokenEstimate.toLocaleString()} tokens)\r\n`,
                        )
                    }
                }

                // === processGeminiStreamEvents() ===
                const toolCallRequests: ToolCallRequest[] = []
                let assistantContent = ''
                let sawInvalidStream = false

                // Filter tools based on plan mode
                const availableTools = this.planMode
                    ? this.registry.getSchemasFiltered(PLAN_MODE_TOOL_NAMES)
                    : this.registry.getSchemas()

                const stream = this.ai.streamWithTools(
                    this.messages, availableTools, this.signal,
                )

                for await (const event of stream) {
                    if (this.signal.aborted) break

                    switch (event.type) {
                        case EventType.Content:
                            assistantContent += event.value
                            this.callbacks.onContent(event.value)
                            break

                        case EventType.Thought:
                            this.callbacks.onThinking(event.value)
                            break

                        case EventType.ToolCall:
                            toolCallRequests.push(event.value as ToolCallRequest)
                            break

                        case EventType.Usage: {
                            const u = event.value as TokensSummary
                            this.usage.promptTokens += u.promptTokens
                            this.usage.completionTokens += u.completionTokens
                            this.usage.cachedTokens += u.cachedTokens
                            this.usage.totalTokens += u.totalTokens
                            // Track last prompt tokens for compression decisions
                            this.lastPromptTokens = u.promptTokens
                            break
                        }

                        case EventType.Retry:
                            this.callbacks.onContent(
                                `\r\n(Retrying... attempt ${event.value.attempt + 1}/${event.value.maxAttempts})\r\n`,
                            )
                            break

                        case EventType.Error:
                            this.callbacks.onError(event.value)
                            return { messages: this.messages.slice(startIndex), usage: this.usage }

                        case EventType.InvalidStream:
                            sawInvalidStream = true
                            break

                        case EventType.Finished:
                            break
                    }
                }

                if (sawInvalidStream) {
                    if (invalidStreamRetries < 2) {
                        invalidStreamRetries++
                        this.messages.push({
                            role: 'user',
                            content: 'Please continue.',
                        })
                        this.callbacks.onContent('\r\n(Invalid stream received; requesting continuation...)\r\n')
                        continue
                    }
                    this.callbacks.onError('Model returned invalid stream repeatedly.')
                    return { messages: this.messages.slice(startIndex), usage: this.usage }
                }
                invalidStreamRetries = 0

                // Always save assistant response to message history for conversation continuity.
                // Without this, subsequent turns lose context (consecutive user messages, no assistant replies).
                if (toolCallRequests.length === 0) {

                    if (assistantContent) {
                        this.messages.push({
                            role: 'assistant',
                            content: assistantContent,
                        })
                    }
                    break
                }

                // === Loop detection ===
                if (this.loopDetector.recordTurn(toolCallRequests)) {
                    this.callbacks.onContent(
                        '\r\n(Loop detected — the same tool calls are repeating. Stopping to avoid wasting tokens.)\r\n',
                    )
                    break
                }

                // === Add assistant message with tool_calls to history ===
                this.messages.push({
                    role: 'assistant',
                    content: assistantContent || null,
                    tool_calls: toolCallRequests.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: tc.function,
                    })),
                })

                // === scheduleToolCalls() — delegate to Scheduler ===
                const context: ToolContext = {
                    cwd: this.collector.cwd || process.cwd(),
                    signal: this.signal,
                    collector: this.collector,
                    callbacks: this.callbacks,
                    bus: this.bus,
                    pathApprovals: this.pathApprovals,
                }

                const completedCalls = await this.scheduler.schedule(
                    toolCallRequests, context,
                )

                // === handleCompletedTools() — convert results to tool messages ===
                for (const call of completedCalls) {
                    let content: string
                    switch (call.status) {
                        case ToolCallStatus.Success:
                            content = call.result.llmContent
                            // Check for plan mode state changes
                            if (call.result.data?.planMode !== undefined) {
                                this.planMode = call.result.data.planMode as boolean
                            }
                            break
                        case ToolCallStatus.Error:
                            content = `Error: ${call.error}`
                            break
                        case ToolCallStatus.Cancelled:
                            content = `Cancelled: ${call.reason}`
                            break
                    }
                    this.messages.push({
                        role: 'tool',
                        content,
                        tool_call_id: call.callId,
                    })
                }

                // === Continuation: loop back to top ===
            }
        } catch (err: any) {
            if (err.name === 'AbortError' || this.signal.aborted) {
                this.callbacks.onContent('\r\n(aborted)\r\n')
            } else {
                this.callbacks.onError(err.message)
                return { messages: this.messages.slice(startIndex), usage: this.usage }
            }
        }

        this.callbacks.onDone()
        this.cleanup()
        return { messages: this.messages.slice(startIndex), usage: this.usage }
    }

    /** Clean up subscriptions and message bus */
    private cleanup (): void {
        for (const sub of this.subscriptions) {
            sub.unsubscribe()
        }
        this.subscriptions = []
        this.bus.destroy()
    }
}

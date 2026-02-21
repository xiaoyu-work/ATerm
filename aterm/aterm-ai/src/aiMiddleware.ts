/**
 * Terminal SessionMiddleware that intercepts `@ ` at command line start
 * and drives the AI agent loop.
 *
 * Replaces gemini-cli's React Ink UI layer with terminal ANSI output.
 * Confirmation flow mirrors gemini-cli's resolveConfirmation()
 * (packages/core/src/scheduler/confirmation.ts)
 */

import colors from 'ansi-colors'
import { ConfigService, PlatformService } from 'aterm-core'
import { SessionMiddleware } from 'aterm-terminal'
import { AIService, ChatMessage } from './ai.service'
import { ContextCollector } from './contextCollector'
import { AgentLoop } from './agentLoop'
import { TokensSummary } from './streamEvents'
import { ConfirmationOutcome } from './tools/types'
import { PathApprovalTracker } from './tools/pathApprovals'
import { MemoryTool } from './tools/definitions/memoryTool'
import { PromptProvider } from './promptProvider'
import { createDefaultRegistry } from './tools/definitions'

const enum State {
    /** Normal mode — all input goes to shell */
    NORMAL,
    /** Saw @ at line start, waiting for space or other char */
    PENDING,
    /** Collecting AI prompt text */
    CAPTURING,
    /** Agent running — AI streaming response */
    AGENT_STREAMING,
    /** Agent paused — waiting for user to approve a command */
    AGENT_CONFIRMING,
    /** Agent running — a shell command is executing */
    AGENT_EXECUTING,
    /** Agent paused — waiting for user free-text response (ask_user tool) */
    AGENT_ASKING,
}

const LARGE_PASTE_LINE_THRESHOLD = 5
const LARGE_PASTE_CHAR_THRESHOLD = 500
const PASTED_TEXT_PLACEHOLDER_REGEX = /\[Pasted Text: \d+ (?:lines|chars)(?: #\d+)?\]/g

export class AIMiddleware extends SessionMiddleware {
    private static readonly RESIZE_REPAINT_SUPPRESS_MS = 220
    private static readonly AI_OUTPUT_PROTECT_WINDOW_MS = 120000

    private state = State.NORMAL
    private promptBuffer = ''
    private atLineStart = true
    private abortController: AbortController | null = null
    private confirmResolve: ((outcome: ConfirmationOutcome) => void) | null = null
    private confirmType: 'exec' | 'edit' | 'path_access' | undefined = undefined
    private askResolve: ((response: string) => void) | null = null
    private askBuffer = ''
    private bannerShown = false
    private conversationHistory: ChatMessage[] = []
    private terminalCheckpoint = 0
    private suppressSessionOutputUntil = 0
    private lastAIDisplayOutputAt = 0
    /** Stores full pasted content keyed by placeholder ID */
    private pastedContent: Record<string, string> = {}
    /** Session-level accumulated token usage — maps to gemini-cli's ModelMetrics.tokens */
    private sessionUsage: TokensSummary = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }
    /** Session-level path approval tracker — persists across agent invocations */
    private pathApprovals = new PathApprovalTracker()
    private promptProvider = new PromptProvider()
    private promptToolNames = createDefaultRegistry().getAll().map(t => t.name)

    constructor (
        private ai: AIService,
        private collector: ContextCollector,
        private config: ConfigService,
        private platform: PlatformService,
    ) {
        super()
    }

    onTerminalResize (_columns: number, _rows: number): void {
        const now = Date.now()
        if (this.state !== State.NORMAL) {
            this.suppressSessionOutputUntil = Math.max(
                this.suppressSessionOutputUntil,
                now + AIMiddleware.RESIZE_REPAINT_SUPPRESS_MS,
            )
            return
        }
        if (now - this.lastAIDisplayOutputAt <= AIMiddleware.AI_OUTPUT_PROTECT_WINDOW_MS) {
            this.suppressSessionOutputUntil = Math.max(
                this.suppressSessionOutputUntil,
                now + AIMiddleware.RESIZE_REPAINT_SUPPRESS_MS,
            )
        }
    }

    feedFromSession (data: Buffer): void {
        try {
            if (!this.bannerShown) {
                this.bannerShown = true
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' + colors.cyan('  [AI Ready] ') + colors.gray('Type "@ " + prompt + Enter to chat with AI') + '\r\n',
                ))
            }
            // Any shell output means cursor is at a prompt/new line
            this.atLineStart = true
            if (Date.now() < this.suppressSessionOutputUntil) {
                return
            }
            this.outputToTerminal.next(data)
        } catch (e) {
            console.error('[aterm-ai] feedFromSession error:', e)
            this.outputToTerminal.next(data)
        }
    }

    feedFromTerminal (data: Buffer): void {
        // Multi-byte data (paste)
        if (data.length !== 1) {
            const text = data.toString('utf-8')
                .replace(/\x1b\[200~/g, '')
                .replace(/\x1b\[201~/g, '')

            if (this.state === State.CAPTURING) {
                if (text) {
                    const display = this.maybeCollapsePaste(text)
                    this.promptBuffer += display
                    this.outputToTerminal.next(Buffer.from(display))
                }
                return
            }
            if (this.state === State.AGENT_ASKING) {
                if (text) {
                    this.askBuffer += text
                    this.outputToTerminal.next(Buffer.from(text))
                }
                return
            }
            if (this.state === State.PENDING) {
                if (!text) {
                    return
                }

                // For multi-byte input (paste/IME), treat as AI prompt content directly.
                this.state = State.CAPTURING
                this.promptBuffer = ''
                this.outputToTerminal.next(Buffer.from(colors.cyan(' ')))
                const pastedPrompt = text.startsWith(' ') ? text.slice(1) : text
                if (pastedPrompt) {
                    const display = this.maybeCollapsePaste(pastedPrompt)
                    this.promptBuffer += display
                    this.outputToTerminal.next(Buffer.from(display))
                }
                return
            }
            if (this.state === State.NORMAL) {
                // Don't reset atLineStart for escape sequences — these are
                // terminal auto-responses (cursor position reports, focus
                // events, etc.) or cursor/function keys, not actual user text.
                if (data[0] !== 0x1b) {
                    this.atLineStart = false
                }
                // Heuristic block tracking for sessions without OSC 133
                this.collector.blockTracker?.pushInput(text)
                this.outputToSession.next(data)
            }
            // In agent states, swallow multi-byte input
            return
        }

        const byte = data[0]

        switch (this.state) {
            case State.NORMAL:
                if (byte === 0x40 /* @ */ && this.atLineStart) {
                    this.state = State.PENDING
                    this.outputToTerminal.next(Buffer.from(colors.cyan('@')))
                    return
                }
                this.atLineStart = (byte === 0x0D)
                // Heuristic block tracking for sessions without OSC 133
                this.collector.blockTracker?.pushInput(String.fromCharCode(byte))
                this.outputToSession.next(data)
                return

            case State.PENDING:
                if (byte === 0x16 /* Ctrl+V */) {
                    const pasted = this.platform.readClipboard()
                    if (pasted) {
                        this.state = State.CAPTURING
                        this.promptBuffer = ''
                        this.outputToTerminal.next(Buffer.from(colors.cyan(' ')))
                        const display = this.maybeCollapsePaste(pasted)
                        this.promptBuffer += display
                        this.outputToTerminal.next(Buffer.from(display))
                    }
                    return
                }
                if (byte === 0x20 /* space */) {
                    this.state = State.CAPTURING
                    this.promptBuffer = ''
                    this.outputToTerminal.next(Buffer.from(colors.cyan(' ')))
                    return
                }
                if (byte === 0x7F || byte === 0x08) {
                    // Backspace — erase the @ we echoed
                    this.outputToTerminal.next(Buffer.from('\b \b'))
                    this.state = State.NORMAL
                    this.atLineStart = true
                    return
                }
                // Not a space — flush @ + current char to shell
                this.outputToTerminal.next(Buffer.from('\b \b'))
                this.state = State.NORMAL
                this.atLineStart = false
                this.outputToSession.next(Buffer.from('@'))
                this.outputToSession.next(data)
                return

            case State.CAPTURING:
                if (byte === 0x16 /* Ctrl+V */) {
                    const pasted = this.platform.readClipboard()
                    if (pasted) {
                        const display = this.maybeCollapsePaste(pasted)
                        this.promptBuffer += display
                        this.outputToTerminal.next(Buffer.from(display))
                    }
                    return
                }
                if (byte === 0x0D /* Enter */) {
                    this.startAgent()
                    return
                }
                if (byte === 0x7F || byte === 0x08) {
                    if (this.promptBuffer.length > 0) {
                        this.promptBuffer = this.promptBuffer.slice(0, -1)
                        this.outputToTerminal.next(Buffer.from('\b \b'))
                    }
                    return
                }
                if (byte === 0x03 /* Ctrl+C */ || byte === 0x1B /* Escape */) {
                    this.outputToTerminal.next(Buffer.from('\r\n'))
                    this.state = State.NORMAL
                    this.atLineStart = true
                    this.promptBuffer = ''
                    this.outputToSession.next(Buffer.from('\r'))
                    return
                }
                // Regular character
                const char = String.fromCharCode(byte)
                this.promptBuffer += char
                this.outputToTerminal.next(Buffer.from(char))
                return

            case State.AGENT_CONFIRMING:
                if (byte === 0x0D /* Enter = approve once */) {
                    this.confirmResolve?.(ConfirmationOutcome.ProceedOnce)
                    this.confirmResolve = null
                    return
                }
                if ((byte === 0x79 || byte === 0x59) /* y/Y = always approve */ && this.confirmType === 'path_access') {
                    this.confirmResolve?.(ConfirmationOutcome.ProceedAlways)
                    this.confirmResolve = null
                    return
                }
                if (byte === 0x03 /* Ctrl+C = skip */) {
                    this.confirmResolve?.(ConfirmationOutcome.Cancel)
                    this.confirmResolve = null
                    return
                }
                return // Swallow all other input during confirmation

            case State.AGENT_ASKING:
                if (byte === 0x16 /* Ctrl+V */) {
                    const pasted = this.platform.readClipboard()
                    if (pasted) {
                        this.askBuffer += pasted
                        this.outputToTerminal.next(Buffer.from(pasted))
                    }
                    return
                }
                if (byte === 0x0D /* Enter = submit response */) {
                    this.outputToTerminal.next(Buffer.from('\r\n'))
                    this.askResolve?.(this.askBuffer)
                    this.askResolve = null
                    this.askBuffer = ''
                    this.state = State.AGENT_STREAMING
                    return
                }
                if (byte === 0x7F || byte === 0x08) {
                    if (this.askBuffer.length > 0) {
                        this.askBuffer = this.askBuffer.slice(0, -1)
                        this.outputToTerminal.next(Buffer.from('\b \b'))
                    }
                    return
                }
                if (byte === 0x03 /* Ctrl+C = cancel */) {
                    this.outputToTerminal.next(Buffer.from('\r\n'))
                    this.askResolve?.('')
                    this.askResolve = null
                    this.askBuffer = ''
                    this.state = State.AGENT_STREAMING
                    return
                }
                {
                    const ch = String.fromCharCode(byte)
                    this.askBuffer += ch
                    this.outputToTerminal.next(Buffer.from(ch))
                }
                return

            case State.AGENT_STREAMING:
            case State.AGENT_EXECUTING:
                if (byte === 0x03 /* Ctrl+C = abort entire agent */) {
                    this.abortController?.abort()
                    return
                }
                return // Swallow all other input during agent execution
        }
    }

    private async startAgent (): Promise<void> {
        let query = this.promptBuffer.trim()
        this.promptBuffer = ''

        // Expand paste placeholders back to full content before sending to AI
        if (Object.keys(this.pastedContent).length > 0) {
            query = query.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
                this.pastedContent[match] ?? match,
            )
            this.pastedContent = {}
        }

        if (!query) {
            this.state = State.NORMAL
            this.atLineStart = true
            this.outputToSession.next(Buffer.from('\r'))
            return
        }

        this.outputToTerminal.next(Buffer.from('\r\n'))
        this.markAIDisplayOutput()
        this.state = State.AGENT_STREAMING
        this.abortController = new AbortController()

        // Build user message with terminal activity since last turn
        const { text: terminalActivity, checkpoint } = this.collector.getOutputSince(this.terminalCheckpoint)
        this.terminalCheckpoint = checkpoint

        let userContent = query
        if (terminalActivity.trim()) {
            userContent = `[Terminal activity since last conversation]\n${terminalActivity.trim()}\n\n${query}`
        }

        // Build messages: fresh system prompt + conversation history + new user message
        const systemPrompt = await this.buildSystemPrompt()
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...this.conversationHistory,
            { role: 'user', content: userContent },
        ]

        const loop = new AgentLoop(this.ai, this.collector, {
            onContent: (text) => {
                this.state = State.AGENT_STREAMING
                const formatted = text.replace(/\n/g, '\r\n')
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(colors.green(formatted)))
            },

            onThinking: (text) => {
                const formatted = text.replace(/\n/g, '\r\n')
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(colors.gray(formatted)))
            },

            onConfirmCommand: (description, type) => {
                this.state = State.AGENT_CONFIRMING
                this.confirmType = type
                this.markAIDisplayOutput()

                const icon = type === 'path_access' ? '📂'
                    : type === 'exec' ? '⚡'
                    : '📝'
                const hint = type === 'path_access'
                    ? '[Enter=allow / y=always / Ctrl+C=skip]'
                    : '[Enter=run / Ctrl+C=skip]'

                this.outputToTerminal.next(Buffer.from(
                    '\r\n' +
                    colors.yellow(`  ${icon} ${description}`) +
                    colors.gray(`  ${hint}`),
                ))
            },

            waitForApproval: () => {
                return new Promise<ConfirmationOutcome>((resolve) => {
                    if (this.confirmResolve) {
                        this.confirmResolve(ConfirmationOutcome.Cancel)
                    }
                    this.confirmResolve = resolve
                })
            },

            onAskUser: (question) => {
                this.state = State.AGENT_ASKING
                this.askBuffer = ''
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' +
                    colors.cyan(`  ? ${question}`) +
                    '\r\n' +
                    colors.gray('  > '),
                ))
            },

            waitForUserResponse: () => {
                return new Promise<string>((resolve) => {
                    if (this.askResolve) {
                        this.askResolve('')
                    }
                    this.askResolve = resolve
                })
            },

            onCommandStart: () => {
                this.state = State.AGENT_EXECUTING
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from('\r\n'))
            },

            onCommandOutput: (chunk) => {
                const formatted = chunk.replace(/\n/g, '\r\n')
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(colors.dim(formatted)))
            },

            onCommandDone: () => {
                this.state = State.AGENT_STREAMING
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from('\r\n'))
            },

            onDone: () => {
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from('\r\n'))
                this.state = State.NORMAL
                this.atLineStart = true
                this.abortController = null
                // NOTE: Do NOT send \r to session here.
                // displayUsage() runs after loop.run() returns — sending \r here
                // triggers shell prompt rendering that races with usage output,
                // causing cursor position desync ("jumping" bug).
                // The \r is sent in startAgent() after all terminal output is done.
            },

            onError: (err) => {
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' + colors.red(`  Error: ${err}`) + '\r\n',
                ))
                this.state = State.NORMAL
                this.atLineStart = true
                this.abortController = null
                // Same as onDone — defer \r to after all terminal output.
            },
        }, this.abortController.signal, this.pathApprovals)

        try {
            const result = await loop.run(messages)

            // Update persistent conversation history
            this.conversationHistory.push({ role: 'user', content: userContent })
            this.conversationHistory.push(...result.messages)

            // Trim history to prevent unbounded growth
            if (this.conversationHistory.length > 80) {
                this.conversationHistory = this.conversationHistory.slice(-80)
            }

            // Display token usage — maps to gemini-cli's StatsDisplay.tsx
            this.displayUsage(result.usage)
        } catch (err) {
            // onError callback already printed the error to terminal;
            // if loop.run() itself throws, print it here as a fallback.
            // Use cast because TS narrows state to AGENT_STREAMING but callbacks mutate it.
            if ((this.state as State) !== State.NORMAL) {
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' + colors.red(`  Error: ${err}`) + '\r\n',
                ))
                this.state = State.NORMAL
                this.atLineStart = true
                this.abortController = null
            }
        } finally {
            // Always trigger shell prompt AFTER all terminal output is complete.
            // This avoids the cursor desync bug where the shell renders its prompt
            // (using absolute cursor positioning) while we're still writing output.
            this.outputToSession.next(Buffer.from('\r'))
        }
    }

    /**
     * Display token usage summary — simplified ANSI version of
     * gemini-cli's StatsDisplay.tsx ModelUsageTable
     */
    private displayUsage (usage: TokensSummary): void {
        if (usage.totalTokens <= 0) return

        // Accumulate session totals (maps to gemini-cli's processApiResponse accumulation)
        this.sessionUsage.promptTokens += usage.promptTokens
        this.sessionUsage.completionTokens += usage.completionTokens
        this.sessionUsage.cachedTokens += usage.cachedTokens
        this.sessionUsage.totalTokens += usage.totalTokens

        // Format: "Tokens: 1,234 input / 567 output / 1,801 total"
        const parts: string[] = []

        if (usage.cachedTokens > 0) {
            const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens)
            parts.push(`${uncached.toLocaleString()} input (${usage.cachedTokens.toLocaleString()} cached)`)
        } else {
            parts.push(`${usage.promptTokens.toLocaleString()} input`)
        }

        parts.push(`${usage.completionTokens.toLocaleString()} output`)
        parts.push(`${usage.totalTokens.toLocaleString()} total`)

        let line = `  Tokens: ${parts.join(' / ')}`

        // Show session totals if this is not the first invocation
        if (this.sessionUsage.totalTokens > usage.totalTokens) {
            line += colors.gray(`  (session: ${this.sessionUsage.totalTokens.toLocaleString()} total)`)
        }

        this.markAIDisplayOutput()
        this.outputToTerminal.next(Buffer.from(
            colors.gray(line) + '\r\n',
        ))

        // Persist to historical per-provider stats
        this.persistUsage(usage)
    }

    /**
     * Persist token usage to config for historical per-provider tracking.
     * Survives app restarts — stored in config.yaml.
     *
     * IMPORTANT: ConfigProxy only creates setter descriptors for keys that exist
     * in defaults. We must SET the entire stats object through the proxy setter
     * (not mutate an existing reference) to ensure it lands in the real store.
     */
    private persistUsage (usage: TokensSummary): void {
        const provider = this.config.store.ai?.provider || 'custom'
        const current = this.config.store.ai.tokenUsage?.[provider]

        // Build a new plain object — avoids proxy mutation issues
        const updated = {
            promptTokens: (current?.promptTokens || 0) + usage.promptTokens,
            completionTokens: (current?.completionTokens || 0) + usage.completionTokens,
            totalTokens: (current?.totalTokens || 0) + usage.totalTokens,
            requestCount: (current?.requestCount || 0) + 1,
        }

        // Assign through proxy setter so it reaches real storage
        this.config.store.ai.tokenUsage[provider] = updated
        this.config.save()
    }

    /**
     * Build system prompt — adapted from gemini-cli's modular prompt composition
     * (packages/core/src/prompts/snippets.ts)
     *
     * Sections: Preamble, Core Mandates, Primary Workflows, Operational Guidelines, Git
     */
    private markAIDisplayOutput (): void {
        this.lastAIDisplayOutputAt = Date.now()
    }

    /**
     * If pasted text exceeds threshold, collapse it into a placeholder
     * and store the full content for later expansion when submitting.
     */
    private maybeCollapsePaste (text: string): string {
        const lineCount = text.split('\n').length
        if (lineCount <= LARGE_PASTE_LINE_THRESHOLD && text.length <= LARGE_PASTE_CHAR_THRESHOLD) {
            return text
        }

        const base = lineCount > LARGE_PASTE_LINE_THRESHOLD
            ? `[Pasted Text: ${lineCount} lines]`
            : `[Pasted Text: ${text.length} chars]`

        // Deduplicate if same placeholder already exists
        let id = base
        let suffix = 2
        while (this.pastedContent[id]) {
            id = base.replace(']', ` #${suffix}]`)
            suffix++
        }

        this.pastedContent[id] = text
        return id
    }

    private async buildSystemPrompt (): Promise<string> {
        const maxBlocks = this.config.store.ai?.maxContextBlocks ?? 5
        const context = this.collector.toPromptString(maxBlocks)
        const cwd = this.collector.cwd || process.cwd()
        const memory = await MemoryTool.loadMemory(cwd)

        return this.promptProvider.getCoreSystemPrompt({
            cwd,
            context,
            memory: memory || '',
            interactive: true,
            interactiveShellEnabled: false,
            planMode: false,
            modelId: this.config.store.ai?.model || '',
            availableTools: this.promptToolNames,
        })
    }
}

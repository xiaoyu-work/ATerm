/**
 * Terminal SessionMiddleware that intercepts `@ ` at command line start
 * and drives the AI agent loop.
 *
 * Replaces gemini-cli's React Ink UI layer with terminal ANSI output.
 * Confirmation flow mirrors gemini-cli's resolveConfirmation()
 * (packages/core/src/scheduler/confirmation.ts)
 */

import colors from 'ansi-colors'
import { ConfigService, PlatformService } from 'tabby-core'
import { SessionMiddleware } from 'tabby-terminal'
import { AIService, ChatMessage } from './ai.service'
import { ContextCollector } from './contextCollector'
import { AgentLoop } from './agentLoop'
import { TokensSummary } from './streamEvents'
import { MemoryTool } from './tools/definitions/memoryTool'

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
    private confirmResolve: ((approved: boolean) => void) | null = null
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
            console.error('[tabby-ai] feedFromSession error:', e)
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
                this.atLineStart = false
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
                if (byte === 0x0D /* Enter = approve */) {
                    this.confirmResolve?.(true)
                    this.confirmResolve = null
                    return
                }
                if (byte === 0x03 /* Ctrl+C = skip this command */) {
                    this.confirmResolve?.(false)
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

            onConfirmCommand: (cmd) => {
                this.state = State.AGENT_CONFIRMING
                this.markAIDisplayOutput()
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' +
                    colors.yellow(`  ⚡ ${cmd}`) +
                    colors.gray('  [Enter=run / Ctrl+C=skip]'),
                ))
            },

            waitForApproval: () => {
                return new Promise<boolean>((resolve) => {
                    if (this.confirmResolve) {
                        this.confirmResolve(false)
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
        }, this.abortController.signal)

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
        const memorySection = memory
            ? `\n\n# Persistent Memory\nThe following content is loaded from .aterm/memory.md. These are saved facts and preferences from previous sessions.\n\n${memory}`
            : ''

        return `You are ATerm AI, an interactive CLI agent embedded in the ATerm terminal, specializing in software engineering tasks. Your primary goal is to help users safely and effectively.

# Core Mandates

## Security & System Integrity
- **Credential Protection:** Never log, print, or commit secrets, API keys, or sensitive credentials. Rigorously protect \`.env\` files, \`.git\`, and system configuration folders.
- **Source Control:** Do not stage or commit changes unless specifically requested by the user.

## Context Efficiency
- Always scope and limit your searches to avoid context window exhaustion and ensure high-signal results. Use \`include\` to target relevant files and strictly limit results using \`total_max_matches\` and \`max_matches_per_file\`, especially during the research phase.
- For broad discovery, use \`names_only=true\` or \`max_matches_per_file=1\` to identify files without retrieving their full content.
- When reading files, prefer targeted reads with offset/limit over reading entire large files.

## Engineering Standards
- **Conventions & Style:** Rigorously adhere to existing workspace conventions, architectural patterns, and style (naming, formatting, typing, commenting). During the research phase, analyze surrounding files, tests, and configuration to ensure your changes are seamless, idiomatic, and consistent with the local context. Never compromise idiomatic quality or completeness (e.g., proper declarations, type safety, documentation) to minimize tool calls; all supporting changes required by local conventions are part of a surgical update.
- **Libraries/Frameworks:** NEVER assume a library/framework is available. Verify its established usage within the project (check imports, configuration files like 'package.json', 'Cargo.toml', 'requirements.txt', etc.) before employing it.
- **Technical Integrity:** You are responsible for the entire lifecycle: implementation, testing, and validation. Within the scope of your changes, prioritize readability and long-term maintainability by consolidating logic into clean abstractions rather than threading state across unrelated layers. Align strictly with the requested architectural direction, ensuring the final implementation is focused and free of redundant "just-in-case" alternatives. Validation is not merely running tests; it is the exhaustive process of ensuring that every aspect of your change—behavioral, structural, and stylistic—is correct and fully compatible with the broader project. For bug fixes, you must empirically reproduce the failure with a new test case or reproduction script before applying the fix.
- **Expertise & Intent Alignment:** Provide proactive technical opinions grounded in research while strictly adhering to the user's intended workflow. Distinguish between **Directives** (unambiguous requests for action or implementation) and **Inquiries** (requests for analysis, advice, or observations). Assume all requests are Inquiries unless they contain an explicit instruction to perform a task. For Inquiries, your scope is strictly limited to research and analysis; you may propose a solution or strategy, but you MUST NOT modify files until a corresponding Directive is issued. Do not initiate implementation based on observations of bugs or statements of fact. Once an Inquiry is resolved, or while waiting for a Directive, stop and wait for the next user instruction. Only clarify if critically underspecified; otherwise, work autonomously.
- **Proactiveness:** When executing a Directive, persist through errors and obstacles by diagnosing failures in the execution phase and, if necessary, backtracking to the research or strategy phases to adjust your approach until a successful, verified outcome is achieved. Fulfill the user's request thoroughly, including adding tests when adding features or fixing bugs. Take reasonable liberties to fulfill broad goals while staying within the requested scope; however, prioritize simplicity and the removal of redundant logic over providing "just-in-case" alternatives that diverge from the established path.
- **Testing:** ALWAYS search for and update related tests after making a code change. You must add a new test case to the existing test file (if one exists) or create a new test file to verify your changes.
- **Explaining Changes:** After completing a code modification or file operation *do not* provide summaries unless asked.
- **Do Not Revert Changes:** Do not revert changes to the codebase unless asked to do so by the user. Only revert changes made by you if they have resulted in an error or if the user has explicitly asked you to revert the changes.
- **Do Not Take Unscoped Actions:** Do not take significant actions beyond the clear scope of the request without confirming with the user. If the user implies a change (e.g., reports a bug) without explicitly asking for a fix, ask for confirmation first. If asked *how* to do something, explain first, don't just do it.
- **Explain Before Acting:** Never call tools in silence. You MUST provide a concise, one-sentence explanation of your intent or strategy immediately before executing tool calls. This is essential for transparency, especially when confirming a request or answering a question. Silence is only acceptable for repetitive, low-level discovery operations (e.g., sequential file reads) where narration would be noisy.

# Primary Workflows

## Development Lifecycle
Operate using a **Research -> Strategy -> Execution** lifecycle. For the Execution phase, resolve each sub-task through an iterative **Plan -> Act -> Validate** cycle.

1. **Research:** Systematically map the codebase and validate assumptions. Use \`grep_search\` and \`glob\` tools extensively (in parallel if independent) to understand file structures, existing code patterns, and conventions. Use \`read_file\` to validate all assumptions. **Prioritize empirical reproduction of reported issues to confirm the failure state.** For complex tasks, consider using \`enter_plan_mode\` to explore safely before making changes.

2. **Strategy:** Formulate a grounded plan based on your research. For complex tasks, break them down into smaller, manageable subtasks and use the \`write_todos\` tool to track your progress. Share a concise summary of your strategy.

3. **Execution:** For each sub-task:
   - **Plan:** Define the specific implementation approach **and the testing strategy to verify the change.**
   - **Act:** Apply targeted, surgical changes strictly related to the sub-task. Use the available tools (e.g., \`replace\`, \`write_file\`, \`run_shell_command\`). Ensure changes are idiomatically complete and follow all workspace standards, even if it requires multiple tool calls. **Include necessary automated tests; a change is incomplete without verification logic.** Avoid unrelated refactoring or "cleanup" of outside code. Before making manual code changes, check if an ecosystem tool (like 'eslint --fix', 'prettier --write', 'go fmt', 'cargo fmt') is available in the project to perform the task automatically.
   - **Validate:** Run tests and workspace standards to confirm the success of the specific change and ensure no regressions were introduced. After making code changes, execute the project-specific build, linting and type-checking commands (e.g., 'tsc', 'npm run lint', 'ruff check .') that you have identified for this project.

**Validation is the only path to finality.** Never assume success or settle for unverified changes. Rigorous, exhaustive verification is mandatory; it prevents the compounding cost of diagnosing failures later. A task is only complete when the behavioral correctness of the change has been verified and its structural integrity is confirmed within the full project context. Prioritize comprehensive validation above all else. Never sacrifice validation rigor for the sake of brevity or to minimize tool-call overhead.

## New Applications
**Goal:** Autonomously implement and deliver a visually appealing, substantially complete, and functional prototype with rich aesthetics. Users judge applications by their visual impact; ensure they feel modern, "alive," and polished through consistent spacing, interactive feedback, and platform-appropriate design.

# Operational Guidelines

## Tone and Style
- **Role:** A senior software engineer and collaborative peer programmer.
- **High-Signal Output:** Focus exclusively on **intent** and **technical rationale**. Avoid conversational filler, apologies, and mechanical tool-use narration (e.g., "I will now call...").
- **Concise & Direct:** Adopt a professional, direct, and concise tone suitable for a CLI environment.
- **Minimal Output:** Aim for fewer than 3 lines of text output (excluding tool use/code generation) per response whenever practical.
- **No Chitchat:** Avoid conversational filler, preambles ("Okay, I will now..."), or postambles ("I have finished the changes...") unless they serve to explain intent as required by the 'Explain Before Acting' mandate.
- **No Repetition:** Once you have provided a final synthesis of your work, do not repeat yourself or provide additional summaries. For simple or direct requests, prioritize extreme brevity.
- **Formatting:** Use GitHub-flavored Markdown. Responses will be rendered in monospace.
- **Tools vs. Text:** Use tools for actions, text output *only* for communication. Do not add explanatory comments within tool calls.
- **Handling Inability:** If unable/unwilling to fulfill a request, state so briefly without excessive justification. Offer alternatives if appropriate.

## Security and Safety Rules
- **Explain Critical Commands:** Before executing commands with \`run_shell_command\` that modify the file system, codebase, or system state, you *must* provide a brief explanation of the command's purpose and potential impact. Prioritize user understanding and safety. You should not ask permission to use the tool; the user will be presented with a confirmation dialogue upon use.
- **Security First:** Always apply security best practices. Never introduce code that exposes, logs, or commits secrets, API keys, or other sensitive information.

## Tool Usage
- **Parallelism:** Execute multiple independent tool calls in parallel when feasible (e.g., searching the codebase with multiple grep/glob calls).
- **Command Execution:** Use the \`run_shell_command\` tool for running shell commands, remembering the safety rule to explain modifying commands first.
- **Memory Tool:** Use \`save_memory\` only for global user preferences, personal facts, or high-level information that applies across all sessions. Never save workspace-specific context, local file paths, or transient session state. Do not use memory to store summaries of code changes, bug fixes, or findings discovered during a task; this tool is for persistent user-related information only.
- **Confirmation Protocol:** If a tool call is declined or cancelled, respect the decision immediately. Do not re-attempt the action or "negotiate" for the same tool call unless the user explicitly directs you to. Offer an alternative technical path if possible.

## Git Repository
- The current working (project) directory is being managed by a git repository.
- **NEVER** stage or commit your changes, unless you are explicitly instructed to commit. For example:
  - "Commit the change" -> add changed files and commit.
  - "Wrap up this PR for me" -> do not commit.
- When asked to commit changes or prepare a commit, always start by gathering information using shell commands:
  - \`git status\` to ensure that all relevant files are tracked and staged, using \`git add ...\` as needed.
  - \`git diff HEAD\` to review all changes (including unstaged changes) to tracked files in work tree since last commit.
  - \`git log -n 3\` to review recent commit messages and match their style (verbosity, formatting, signature line, etc.)
- Combine shell commands whenever possible to save time/steps, e.g. \`git status && git diff HEAD && git log -n 3\`.
- Always propose a draft commit message. Never just ask the user to give you the full commit message.
- Prefer commit messages that are clear, concise, and focused more on "why" and less on "what".
- After each commit, confirm that it was successful by running \`git status\`.
- If a commit fails, never attempt to work around the issues without being asked to do so.
- Never push changes to a remote repository without being asked explicitly by the user.

# Final Reminder
Your core function is efficient and safe assistance. Balance extreme conciseness with the crucial need for clarity, especially regarding safety and potential system modifications. Always prioritize user control and project conventions. Never make assumptions about the contents of files; instead use \`read_file\` to ensure you aren't making broad assumptions. You are an agent — please keep going until the user's query is completely resolved.

# Terminal Context
${context}${memorySection}`
    }
}

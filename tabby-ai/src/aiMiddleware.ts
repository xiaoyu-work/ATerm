/**
 * Terminal SessionMiddleware that intercepts `@ ` at command line start
 * and drives the AI agent loop.
 *
 * Replaces gemini-cli's React Ink UI layer with terminal ANSI output.
 * Confirmation flow mirrors gemini-cli's resolveConfirmation()
 * (packages/core/src/scheduler/confirmation.ts)
 */

import colors from 'ansi-colors'
import { ConfigService } from 'tabby-core'
import { SessionMiddleware } from 'tabby-terminal'
import { AIService, ChatMessage } from './ai.service'
import { ContextCollector } from './contextCollector'
import { AgentLoop } from './agentLoop'
import { TokensSummary } from './streamEvents'

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
}

export class AIMiddleware extends SessionMiddleware {
    private state = State.NORMAL
    private promptBuffer = ''
    private atLineStart = true
    private abortController: AbortController | null = null
    private confirmResolve: ((approved: boolean) => void) | null = null
    private bannerShown = false
    private conversationHistory: ChatMessage[] = []
    private terminalCheckpoint = 0
    /** Session-level accumulated token usage — maps to gemini-cli's ModelMetrics.tokens */
    private sessionUsage: TokensSummary = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }

    constructor (
        private ai: AIService,
        private collector: ContextCollector,
        private config: ConfigService,
    ) {
        super()
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
            this.outputToTerminal.next(data)
        } catch (e) {
            console.error('[tabby-ai] feedFromSession error:', e)
            this.outputToTerminal.next(data)
        }
    }

    feedFromTerminal (data: Buffer): void {
        // Multi-byte data (paste)
        if (data.length !== 1) {
            if (this.state === State.CAPTURING) {
                const text = data.toString('utf-8')
                this.promptBuffer += text
                this.outputToTerminal.next(Buffer.from(colors.white(text)))
                return
            }
            if (this.state === State.NORMAL) {
                this.atLineStart = false
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
                this.outputToSession.next(data)
                return

            case State.PENDING:
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
                this.outputToTerminal.next(Buffer.from(colors.white(char)))
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
        const query = this.promptBuffer.trim()
        this.promptBuffer = ''

        if (!query) {
            this.state = State.NORMAL
            this.atLineStart = true
            this.outputToSession.next(Buffer.from('\r'))
            return
        }

        this.outputToTerminal.next(Buffer.from('\r\n'))
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
        const messages: ChatMessage[] = [
            { role: 'system', content: this.buildSystemPrompt() },
            ...this.conversationHistory,
            { role: 'user', content: userContent },
        ]

        // Trim if conversation is too long: keep system + last 80 messages
        if (messages.length > 90) {
            const system = messages.shift()!
            const recent = messages.slice(-80)
            messages.length = 0
            messages.push(system, ...recent)
        }

        const loop = new AgentLoop(this.ai, this.collector, {
            onContent: (text) => {
                this.state = State.AGENT_STREAMING
                const formatted = text.replace(/\n/g, '\r\n')
                this.outputToTerminal.next(Buffer.from(colors.green(formatted)))
            },

            onThinking: (text) => {
                const formatted = text.replace(/\n/g, '\r\n')
                this.outputToTerminal.next(Buffer.from(colors.gray(formatted)))
            },

            onConfirmCommand: (cmd) => {
                this.state = State.AGENT_CONFIRMING
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

            onCommandStart: () => {
                this.state = State.AGENT_EXECUTING
                this.outputToTerminal.next(Buffer.from('\r\n'))
            },

            onCommandOutput: (chunk) => {
                const formatted = chunk.replace(/\n/g, '\r\n')
                this.outputToTerminal.next(Buffer.from(colors.dim(formatted)))
            },

            onCommandDone: () => {
                this.state = State.AGENT_STREAMING
                this.outputToTerminal.next(Buffer.from('\r\n'))
            },

            onDone: () => {
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
    private buildSystemPrompt (): string {
        const context = this.collector.toPromptString()
        return `You are ATerm AI, an interactive CLI agent embedded in the ATerm terminal, specializing in software engineering tasks. Your primary goal is to help users safely and effectively.

# Core Mandates

## Security & System Integrity
- Never log, print, or commit secrets, API keys, or sensitive credentials. Protect .env files, .git, and system configuration folders.
- Do not stage or commit changes unless specifically requested by the user.

## Engineering Standards
- Rigorously adhere to existing workspace conventions, architectural patterns, and style (naming, formatting, typing).
- NEVER assume a library/framework is available. Verify its usage within the project before employing it.
- After making code changes, search for and update related tests.
- Explain what you are about to do before executing tool calls. Silence is only acceptable for repetitive low-level discovery operations.
- After completing a code modification, do not provide summaries unless asked.
- Do not revert changes unless asked or they caused an error.
- Do not take significant actions beyond the clear scope of the request without confirming with the user.

# Primary Workflows

## Development Lifecycle
Operate using a **Research -> Strategy -> Execution** lifecycle. For the Execution phase, resolve each sub-task through an iterative **Plan -> Act -> Validate** cycle.

1. **Research:** Systematically map the codebase and validate assumptions. Use grep_search and glob tools extensively (in parallel if independent) to understand file structures, existing code patterns, and conventions. Use read_file to validate all assumptions. Prioritize empirical reproduction of reported issues.
2. **Strategy:** Formulate a grounded plan based on your research. For complex tasks, break them down into smaller, manageable subtasks. Share a concise summary of your strategy.
3. **Execution:** For each sub-task:
   - **Plan:** Define the specific implementation approach and the testing strategy to verify the change.
   - **Act:** Apply targeted, surgical changes strictly related to the sub-task. Ensure changes are idiomatically complete and follow all workspace standards. Avoid unrelated refactoring or cleanup. Before making manual code changes, check if an ecosystem tool (like eslint --fix, prettier --write, go fmt, cargo fmt) is available.
   - **Validate:** Run tests and workspace standards to confirm the success of the change and ensure no regressions. Execute the project-specific build, linting and type-checking commands. A task is only complete when behavioral correctness has been verified.

Validation is the only path to finality. Never assume success or settle for unverified changes.

# Operational Guidelines

## Tone and Style
- Act as a senior software engineer and collaborative peer programmer.
- Be concise and direct. Aim for fewer than 3 lines of text output per response whenever practical.
- Avoid conversational filler, preambles, or postambles. No chitchat.
- Use GitHub-flavored Markdown for formatting.
- Use tools for actions, text output only for communication.
- If unable to fulfill a request, state so briefly. Offer alternatives if appropriate.

## Tool Usage
- Execute multiple independent tool calls in parallel when feasible (e.g., searching the codebase with multiple grep/glob calls).
- Use run_shell_command for shell commands. Explain modifying commands first.
- If a tool call is declined, respect the decision immediately. Do not re-attempt. Offer an alternative path if possible.

## Git Repository
- NEVER stage or commit changes unless explicitly instructed.
- When asked to commit, gather information first: git status, git diff HEAD, git log -n 3.
- Propose a draft commit message. Prefer clear, concise messages focused on "why".
- Never push to remote without being explicitly asked.

# Terminal Context
${context}`
    }
}

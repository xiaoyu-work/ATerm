/**
 * Terminal SessionMiddleware that intercepts `@ ` at command line start
 * and injects `__aterm_ai 'prompt'` into the shell.
 *
 * AI runs as a real shell command (aterm-ai-cli), so all output flows
 * through ConPTY naturally. No more xterm.js / ConPTY desync.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import colors from 'ansi-colors'
import { PlatformService } from 'aterm-core'
import { BlockTracker, SessionMiddleware } from 'aterm-terminal'

const enum State {
    /** Normal mode — all input goes to shell */
    NORMAL,
    /** Saw @ at line start, waiting for space or other char */
    PENDING,
    /** Collecting AI prompt text */
    CAPTURING,
}

const LARGE_PASTE_LINE_THRESHOLD = 1
const LARGE_PASTE_CHAR_THRESHOLD = 300
const PASTED_TEXT_PLACEHOLDER_REGEX = /\[Pasted Text: \d+ (?:lines|chars)(?: #\d+)?\]/g
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g
const MAX_CONTEXT_LINES = 100

export class AIMiddleware extends SessionMiddleware {
    private state = State.NORMAL
    private promptBuffer = ''
    /** Number of characters user has typed on the current shell line (0 = at line start) */
    private inputLength = 0
    /** Stores full pasted content keyed by placeholder ID */
    private pastedContent: Record<string, string> = {}
    /** Maps queryId → display text for filtering __aterm_ai from resize repaint */
    private queryMap = new Map<string, string>()
    /**
     * Echo suppression: after injecting __aterm_ai, buffer all session output
     * until the echo is complete, then discard it.
     */
    private suppressingEcho = false
    private echoBuffer = ''
    private echoTimeout: ReturnType<typeof setTimeout> | null = null
    /** True when a TUI app is using the alternate screen buffer (vim, claude, etc.) */
    private alternateScreenActive = false
    /** Rolling buffer of cleaned terminal output for AI context */
    private contextBuffer: string[] = []
    blockTracker: BlockTracker | null = null
    maxContextBlocks = 5
    /** True for SSH/Telnet/Serial sessions — AI runs locally instead of shell injection */
    isRemoteSession = false
    /** Config service reference for computing AI env vars (set by decorator for remote sessions) */
    configService: any = null
    /** Local AI CLI child process (active only during AI execution in remote sessions) */
    private localProcess: ChildProcess | null = null
    /** Session file path for conversation persistence across queries within one session */
    private sessionFile = ''

    constructor (
        private platform: PlatformService,
    ) {
        super()
    }

    seedContextFromOutput (data: Buffer): void {
        this.captureContext(data.toString('utf-8'))
    }

    // ───────────────────────── Helpers ─────────────────────────

    private captureContext (raw: string): void {
        const clean = raw.replace(ANSI_REGEX, '')
        const lines = clean.split(/\r?\n/)
        this.contextBuffer.push(...lines)
        if (this.contextBuffer.length > MAX_CONTEXT_LINES) {
            this.contextBuffer = this.contextBuffer.slice(-MAX_CONTEXT_LINES)
        }
    }

    private popLastInputChar (value: string): string {
        const chars = Array.from(value)
        chars.pop()
        return chars.join('')
    }

    private renderCapturingPrompt (): void {
        // Highlight paste placeholders (all multi-line pastes are collapsed to single-line placeholders)
        const display = this.promptBuffer.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
            colors.yellow(match),
        )
        this.outputToTerminal.next(Buffer.from(
            '\r\x1b[2K' + colors.cyan('@ ') + display,
        ))
    }

    private applyCapturingText (rawText: string): void {
        // Handle bracketed paste as a single block — don't let \r inside
        // the paste trigger submission.  The paste() method in the terminal
        // tab converts \r\n → \r, so pasted multi-line text is full of \r.
        const pasteMatch = rawText.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/)
        if (pasteMatch) {
            const pasted = pasteMatch[1]?.replace(/\r\n?/g, '\n')
            if (pasted) {
                const display = this.maybeCollapsePaste(pasted)
                this.promptBuffer += display
                this.renderCapturingPrompt()
            }
            // Process any text after the paste end marker (e.g. Enter key)
            const afterPaste = rawText.slice(rawText.indexOf('\x1b[201~') + 6)
            if (afterPaste) {
                this.applyCapturingText(afterPaste)
            }
            return
        }

        const text = rawText
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .replace(/\x1bO./g, '')

        if (!text) {
            return
        }

        let changed = false
        for (const char of Array.from(text)) {
            if (char === '\u0016') {
                const pasted = this.platform.readClipboard()
                if (pasted) {
                    const display = this.maybeCollapsePaste(pasted)
                    this.promptBuffer += display
                    changed = true
                }
                continue
            }
            if (char === '\r') {
                this.submitToShell()
                return
            }
            if (char === '\n') {
                continue
            }
            if (char === '\u007f' || char === '\b') {
                if (this.promptBuffer.length > 0) {
                    this.promptBuffer = this.popLastInputChar(this.promptBuffer)
                    changed = true
                } else {
                    // Buffer empty — exit AI mode, re-draw shell prompt
                    this.outputToTerminal.next(Buffer.from('\r\x1b[2K'))
                    this.state = State.NORMAL
                    this.inputLength = 0
                    this.outputToSession.next(Buffer.from('\r'))
                    return
                }
                continue
            }
            if (char === '\u0003' || char === '\u001b') {
                this.outputToTerminal.next(Buffer.from('\r\n'))
                this.state = State.NORMAL
                this.inputLength = 0
                this.promptBuffer = ''
                this.outputToSession.next(Buffer.from('\r'))
                return
            }
            this.promptBuffer += char
            changed = true
        }

        if (changed) {
            this.renderCapturingPrompt()
        }
    }

    // ───────────────────────── Echo suppression ─────────────────────────

    /**
     * Stop suppressing and flush any remaining buffered data that isn't echo.
     */
    private stopSuppressing (remainder?: string): void {
        this.suppressingEcho = false
        this.echoBuffer = ''
        if (this.echoTimeout) {
            clearTimeout(this.echoTimeout)
            this.echoTimeout = null
        }
        if (remainder && remainder.length > 0) {
            this.outputToTerminal.next(Buffer.from(remainder))
        }
    }

    /**
     * Process accumulated echo buffer: find and discard the __aterm_ai echo,
     * pass through anything that comes after it.
     */
    private processEchoBuffer (): void {
        // Strip ANSI sequences for detection purposes
        const plain = this.echoBuffer.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')

        // Look for __aterm_ai in the buffer
        const aiIdx = plain.indexOf('__aterm_ai')
        if (aiIdx === -1) {
            // Haven't seen echo yet — keep buffering
            return
        }

        // Look for a newline AFTER __aterm_ai (end of echo line)
        const afterAi = plain.indexOf('\n', aiIdx)
        if (afterAi === -1) {
            // Echo started but hasn't ended — keep buffering
            return
        }

        // Echo is complete. Find the corresponding position in the raw buffer.
        // Strategy: find the last \n in the raw buffer that's part of the echo.
        // Everything after that newline is real command output.
        let rawNewlineCount = 0
        const plainNewlineCount = plain.slice(0, afterAi + 1).split('\n').length - 1
        let cutPos = 0
        for (let i = 0; i < this.echoBuffer.length; i++) {
            if (this.echoBuffer[i] === '\n') {
                rawNewlineCount++
                if (rawNewlineCount >= plainNewlineCount) {
                    cutPos = i + 1
                    break
                }
            }
        }

        const remainder = this.echoBuffer.slice(cutPos)
        this.stopSuppressing(remainder)
    }

    // ───────────────────────── Shell injection ─────────────────────────

    /**
     * Write query to a temp file and inject `__aterm_ai --file <path>`.
     *
     * Using a temp file avoids all shell escaping issues — newlines, quotes,
     * special characters in pasted content are handled safely.
     */
    private submitToShell (): void {
        // For remote sessions, spawn CLI locally instead of injecting shell command
        if (this.isRemoteSession) {
            console.log('[aterm-ai] Remote session: spawning CLI locally')
            this.submitLocally()
            return
        }

        const rawPrompt = this.promptBuffer.trim()
        this.promptBuffer = ''

        if (!rawPrompt) {
            this.state = State.NORMAL
            this.inputLength = 0
            this.outputToSession.next(Buffer.from('\r'))
            return
        }

        // Expand paste placeholders to full content for the actual query
        let query = rawPrompt
        if (Object.keys(this.pastedContent).length > 0) {
            query = query.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
                this.pastedContent[match] ?? match,
            )
            this.pastedContent = {}
        }

        // Write query to temp file with short ID to keep the shell command short.
        // The shell function uses ATERM_AI_TMP env var to construct the full path.
        const queryId = Math.random().toString(36).slice(2, 8)
        const queryFile = path.join(os.tmpdir(), `aq-${queryId}.txt`)
        try {
            fs.writeFileSync(queryFile, query, 'utf-8')
        } catch (e) {
            this.outputToTerminal.next(Buffer.from(
                '\r\n' + colors.red(`  Error: Failed to write query file: ${e}`) + '\r\n',
            ))
            this.state = State.NORMAL
            this.inputLength = 0
            this.outputToSession.next(Buffer.from('\r'))
            return
        }

        // Write terminal context file for CLI process
        try {
            const contextFile = path.join(os.tmpdir(), `ac-${queryId}.json`)
            const contextData: any = {
                scrollback: this.contextBuffer.slice(-50).join('\n'),
            }
            if (this.blockTracker) {
                const blocks = this.blockTracker.getRecentBlocks(this.maxContextBlocks)
                contextData.blocks = blocks.map(b => ({
                    command: b.command,
                    output: b.output,
                    exitCode: b.exitCode,
                    cwd: b.cwd,
                }))
            }
            fs.writeFileSync(contextFile, JSON.stringify(contextData), 'utf-8')
        } catch {
            // Best effort — AI still works without context
        }

        // Show prompt with paste placeholders (single-line to stay cursor-compatible with ConPTY)
        const display = rawPrompt.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
            colors.yellow(match),
        )
        this.outputToTerminal.next(Buffer.from(
            '\r\x1b[2K' + colors.cyan('@ ') + display + '\r\n',
        ))

        // Start echo suppression before injecting the command
        this.suppressingEcho = true
        this.echoBuffer = ''

        if (this.echoTimeout) {
            clearTimeout(this.echoTimeout)
        }
        this.echoTimeout = setTimeout(() => {
            if (this.suppressingEcho) {
                this.stopSuppressing()
            }
        }, 2000)

        // Store mapping for output filtering (handles resize repaint)
        this.queryMap.set(queryId, rawPrompt)
        if (this.queryMap.size > 50) {
            const oldest = this.queryMap.keys().next().value
            if (oldest !== undefined) {
                this.queryMap.delete(oldest)
            }
        }

        // Inject short command. Leading space prevents history save
        // (Bash HISTCONTROL=ignorespace, Zsh HIST_IGNORE_SPACE, PowerShell AddToHistoryHandler).
        // The shell function will cursor-up to replace the echo line in ConPTY's buffer
        // with "@ query", ensuring the display survives terminal resize.
        this.outputToSession.next(Buffer.from(` __aterm_ai ${queryId}\r`))

        this.state = State.NORMAL
        this.inputLength = 0
    }

    // ───────────────────────── Session I/O ─────────────────────────

    feedFromSession (data: Buffer): void {
        // Detect alternate screen buffer switches (used by TUI apps like vim, claude, etc.)
        // Must check BEFORE any early returns so we always track the state.
        const raw = data.toString('utf-8')
        if (raw.includes('\x1b[?1049h')) {
            this.alternateScreenActive = true
        }
        if (raw.includes('\x1b[?1049l')) {
            this.alternateScreenActive = false
            this.inputLength = 0
        }

        // In alternate screen mode, pass through everything untouched.
        // TUI apps (claude, vim, htop, etc.) rely on precise cursor positioning
        // and rapid redraws that middleware processing would corrupt.
        if (this.alternateScreenActive) {
            this.outputToTerminal.next(data)
            return
        }

        // Echo suppression: buffer data and check for echo completion
        if (this.suppressingEcho) {
            this.echoBuffer += data.toString('utf-8')
            this.processEchoBuffer()
            return
        }

        // Reset input counter only when shell output contains a line break
        // (new prompt after command, Ctrl+C output, etc.)
        // Pure echo of keystrokes (no newlines) must NOT reset the counter,
        // otherwise a race between echo and user input breaks @ detection.
        if (raw.includes('\n') || raw.includes('\r')) {
            this.inputLength = 0
        }

        // Capture cleaned output for AI context
        this.captureContext(raw)

        // Filter __aterm_ai patterns from output (handles ConPTY resize repaint)
        if (this.queryMap.size > 0) {
            if (raw.includes('__aterm_ai')) {
                let modified = raw
                for (const [id, display] of this.queryMap) {
                    const pattern = `__aterm_ai ${id}`
                    if (modified.includes(pattern)) {
                        modified = modified.split(pattern).join(`@ ${display}`)
                    }
                }
                if (modified !== raw) {
                    this.outputToTerminal.next(Buffer.from(modified))
                    return
                }
            }
        }

        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
        // In alternate screen mode, pass all input directly to the session.
        // Don't intercept @ or track inputLength — the TUI app handles everything.
        if (this.alternateScreenActive) {
            this.outputToSession.next(data)
            return
        }

        // When local AI process is running (remote sessions), forward all input to it
        if (this.localProcess) {
            this.localProcess.stdin?.write(data)
            return
        }

        if (this.state === State.CAPTURING) {
            this.applyCapturingText(data.toString('utf-8'))
            return
        }

        // Multi-byte data (paste)
        if (data.length !== 1) {
            const text = data.toString('utf-8')
                .replace(/\x1b\[200~/g, '')
                .replace(/\x1b\[201~/g, '')

            if (this.state === State.PENDING) {
                const clean = text
                    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
                    .replace(/\x1bO./g, '')
                if (!clean) {
                    return
                }

                this.state = State.CAPTURING
                this.promptBuffer = ''
                const pastedPrompt = (clean.startsWith(' ') ? clean.slice(1) : clean).replace(/\r\n?/g, '\n')
                if (pastedPrompt) {
                    const display = this.maybeCollapsePaste(pastedPrompt)
                    this.promptBuffer += display
                }
                this.renderCapturingPrompt()
                return
            }
            if (this.state === State.NORMAL) {
                if (data[0] !== 0x1b) {
                    this.inputLength += text.length
                }
                this.outputToSession.next(data)
            }
            return
        }

        const byte = data[0]

        switch (this.state) {
            case State.NORMAL:
                if (byte === 0x40 /* @ */ && this.inputLength === 0) {
                    this.state = State.PENDING
                    this.outputToTerminal.next(Buffer.from(colors.cyan('@')))
                    return
                }
                if (byte === 0x0D) {
                    this.inputLength = 0
                } else if (byte === 0x7F || byte === 0x08) {
                    this.inputLength = Math.max(0, this.inputLength - 1)
                } else if (byte === 0x03) {
                    this.inputLength = 0
                } else if (byte === 0x15) {
                    this.inputLength = 0
                } else if (byte >= 0x20) {
                    this.inputLength++
                }
                this.outputToSession.next(data)
                return

            case State.PENDING:
                if (byte === 0x16 /* Ctrl+V */) {
                    const pasted = this.platform.readClipboard()
                    if (pasted) {
                        this.state = State.CAPTURING
                        this.promptBuffer = ''
                        const display = this.maybeCollapsePaste(pasted)
                        this.promptBuffer += display
                        this.renderCapturingPrompt()
                    }
                    return
                }
                if (byte === 0x20 /* space */) {
                    this.state = State.CAPTURING
                    this.promptBuffer = ''
                    this.renderCapturingPrompt()
                    return
                }
                if (byte === 0x7F || byte === 0x08) {
                    this.outputToTerminal.next(Buffer.from('\b \b'))
                    this.state = State.NORMAL
                    this.inputLength = 0
                    return
                }
                // Not a space — flush @ + current char to shell
                this.outputToTerminal.next(Buffer.from('\b \b'))
                this.state = State.NORMAL
                this.inputLength = 2
                this.outputToSession.next(Buffer.from('@'))
                this.outputToSession.next(data)
                return
        }
    }

    // ───────────────────────── Paste helpers ─────────────────────────

    private maybeCollapsePaste (text: string): string {
        const lineCount = text.split('\n').length
        if (lineCount <= LARGE_PASTE_LINE_THRESHOLD && text.length <= LARGE_PASTE_CHAR_THRESHOLD) {
            return text
        }

        const base = lineCount > LARGE_PASTE_LINE_THRESHOLD
            ? `[Pasted Text: ${lineCount} lines]`
            : `[Pasted Text: ${text.length} chars]`

        let id = base
        let suffix = 2
        while (this.pastedContent[id]) {
            id = base.replace(']', ` #${suffix}]`)
            suffix++
        }

        this.pastedContent[id] = text
        return id
    }

    // ───────────────────────── Remote session support ─────────────────────────

    /**
     * Build environment variables for the AI CLI process.
     * Mirrors the env var logic from aterm-local/src/session.ts.
     */
    private async buildAIEnv (): Promise<Record<string, string>> {
        const aiConfig = this.configService?.store?.ai
        if (!aiConfig) {
            return {}
        }

        const provider = aiConfig.provider || 'gemini'

        // Check if provider uses OAuth (same mapping as local session.ts)
        const oauthProviders: Record<string, string> = {
            copilot: 'copilot', codex: 'codex', claude: 'claude',
            'gemini-oauth': 'gemini-oauth', minimax: 'minimax',
        }
        const oauthId = aiConfig.oauthTokens ? (oauthProviders[provider] || '') : ''

        let oauthAccessToken = ''
        let copilotBaseUrl = ''
        if (oauthId) {
            const tokenData = aiConfig.oauthTokens?.[oauthId]
            if (tokenData?.accessToken) {
                if (oauthId === 'copilot' && tokenData.metadata?.githubToken) {
                    try {
                        const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
                            headers: { Accept: 'application/json', Authorization: `Bearer ${tokenData.metadata.githubToken}` },
                        })
                        if (res.ok) {
                            const json = await res.json()
                            oauthAccessToken = json.token || tokenData.accessToken
                            const epMatch = (json.token || '').match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)
                            if (epMatch?.[1]) {
                                const host = epMatch[1].trim().replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.')
                                copilotBaseUrl = `https://${host}`
                            }
                        } else {
                            oauthAccessToken = tokenData.accessToken
                        }
                    } catch {
                        oauthAccessToken = tokenData.accessToken
                    }
                } else {
                    oauthAccessToken = tokenData.accessToken
                }
            }
        }

        const isOAuth = !!oauthId
        const agentBackend = aiConfig.agentBackend || 'builtin'
        const cliEntryPoint = agentBackend === 'copilot-sdk'
            ? path.join(__dirname, 'copilotSdkMain.js')
            : path.join(__dirname, 'cli.js')

        if (!this.sessionFile) {
            this.sessionFile = path.join(os.tmpdir(),
                `aterm-ai-session-remote-${process.pid}-${Date.now()}.json`)
        }

        const env: Record<string, string> = {
            NODE_NO_WARNINGS: '1',
            ATERM_AI_PROVIDER: provider,
            ATERM_AI_BASE_URL: copilotBaseUrl || aiConfig.baseUrl || '',
            ATERM_AI_API_KEY: isOAuth ? '' : (aiConfig.apiKeys?.[provider] || aiConfig.apiKey || ''),
            ATERM_AI_OAUTH_TOKEN: oauthAccessToken,
            ATERM_AI_MODEL: aiConfig.model || '',
            ATERM_AI_DEPLOYMENT: aiConfig.deployment || '',
            ATERM_AI_API_VERSION: aiConfig.apiVersion || '',
            ATERM_AI_COLORS: JSON.stringify(aiConfig.colorTheme || {}),
            ATERM_AI_CLI_PATH: cliEntryPoint,
            ATERM_AI_SESSION_FILE: this.sessionFile,
            ATERM_AI_TMP: os.tmpdir(),
            ATERM_AI_AGENT_BACKEND: agentBackend,
        }

        if (agentBackend === 'copilot-sdk' && provider === 'copilot') {
            const copilotTokenData = aiConfig.oauthTokens?.copilot
            if (copilotTokenData?.metadata?.githubToken) {
                env['ATERM_AI_GITHUB_TOKEN'] = copilotTokenData.metadata.githubToken
            } else if (copilotTokenData?.accessToken) {
                env['ATERM_AI_GITHUB_TOKEN'] = copilotTokenData.accessToken
            }
        }

        return env
    }

    /**
     * Spawn the AI CLI process locally for remote sessions.
     * The CLI's stdout/stderr go to the terminal; terminal input
     * is forwarded to the CLI's stdin for interactive confirmations.
     */
    private async submitLocally (): Promise<void> {
        const rawPrompt = this.promptBuffer.trim()
        this.promptBuffer = ''

        if (!rawPrompt) {
            this.state = State.NORMAL
            this.inputLength = 0
            this.outputToTerminal.next(Buffer.from('\r\n'))
            return
        }

        // Expand paste placeholders
        let query = rawPrompt
        if (Object.keys(this.pastedContent).length > 0) {
            query = query.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
                this.pastedContent[match] ?? match,
            )
            this.pastedContent = {}
        }

        // Write query to temp file
        const queryId = Math.random().toString(36).slice(2, 8)
        const queryFile = path.join(os.tmpdir(), `aq-${queryId}.txt`)
        try {
            fs.writeFileSync(queryFile, query, 'utf-8')
        } catch (e) {
            this.outputToTerminal.next(Buffer.from(
                '\r\n' + colors.red(`  Error: Failed to write query file: ${e}`) + '\r\n',
            ))
            this.state = State.NORMAL
            this.inputLength = 0
            return
        }

        // Write context file
        try {
            const contextFile = path.join(os.tmpdir(), `ac-${queryId}.json`)
            const contextData: any = {
                scrollback: this.contextBuffer.slice(-50).join('\n'),
            }
            if (this.blockTracker) {
                const blocks = this.blockTracker.getRecentBlocks(this.maxContextBlocks)
                contextData.blocks = blocks.map(b => ({
                    command: b.command,
                    output: b.output,
                    exitCode: b.exitCode,
                    cwd: b.cwd,
                }))
            }
            fs.writeFileSync(contextFile, JSON.stringify(contextData), 'utf-8')
        } catch {
            // Best effort — AI still works without context
        }

        // Show prompt display
        const display = rawPrompt.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
            colors.yellow(match),
        )
        this.outputToTerminal.next(Buffer.from(
            '\r\x1b[2K' + colors.cyan('@ ') + display + '\r\n',
        ))

        // Build env vars (async — handles Copilot token exchange)
        let aiEnv: Record<string, string>
        try {
            aiEnv = await this.buildAIEnv()
        } catch (e) {
            this.outputToTerminal.next(Buffer.from(
                colors.red(`  Error building AI config: ${e}`) + '\r\n',
            ))
            this.state = State.NORMAL
            this.inputLength = 0
            return
        }

        const cliPath = aiEnv['ATERM_AI_CLI_PATH']
        if (!cliPath) {
            this.outputToTerminal.next(Buffer.from(
                colors.red('  Error: AI CLI path not configured.') + '\r\n',
            ))
            this.state = State.NORMAL
            this.inputLength = 0
            return
        }

        // Spawn the CLI process locally
        const child = spawn(process.execPath, [cliPath, '--file', queryFile], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...aiEnv },
        })

        this.localProcess = child

        child.stdout?.on('data', (data: Buffer) => {
            this.outputToTerminal.next(data)
        })

        child.stderr?.on('data', (data: Buffer) => {
            this.outputToTerminal.next(data)
        })

        child.on('close', () => {
            this.localProcess = null
            this.outputToTerminal.next(Buffer.from('\r\n'))
        })

        child.on('error', (err) => {
            this.localProcess = null
            this.outputToTerminal.next(Buffer.from(
                colors.red(`  AI process error: ${err.message}`) + '\r\n',
            ))
        })

        this.state = State.NORMAL
        this.inputLength = 0
    }

    close (): void {
        if (this.echoTimeout) {
            clearTimeout(this.echoTimeout)
            this.echoTimeout = null
        }
        if (this.localProcess) {
            try { this.localProcess.kill() } catch { /* ignore */ }
            this.localProcess = null
        }
        super.close()
    }
}

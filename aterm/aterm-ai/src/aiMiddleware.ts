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
import colors from 'ansi-colors'
import { PlatformService } from 'aterm-core'
import { SessionMiddleware } from 'aterm-terminal'

const enum State {
    /** Normal mode — all input goes to shell */
    NORMAL,
    /** Saw @ at line start, waiting for space or other char */
    PENDING,
    /** Collecting AI prompt text */
    CAPTURING,
}

const LARGE_PASTE_LINE_THRESHOLD = 5
const LARGE_PASTE_CHAR_THRESHOLD = 500
const PASTED_TEXT_PLACEHOLDER_REGEX = /\[Pasted Text: \d+ (?:lines|chars)(?: #\d+)?\]/g

export class AIMiddleware extends SessionMiddleware {
    private state = State.NORMAL
    private promptBuffer = ''
    /** Number of characters user has typed on the current shell line (0 = at line start) */
    private inputLength = 0
    private bannerShown = false
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

    constructor (
        private platform: PlatformService,
    ) {
        super()
    }

    // ───────────────────────── Helpers ─────────────────────────

    private popLastInputChar (value: string): string {
        const chars = Array.from(value)
        chars.pop()
        return chars.join('')
    }

    private renderCapturingPrompt (): void {
        // For multi-line content, show first line + line count
        const lines = this.promptBuffer.split('\n')
        let display = lines[0]
        if (lines.length > 1) {
            display += colors.gray(` (${lines.length} lines)`)
        }
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
        let query = this.promptBuffer.trim()
        this.promptBuffer = ''

        if (Object.keys(this.pastedContent).length > 0) {
            query = query.replace(PASTED_TEXT_PLACEHOLDER_REGEX, match =>
                this.pastedContent[match] ?? match,
            )
            this.pastedContent = {}
        }

        if (!query) {
            this.state = State.NORMAL
            this.inputLength = 0
            this.outputToSession.next(Buffer.from('\r'))
            return
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

        // Show "@ <first line preview>" as the visible command
        const firstLine = query.split('\n')[0]
        const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
        const lineCount = query.split('\n').length
        const displaySuffix = lineCount > 1 ? colors.gray(` (${lineCount} lines)`) : ''
        this.outputToTerminal.next(Buffer.from(
            '\r\x1b[2K' + colors.cyan('@ ') + preview + displaySuffix + '\r\n',
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
        this.queryMap.set(queryId, preview)
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
        if (!this.bannerShown) {
            this.bannerShown = true
            this.outputToTerminal.next(Buffer.from(
                '\r\n' + colors.cyan('  [AI Ready] ') + colors.gray('Type "@ " + prompt + Enter to chat with AI') + '\r\n',
            ))
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
        const str = data.toString('utf-8')
        if (str.includes('\n') || str.includes('\r')) {
            this.inputLength = 0
        }

        // Filter __aterm_ai patterns from output (handles ConPTY resize repaint)
        if (this.queryMap.size > 0) {
            if (str.includes('__aterm_ai')) {
                let modified = str
                for (const [id, display] of this.queryMap) {
                    const pattern = `__aterm_ai ${id}`
                    if (modified.includes(pattern)) {
                        modified = modified.split(pattern).join(`@ ${display}`)
                    }
                }
                if (modified !== str) {
                    this.outputToTerminal.next(Buffer.from(modified))
                    return
                }
            }
        }

        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
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

    close (): void {
        if (this.echoTimeout) {
            clearTimeout(this.echoTimeout)
            this.echoTimeout = null
        }
        super.close()
    }
}

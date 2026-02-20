import { Subject, Observable } from 'rxjs'

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g

export interface TerminalBlock {
    id: number
    command: string
    output: string
    exitCode: number | null
    cwd: string
    startTime: number
    endTime: number | null
}

const enum TrackerState {
    /** Waiting for prompt */
    IDLE,
    /** Inside prompt (after OSC 133;A) */
    PROMPT,
    /** User typing command (after OSC 133;B) */
    INPUT,
    /** Command executing, collecting output (after OSC 133;C) */
    EXECUTING,
}

/**
 * Tracks terminal command blocks using OSC 133 shell integration signals.
 *
 * State machine: IDLE → PROMPT → INPUT → EXECUTING → IDLE
 *
 * Falls back to heuristic input tracking when OSC 133 is unavailable:
 * pushInput() on Enter creates a block, pushOutput() appends to it.
 */
export class BlockTracker {
    private _blocks: TerminalBlock[] = []
    private state = TrackerState.IDLE
    private nextId = 1
    private currentCommand = ''
    private currentOutput = ''
    private currentStartTime = 0
    private currentCwd = ''
    private shellIntegrationActive = false
    private inputBuffer = ''

    private blockCompleted_ = new Subject<TerminalBlock>()
    get blockCompleted$ (): Observable<TerminalBlock> { return this.blockCompleted_ }

    get hasShellIntegration (): boolean { return this.shellIntegrationActive }

    get blocks (): readonly TerminalBlock[] { return this._blocks }

    // ── OSC 133 event handlers ──────────────────────────────────

    /** OSC 133;A — prompt rendering started */
    onPromptStart (): void {
        this.shellIntegrationActive = true
        if (this.state === TrackerState.EXECUTING) {
            this.finalizeBlock(null)
        }
        this.state = TrackerState.PROMPT
    }

    /** OSC 133;B — prompt finished, waiting for user input */
    onCommandInputStart (): void {
        this.shellIntegrationActive = true
        this.state = TrackerState.INPUT
        this.currentCommand = ''
        this.currentOutput = ''
        this.currentStartTime = Date.now()
    }

    /** OSC 133;C — user pressed Enter, command execution begins */
    onCommandExecuted (): void {
        this.shellIntegrationActive = true
        this.state = TrackerState.EXECUTING
        this.currentOutput = ''
        this.currentStartTime = this.currentStartTime || Date.now()
    }

    /** OSC 133;D — command finished with exit code */
    onCommandFinished (exitCode: number): void {
        this.shellIntegrationActive = true
        if (this.state === TrackerState.EXECUTING) {
            this.finalizeBlock(exitCode)
        }
        this.state = TrackerState.IDLE
    }

    // ── Data feed ───────────────────────────────────────────────

    /** Feed cleaned output text — accumulates during EXECUTING and INPUT states */
    pushOutput (data: string): void {
        const clean = data.replace(ANSI_REGEX, '')
        if (this.state === TrackerState.EXECUTING) {
            this.currentOutput += clean
        } else if (this.state === TrackerState.INPUT) {
            // Between 133;B and 133;C, session output is the echoed command
            this.currentCommand += clean
        }
    }

    /**
     * Heuristic fallback for sessions without OSC 133 (SSH, Telnet).
     * Tracks typed characters; on Enter, starts a new block.
     */
    pushInput (data: string): void {
        if (this.shellIntegrationActive) return

        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                const cmd = this.inputBuffer.trim()
                if (cmd) {
                    if (this.state === TrackerState.EXECUTING) {
                        this.finalizeBlock(null)
                    }
                    this.currentCommand = cmd
                    this.currentOutput = ''
                    this.currentStartTime = Date.now()
                    this.state = TrackerState.EXECUTING
                }
                this.inputBuffer = ''
            } else if (ch === '\x7f' || ch === '\b') {
                this.inputBuffer = this.inputBuffer.slice(0, -1)
            } else if (ch.charCodeAt(0) >= 0x20) {
                this.inputBuffer += ch
            }
        }
    }

    setCwd (cwd: string): void {
        this.currentCwd = cwd
    }

    // ── Query ───────────────────────────────────────────────────

    getRecentBlocks (n = 10): TerminalBlock[] {
        return this._blocks.slice(-n)
    }

    getLastBlock (): TerminalBlock | null {
        return this._blocks.length > 0 ? this._blocks[this._blocks.length - 1] : null
    }

    getBlock (id: number): TerminalBlock | null {
        return this._blocks.find(b => b.id === id) ?? null
    }

    close (): void {
        if (this.state === TrackerState.EXECUTING) {
            this.finalizeBlock(null)
        }
        this.blockCompleted_.complete()
    }

    // ── Internal ────────────────────────────────────────────────

    private finalizeBlock (exitCode: number | null): void {
        const command = this.currentCommand.replace(/[\r\n]+$/, '').trim()
        if (!command && !this.currentOutput.trim()) return

        const block: TerminalBlock = {
            id: this.nextId++,
            command,
            output: this.currentOutput.replace(/[\r\n]+$/, ''),
            exitCode,
            cwd: this.currentCwd,
            startTime: this.currentStartTime,
            endTime: Date.now(),
        }

        this._blocks.push(block)
        if (this._blocks.length > 50) {
            this._blocks = this._blocks.slice(-50)
        }

        this.blockCompleted_.next(block)

        this.currentCommand = ''
        this.currentOutput = ''
    }
}

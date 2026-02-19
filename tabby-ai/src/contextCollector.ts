/**
 * Captures terminal output and state for AI context injection.
 *
 * Each terminal tab gets its own ContextCollector instance.
 * The decorator feeds PTY output into it, and when the AI is
 * triggered, we produce a snapshot of what the user is seeing.
 *
 * When a BlockTracker is attached (via shell integration), context
 * is structured as discrete command blocks instead of raw scrollback.
 */

import { BlockTracker, TerminalBlock } from 'tabby-terminal'

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g

export class ContextCollector {
    private buffer: string[] = []
    private _cwd = ''
    private readonly maxLines: number
    private totalLinesPushed = 0
    private _blockTracker: BlockTracker | null = null

    constructor (maxLines = 100) {
        this.maxLines = maxLines
    }

    /**
     * Feed raw PTY output — strips ANSI, splits into lines, keeps last N.
     */
    pushOutput (data: Buffer): void {
        const clean = data.toString('utf-8').replace(ANSI_REGEX, '')
        const lines = clean.split(/\r?\n/)
        this.totalLinesPushed += lines.length
        this.buffer.push(...lines)
        if (this.buffer.length > this.maxLines) {
            this.buffer = this.buffer.slice(-this.maxLines)
        }
    }

    /**
     * Get terminal output added since the given checkpoint.
     * Returns the text and a new checkpoint value.
     */
    getOutputSince (checkpoint: number): { text: string; checkpoint: number } {
        const newLines = this.totalLinesPushed - checkpoint
        if (newLines <= 0) {
            return { text: '', checkpoint: this.totalLinesPushed }
        }
        const available = Math.min(newLines, this.buffer.length)
        const lines = this.buffer.slice(-available)
        return {
            text: lines.join('\n'),
            checkpoint: this.totalLinesPushed,
        }
    }

    set cwd (value: string) {
        this._cwd = value
    }

    get cwd (): string {
        return this._cwd
    }

    get blockTracker (): BlockTracker | null {
        return this._blockTracker
    }

    setBlockTracker (tracker: BlockTracker): void {
        this._blockTracker = tracker
    }

    /**
     * Format recent blocks as structured context for AI.
     * Returns full command + full output for each block — no truncation.
     */
    formatBlocks (n = 5): string {
        if (!this._blockTracker) return ''
        const blocks = this._blockTracker.getRecentBlocks(n)
        if (blocks.length === 0) return ''

        return blocks.map((b, i) => this.formatSingleBlock(b, i + 1)).join('\n\n')
    }

    private formatSingleBlock (b: TerminalBlock, index: number): string {
        const parts: string[] = []
        const header = b.exitCode !== null
            ? `[Block ${index}] [exit: ${b.exitCode}]`
            : `[Block ${index}]`

        if (b.command) {
            parts.push(`${header} $ ${b.command}`)
        } else {
            parts.push(header)
        }
        if (b.cwd) {
            parts.push(`[cwd: ${b.cwd}]`)
        }
        if (b.output) {
            parts.push(b.output)
        }
        return parts.join('\n')
    }

    /**
     * Build a context snapshot for the AI prompt.
     */
    snapshot (): { cwd: string; scrollback: string; shell: string } {
        return {
            cwd: this._cwd,
            scrollback: this.buffer.slice(-50).join('\n'),
            shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
        }
    }

    /**
     * Format context as a string for the AI system prompt.
     * Uses structured blocks when available, falls back to raw scrollback.
     */
    toPromptString (maxBlocks = 5): string {
        const ctx = this.snapshot()
        const parts: string[] = [
            '<terminal_context>',
            `cwd: ${ctx.cwd}`,
            `shell: ${ctx.shell}`,
        ]

        const blockContext = this.formatBlocks(maxBlocks)
        if (blockContext) {
            parts.push('', 'Recent commands (structured blocks):', blockContext)
        } else if (ctx.scrollback) {
            parts.push('', 'Recent terminal output:', ctx.scrollback)
        }

        parts.push('</terminal_context>')
        return parts.join('\n')
    }
}

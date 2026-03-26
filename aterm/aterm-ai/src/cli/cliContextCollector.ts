/**
 * ContextCollector for CLI usage.
 * Reads terminal context (scrollback + command blocks) from a JSON file
 * written by AIMiddleware before the CLI process was spawned.
 */

export interface CLIContextBlock {
    command: string
    output: string
    exitCode: number | null
    cwd: string
}

export interface CLIContextData {
    scrollback?: string
    blocks?: CLIContextBlock[]
}

export class CLIContextCollector {
    cwd: string
    blockTracker = null
    private scrollback: string
    private blocks: CLIContextBlock[]

    constructor (cwd: string, context?: CLIContextData) {
        this.cwd = cwd
        this.scrollback = context?.scrollback ?? ''
        this.blocks = context?.blocks ?? []
    }

    pushOutput (): void { /* no-op in CLI mode */ }

    getOutputSince (_checkpoint: number): { text: string; checkpoint: number } {
        return { text: '', checkpoint: 0 }
    }

    setBlockTracker (): void { /* no-op in CLI mode */ }

    snapshot (): { cwd: string; scrollback: string; shell: string } {
        return {
            cwd: this.cwd,
            scrollback: this.scrollback,
            shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
        }
    }

    toPromptString (): string {
        const ctx = this.snapshot()
        const parts: string[] = [
            '<terminal_context>',
            `cwd: ${ctx.cwd}`,
            `shell: ${ctx.shell}`,
        ]

        const blockContext = this.formatBlocks()
        if (blockContext) {
            parts.push('', 'Recent commands (structured blocks):', blockContext)
        }
        if (ctx.scrollback) {
            parts.push('', 'Recent terminal output:', ctx.scrollback)
        }

        parts.push('</terminal_context>')
        return parts.join('\n')
    }

    formatBlocks (): string {
        if (this.blocks.length === 0) return ''

        return this.blocks.map((b, i) => {
            const parts: string[] = []
            const header = b.exitCode !== null
                ? `[Block ${i + 1}] [exit: ${b.exitCode}]`
                : `[Block ${i + 1}]`

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
        }).join('\n\n')
    }
}

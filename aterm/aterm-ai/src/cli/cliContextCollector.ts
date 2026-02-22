/**
 * Minimal ContextCollector for CLI usage.
 * The CLI doesn't have access to the terminal's xterm.js buffer,
 * so it provides a simplified implementation with just the cwd.
 */

export class CLIContextCollector {
    cwd: string
    blockTracker = null

    constructor (cwd: string) {
        this.cwd = cwd
    }

    pushOutput (): void { /* no-op in CLI mode */ }

    getOutputSince (_checkpoint: number): { text: string; checkpoint: number } {
        return { text: '', checkpoint: 0 }
    }

    setBlockTracker (): void { /* no-op in CLI mode */ }

    snapshot (): { cwd: string; scrollback: string; shell: string } {
        return {
            cwd: this.cwd,
            scrollback: '',
            shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
        }
    }

    toPromptString (): string {
        const ctx = this.snapshot()
        return [
            '<terminal_context>',
            `cwd: ${ctx.cwd}`,
            `shell: ${ctx.shell}`,
            '</terminal_context>',
        ].join('\n')
    }

    formatBlocks (): string {
        return ''
    }
}

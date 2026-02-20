/**
 * Shell command execution tool.
 *
 * Mirrors gemini-cli's ShellTool + ShellToolInvocation
 * (packages/core/src/tools/definitions/shell.ts)
 *
 * Logic extracted from AgentLoop.executeShellCommand().
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { executeCommand } from '../../shellExecutor'

export interface ShellToolParams {
    command: string
}

class ShellToolInvocation extends BaseToolInvocation<ShellToolParams> {
    constructor (params: ShellToolParams) {
        super(params, ToolKind.Execute)
    }

    getDescription (): string {
        return `Run: ${this.params.command}`
    }

    /**
     * Mirrors gemini-cli's ShellToolInvocation.getConfirmationDetails()
     * (packages/core/src/tools/shell.ts)
     */
    getConfirmationDetails (_context: ToolContext): ConfirmationDetails | false {
        return { type: 'exec', title: 'Run command', command: this.params.command }
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        context.callbacks.onCommandStart(this.params.command)

        const result = await executeCommand(
            this.params.command,
            context.cwd,
            context.signal,
            (chunk) => context.callbacks.onCommandOutput(chunk),
        )

        context.callbacks.onCommandDone(result)

        const output = (result.stdout + result.stderr).trim()
        if (result.timedOut) {
            return this.success(`Command timed out after 30s.\nPartial output:\n${output}`)
        }
        if (result.exitCode !== 0) {
            return this.success(`Command exited with code ${result.exitCode}\n${output}`)
        }
        return this.success(output || '(no output)')
    }
}

export class ShellTool extends DeclarativeTool<ShellToolParams> {
    readonly name = 'run_shell_command'
    readonly displayName = 'Shell Command'
    readonly description = 'Executes a shell command and returns its output. The following information is returned: Output: Combined stdout/stderr. Can be `(empty)` or partial on error. Exit Code: Only included if non-zero (command failed). Always prefer non-interactive commands (e.g., using \'run once\' or \'CI\' flags for test runners to avoid persistent watch modes or \'git --no-pager\').'
    readonly kind = ToolKind.Execute
    readonly parameters = {
        command: {
            type: 'string',
            description: 'The exact shell command to execute.',
        },
        description: {
            type: 'string',
            description: 'Brief description of the command for the user. Be specific and concise. Ideally a single sentence.',
        },
    }
    readonly required = ['command']

    protected createInvocation (params: ShellToolParams, _context: ToolContext): ShellToolInvocation {
        return new ShellToolInvocation(params)
    }
}

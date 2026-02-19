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
import { ToolKind, ToolContext, ToolResult } from '../types'
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
    readonly description = 'Execute a shell command and return its output. Use this for any system operations, checking status, installing packages, running builds, etc.'
    readonly kind = ToolKind.Execute
    readonly parameters = {
        command: {
            type: 'string',
            description: 'The shell command to execute',
        },
    }
    readonly required = ['command']

    protected createInvocation (params: ShellToolParams, _context: ToolContext): ShellToolInvocation {
        return new ShellToolInvocation(params)
    }
}

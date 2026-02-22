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
import { validatePath } from '../security'
import { classifyCommand, CommandRisk } from '../commandClassifier'

export interface ShellToolParams {
    command: string
    description?: string
    dir_path?: string
    is_background?: boolean
}

class ShellToolInvocation extends BaseToolInvocation<ShellToolParams> {
    constructor (params: ShellToolParams) {
        super(params, ToolKind.Execute)
    }

    getDescription (): string {
        let description = `${this.params.command}`
        if (this.params.dir_path) {
            description += ` [in ${this.params.dir_path}]`
        } else {
            description += ` [current working directory ${process.cwd()}]`
        }
        if (this.params.description) {
            description += ` (${this.params.description.replace(/\n/g, ' ')})`
        }
        if (this.params.is_background) {
            description += ' [background]'
        }
        return description
    }

    /**
     * Mirrors gemini-cli's ShellToolInvocation.getConfirmationDetails()
     * (packages/core/src/tools/shell.ts)
     */
    getConfirmationDetails (_context: ToolContext): ConfirmationDetails | false {
        if (this.params.dir_path) {
            const validation = validatePath(this.params.dir_path, _context.cwd)
            if ('error' in validation) return false
            if (validation.outsideCwd) {
                return {
                    type: 'path_access',
                    title: 'Run command outside CWD',
                    resolvedPath: validation.resolved,
                }
            }
        }
        // Safe commands (read-only) skip confirmation
        const risk = classifyCommand(this.params.command)
        if (risk === CommandRisk.Safe) {
            return false
        }

        return { type: 'exec', title: 'Confirm Shell Command', command: this.params.command }
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        let cwd = context.cwd
        if (this.params.dir_path) {
            const validation = validatePath(this.params.dir_path, context.cwd)
            if ('error' in validation) {
                return this.error(validation.error)
            }
            if (validation.outsideCwd && !context.pathApprovals.isAllowed()) {
                return this.error(`Path outside CWD requires approval: ${validation.resolved}`)
            }
            cwd = validation.resolved
        }

        context.callbacks.onCommandStart(this.params.command)

        const result = await executeCommand(
            this.params.command,
            cwd,
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
        if (this.params.is_background) {
            return this.success('Background mode requested. This host executed the command in foreground and captured the output.\n' + (output || '(no output)'))
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
        dir_path: {
            type: 'string',
            description: 'Optional: Directory to run the command in. Relative paths are resolved against the current working directory.',
        },
        is_background: {
            type: 'boolean',
            description: 'Optional: Whether to run the command in background mode.',
        },
    }
    readonly required = ['command']

    protected createInvocation (params: ShellToolParams, _context: ToolContext): ShellToolInvocation {
        return new ShellToolInvocation(params)
    }
}

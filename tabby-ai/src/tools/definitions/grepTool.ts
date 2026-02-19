/**
 * Grep search tool.
 *
 * Mirrors gemini-cli's GrepTool
 * (packages/core/src/tools/definitions/grep.ts)
 *
 * Logic extracted from AgentLoop.grepSearch().
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { isPathOutsideCwd } from '../security'
import { executeCommand } from '../../shellExecutor'

export interface GrepToolParams {
    pattern: string
    dir_path?: string
    include?: string
}

class GrepToolInvocation extends BaseToolInvocation<GrepToolParams> {
    constructor (params: GrepToolParams) {
        super(params, ToolKind.Search)
    }

    getDescription (): string {
        return `Grep: ${this.params.pattern}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const searchDir = this.params.dir_path
            ? path.resolve(context.cwd, this.params.dir_path)
            : context.cwd

        if (isPathOutsideCwd(searchDir, context.cwd)) {
            return this.error(`Access denied – "${this.params.dir_path}" resolves to a path outside the working directory.`)
        }

        try {
            const isGit = await fs.access(path.join(context.cwd, '.git')).then(() => true).catch(() => false)
            const maxMatches = 100

            let command: string
            if (isGit) {
                const includeArg = this.params.include ? ` -- "${this.params.include}"` : ''
                command = `git grep --untracked -n -E --ignore-case -m ${maxMatches} "${this.params.pattern.replace(/"/g, '\\"')}"${includeArg}`
            } else {
                const includeArg = this.params.include ? ` --include="${this.params.include}"` : ''
                command = `grep -r -n -H -E -i${includeArg} "${this.params.pattern.replace(/"/g, '\\"')}" . | head -${maxMatches}`
            }

            const result = await executeCommand(command, searchDir, context.signal, undefined, 10000)
            const output = result.stdout.trim()

            if (!output) {
                return this.success(`No matches found for pattern: ${this.params.pattern}`)
            }

            return this.success(output)
        } catch (err: any) {
            return this.error(`Searching: ${err.message}`)
        }
    }
}

export class GrepTool extends DeclarativeTool<GrepToolParams> {
    readonly name = 'grep_search'
    readonly displayName = 'Grep Search'
    readonly description = 'Searches for a regular expression pattern within file contents. Returns matching lines with file paths and line numbers. Max 100 matches.'
    readonly kind = ToolKind.Search
    readonly parameters = {
        pattern: {
            type: 'string',
            description: 'The regular expression pattern to search for within file contents',
        },
        dir_path: {
            type: 'string',
            description: 'Optional: The directory to search within (absolute or relative to CWD). Defaults to CWD.',
        },
        include: {
            type: 'string',
            description: 'Optional: A glob pattern to filter which files are searched (e.g., "*.js", "*.{ts,tsx}")',
        },
    }
    readonly required = ['pattern']

    protected createInvocation (params: GrepToolParams, _context: ToolContext): GrepToolInvocation {
        return new GrepToolInvocation(params)
    }
}

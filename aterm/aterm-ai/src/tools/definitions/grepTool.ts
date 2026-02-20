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
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { isPathOutsideCwd } from '../security'
import { executeCommand } from '../../shellExecutor'

export interface GrepToolParams {
    pattern: string
    dir_path?: string
    include?: string
    exclude_pattern?: string
    names_only?: boolean
    max_matches_per_file?: number
    total_max_matches?: number
}

class GrepToolInvocation extends BaseToolInvocation<GrepToolParams> {
    constructor (params: GrepToolParams) {
        super(params, ToolKind.Search)
    }

    getDescription (): string {
        return `Grep: ${this.params.pattern}`
    }

    getConfirmationDetails (context: ToolContext): ConfirmationDetails | false {
        const searchDir = this.params.dir_path
            ? path.resolve(context.cwd, this.params.dir_path)
            : context.cwd
        if (isPathOutsideCwd(searchDir, context.cwd)) {
            return { type: 'path_access', title: 'Search outside CWD', resolvedPath: searchDir }
        }
        return false
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const searchDir = this.params.dir_path
            ? path.resolve(context.cwd, this.params.dir_path)
            : context.cwd
        // outsideCwd check removed — handled by scheduler before execute()

        try {
            const isGit = await fs.access(path.join(context.cwd, '.git')).then(() => true).catch(() => false)
            const totalMax = this.params.total_max_matches || 100
            const perFileMax = this.params.max_matches_per_file

            let command: string
            if (isGit) {
                const includeArg = this.params.include ? ` -- "${this.params.include}"` : ''
                const perFileArg = perFileMax ? ` -m ${perFileMax}` : ''
                const namesArg = this.params.names_only ? ' -l' : ' -n'
                command = `git grep --untracked${namesArg} -E --ignore-case${perFileArg} "${this.params.pattern.replace(/"/g, '\\"')}"${includeArg} | head -${totalMax}`
            } else {
                const includeArg = this.params.include ? ` --include="${this.params.include}"` : ''
                const perFileArg = perFileMax ? ` -m ${perFileMax}` : ''
                const namesArg = this.params.names_only ? ' -l' : ' -n -H'
                command = `grep -r -E -i${namesArg}${perFileArg}${includeArg} "${this.params.pattern.replace(/"/g, '\\"')}" . | head -${totalMax}`
            }

            const result = await executeCommand(command, searchDir, context.signal, undefined, 10000)
            let output = result.stdout.trim()

            // Apply exclude_pattern filter
            if (output && this.params.exclude_pattern) {
                const excludeRe = new RegExp(this.params.exclude_pattern, 'i')
                output = output.split('\n').filter(line => !excludeRe.test(line)).join('\n')
            }

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
    readonly description = 'Searches for a regular expression pattern within file contents. Returns matching lines with file paths and line numbers. Use `include` to target relevant files and `total_max_matches`/`max_matches_per_file` to limit results and preserve context window. For broad discovery, use `names_only=true` to identify files without retrieving line content.'
    readonly kind = ToolKind.Search
    readonly parameters = {
        pattern: {
            type: 'string',
            description: 'The regular expression (regex) pattern to search for within file contents (e.g., \'function\\s+myFunction\', \'import\\s+\\{.*\\}\\s+from\\s+.*\').',
        },
        dir_path: {
            type: 'string',
            description: 'The absolute path to the directory to search within. If omitted, searches the current working directory.',
        },
        include: {
            type: 'string',
            description: 'A glob pattern to filter which files are searched (e.g., \'*.js\', \'*.{ts,tsx}\', \'src/**\'). If omitted, searches all files.',
        },
        exclude_pattern: {
            type: 'string',
            description: 'A regular expression pattern to exclude from the search results.',
        },
        names_only: {
            type: 'boolean',
            description: 'If true, only the file paths of matches will be returned, without line content or line numbers. Useful for gathering a list of files.',
        },
        max_matches_per_file: {
            type: 'integer',
            description: 'Maximum number of matches to return per file. Use this to prevent being overwhelmed by repetitive matches in large files.',
            minimum: 1,
        },
        total_max_matches: {
            type: 'integer',
            description: 'Maximum number of total matches to return. Use this to limit the overall size of the response. Defaults to 100.',
            minimum: 1,
        },
    }
    readonly required = ['pattern']

    protected createInvocation (params: GrepToolParams, _context: ToolContext): GrepToolInvocation {
        return new GrepToolInvocation(params)
    }
}

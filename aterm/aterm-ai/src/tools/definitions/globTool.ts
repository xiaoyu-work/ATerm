/**
 * Glob search tool.
 *
 * Mirrors gemini-cli's GlobTool
 * (packages/core/src/tools/definitions/glob.ts)
 *
 * Logic extracted from AgentLoop.globSearch().
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { isPathOutsideCwd } from '../security'
import { executeCommand } from '../../shellExecutor'

export interface GlobToolParams {
    pattern: string
    dir_path?: string
}

class GlobToolInvocation extends BaseToolInvocation<GlobToolParams> {
    constructor (params: GlobToolParams) {
        super(params, ToolKind.Search)
    }

    getDescription (): string {
        return `Glob: ${this.params.pattern}`
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

        const MAX_RESULTS = 200

        try {
            // Use git ls-files for .gitignore respect, fall back to find/dir
            const isGit = await fs.access(path.join(context.cwd, '.git')).then(() => true).catch(() => false)

            let command: string
            if (isGit) {
                command = `git ls-files --cached --others --exclude-standard "${this.params.pattern}"`
            } else if (process.platform === 'win32') {
                // PowerShell-compatible: Get-ChildItem instead of dir/find
                const escapedPattern = this.params.pattern.replace(/'/g, "''")
                command = `Get-ChildItem -Recurse -Name -Filter '${escapedPattern}' -ErrorAction SilentlyContinue`
            } else {
                command = `find . -name "${this.params.pattern}" -not -path "./.git/*"`
            }

            const result = await executeCommand(command, searchDir, context.signal)
            let output = result.stdout.trim()

            if (!output) {
                return this.success(`No files found matching pattern: ${this.params.pattern}`)
            }

            // Truncate to MAX_RESULTS lines (cross-platform, replaces `| head`)
            const lines = output.split('\n')
            if (lines.length > MAX_RESULTS) {
                output = lines.slice(0, MAX_RESULTS).join('\n')
            }

            return this.success(output)
        } catch (err: any) {
            return this.error(`Searching files: ${err.message}`)
        }
    }
}

export class GlobTool extends DeclarativeTool<GlobToolParams> {
    readonly name = 'glob'
    readonly displayName = 'Glob'
    readonly description = 'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases.'
    readonly kind = ToolKind.Search
    readonly parameters = {
        pattern: {
            type: 'string',
            description: 'The glob pattern to match against (e.g., \'**/*.py\', \'docs/*.md\').',
        },
        dir_path: {
            type: 'string',
            description: 'The absolute path to the directory to search within. If omitted, searches the root directory.',
        },
    }
    readonly required = ['pattern']

    protected createInvocation (params: GlobToolParams, _context: ToolContext): GlobToolInvocation {
        return new GlobToolInvocation(params)
    }
}

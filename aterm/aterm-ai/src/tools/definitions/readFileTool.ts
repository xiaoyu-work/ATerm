/**
 * Read file tool.
 *
 * Mirrors gemini-cli's ReadFileTool + ReadFileToolInvocation
 * (packages/core/src/tools/definitions/read-file.ts)
 *
 * Logic extracted from AgentLoop.readFile().
 */

import * as fs from 'fs/promises'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { validatePath } from '../security'

export interface ReadFileToolParams {
    file_path: string
    offset?: number
    limit?: number
}

class ReadFileToolInvocation extends BaseToolInvocation<ReadFileToolParams> {
    constructor (params: ReadFileToolParams) {
        super(params, ToolKind.Read)
    }

    getDescription (): string {
        return `Read file: ${this.params.file_path}`
    }

    /**
     * Mirrors gemini-cli's path validation in ReadFileToolInvocation.
     * Returns path_access details if file is outside CWD.
     */
    getConfirmationDetails (context: ToolContext): ConfirmationDetails | false {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) return false // Will error in execute()
        if (validation.outsideCwd) {
            return { type: 'path_access', title: 'Read outside CWD', resolvedPath: validation.resolved }
        }
        return false
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) {
            return this.error(validation.error)
        }
        // outsideCwd check removed — handled by scheduler before execute()

        try {
            const content = await fs.readFile(validation.resolved, 'utf-8')
            const lines = content.split('\n')
            const totalLines = lines.length

            // Apply offset/limit (1-based offset)
            const startLine = Math.max(1, this.params.offset || 1)
            const maxLines = this.params.limit || 2000
            const selectedLines = lines.slice(startLine - 1, startLine - 1 + maxLines)

            // Format with line numbers (like gemini-cli's read_file)
            const numbered = selectedLines.map((line, i) =>
                `${String(startLine + i).padStart(6)} | ${line}`,
            ).join('\n')

            let result = numbered
            if (startLine + selectedLines.length - 1 < totalLines) {
                result += `\n\n... (${totalLines} total lines, showing ${startLine}-${startLine + selectedLines.length - 1})`
            }

            return this.success(result)
        } catch (err: any) {
            return this.error(`Reading file: ${err.message}`)
        }
    }
}

export class ReadFileTool extends DeclarativeTool<ReadFileToolParams> {
    readonly name = 'read_file'
    readonly displayName = 'Read File'
    readonly description = 'Reads and returns the content of a specified file with line numbers. If the file is large, the content will be truncated. The tool\'s response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the \'offset\' and \'limit\' parameters. For text files, it can read specific line ranges for efficient context management.'
    readonly kind = ToolKind.Read
    readonly parameters = {
        file_path: {
            type: 'string',
            description: 'The path to the file to read.',
        },
        offset: {
            type: 'integer',
            description: 'The 1-based line number to start reading from. Requires \'limit\' to be set. Use for paginating through large files.',
        },
        limit: {
            type: 'integer',
            description: 'Maximum number of lines to read. Use with \'offset\' to paginate through large files. If omitted, reads the entire file (up to 2000 lines).',
        },
    }
    readonly required = ['file_path']

    protected createInvocation (params: ReadFileToolParams, _context: ToolContext): ReadFileToolInvocation {
        return new ReadFileToolInvocation(params)
    }
}

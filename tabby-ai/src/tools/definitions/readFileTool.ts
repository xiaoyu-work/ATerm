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
import { ToolKind, ToolContext, ToolResult } from '../types'
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

    async execute (context: ToolContext): Promise<ToolResult> {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) {
            return this.error(validation.error)
        }

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
    readonly description = 'Read the contents of a file at the specified path. Returns the file content with line numbers. For large files, use offset and limit to read specific sections.'
    readonly kind = ToolKind.Read
    readonly parameters = {
        file_path: {
            type: 'string',
            description: 'The path to the file to read (absolute or relative to CWD)',
        },
        offset: {
            type: 'integer',
            description: 'Optional: The line number to start reading from (1-based). Defaults to 1.',
        },
        limit: {
            type: 'integer',
            description: 'Optional: The number of lines to read. Defaults to reading the entire file (up to 2000 lines).',
        },
    }
    readonly required = ['file_path']

    protected createInvocation (params: ReadFileToolParams, _context: ToolContext): ReadFileToolInvocation {
        return new ReadFileToolInvocation(params)
    }
}

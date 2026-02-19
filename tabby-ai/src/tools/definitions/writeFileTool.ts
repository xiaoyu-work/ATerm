/**
 * Write file tool.
 *
 * Mirrors gemini-cli's WriteFileTool + WriteFileToolInvocation
 * (packages/core/src/tools/definitions/write-file.ts)
 *
 * Logic extracted from AgentLoop.writeFile().
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { validatePath } from '../security'

export interface WriteFileToolParams {
    file_path: string
    content: string
}

class WriteFileToolInvocation extends BaseToolInvocation<WriteFileToolParams> {
    constructor (params: WriteFileToolParams) {
        super(params, ToolKind.Edit)
    }

    getDescription (): string {
        return `Write file: ${this.params.file_path}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) {
            return this.error(validation.error)
        }

        try {
            // Create parent directories if needed (mirrors gemini-cli's mkdirp)
            await fs.mkdir(path.dirname(validation.resolved), { recursive: true })
            await fs.writeFile(validation.resolved, this.params.content, 'utf-8')
            const lineCount = this.params.content.split('\n').length
            return this.success(`Successfully wrote ${lineCount} lines to ${this.params.file_path}`)
        } catch (err: any) {
            return this.error(`Writing file: ${err.message}`)
        }
    }
}

export class WriteFileTool extends DeclarativeTool<WriteFileToolParams> {
    readonly name = 'write_file'
    readonly displayName = 'Write File'
    readonly description = 'Writes content to a specified file. Creates the file and parent directories if they do not exist. Overwrites existing content.'
    readonly kind = ToolKind.Edit
    readonly parameters = {
        file_path: {
            type: 'string',
            description: 'The path to the file to write to (absolute or relative to CWD)',
        },
        content: {
            type: 'string',
            description: 'The content to write to the file',
        },
    }
    readonly required = ['file_path', 'content']

    protected createInvocation (params: WriteFileToolParams, _context: ToolContext): WriteFileToolInvocation {
        return new WriteFileToolInvocation(params)
    }
}

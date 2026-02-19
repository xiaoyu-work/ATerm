/**
 * List directory tool.
 *
 * Mirrors gemini-cli's LSTool
 * (packages/core/src/tools/definitions/ls.ts)
 *
 * Logic extracted from AgentLoop.listDirectory().
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { isPathOutsideCwd } from '../security'

export interface ListDirectoryToolParams {
    dir_path: string
}

class ListDirectoryToolInvocation extends BaseToolInvocation<ListDirectoryToolParams> {
    constructor (params: ListDirectoryToolParams) {
        super(params, ToolKind.Read)
    }

    getDescription (): string {
        return `List: ${this.params.dir_path}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const resolved = path.resolve(context.cwd, this.params.dir_path)

        if (isPathOutsideCwd(resolved, context.cwd)) {
            return this.error(`Access denied – "${this.params.dir_path}" resolves to a path outside the working directory.`)
        }

        try {
            const entries = await fs.readdir(resolved, { withFileTypes: true })

            // Sort: directories first, then alphabetically
            entries.sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) {
                    return a.isDirectory() ? -1 : 1
                }
                return a.name.localeCompare(b.name)
            })

            const lines = entries.map(e =>
                e.isDirectory() ? `${e.name}/` : e.name,
            )

            if (lines.length === 0) {
                return this.success(`(empty directory: ${this.params.dir_path})`)
            }

            return this.success(lines.join('\n'))
        } catch (err: any) {
            return this.error(`Listing directory: ${err.message}`)
        }
    }
}

export class ListDirectoryTool extends DeclarativeTool<ListDirectoryToolParams> {
    readonly name = 'list_directory'
    readonly displayName = 'List Directory'
    readonly description = 'Lists the names of files and subdirectories directly within a specified directory path.'
    readonly kind = ToolKind.Read
    readonly parameters = {
        dir_path: {
            type: 'string',
            description: 'The path to the directory to list (absolute or relative to CWD)',
        },
    }
    readonly required = ['dir_path']

    protected createInvocation (params: ListDirectoryToolParams, _context: ToolContext): ListDirectoryToolInvocation {
        return new ListDirectoryToolInvocation(params)
    }
}

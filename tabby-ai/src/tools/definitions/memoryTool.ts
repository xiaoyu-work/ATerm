/**
 * Memory tool — saves persistent context to .aterm/memory.md.
 *
 * Mirrors gemini-cli's MemoryTool (save_memory)
 * (packages/core/src/tools/definitions/memory.ts)
 *
 * Appends timestamped entries to a project-local memory file.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'

export interface MemoryToolParams {
    content: string
}

class MemoryToolInvocation extends BaseToolInvocation<MemoryToolParams> {
    constructor (params: MemoryToolParams) {
        super(params, ToolKind.Other)
    }

    getDescription (): string {
        return 'Save to memory'
    }

    /** Memory tool does not require confirmation */
    override shouldConfirmExecute (): boolean {
        return false
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const memDir = path.join(context.cwd, '.aterm')
        const memFile = path.join(memDir, 'memory.md')

        try {
            await fs.mkdir(memDir, { recursive: true })
            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
            const entry = `\n## ${timestamp}\n${this.params.content}\n`
            await fs.appendFile(memFile, entry, 'utf-8')
            return this.success('Saved to memory (.aterm/memory.md)')
        } catch (err: any) {
            return this.error(`Saving memory: ${err.message}`)
        }
    }
}

export class MemoryTool extends DeclarativeTool<MemoryToolParams> {
    readonly name = 'save_memory'
    readonly displayName = 'Save Memory'
    readonly description = 'Save important context, decisions, or notes to persistent memory (.aterm/memory.md). This survives across sessions. Use this to remember project conventions, user preferences, architectural decisions, or anything that should persist.'
    readonly kind = ToolKind.Other
    readonly parameters = {
        content: {
            type: 'string',
            description: 'The content to save to memory. Will be appended to existing memory.',
        },
    }
    readonly required = ['content']

    protected createInvocation (params: MemoryToolParams, _context: ToolContext): MemoryToolInvocation {
        return new MemoryToolInvocation(params)
    }

    /**
     * Load saved memory from .aterm/memory.md (if it exists).
     * Called externally to inject into system prompt.
     */
    static async loadMemory (cwd: string): Promise<string> {
        const memFile = path.join(cwd, '.aterm', 'memory.md')
        try {
            const content = await fs.readFile(memFile, 'utf-8')
            return content.trim()
        } catch {
            return ''
        }
    }
}

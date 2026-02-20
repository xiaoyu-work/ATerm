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
    readonly description = `Saves concise global user context (preferences, facts) for use across ALL sessions.

**CRITICAL: GLOBAL CONTEXT ONLY**
NEVER save workspace-specific context, local paths, or commands (e.g. "The entry point is src/index.js", "The test command is npm test"). These are local to the current workspace and must NOT be saved globally. EXCLUSIVELY for context relevant across ALL sessions.

- Use for "Remember X" or clear personal facts.
- Do NOT use for session context.`
    readonly kind = ToolKind.Other
    readonly parameters = {
        content: {
            type: 'string',
            description: 'The specific fact or piece of information to remember. Should be a clear, self-contained statement.',
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

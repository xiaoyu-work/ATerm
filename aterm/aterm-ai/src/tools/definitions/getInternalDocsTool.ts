/**
 * Internal docs tool.
 *
 * Provides a stable gemini-cli-compatible tool name.
 */

import * as fs from 'fs/promises'
import type { Dirent } from 'fs'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'

export interface GetInternalDocsToolParams {
    path?: string
}

async function listFilesRecursive (root: string, base = root): Promise<string[]> {
    const out: string[] = []
    let entries: Dirent[]
    try {
        entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
        return out
    }
    for (const entry of entries) {
        const abs = path.join(root, entry.name)
        if (entry.isDirectory()) {
            out.push(...await listFilesRecursive(abs, base))
        } else if (entry.isFile()) {
            out.push(path.relative(base, abs).replace(/\\/g, '/'))
        }
    }
    return out
}

class GetInternalDocsToolInvocation extends BaseToolInvocation<GetInternalDocsToolParams> {
    constructor (params: GetInternalDocsToolParams) {
        super(params, ToolKind.Read)
    }

    getDescription (): string {
        return this.params.path ? `Read internal docs: ${this.params.path}` : 'List internal docs'
    }

    getConfirmationDetails (): false {
        return false
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const docsRoot = path.resolve(context.cwd, '.aterm', 'internal-docs')
        if (!this.params.path) {
            const files = await listFilesRecursive(docsRoot)
            if (files.length === 0) {
                return this.success('No internal documentation found. Expected docs under .aterm/internal-docs/')
            }
            return this.success(files.join('\n'))
        }

        const requested = this.params.path.replace(/\\/g, '/')
        const resolved = path.resolve(docsRoot, requested)
        if (!resolved.startsWith(docsRoot)) {
            return this.error('Invalid docs path.')
        }

        try {
            const content = await fs.readFile(resolved, 'utf-8')
            return this.success(content)
        } catch (err: any) {
            return this.error(`Failed to read docs: ${err.message}`)
        }
    }
}

export class GetInternalDocsTool extends DeclarativeTool<GetInternalDocsToolParams> {
    readonly name = 'get_internal_docs'
    readonly displayName = 'Get Internal Docs'
    readonly description = 'Returns internal documentation content. If no path is provided, returns available documentation paths.'
    readonly kind = ToolKind.Read
    readonly parameters = {
        path: {
            type: 'string',
            description: 'Relative path to an internal documentation file. If omitted, lists available docs.',
        },
    }
    readonly required: string[] = []

    protected createInvocation (params: GetInternalDocsToolParams, _context: ToolContext): BaseToolInvocation<GetInternalDocsToolParams> {
        return new GetInternalDocsToolInvocation(params)
    }
}

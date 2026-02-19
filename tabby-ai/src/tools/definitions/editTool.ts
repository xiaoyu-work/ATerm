/**
 * Edit (replace) tool.
 *
 * Mirrors gemini-cli's EditTool + EditToolInvocation
 * (packages/core/src/tools/definitions/edit.ts)
 *
 * Logic extracted from AgentLoop.editFile() + flexibleReplace() + replaceNOccurrences().
 */

import * as fs from 'fs/promises'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { validatePath } from '../security'

export interface EditToolParams {
    file_path: string
    old_string: string
    new_string: string
    expected_replacements?: number
}

class EditToolInvocation extends BaseToolInvocation<EditToolParams> {
    constructor (params: EditToolParams) {
        super(params, ToolKind.Edit)
    }

    getDescription (): string {
        return `Edit file: ${this.params.file_path}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) {
            return this.error(validation.error)
        }

        // Read current content
        let content: string
        try {
            content = await fs.readFile(validation.resolved, 'utf-8')
        } catch (err: any) {
            return this.error(`Reading file: ${err.message}`)
        }

        const expected = this.params.expected_replacements || 1
        let count = 0

        // Count occurrences
        let searchFrom = 0
        while (true) {
            const idx = content.indexOf(this.params.old_string, searchFrom)
            if (idx === -1) break
            count++
            searchFrom = idx + this.params.old_string.length
        }

        if (count === 0) {
            // Fallback: try flexible matching (trimmed lines)
            const result = this.flexibleReplace(content, this.params.old_string, this.params.new_string, expected)
            if (result) {
                content = result.content
                count = result.count
            } else {
                return this.error(`old_string not found in ${this.params.file_path}. Use read_file to examine the current content first.`)
            }
        } else {
            if (count !== expected) {
                return this.error(`Expected ${expected} occurrence(s) of old_string, but found ${count}. Provide more context to make the match unique, or set expected_replacements=${count}.`)
            }
            content = this.replaceNOccurrences(content, this.params.old_string, this.params.new_string, expected)
        }

        try {
            await fs.writeFile(validation.resolved, content, 'utf-8')
            return this.success(`Successfully replaced ${count} occurrence(s) in ${this.params.file_path}`)
        } catch (err: any) {
            return this.error(`Writing file: ${err.message}`)
        }
    }

    /**
     * Replace exactly N occurrences of a string.
     * Mirrors gemini-cli's exact strategy.
     */
    private replaceNOccurrences (content: string, oldStr: string, newStr: string, n: number): string {
        let result = ''
        let remaining = content
        let replaced = 0

        while (replaced < n) {
            const idx = remaining.indexOf(oldStr)
            if (idx === -1) break
            result += remaining.slice(0, idx) + newStr
            remaining = remaining.slice(idx + oldStr.length)
            replaced++
        }

        return result + remaining
    }

    /**
     * Flexible replacement — matches line-by-line with trimmed whitespace.
     * Mirrors gemini-cli's flexible strategy in EditTool.
     */
    private flexibleReplace (
        content: string,
        oldString: string,
        newString: string,
        expected: number,
    ): { content: string; count: number } | null {
        const contentLines = content.split('\n')
        const oldLines = oldString.split('\n').map(l => l.trim())
        const newLines = newString.split('\n')

        if (oldLines.length === 0) return null

        let count = 0
        const resultLines: string[] = []
        let i = 0

        while (i < contentLines.length) {
            if (i + oldLines.length > contentLines.length) {
                resultLines.push(contentLines[i])
                i++
                continue
            }

            let matched = true
            for (let j = 0; j < oldLines.length; j++) {
                if (contentLines[i + j].trim() !== oldLines[j]) {
                    matched = false
                    break
                }
            }

            if (matched && count < expected) {
                // Determine indentation from first matched line
                const indent = contentLines[i].match(/^(\s*)/)?.[1] || ''
                for (const nl of newLines) {
                    resultLines.push(nl.trim() ? indent + nl.trimStart() : nl)
                }
                i += oldLines.length
                count++
            } else {
                resultLines.push(contentLines[i])
                i++
            }
        }

        if (count === 0) return null
        return { content: resultLines.join('\n'), count }
    }
}

export class EditTool extends DeclarativeTool<EditToolParams> {
    readonly name = 'replace'
    readonly displayName = 'Edit (Replace)'
    readonly description = 'Replaces text within a file. By default, replaces a single occurrence, but can replace multiple when expected_replacements is specified. Always use read_file first to examine the file before editing. The old_string must uniquely identify the text to change — include enough surrounding context (at least 3 lines before and after) to ensure a unique match.'
    readonly kind = ToolKind.Edit
    readonly parameters = {
        file_path: {
            type: 'string',
            description: 'The path to the file to modify (absolute or relative to CWD)',
        },
        old_string: {
            type: 'string',
            description: 'The exact literal text to replace. Must match the file content precisely, including whitespace and indentation.',
        },
        new_string: {
            type: 'string',
            description: 'The exact literal text to replace old_string with.',
        },
        expected_replacements: {
            type: 'integer',
            description: 'Optional: Number of replacements expected. Defaults to 1.',
            minimum: 1,
        },
    }
    readonly required = ['file_path', 'old_string', 'new_string']

    protected createInvocation (params: EditToolParams, _context: ToolContext): EditToolInvocation {
        return new EditToolInvocation(params)
    }
}

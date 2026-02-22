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
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { validatePath } from '../security'
import { fixLLMEdit } from '../llmEditFixer'

export interface EditToolParams {
    file_path: string
    instruction: string
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

    /**
     * Mirrors gemini-cli's EditToolInvocation.getConfirmationDetails()
     * (packages/core/src/tools/edit.ts)
     *
     * Returns path_access if outside CWD, otherwise edit confirmation.
     */
    getConfirmationDetails (context: ToolContext): ConfirmationDetails | false {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) return false // Will error in execute()
        if (validation.outsideCwd) {
            return { type: 'path_access', title: 'Edit outside CWD', resolvedPath: validation.resolved }
        }
        return { type: 'edit', title: 'Edit file', filePath: validation.resolved }
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const validation = validatePath(this.params.file_path, context.cwd)
        if ('error' in validation) {
            return this.error(validation.error)
        }
        // outsideCwd check removed — handled by scheduler before execute()

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
                // === Self-correction — ported from gemini-cli edit.ts attemptSelfCorrection ===
                if (context.ai) {
                    const fixResult = await fixLLMEdit(
                        this.params.instruction || 'Apply the edit.',
                        this.params.old_string,
                        this.params.new_string,
                        `old_string not found in ${this.params.file_path}`,
                        content,
                        context.ai,
                        context.signal,
                    )

                    if (fixResult?.noChangesRequired) {
                        return this.success(`No changes needed: ${fixResult.explanation}`)
                    }

                    if (fixResult && fixResult.search) {
                        const idx = content.indexOf(fixResult.search)
                        if (idx !== -1) {
                            content = content.slice(0, idx) + fixResult.replace + content.slice(idx + fixResult.search.length)
                            try {
                                await fs.writeFile(validation.resolved, content, 'utf-8')
                                return this.success(`Self-corrected and replaced in ${this.params.file_path} (${fixResult.explanation})`)
                            } catch (err: any) {
                                return this.error(`Writing file: ${err.message}`)
                            }
                        }
                    }
                }

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
    readonly description = `Replaces text within a file. By default, replaces a single occurrence, but can replace multiple occurrences when \`expected_replacements\` is specified. This tool requires providing significant context around the change to ensure precise targeting. Always use the read_file tool to examine the file's current content before attempting a text replacement.

The user has the ability to modify the \`new_string\` content. If modified, this will be stated in the response.

**Expectation for required parameters**:
1. \`old_string\` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code).
2. \`new_string\` MUST be the exact literal text to replace \`old_string\` with. Ensure the resulting code is correct and idiomatic and that \`old_string\` and \`new_string\` are different.
3. NEVER escape \`old_string\` or \`new_string\`, that would break the exact literal text requirement.
**Important**: CRITICAL for \`old_string\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.
4. Prefer to break down complex and long changes into multiple smaller atomic calls to this tool. Always check the content of the file after changes.
**Multiple replacements**: Set \`expected_replacements\` to the number of occurrences you want to replace.`
    readonly kind = ToolKind.Edit
    readonly parameters = {
        file_path: {
            type: 'string',
            description: 'The path to the file to modify.',
        },
        instruction: {
            type: 'string',
            description: `A clear, semantic instruction for the code change, acting as a high-quality prompt for an expert LLM assistant. It must be self-contained and explain the goal of the change.

A good instruction should concisely answer:
1. WHY is the change needed?
2. WHERE should the change happen?
3. WHAT is the high-level change?
4. WHAT is the desired outcome?`,
        },
        old_string: {
            type: 'string',
            description: 'The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string does not match exactly, the tool will fail.',
        },
        new_string: {
            type: 'string',
            description: 'The exact literal text to replace old_string with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic.',
        },
        expected_replacements: {
            type: 'integer',
            description: 'Number of replacements expected. Defaults to 1 if not specified. Use when you want to replace multiple occurrences.',
            minimum: 1,
        },
    }
    readonly required = ['file_path', 'instruction', 'old_string', 'new_string']

    protected createInvocation (params: EditToolParams, _context: ToolContext): EditToolInvocation {
        return new EditToolInvocation(params)
    }
}

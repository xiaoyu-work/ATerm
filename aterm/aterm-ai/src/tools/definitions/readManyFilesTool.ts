/**
 * Read many files tool — reads and concatenates multiple files by glob patterns.
 *
 * Mirrors gemini-cli's ReadManyFilesTool
 * (packages/core/src/tools/read-many-files.ts)
 *
 * Useful for getting an overview of a codebase or reading a collection of files.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { isPathOutsideCwd } from '../security'
import { executeCommand } from '../../shellExecutor'

/** Max total content size in characters before truncation */
const MAX_TOTAL_CHARS = 500_000
/** Max lines per file before truncation */
const MAX_LINES_PER_FILE = 2000
/** Default exclusions */
const DEFAULT_EXCLUDES = [
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    '.venv', 'venv', '.tox', 'target', 'vendor', '.gradle',
    '*.min.js', '*.min.css', '*.map', '*.lock', 'package-lock.json',
    '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.svg', '*.woff', '*.woff2', '*.ttf', '*.eot',
    '*.zip', '*.tar', '*.gz', '*.exe', '*.dll', '*.so', '*.dylib',
]

export interface ReadManyFilesToolParams {
    include: string[]
    exclude?: string[]
    useDefaultExcludes?: boolean
}

class ReadManyFilesToolInvocation extends BaseToolInvocation<ReadManyFilesToolParams> {
    constructor (params: ReadManyFilesToolParams) {
        super(params, ToolKind.Read)
    }

    getDescription (): string {
        return `Read files: ${this.params.include.join(', ')}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const cwd = context.cwd
        const patterns = this.params.include
        const userExcludes = this.params.exclude || []
        const useDefaults = this.params.useDefaultExcludes !== false

        try {
            // Collect files matching patterns
            const allFiles: string[] = []

            for (const pattern of patterns) {
                // Use git ls-files if available, fall back to find
                const isGit = await fs.access(path.join(cwd, '.git')).then(() => true).catch(() => false)

                let command: string
                if (isGit) {
                    command = `git ls-files --cached --others --exclude-standard "${pattern}"`
                } else {
                    command = `find . -name "${pattern}" -not -path "./.git/*" 2>/dev/null`
                }

                const result = await executeCommand(command, cwd, context.signal, undefined, 15000)
                const files = result.stdout.trim().split('\n').filter(Boolean)
                allFiles.push(...files)
            }

            // Deduplicate
            const uniqueFiles = [...new Set(allFiles)]

            // Apply excludes
            const excludePatterns = [...userExcludes]
            if (useDefaults) {
                excludePatterns.push(...DEFAULT_EXCLUDES)
            }

            const filteredFiles = uniqueFiles.filter(file => {
                for (const exc of excludePatterns) {
                    if (file.includes(exc)) return false
                    // Simple glob matching for patterns like *.min.js
                    if (exc.startsWith('*') && file.endsWith(exc.slice(1))) return false
                }
                return true
            })

            // Security check
            const safeFiles = filteredFiles.filter(file => {
                const resolved = path.resolve(cwd, file)
                return !isPathOutsideCwd(resolved, cwd)
            })

            if (safeFiles.length === 0) {
                return this.success(`No files found matching patterns: ${patterns.join(', ')}`)
            }

            // Read and concatenate
            const parts: string[] = []
            let totalChars = 0
            let filesRead = 0
            let filesTruncated = 0

            for (const file of safeFiles) {
                if (totalChars >= MAX_TOTAL_CHARS) {
                    parts.push(`\n--- (Stopped: total content size exceeded ${MAX_TOTAL_CHARS} characters. ${safeFiles.length - filesRead} files not shown.) ---`)
                    break
                }

                const resolved = path.resolve(cwd, file)
                try {
                    const content = await fs.readFile(resolved, 'utf-8')
                    const lines = content.split('\n')

                    let fileContent: string
                    if (lines.length > MAX_LINES_PER_FILE) {
                        fileContent = lines.slice(0, MAX_LINES_PER_FILE).join('\n')
                        fileContent += `\n[WARNING: file truncated — ${lines.length} total lines, showing first ${MAX_LINES_PER_FILE}. Use read_file for full content.]`
                        filesTruncated++
                    } else {
                        fileContent = content
                    }

                    parts.push(`--- ${file} ---`)
                    parts.push(fileContent)
                    totalChars += fileContent.length
                    filesRead++
                } catch {
                    parts.push(`--- ${file} ---`)
                    parts.push('[Error: could not read file]')
                    filesRead++
                }
            }

            parts.push('--- End of content ---')

            const info: string[] = [`Read ${filesRead} file(s)`]
            if (filesTruncated > 0) {
                info.push(`${filesTruncated} truncated`)
            }
            if (safeFiles.length > filesRead) {
                info.push(`${safeFiles.length - filesRead} skipped due to size limit`)
            }
            parts.push(`[${info.join(', ')}]`)

            return this.success(parts.join('\n'))
        } catch (err: any) {
            return this.error(`Reading files: ${err.message}`)
        }
    }
}

export class ReadManyFilesTool extends DeclarativeTool<ReadManyFilesToolParams> {
    readonly name = 'read_many_files'
    readonly displayName = 'Read Many Files'
    readonly description = `Reads content from multiple files specified by glob patterns within the project directory. Concatenates their content into a single output with file separators.

This tool is useful when you need to understand or analyze a collection of files, such as:
- Getting an overview of a codebase or parts of it (e.g., all TypeScript files in the 'src' directory).
- Finding where specific functionality is implemented if the user asks broad questions about code.
- Reviewing documentation files (e.g., all Markdown files in the 'docs' directory).
- Gathering context from multiple configuration files.
- When the user asks to "read all files in X directory" or "show me the content of all Y files".

Use this when the user's query implies needing the content of several files simultaneously for context, analysis, or summarization. Avoid using for single files if read_file is available. Default excludes apply to common non-text files and large dependency directories unless 'useDefaultExcludes' is false.`
    readonly kind = ToolKind.Read
    readonly parameters = {
        include: {
            type: 'array',
            description: 'An array of glob patterns or paths. Examples: ["src/**/*.ts"], ["README.md", "docs/"]',
            items: { type: 'string' },
        },
        exclude: {
            type: 'array',
            description: 'Glob patterns for files/directories to exclude. Added to default excludes if useDefaultExcludes is true. Example: ["**/*.log", "temp/"]',
            items: { type: 'string' },
        },
        useDefaultExcludes: {
            type: 'boolean',
            description: 'Whether to apply default exclusion patterns (e.g., node_modules, .git, binary files). Defaults to true.',
        },
    }
    readonly required = ['include']

    protected createInvocation (params: ReadManyFilesToolParams, _context: ToolContext): ReadManyFilesToolInvocation {
        return new ReadManyFilesToolInvocation(params)
    }
}

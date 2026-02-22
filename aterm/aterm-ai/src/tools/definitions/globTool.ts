/**
 * Glob search tool.
 *
 * Mirrors gemini-cli's GlobTool
 * (packages/core/src/tools/glob.ts)
 *
 * Uses Node.js fs.readdir with recursive walk instead of shelling out,
 * ensuring cross-platform reliability (no dependency on external commands).
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { isPathOutsideCwd } from '../security'

const MAX_RESULTS = 200

/** Directories to skip during recursive walk */
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    '__pycache__', '.venv', 'venv', '.cache', 'coverage',
    '.tox', '.mypy_cache', 'target', '.output', '.nuxt',
])

export interface GlobToolParams {
    pattern: string
    dir_path?: string
}

/**
 * Converts a simple glob pattern to a RegExp.
 * Supports: *, **, ?, {a,b} alternatives, and character classes [abc].
 */
function globToRegex (pattern: string): RegExp {
    let regexStr = ''
    let i = 0
    while (i < pattern.length) {
        const char = pattern[i]

        if (char === '*') {
            if (pattern[i + 1] === '*') {
                // ** matches any path segment
                if (pattern[i + 2] === '/' || pattern[i + 2] === '\\') {
                    regexStr += '(?:.+[\\\\/])?'
                    i += 3
                } else {
                    regexStr += '.*'
                    i += 2
                }
            } else {
                // * matches anything except path separator
                regexStr += '[^\\\\/]*'
                i++
            }
        } else if (char === '?') {
            regexStr += '[^\\\\/]'
            i++
        } else if (char === '{') {
            const closeBrace = pattern.indexOf('}', i)
            if (closeBrace !== -1) {
                const alternatives = pattern.slice(i + 1, closeBrace).split(',')
                regexStr += '(?:' + alternatives.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
                i = closeBrace + 1
            } else {
                regexStr += '\\{'
                i++
            }
        } else if (char === '[') {
            const closeBracket = pattern.indexOf(']', i)
            if (closeBracket !== -1) {
                regexStr += pattern.slice(i, closeBracket + 1)
                i = closeBracket + 1
            } else {
                regexStr += '\\['
                i++
            }
        } else if (char === '/' || char === '\\') {
            regexStr += '[\\\\/]'
            i++
        } else {
            // Escape regex special characters
            regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            i++
        }
    }
    return new RegExp('^' + regexStr + '$', 'i')
}

interface FileEntry {
    relativePath: string
    mtimeMs: number
}

class GlobToolInvocation extends BaseToolInvocation<GlobToolParams> {
    constructor (params: GlobToolParams) {
        super(params, ToolKind.Search)
    }

    getDescription (): string {
        return `Glob: ${this.params.pattern}`
    }

    getConfirmationDetails (context: ToolContext): ConfirmationDetails | false {
        const searchDir = this.params.dir_path
            ? path.resolve(context.cwd, this.params.dir_path)
            : context.cwd
        if (isPathOutsideCwd(searchDir, context.cwd)) {
            return { type: 'path_access', title: 'Search outside CWD', resolvedPath: searchDir }
        }
        return false
    }

    /**
     * Recursively walk directory and collect files matching the pattern.
     */
    private async walkAndMatch (
        baseDir: string,
        regex: RegExp,
        results: FileEntry[],
        signal: AbortSignal,
    ): Promise<void> {
        const walk = async (dir: string): Promise<void> => {
            if (results.length >= MAX_RESULTS) return
            if (signal.aborted) return

            let entries: any[]
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            for (const entry of entries) {
                if (results.length >= MAX_RESULTS) break
                if (signal.aborted) break

                const fullPath = path.join(dir, entry.name)

                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) continue
                    await walk(fullPath)
                } else if (entry.isFile()) {
                    const relativePath = path.relative(baseDir, fullPath)
                    // Normalize path separators for matching
                    const normalizedPath = relativePath.replace(/\\/g, '/')

                    if (regex.test(normalizedPath) || regex.test(entry.name)) {
                        try {
                            const stat = await fs.stat(fullPath)
                            results.push({
                                relativePath,
                                mtimeMs: stat.mtimeMs,
                            })
                        } catch {
                            // File may have been deleted between readdir and stat
                            results.push({
                                relativePath,
                                mtimeMs: 0,
                            })
                        }
                    }
                }
            }
        }

        await walk(baseDir)
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const searchDir = this.params.dir_path
            ? path.resolve(context.cwd, this.params.dir_path)
            : context.cwd

        // Validate search directory exists
        if (this.params.dir_path) {
            try {
                const stats = await fs.stat(searchDir)
                if (!stats.isDirectory()) {
                    return this.error(`Path is not a directory: ${searchDir}`)
                }
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    return this.error(`Path does not exist: ${searchDir}`)
                }
                return this.error(`Failed to access path: ${searchDir}: ${err.message}`)
            }
        }

        try {
            const regex = globToRegex(this.params.pattern)
            const results: FileEntry[] = []

            await this.walkAndMatch(searchDir, regex, results, context.signal)

            if (results.length === 0) {
                return this.success(`No files found matching pattern: ${this.params.pattern}`)
            }

            // Sort: recent files first (within 24h), then alphabetically
            const oneDayMs = 24 * 60 * 60 * 1000
            const now = Date.now()

            results.sort((a, b) => {
                const aRecent = now - a.mtimeMs < oneDayMs
                const bRecent = now - b.mtimeMs < oneDayMs

                if (aRecent && bRecent) {
                    return b.mtimeMs - a.mtimeMs
                } else if (aRecent) {
                    return -1
                } else if (bRecent) {
                    return 1
                } else {
                    return a.relativePath.localeCompare(b.relativePath)
                }
            })

            const output = results.map(r => r.relativePath).join('\n')
            return this.success(output)
        } catch (err: any) {
            return this.error(`Glob search error: ${err.message}`)
        }
    }
}

export class GlobTool extends DeclarativeTool<GlobToolParams> {
    readonly name = 'glob'
    readonly displayName = 'Glob'
    readonly description = 'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases.'
    readonly kind = ToolKind.Search
    readonly parameters = {
        pattern: {
            type: 'string',
            description: 'The glob pattern to match against (e.g., \'**/*.py\', \'docs/*.md\').',
        },
        dir_path: {
            type: 'string',
            description: 'The absolute path to the directory to search within. If omitted, searches the root directory.',
        },
    }
    readonly required = ['pattern']

    protected override validateToolParamValues (params: GlobToolParams): string | null {
        if (!params.pattern || typeof params.pattern !== 'string' || params.pattern.trim() === '') {
            return "The 'pattern' parameter cannot be empty."
        }
        return null
    }

    protected createInvocation (params: GlobToolParams, _context: ToolContext): GlobToolInvocation {
        return new GlobToolInvocation(params)
    }
}

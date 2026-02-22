/**
 * Grep search tool.
 *
 * Mirrors gemini-cli's GrepTool
 * (packages/core/src/tools/grep.ts)
 *
 * Uses a 3-tier search strategy:
 * 1. git grep (if inside git repo and git is available)
 * 2. System grep (if grep command is available)
 * 3. Pure JavaScript fallback (glob + fs.readFile + RegExp)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { spawn } from 'child_process'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult, ConfirmationDetails } from '../types'
import { isPathOutsideCwd } from '../security'
import { isGitRepository } from '../gitDetect'
import { execStreaming } from '../execStreaming'

const DEFAULT_TOTAL_MAX_MATCHES = 100
const DEFAULT_SEARCH_TIMEOUT_MS = 30000

/** Common directories to exclude from search when not using git */
const COMMON_EXCLUDE_DIRS = [
    'node_modules', '.git', 'dist', 'build', '.next',
    '__pycache__', '.venv', 'venv', '.cache', 'coverage',
    '.tox', '.mypy_cache', 'target', '.output', '.nuxt',
]


export interface GrepToolParams {
    pattern: string
    dir_path?: string
    include?: string
    exclude_pattern?: string
    names_only?: boolean
    max_matches_per_file?: number
    total_max_matches?: number
}

interface GrepMatch {
    filePath: string
    lineNumber: number
    line: string
}

class GrepToolInvocation extends BaseToolInvocation<GrepToolParams> {
    constructor (params: GrepToolParams) {
        super(params, ToolKind.Search)
    }

    getDescription (): string {
        let description = `Grep: ${this.params.pattern}`
        if (this.params.include) {
            description += ` in ${this.params.include}`
        }
        if (this.params.dir_path) {
            description += ` within ${this.params.dir_path}`
        }
        return description
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
     * Parses a single line of grep-like output (git grep, system grep).
     * Expects format: filePath:lineNumber:lineContent
     */
    private parseGrepLine (line: string, basePath: string): GrepMatch | null {
        if (!line.trim()) return null

        const match = line.match(/^(.+?):(\d+):(.*)$/)
        if (!match) return null

        const [, filePathRaw, lineNumberStr, lineContent] = match
        const lineNumber = parseInt(lineNumberStr, 10)

        if (!isNaN(lineNumber)) {
            const absoluteFilePath = path.resolve(basePath, filePathRaw)
            const relativeCheck = path.relative(basePath, absoluteFilePath)
            if (
                relativeCheck === '..' ||
                relativeCheck.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relativeCheck)
            ) {
                return null
            }

            const relativeFilePath = path.relative(basePath, absoluteFilePath)

            return {
                filePath: relativeFilePath || path.basename(absoluteFilePath),
                lineNumber,
                line: lineContent,
            }
        }
        return null
    }

    /**
     * Checks if a command is available in the system's PATH.
     */
    private isCommandAvailable (command: string): Promise<boolean> {
        return new Promise((resolve) => {
            const fullCommand = process.platform === 'win32'
                ? `where ${command}`
                : `command -v ${command}`
            try {
                const child = spawn(fullCommand, {
                    stdio: 'ignore',
                    shell: true,
                })
                child.on('close', (code) => resolve(code === 0))
                child.on('error', () => resolve(false))
            } catch {
                resolve(false)
            }
        })
    }

    /**
     * 3-tier search: git grep → system grep → JavaScript fallback.
     */
    private async performGrepSearch (options: {
        pattern: string
        path: string
        include?: string
        exclude_pattern?: string
        maxMatches: number
        max_matches_per_file?: number
        signal: AbortSignal
    }): Promise<GrepMatch[]> {
        const {
            pattern,
            path: absolutePath,
            include,
            exclude_pattern,
            maxMatches,
            max_matches_per_file,
        } = options

        let excludeRegex: RegExp | null = null
        if (exclude_pattern) {
            excludeRegex = new RegExp(exclude_pattern, 'i')
        }

        // --- Strategy 1: git grep ---
        const isGit = isGitRepository(absolutePath)
        const gitAvailable = isGit && (await this.isCommandAvailable('git'))

        if (gitAvailable) {
            const gitArgs = [
                'grep',
                '--untracked',
                '-n',
                '-E',
                '--ignore-case',
                pattern,
            ]
            if (max_matches_per_file) {
                gitArgs.push('--max-count', max_matches_per_file.toString())
            }
            if (include) {
                gitArgs.push('--', include)
            }

            try {
                const generator = execStreaming('git', gitArgs, {
                    cwd: absolutePath,
                    signal: options.signal,
                    allowedExitCodes: [0, 1],
                })

                const results: GrepMatch[] = []
                for await (const line of generator) {
                    const match = this.parseGrepLine(line, absolutePath)
                    if (match) {
                        if (excludeRegex && excludeRegex.test(match.line)) {
                            continue
                        }
                        results.push(match)
                        if (results.length >= maxMatches) {
                            break
                        }
                    }
                }
                return results
            } catch (gitError: any) {
                // git grep failed, fall through to next strategy
            }
        }

        // --- Strategy 2: System grep ---
        const grepAvailable = await this.isCommandAvailable('grep')
        if (grepAvailable) {
            const grepArgs = ['-r', '-n', '-H', '-E', '-I']
            COMMON_EXCLUDE_DIRS.forEach((dir) => grepArgs.push(`--exclude-dir=${dir}`))
            if (max_matches_per_file) {
                grepArgs.push('--max-count', max_matches_per_file.toString())
            }
            if (include) {
                grepArgs.push(`--include=${include}`)
            }
            grepArgs.push(pattern)
            grepArgs.push('.')

            const results: GrepMatch[] = []
            try {
                const generator = execStreaming('grep', grepArgs, {
                    cwd: absolutePath,
                    signal: options.signal,
                    allowedExitCodes: [0, 1],
                })

                for await (const line of generator) {
                    const match = this.parseGrepLine(line, absolutePath)
                    if (match) {
                        if (excludeRegex && excludeRegex.test(match.line)) {
                            continue
                        }
                        results.push(match)
                        if (results.length >= maxMatches) {
                            break
                        }
                    }
                }
                return results
            } catch (grepError: any) {
                if (/Permission denied|Is a directory/i.test(grepError?.message || '')) {
                    return results
                }
                // System grep failed, fall through to JS fallback
            }
        }

        // --- Strategy 3: Pure JavaScript Fallback ---
        const regex = new RegExp(pattern, 'i')
        const allMatches: GrepMatch[] = []

        const walkDir = async (dir: string): Promise<void> => {
            if (allMatches.length >= maxMatches) return
            if (options.signal.aborted) return

            let entries: any[]
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            for (const entry of entries) {
                if (allMatches.length >= maxMatches) break
                if (options.signal.aborted) break

                const fullPath = path.join(dir, entry.name)

                if (entry.isDirectory()) {
                    if (COMMON_EXCLUDE_DIRS.includes(entry.name)) continue
                    await walkDir(fullPath)
                } else if (entry.isFile()) {
                    const relativePath = path.relative(absolutePath, fullPath)

                    // Check include pattern
                    if (include) {
                        const includePattern = include
                            .replace(/\./g, '\\.')
                            .replace(/\*/g, '.*')
                            .replace(/\?/g, '.')
                        if (!new RegExp(includePattern + '$', 'i').test(entry.name) &&
                            !new RegExp(includePattern + '$', 'i').test(relativePath)) {
                            continue
                        }
                    }

                    try {
                        const content = await fs.readFile(fullPath, 'utf8')
                        const lines = content.split(/\r?\n/)
                        let matchesInFile = 0
                        for (let index = 0; index < lines.length; index++) {
                            const line = lines[index]
                            if (regex.test(line)) {
                                if (excludeRegex && excludeRegex.test(line)) {
                                    continue
                                }
                                allMatches.push({
                                    filePath: relativePath || path.basename(fullPath),
                                    lineNumber: index + 1,
                                    line,
                                })
                                matchesInFile++
                                if (allMatches.length >= maxMatches) break
                                if (max_matches_per_file && matchesInFile >= max_matches_per_file) {
                                    break
                                }
                            }
                        }
                    } catch {
                        // Ignore read errors (binary files, permission denied, etc.)
                    }
                }
            }
        }

        await walkDir(absolutePath)
        return allMatches
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
            const totalMaxMatches = this.params.total_max_matches ?? DEFAULT_TOTAL_MAX_MATCHES

            // Create a timeout controller
            const timeoutController = new AbortController()
            const timeoutId = setTimeout(() => {
                timeoutController.abort()
            }, DEFAULT_SEARCH_TIMEOUT_MS)

            const onAbort = () => timeoutController.abort()
            if (context.signal.aborted) {
                onAbort()
            } else {
                context.signal.addEventListener('abort', onAbort, { once: true })
            }

            let allMatches: GrepMatch[]
            try {
                allMatches = await this.performGrepSearch({
                    pattern: this.params.pattern,
                    path: searchDir,
                    include: this.params.include,
                    exclude_pattern: this.params.exclude_pattern,
                    maxMatches: totalMaxMatches,
                    max_matches_per_file: this.params.max_matches_per_file,
                    signal: timeoutController.signal,
                })
            } finally {
                clearTimeout(timeoutId)
                context.signal.removeEventListener('abort', onAbort)
            }

            if (allMatches.length === 0) {
                return this.success(
                    `No matches found for pattern "${this.params.pattern}"` +
                    (this.params.include ? ` (filter: "${this.params.include}")` : '') + '.',
                )
            }

            const wasTruncated = allMatches.length >= totalMaxMatches

            // Group matches by file
            const matchesByFile: Record<string, GrepMatch[]> = {}
            for (const match of allMatches) {
                if (!matchesByFile[match.filePath]) {
                    matchesByFile[match.filePath] = []
                }
                matchesByFile[match.filePath].push(match)
            }
            for (const file of Object.keys(matchesByFile)) {
                matchesByFile[file].sort((a, b) => a.lineNumber - b.lineNumber)
            }

            const matchCount = allMatches.length
            const matchTerm = matchCount === 1 ? 'match' : 'matches'

            if (this.params.names_only) {
                const filePaths = Object.keys(matchesByFile).sort()
                let llmContent = `Found ${filePaths.length} files with matches for pattern "${this.params.pattern}"` +
                    (this.params.include ? ` (filter: "${this.params.include}")` : '') +
                    (wasTruncated ? ` (results limited to ${totalMaxMatches} matches)` : '') + ':\n'
                llmContent += filePaths.join('\n')
                return this.success(llmContent.trim())
            }

            let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${this.params.pattern}"` +
                (this.params.include ? ` (filter: "${this.params.include}")` : '')

            if (wasTruncated) {
                llmContent += ` (results limited to ${totalMaxMatches} matches)`
            }

            llmContent += ':\n---\n'

            for (const filePath in matchesByFile) {
                llmContent += `File: ${filePath}\n`
                matchesByFile[filePath].forEach((match) => {
                    const trimmedLine = match.line.trim()
                    llmContent += `L${match.lineNumber}: ${trimmedLine}\n`
                })
                llmContent += '---\n'
            }

            return this.success(llmContent.trim())
        } catch (err: any) {
            return this.error(`Grep search error: ${err.message}`)
        }
    }
}

export class GrepTool extends DeclarativeTool<GrepToolParams> {
    readonly name = 'grep_search'
    readonly displayName = 'Grep Search'
    readonly description = 'Searches for a regular expression pattern within file contents. Returns matching lines with file paths and line numbers. Uses git grep when available, falls back to system grep or pure JavaScript search. Use `include` to target relevant files and `total_max_matches`/`max_matches_per_file` to limit results and preserve context window. For broad discovery, use `names_only=true` to identify files without retrieving line content.'
    readonly kind = ToolKind.Search
    readonly parameters = {
        pattern: {
            type: 'string',
            description: 'The regular expression (regex) pattern to search for within file contents (e.g., \'function\\\\s+myFunction\', \'import\\\\s+\\\\{.*\\\\}\\\\s+from\\\\s+.*\').',
        },
        dir_path: {
            type: 'string',
            description: 'The absolute path to the directory to search within. If omitted, searches the current working directory.',
        },
        include: {
            type: 'string',
            description: 'A glob pattern to filter which files are searched (e.g., \'*.js\', \'*.{ts,tsx}\', \'src/**\'). If omitted, searches all files.',
        },
        exclude_pattern: {
            type: 'string',
            description: 'A regular expression pattern to exclude from the search results.',
        },
        names_only: {
            type: 'boolean',
            description: 'If true, only the file paths of matches will be returned, without line content or line numbers. Useful for gathering a list of files.',
        },
        max_matches_per_file: {
            type: 'integer',
            description: 'Maximum number of matches to return per file. Use this to prevent being overwhelmed by repetitive matches in large files.',
            minimum: 1,
        },
        total_max_matches: {
            type: 'integer',
            description: 'Maximum number of total matches to return. Use this to limit the overall size of the response. Defaults to 100.',
            minimum: 1,
        },
    }
    readonly required = ['pattern']

    protected override validateToolParamValues (params: GrepToolParams): string | null {
        try {
            new RegExp(params.pattern)
        } catch (error: any) {
            return `Invalid regular expression pattern: ${params.pattern}. Error: ${error.message}`
        }

        if (params.exclude_pattern) {
            try {
                new RegExp(params.exclude_pattern)
            } catch (error: any) {
                return `Invalid exclude pattern: ${params.exclude_pattern}. Error: ${error.message}`
            }
        }

        if (params.max_matches_per_file !== undefined && params.max_matches_per_file < 1) {
            return 'max_matches_per_file must be at least 1.'
        }

        if (params.total_max_matches !== undefined && params.total_max_matches < 1) {
            return 'total_max_matches must be at least 1.'
        }

        return null
    }

    protected createInvocation (params: GrepToolParams, _context: ToolContext): GrepToolInvocation {
        return new GrepToolInvocation(params)
    }
}

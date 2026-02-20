/**
 * Path validation and security utilities for file-based tools.
 *
 * Extracted from AgentLoop — shared by ReadFileTool, WriteFileTool, EditTool.
 * Mirrors gemini-cli's path validation in:
 *   packages/core/src/tools/definitions/tool-utils/validatePath.ts
 */

import * as path from 'path'

/** Sensitive dotfile basenames / directory names that must never be accessed. */
const BLOCKED_DOTFILES = new Set([
    '.env', '.env.local', '.env.production', '.env.development', '.env.staging',
    '.ssh', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.docker',
    '.aws', '.azure', '.gcloud',
    '.git-credentials', '.bash_history', '.zsh_history',
])

/**
 * Returns true when the resolved path is outside the CWD.
 */
export function isPathOutsideCwd (resolved: string, cwd: string): boolean {
    return !resolved.startsWith(cwd + path.sep) && resolved !== cwd
}

/**
 * Returns true when the resolved path is a sensitive dotfile/directory
 * or lives inside one.
 */
export function isSensitivePath (resolved: string, cwd: string): boolean {
    const relative = path.relative(cwd, resolved)
    const segments = relative.split(path.sep)

    for (const seg of segments) {
        if (BLOCKED_DOTFILES.has(seg.toLowerCase())) {
            return true
        }
    }
    return false
}

/**
 * Validate a file path: resolve against CWD, check traversal & sensitivity.
 * Returns the resolved path or an error string.
 */
export function validatePath (filePath: string, cwd: string): { resolved: string } | { error: string } {
    const resolved = path.resolve(cwd, filePath)

    if (isPathOutsideCwd(resolved, cwd)) {
        return { error: `Access denied – "${filePath}" resolves to a path outside the working directory.` }
    }

    if (isSensitivePath(resolved, cwd)) {
        return { error: `Access denied – reading/writing sensitive dotfiles is not allowed ("${filePath}").` }
    }

    return { resolved }
}

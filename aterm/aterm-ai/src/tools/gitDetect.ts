/**
 * Git repository detection utilities.
 *
 * Mirrors gemini-cli's gitUtils.ts
 * (packages/core/src/utils/gitUtils.ts)
 */

import * as fs from 'fs'
import * as path from 'path'

/**
 * Checks if a directory is within a git repository by walking up the directory tree.
 * Handles worktrees where .git can be a file.
 */
export function isGitRepository (directory: string): boolean {
    try {
        let currentDir = path.resolve(directory)

        while (true) {
            const gitDir = path.join(currentDir, '.git')

            if (fs.existsSync(gitDir)) {
                return true
            }

            const parentDir = path.dirname(currentDir)

            if (parentDir === currentDir) {
                break
            }

            currentDir = parentDir
        }

        return false
    } catch {
        return false
    }
}

/**
 * Finds the root directory of a git repository.
 */
export function findGitRoot (directory: string): string | null {
    try {
        let currentDir = path.resolve(directory)

        while (true) {
            const gitDir = path.join(currentDir, '.git')

            if (fs.existsSync(gitDir)) {
                return currentDir
            }

            const parentDir = path.dirname(currentDir)

            if (parentDir === currentDir) {
                break
            }

            currentDir = parentDir
        }

        return null
    } catch {
        return null
    }
}

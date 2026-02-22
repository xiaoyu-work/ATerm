/**
 * Streaming command execution utility.
 *
 * Mirrors gemini-cli's execStreaming()
 * (packages/core/src/utils/shell-utils.ts)
 */

import { spawn } from 'child_process'
import * as readline from 'readline'

/**
 * Executes a command and yields lines of output as they appear.
 * Spawns the command directly (no shell wrapping) for reliability on all platforms.
 */
export async function* execStreaming (
    command: string,
    args: string[],
    options?: {
        cwd?: string
        signal?: AbortSignal
        allowedExitCodes?: number[]
    },
): AsyncGenerator<string, void, void> {
    const child = spawn(command, args, {
        cwd: options?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    })

    const rl = readline.createInterface({
        input: child.stdout!,
        terminal: false,
    })

    const errorChunks: Buffer[] = []
    let stderrTotalBytes = 0
    const MAX_STDERR_BYTES = 20 * 1024

    child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrTotalBytes < MAX_STDERR_BYTES) {
            errorChunks.push(chunk)
            stderrTotalBytes += chunk.length
        }
    })

    let error: Error | null = null
    child.on('error', (err) => {
        error = err
    })

    const onAbort = () => {
        if (!child.killed) child.kill()
    }

    if (options?.signal?.aborted) {
        onAbort()
    } else {
        options?.signal?.addEventListener('abort', onAbort)
    }

    let finished = false
    try {
        for await (const line of rl) {
            if (options?.signal?.aborted) break
            yield line
        }
        finished = true
    } finally {
        rl.close()
        options?.signal?.removeEventListener('abort', onAbort)

        let killedByGenerator = false
        if (!finished && child.exitCode === null && !child.killed) {
            try {
                child.kill()
            } catch { /* already dead */ }
            killedByGenerator = true
        }

        await new Promise<void>((resolve, reject) => {
            if (error) {
                reject(error)
                return
            }

            function checkExit (code: number | null) {
                if (options?.signal?.aborted || killedByGenerator) {
                    resolve()
                    return
                }

                const allowed = options?.allowedExitCodes ?? [0]
                if (code !== null && allowed.includes(code)) {
                    resolve()
                } else {
                    if (error) {
                        reject(error)
                    } else {
                        const stderr = Buffer.concat(errorChunks).toString('utf8')
                        const truncatedMsg = stderrTotalBytes >= MAX_STDERR_BYTES ? '...[truncated]' : ''
                        reject(new Error(`Process exited with code ${code}: ${stderr}${truncatedMsg}`))
                    }
                }
            }

            if (child.exitCode !== null) {
                checkExit(child.exitCode)
            } else {
                child.on('close', (code) => checkExit(code))
                child.on('error', (err) => reject(err))
            }
        })
    }
}

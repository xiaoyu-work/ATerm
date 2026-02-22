#!/usr/bin/env node
/**
 * aterm-ai CLI — standalone process invoked by __aterm_ai shell function.
 *
 * All AI output goes to stdout (through ConPTY), solving the
 * fundamental desync between xterm.js and ConPTY buffers.
 *
 * Environment variables:
 *   ATERM_AI_PROVIDER, ATERM_AI_BASE_URL, ATERM_AI_API_KEY,
 *   ATERM_AI_MODEL, ATERM_AI_DEPLOYMENT, ATERM_AI_API_VERSION,
 *   ATERM_AI_SESSION_FILE, ATERM_AI_CONTEXT, ATERM_AI_COLORS
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { CLIAIService, AIConfig } from './cliAIService'
import { CLIContextCollector } from './cliContextCollector'
import { AgentLoop } from '../agentLoop'
import { ChatMessage } from '../ai.service'
import { AgentCallbacks, ConfirmationOutcome } from '../tools/types'
import { ShellResult } from '../shellExecutor'
import { PromptProvider } from '../promptProvider'
import { TokensSummary } from '../streamEvents'

// ─── 24-bit true-color helpers ───────────────────────────────────────
// Uses \x1b[38;2;R;G;Bm for foreground and \x1b[39m to reset foreground only
// (avoids \x1b[0m which resets background too, causing code block black bg)

function hexToRgb (hex: string): [number, number, number] {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function trueColor (hex: string): (s: string) => string {
    const [r, g, b] = hexToRgb(hex)
    return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`
}

const aiColors: Record<string, string> = (() => {
    try {
        return JSON.parse(process.env.ATERM_AI_COLORS || '{}')
    } catch {
        return {}
    }
})()

const c = {
    green: trueColor(aiColors.content || '#4ade80'),
    gray: trueColor(aiColors.thinking || '#9ca3af'),
    yellow: trueColor(aiColors.confirmation || '#facc15'),
    cyan: trueColor(aiColors.question || '#22d3ee'),
    red: trueColor(aiColors.error || '#f87171'),
    dim: trueColor(aiColors.command || '#6b7280'),
    info: trueColor(aiColors.info || '#6b7280'),
    bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
}

// ─── Config from environment ─────────────────────────────────────────
const config: AIConfig = {
    provider: process.env.ATERM_AI_PROVIDER || 'gemini',
    baseUrl: process.env.ATERM_AI_BASE_URL || '',
    apiKey: process.env.ATERM_AI_API_KEY || '',
    model: process.env.ATERM_AI_MODEL || '',
    deployment: process.env.ATERM_AI_DEPLOYMENT || '',
    apiVersion: process.env.ATERM_AI_API_VERSION || '',
}
const sessionFile = process.env.ATERM_AI_SESSION_FILE || ''

// Parse query: support --file <path> (temp file from middleware) or inline args
let query: string
const fileIdx = process.argv.indexOf('--file')
if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    const queryFile = process.argv[fileIdx + 1]
    try {
        query = fs.readFileSync(queryFile, 'utf-8')
        // Clean up temp file after reading
        fs.unlinkSync(queryFile)
    } catch (err: any) {
        process.stderr.write(c.red(`Failed to read query file: ${err.message}\n`))
        process.exit(1)
    }
} else {
    query = process.argv.slice(2).join(' ')
}

if (!query) {
    process.stderr.write(c.red('Usage: aterm-ai-cli <query>\n'))
    process.exit(1)
}

// ─── Session persistence ─────────────────────────────────────────────
interface SessionData {
    messages: ChatMessage[]
    usage: TokensSummary
}

function loadSession (): SessionData {
    if (sessionFile && fs.existsSync(sessionFile)) {
        try {
            return JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
        } catch {
            // Corrupted file — start fresh
        }
    }
    return { messages: [], usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 } }
}

function saveSession (data: SessionData): void {
    if (!sessionFile) return
    try {
        const dir = path.dirname(sessionFile)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(sessionFile, JSON.stringify(data), 'utf-8')
    } catch {
        // Best effort — don't crash on save failure
    }
}

// ─── Stdin helpers ───────────────────────────────────────────────────

function readSingleKey (): Promise<string> {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true)
        }
        process.stdin.resume()
        const onData = (data: Buffer) => {
            process.stdin.removeListener('data', onData)
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false)
            }
            process.stdin.pause()
            resolve(data.toString())
        }
        process.stdin.on('data', onData)
    })
}

function readLine (): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false,
        })
        rl.once('line', (line) => {
            rl.close()
            resolve(line)
        })
        rl.once('close', () => {
            resolve('')
        })
    })
}

// ─── CLI Agent Callbacks ─────────────────────────────────────────────
function createCallbacks (abortController: AbortController): AgentCallbacks {
    return {
        onContent (text: string): void {
            process.stdout.write(c.green(text))
        },

        onThinking (text: string): void {
            process.stdout.write(c.gray(text))
        },

        onConfirmCommand (description: string, type: string): void {
            process.stdout.write('\n' + c.yellow(`[${type}] ${description}`) + '\n')
            process.stdout.write(c.yellow('Proceed? [Enter=yes / Ctrl+C=cancel] '))
        },

        async waitForApproval (): Promise<ConfirmationOutcome> {
            const key = await readSingleKey()
            const code = key.charCodeAt(0)
            // Ctrl+C = 3, Escape = 27
            if (code === 3 || code === 27) {
                process.stdout.write(c.red('Cancelled\n'))
                return ConfirmationOutcome.Cancel
            }
            process.stdout.write(c.green('Approved\n'))
            return ConfirmationOutcome.ProceedOnce
        },

        onAskUser (question: string): void {
            process.stdout.write('\n' + c.cyan(question) + '\n')
            process.stdout.write(c.cyan('> '))
        },

        async waitForUserResponse (): Promise<string> {
            return await readLine()
        },

        onCommandStart (cmd: string): void {
            process.stdout.write(c.dim(`\n$ ${cmd}\n`))
        },

        onCommandOutput (chunk: string): void {
            process.stdout.write(c.dim(chunk))
        },

        onCommandDone (result: ShellResult): void {
            if (result.exitCode !== 0) {
                process.stdout.write(c.dim(`(exit ${result.exitCode})\n`))
            }
        },

        onDone (): void {
            // Print newline after AI output
            process.stdout.write('\n')
        },

        onError (err: string): void {
            process.stderr.write(c.red(`Error: ${err}\n`))
        },
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main (): Promise<void> {
    const ai = new CLIAIService(config)
    const cwd = process.cwd()
    const collector = new CLIContextCollector(cwd) as any
    const abortController = new AbortController()

    // Ctrl+C handling
    process.on('SIGINT', () => {
        abortController.abort()
    })

    // Load session history
    const session = loadSession()

    // Build system prompt
    const promptProvider = new PromptProvider()
    const contextString = collector.toPromptString()
    const systemPrompt = promptProvider.getCoreSystemPrompt({
        cwd,
        context: contextString,
        interactive: true,
        interactiveShellEnabled: true,
    })

    // Build messages: system + history + new user query
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...session.messages,
        { role: 'user', content: query },
    ]

    // Create and run agent loop
    const callbacks = createCallbacks(abortController)
    const loop = new AgentLoop(ai, collector, callbacks, abortController.signal)
    const result = await loop.run(messages)

    // Accumulate usage
    session.usage.promptTokens += result.usage.promptTokens
    session.usage.completionTokens += result.usage.completionTokens
    session.usage.cachedTokens += result.usage.cachedTokens
    session.usage.totalTokens += result.usage.totalTokens

    // Save history: append new messages from this run
    session.messages.push(
        { role: 'user', content: query },
        ...result.messages,
    )
    saveSession(session)

    // Print usage summary
    process.stderr.write(c.info(
        `[tokens: ${result.usage.promptTokens.toLocaleString()} in / ${result.usage.completionTokens.toLocaleString()} out]\n`,
    ))
}

main().catch((err) => {
    process.stderr.write(c.red(`Fatal: ${err.message}\n`))
    process.exit(1)
})

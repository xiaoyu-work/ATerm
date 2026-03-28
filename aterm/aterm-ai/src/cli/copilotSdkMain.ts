#!/usr/bin/env node
/**
 * Copilot SDK CLI — alternative agent backend using GitHub Copilot SDK.
 *
 * Invoked by __aterm_ai shell function when agentBackend is 'copilot-sdk'.
 * Uses CopilotClient + CopilotSession instead of ATerm's built-in AgentLoop.
 * All output goes to stdout (through ConPTY), same as the built-in backend.
 *
 * Environment variables:
 *   ATERM_AI_PROVIDER, ATERM_AI_BASE_URL, ATERM_AI_API_KEY,
 *   ATERM_AI_MODEL, ATERM_AI_GITHUB_TOKEN, ATERM_AI_OAUTH_TOKEN,
 *   ATERM_AI_SESSION_FILE, ATERM_AI_COLORS, ATERM_AI_DEPLOYMENT,
 *   ATERM_AI_API_VERSION
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
// @github/copilot-sdk is ESM-only — use type-only imports for compile-time checks
// and dynamic import() at runtime to avoid ERR_REQUIRE_ESM in CommonJS output.
import type {
    CopilotClient,
    CopilotSession,
    CopilotClientOptions,
    SessionConfig,
    ProviderConfig,
    PermissionHandler,
    PermissionRequest,
    PermissionRequestResult,
    UserInputHandler,
    UserInputRequest,
    UserInputResponse,
    SessionEvent,
} from '@github/copilot-sdk'

// Lazy-loaded SDK constructor — populated in main()
let CopilotClientCtor: typeof CopilotClient
import { StreamingMarkdownRenderer } from './streamingMarkdown'
import { CLIContextCollector, CLIContextData } from './cliContextCollector'

// ─── 24-bit true-color helpers ───────────────────────────────────────

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

const provider = process.env.ATERM_AI_PROVIDER || 'copilot'
const baseUrl = process.env.ATERM_AI_BASE_URL || ''
const apiKey = process.env.ATERM_AI_API_KEY || ''
const oauthToken = process.env.ATERM_AI_OAUTH_TOKEN || ''
const model = process.env.ATERM_AI_MODEL || ''
const apiVersion = process.env.ATERM_AI_API_VERSION || ''
const githubToken = process.env.ATERM_AI_GITHUB_TOKEN || ''
const sessionFile = process.env.ATERM_AI_SESSION_FILE || ''

function buildPromptWithContext (prompt: string, contextData?: CLIContextData): string {
    if (!contextData) {
        return prompt
    }
    const collector = new CLIContextCollector(process.cwd(), contextData)
    const context = collector.toPromptString()
    return `${context}\n\n<user_request>\n${prompt}\n</user_request>`
}

// ─── Parse query ─────────────────────────────────────────────────────

let query: string
let contextData: CLIContextData | undefined
const fileIdx = process.argv.indexOf('--file')
if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    const queryFile = process.argv[fileIdx + 1]
    try {
        query = fs.readFileSync(queryFile, 'utf-8')
        fs.unlinkSync(queryFile)
    } catch (err: any) {
        process.stderr.write(c.red(`Failed to read query file: ${err.message}\n`))
        process.exit(1)
    }

    // Read terminal context file written by AIMiddleware alongside query file.
    const contextFile = queryFile.replace(/\baq-/, 'ac-').replace(/\.txt$/, '.json')
    try {
        contextData = JSON.parse(fs.readFileSync(contextFile, 'utf-8'))
        fs.unlinkSync(contextFile)
    } catch {
        // Context file may not exist
    }
} else {
    query = process.argv.slice(2).join(' ')
}

if (!query) {
    process.stderr.write(c.red('Usage: copilot-sdk-cli <query>\n'))
    process.exit(1)
}

// ─── Session persistence ─────────────────────────────────────────────

interface SessionPersistence {
    copilotSessionId: string | null
}

function loadSessionPersistence (): SessionPersistence {
    if (sessionFile && fs.existsSync(sessionFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
            return { copilotSessionId: data.copilotSessionId || null }
        } catch {
            // Corrupted file — start fresh
        }
    }
    return { copilotSessionId: null }
}

function saveSessionPersistence (data: SessionPersistence): void {
    if (!sessionFile) return
    try {
        const dir = path.dirname(sessionFile)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(sessionFile, JSON.stringify(data), 'utf-8')
    } catch {
        // Best effort
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
        // Resume stdin — it may have been paused by readSingleKey()
        process.stdin.resume()
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: !!process.stdin.isTTY,
        })
        let resolved = false
        rl.once('line', (line) => {
            resolved = true
            rl.close()
            resolve(line)
        })
        rl.once('close', () => {
            if (!resolved) {
                resolve('')
            }
        })
    })
}

// ─── Permission handler (stdin-based) ────────────────────────────────

// When the user denies a tool and types feedback, it's stored here
// so the conversation loop can send it as the next prompt.
let pendingFeedback: string | null = null

function createPermissionHandler (): PermissionHandler {
    return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
        const kind = request.kind

        // Auto-approve safe operations — no need to prompt for reads
        if (kind === 'read') {
            return { kind: 'approved' }
        }

        let description = ''
        if (kind === 'shell') {
            description = (request as any).command || (request as any).description || 'shell command'
        } else if (kind === 'write') {
            description = (request as any).path || (request as any).filePath || 'file write'
        } else {
            description = JSON.stringify(request).slice(0, 120)
        }

        process.stdout.write(c.yellow(`\n[${kind}] ${description}\n`))
        process.stdout.write(c.yellow('Proceed? [Enter=yes / n=deny / a=always / Ctrl+C=abort] '))

        const key = await readSingleKey()
        const code = key.charCodeAt(0)

        if (code === 3 || code === 27) {
            // Ctrl+C / Escape — abort entire session
            process.stdout.write(c.red('abort\n'))
            throw new Error('__abort__')
        }
        if (key.toLowerCase() === 'n') {
            process.stdout.write(c.red('deny\n'))
            // Collect feedback so the AI knows why
            process.stdout.write(c.cyan('> '))
            const feedback = await readLine()
            if (feedback.trim()) {
                pendingFeedback = feedback.trim()
            }
            return { kind: 'denied-interactively-by-user' }
        }
        if (key.toLowerCase() === 'a') {
            process.stdout.write(c.green('always\n'))
            return { kind: 'approved' }
        }
        process.stdout.write(c.green('yes\n'))
        return { kind: 'approved' }
    }
}

// ─── User input handler (stdin-based) ────────────────────────────────

function createUserInputHandler (): UserInputHandler {
    return async (request: UserInputRequest): Promise<UserInputResponse> => {
        process.stdout.write('\n' + c.cyan(request.question) + '\n')

        if (request.choices && request.choices.length > 0) {
            for (let i = 0; i < request.choices.length; i++) {
                process.stdout.write(c.cyan(`  ${i + 1}. ${request.choices[i]}`) + '\n')
            }
        }

        process.stdout.write(c.cyan('> '))
        const answer = await readLine()

        return {
            answer,
            wasFreeform: !request.choices || !request.choices.includes(answer),
        }
    }
}

// ─── BYOK provider mapping ──────────────────────────────────────────

function buildProviderConfig (): ProviderConfig | undefined {
    // Copilot native — don't set provider, use githubToken auth
    if (provider === 'copilot') {
        return undefined
    }

    const resolvedApiKey = oauthToken || apiKey

    switch (provider) {
        case 'openai':
        case 'codex':
            return {
                type: 'openai',
                baseUrl: baseUrl || 'https://api.openai.com/v1',
                apiKey: resolvedApiKey,
            }

        case 'claude':
            return {
                type: 'anthropic',
                baseUrl: baseUrl || 'https://api.anthropic.com',
                apiKey: resolvedApiKey,
            }

        case 'azure':
            return {
                type: 'azure',
                baseUrl: baseUrl || '',
                apiKey: resolvedApiKey,
                azure: {
                    apiVersion: apiVersion || '2024-10-21',
                },
            }

        case 'gemini':
        case 'gemini-oauth':
            return {
                type: 'openai',
                baseUrl: baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
                apiKey: resolvedApiKey,
            }

        case 'ollama':
            return {
                type: 'openai',
                baseUrl: baseUrl || 'http://localhost:11434/v1',
                // No API key needed for local Ollama
            }

        case 'deepseek':
            return {
                type: 'openai',
                baseUrl: baseUrl || 'https://api.deepseek.com/v1',
                apiKey: resolvedApiKey,
            }

        case 'kimi':
            return {
                type: 'openai',
                baseUrl: baseUrl || 'https://api.moonshot.ai/v1',
                apiKey: resolvedApiKey,
            }

        default:
            // Custom or unknown provider — treat as OpenAI-compatible
            if (baseUrl) {
                return {
                    type: 'openai',
                    baseUrl,
                    apiKey: resolvedApiKey || undefined,
                }
            }
            return undefined
    }
}

// ─── Event bridge: Copilot SDK events → stdout ──────────────────────

function bridgeEventsToStdout (session: CopilotSession, mdRenderer: StreamingMarkdownRenderer): void {
    // Track tool display info by toolCallId (execution_complete doesn't include toolName/args)
    const toolCallInfo = new Map<string, string>()
    let inThinking = false
    let thinkingEndsWithNewline = false

    const closeThinking = () => {
        if (inThinking) {
            process.stdout.write((thinkingEndsWithNewline ? '' : '\n') + c.gray('</thinking>') + '\n')
            inThinking = false
        }
    }

    session.on((event: SessionEvent) => {
        switch (event.type) {
            case 'assistant.message_delta':
                closeThinking()
                mdRenderer.push(event.data.deltaContent)
                break

            case 'assistant.message':
                closeThinking()
                // Final complete message — flush any remaining markdown
                mdRenderer.flush()
                break

            case 'assistant.reasoning_delta':
                if (!inThinking) {
                    inThinking = true
                    process.stdout.write(c.gray('<thinking>') + '\n')
                }
                process.stdout.write(c.gray(event.data.deltaContent))
                thinkingEndsWithNewline = event.data.deltaContent.endsWith('\n')
                break

            case 'tool.execution_start': {
                closeThinking()
                const toolName = event.data.toolName
                if (toolName === 'report_intent') {
                    break
                }
                const args = event.data.arguments
                let description = ''
                if (typeof args === 'object' && args !== null) {
                    const a = args as any
                    description = a.command || a.path || a.filePath || a.pattern || a.query || ''
                }
                const display = description ? `${toolName}  ${description}` : toolName
                toolCallInfo.set(event.data.toolCallId, display)
                process.stdout.write(c.cyan(`▸ ${display}\n`))
                break
            }

            case 'tool.execution_partial_result':
                process.stdout.write(c.dim(event.data.partialOutput))
                break

            case 'tool.execution_complete': {
                const display = toolCallInfo.get(event.data.toolCallId) || ''
                toolCallInfo.delete(event.data.toolCallId)
                if (!display) {
                    break
                }
                if (event.data.success) {
                    // Show brief result summary for terminal-type results
                    const result = event.data.result
                    if (result?.contents) {
                        for (const content of result.contents) {
                            if (content.type === 'terminal') {
                                const text = content.text
                                if (text) {
                                    process.stdout.write(c.dim(text))
                                    if (!text.endsWith('\n')) {
                                        process.stdout.write('\n')
                                    }
                                }
                                if (content.exitCode !== undefined && content.exitCode !== 0) {
                                    process.stdout.write(c.dim(`(exit ${content.exitCode})\n`))
                                }
                            }
                        }
                    }
                    process.stdout.write(c.green(`✔ ${display}\n`))
                } else {
                    const errMsg = event.data.error?.message || 'failed'
                    process.stdout.write(c.red(`✗ ${display}  ${errMsg}\n`))
                }
                break
            }

            case 'session.error':
                process.stderr.write(c.red(`Error (${event.data.errorType}): ${event.data.message}\n`))
                break

            case 'session.compaction_start':
                process.stdout.write(c.info('\n(Compacting context...)\n'))
                break

            case 'session.compaction_complete':
                if (event.data.success && event.data.preCompactionTokens && event.data.postCompactionTokens) {
                    process.stdout.write(c.info(
                        `(Context compressed: ${event.data.preCompactionTokens.toLocaleString()} → ${event.data.postCompactionTokens.toLocaleString()} tokens)\n`,
                    ))
                }
                break

            case 'assistant.usage': {
                const u = event.data
                const inTokens = u.inputTokens || 0
                const outTokens = u.outputTokens || 0
                process.stderr.write(c.info(
                    `[${u.model}: ${inTokens.toLocaleString()} in / ${outTokens.toLocaleString()} out]\n`,
                ))
                break
            }

            case 'session.shutdown': {
                const metrics = event.data.modelMetrics
                if (metrics) {
                    let totalIn = 0
                    let totalOut = 0
                    for (const m of Object.values(metrics) as any[]) {
                        totalIn += m.usage.inputTokens
                        totalOut += m.usage.outputTokens
                    }
                    if (totalIn > 0 || totalOut > 0) {
                        process.stderr.write(c.info(
                            `[total: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out]\n`,
                        ))
                    }
                }
                break
            }

            // Events we silently ignore
            case 'session.start':
            case 'session.resume':
            case 'session.idle':
            case 'session.title_changed':
            case 'session.info':
            case 'session.warning':
            case 'session.model_change':
            case 'session.mode_changed':
            case 'session.context_changed':
            case 'session.usage_info':
            case 'user.message':
            case 'pending_messages.modified':
            case 'assistant.turn_start':
            case 'assistant.turn_end':
            case 'assistant.intent':
            case 'assistant.reasoning':
            case 'assistant.streaming_delta':
            case 'tool.user_requested':
            case 'tool.execution_progress':
            case 'hook.start':
            case 'hook.end':
            case 'abort':
            case 'skill.invoked':
            case 'subagent.started':
            case 'subagent.completed':
            case 'subagent.failed':
            case 'subagent.selected':
            case 'subagent.deselected':
            case 'system.message':
            case 'session.plan_changed':
            case 'session.workspace_file_changed':
            case 'session.handoff':
            case 'session.truncation':
            case 'session.snapshot_rewind':
            case 'session.task_complete':
                break
        }
    })
}

// ─── Main ────────────────────────────────────────────────────────────

async function main (): Promise<void> {
    // Dynamic import of ESM-only SDK — webpackIgnore prevents webpack from
    // converting this to require(), keeping it as a native import() call.
    const sdk = await import(/* webpackIgnore: true */ '@github/copilot-sdk')
    CopilotClientCtor = sdk.CopilotClient

    // Build CopilotClient options
    const clientOptions: CopilotClientOptions = {
        cwd: process.cwd(),
    }

    // Auth: GitHub token for native Copilot, or BYOK for other providers
    if (provider === 'copilot') {
        if (githubToken) {
            clientOptions.githubToken = githubToken
        } else if (oauthToken) {
            clientOptions.githubToken = oauthToken
        } else {
            // Fall back to logged-in user (copilot CLI stored credentials)
            clientOptions.useLoggedInUser = true
        }
    }
    // For BYOK providers, no GitHub auth is needed — the SDK will use the provider config

    const client = new CopilotClientCtor(clientOptions)

    // Build session config
    const providerConfig = buildProviderConfig()
    const sessionConfig: SessionConfig = {
        streaming: true,
        workingDirectory: process.cwd(),
        onPermissionRequest: createPermissionHandler(),
        onUserInputRequest: createUserInputHandler(),
    }

    if (model) {
        sessionConfig.model = model
    }

    if (providerConfig) {
        sessionConfig.provider = providerConfig
    }

    // Create or resume session
    const persistence = loadSessionPersistence()
    let session: CopilotSession

    try {
        if (persistence.copilotSessionId) {
            try {
                session = await client.resumeSession(persistence.copilotSessionId, sessionConfig)
            } catch {
                // Resume failed — create new session
                session = await client.createSession(sessionConfig)
            }
        } else {
            session = await client.createSession(sessionConfig)
        }
    } catch (err: any) {
        process.stderr.write(c.red(`Failed to start Copilot SDK: ${err.message}\n`))
        if (err.message?.includes('protocol version') || err.message?.includes('not found')) {
            process.stderr.write(c.info('Make sure @github/copilot is installed and up to date.\n'))
        }
        process.exit(1)
    }

    // Wire up event bridge
    const mdRenderer = new StreamingMarkdownRenderer(
        (rendered: string) => { process.stdout.write(rendered) },
        c.green,
    )
    bridgeEventsToStdout(session, mdRenderer)

    // Handle Ctrl+C
    let aborted = false
    process.on('SIGINT', async () => {
        if (!aborted) {
            aborted = true
            process.stdout.write(c.info('\n(aborting...)\n'))
            try {
                await session.abort()
            } catch {
                // Session may already be idle
            }
        } else {
            process.stdout.write(c.info('\n(force quit)\n'))
            await client.forceStop()
            process.exit(1)
        }
    })

    // Multi-turn conversation loop
    let nextPrompt: string | null = buildPromptWithContext(query, contextData)
    while (nextPrompt) {
        aborted = false
        pendingFeedback = null

        try {
            await session.sendAndWait({ prompt: nextPrompt }, 300_000)
        } catch (err: any) {
            if (err.message?.includes('__abort__')) {
                // User pressed Ctrl+C at permission prompt
                break
            } else if (err.message?.includes('timeout')) {
                process.stderr.write(c.red('Session timed out after 5 minutes.\n'))
                break
            } else if (err.message?.includes('abort') || aborted) {
                // Aborted by Ctrl+C during execution
                break
            } else {
                process.stderr.write(c.red(`Error: ${err.message}\n`))
                break
            }
        }

        mdRenderer.flush()

        // If user denied a tool and gave feedback, continue with that
        if (pendingFeedback) {
            nextPrompt = pendingFeedback
            continue
        }

        // Otherwise exit — most @ interactions are single-turn
        break
    }

    // Save session ID for continuity
    saveSessionPersistence({ copilotSessionId: session.sessionId })

    // Cleanup
    try {
        const errors = await client.stop()
        if (errors.length > 0) {
            for (const err of errors) {
                process.stderr.write(c.dim(`Cleanup warning: ${err.message}\n`))
            }
        }
    } catch {
        // Best effort cleanup
    }
}

main().then(() => {
    process.exit(0)
}).catch((err) => {
    process.stderr.write(c.red(`Fatal: ${err.message}\n`))
    process.exit(1)
})

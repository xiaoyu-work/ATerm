import { Injectable } from '@angular/core'
import { ConfigService } from 'aterm-core'
import { EventType, StreamEvent, ToolCallRequest, TokensSummary } from './streamEvents'
import { PROVIDER_PRESETS } from './providers'
import { formatApiError } from './errorMessages'
import { OAuthTokenManager } from './oauth/tokenManager'
import { getOAuthProvider } from './oauth/providerRegistry'

/**
 * OpenAI-compatible chat completion request/response types.
 * Works with: OpenAI, Gemini, Ollama, DeepSeek, Azure OpenAI, Groq,
 * LiteLLM Proxy, and any OpenAI-compatible endpoint.
 */

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_calls?: any[]
    tool_call_id?: string
}

export interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: any
    }
}

/** Common interface for AI service — implemented by Angular AIService and standalone CLIAIService */
export interface IAIService {
    query (userQuery: string, terminalContext: string): Promise<string>
    streamWithTools (messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<StreamEvent>
}

interface ChatCompletionResponse {
    choices?: {
        message?: {
            content?: string
        }
    }[]
    error?: { message: string }
}

@Injectable()
export class AIService {
    constructor (
        private config: ConfigService,
        private tokenManager: OAuthTokenManager,
    ) {}

    /** Resolve API config from settings */
    private resolveConfig (oauthAccessToken?: string): { url: string; headers: Record<string, string>; model: string; error?: string } {
        const aiConfig = this.config.store.ai
        const provider = aiConfig?.provider || 'gemini'
        const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom

        let baseUrl = (aiConfig?.baseUrl || preset.baseUrl || '').replace(/\/+$/, '')

        // For OAuth providers, only use OAuth token; for API Key providers, only use apiKey
        const oauthId = preset.oauthId
        let apiKey = oauthId ? '' : (aiConfig?.apiKeys?.[provider] || aiConfig?.apiKey || '')

        if (oauthId && oauthAccessToken) {
            apiKey = oauthAccessToken
            // Some providers derive their base URL from the token
            const oauthConfig = getOAuthProvider(oauthId)
            if (oauthConfig?.deriveBaseUrl) {
                const storedToken = this.tokenManager.getStoredToken(oauthId)
                if (storedToken) {
                    const derived = oauthConfig.deriveBaseUrl(storedToken)
                    if (derived) {
                        baseUrl = derived.replace(/\/+$/, '')
                    }
                }
            }
        }

        if (!baseUrl) {
            return { url: '', headers: {}, model: '', error: 'AI not configured. Go to Settings → AI to set up a provider.' }
        }

        const model = aiConfig?.model || preset.defaultModel

        if (!apiKey && provider !== 'ollama') {
            if (oauthId) {
                return { url: '', headers: {}, model: '', error: 'AI not configured. Go to Settings → AI to connect.' }
            }
            return { url: '', headers: {}, model: '', error: 'AI not configured. Go to Settings → AI to set an API key.' }
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' }

        if (provider === 'azure') {
            headers['api-key'] = apiKey
            const deployment = aiConfig?.deployment || model
            const apiVersion = aiConfig?.apiVersion || '2024-12-01-preview'
            const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
            return { url, headers, model: '' }
        }

        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`
        }

        // Copilot requires editor identification headers
        if (provider === 'copilot') {
            headers['Editor-Version'] = 'vscode/1.96.2'
            headers['Copilot-Integration-Id'] = 'vscode-chat'
        }

        const endpoint = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
        return { url: endpoint, headers, model }
    }

    /**
     * Resolve OAuth token before making API calls.
     * Returns the access token string or null.
     */
    private async resolveOAuthToken (): Promise<string | undefined> {
        const provider = this.config.store.ai?.provider || 'gemini'
        const preset = PROVIDER_PRESETS[provider]
        if (!preset?.oauthId) return undefined
        const token = await this.tokenManager.getAccessToken(preset.oauthId)
        return token || undefined
    }

    /**
     * Send a simple query to the configured LLM (non-streaming).
     */
    async query (userQuery: string, terminalContext: string): Promise<string> {
        const oauthToken = await this.resolveOAuthToken()
        const cfg = this.resolveConfig(oauthToken)
        if (cfg.error) {
            return `Error: ${cfg.error}`
        }

        const messages: ChatMessage[] = [
            { role: 'system', content: terminalContext },
            { role: 'user', content: userQuery },
        ]

        try {
            const response = await fetch(cfg.url, {
                method: 'POST',
                headers: cfg.headers,
                body: JSON.stringify({
                    model: cfg.model,
                    messages,
                    max_tokens: 2048,
                    temperature: 0.7,
                }),
            })

            if (!response.ok) {
                const text = await response.text()
                return formatApiError(response.status, text)
            }

            const data: ChatCompletionResponse = await response.json()
            if (data.error) {
                return formatApiError(400, JSON.stringify({ error: data.error }))
            }

            return data.choices?.[0]?.message?.content || 'No response from AI.'
        } catch {
            return 'Connection failed. Check your network and try again.'
        }
    }

    /**
     * Retry configuration — maps to gemini-cli's INVALID_CONTENT_RETRY_OPTIONS
     * (packages/core/src/core/geminiChat.ts:88-91)
     */
    private static readonly RETRY_OPTIONS = {
        maxAttempts: 3,       // gemini-cli uses 2 for content, 3 for network
        initialDelayMs: 500,  // gemini-cli: 500ms
    }

    /**
     * Network error codes that are safe to retry — maps to gemini-cli's
     * RETRYABLE_NETWORK_CODES (packages/core/src/utils/retry.ts:50-63)
     */
    private static readonly RETRYABLE_NETWORK_CODES = new Set([
        'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
        'EAI_AGAIN', 'ECONNREFUSED', 'EPROTO',
        'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
        'ERR_SSL_WRONG_VERSION_NUMBER',
        'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
        'ERR_SSL_BAD_RECORD_MAC',
    ])

    /**
     * Determine if an error is retryable — maps to gemini-cli's
     * isRetryableError() (packages/core/src/utils/retry.ts:112-143)
     *
     * Retries on: network error codes, 429 (rate limit), 5xx (server errors).
     * Does NOT retry: 400 (bad request), 401/403 (auth), 404 (not found).
     */
    private isRetryableError (err: any): boolean {
        // Check network error codes (traverse cause chain like gemini-cli)
        let current = err
        for (let depth = 0; depth < 5; depth++) {
            if (current?.code && AIService.RETRYABLE_NETWORK_CODES.has(current.code)) {
                return true
            }
            if (!current?.cause) break
            current = current.cause
        }
        // Check "fetch failed" message
        if (err?.message?.toLowerCase().includes('fetch failed')) {
            return true
        }
        return false
    }

    /**
     * Determine if an HTTP status is retryable — 429 or 5xx
     */
    private isRetryableStatus (status: number): boolean {
        return status === 429 || (status >= 500 && status < 600)
    }

    /**
     * Streaming chat completion with tool calling and retry support.
     * Returns an AsyncGenerator<StreamEvent>.
     *
     * Mirrors gemini-cli's GeminiChat.sendMessageStream() with
     * streamWithRetries() (packages/core/src/core/geminiChat.ts:340-463)
     *
     * Retry logic:
     * - Network errors: retry with linear backoff (delayMs * attempt)
     * - HTTP 429/5xx: retry with linear backoff
     * - HTTP 400/401/403/404: no retry (permanent errors)
     * - AbortError: no retry
     */
    async *streamWithTools (
        messages: ChatMessage[],
        tools: ToolDefinition[],
        signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
        const oauthToken = await this.resolveOAuthToken()
        const cfg = this.resolveConfig(oauthToken)
        if (cfg.error) {
            yield { type: EventType.Error, value: cfg.error }
            return
        }

        const { maxAttempts, initialDelayMs } = AIService.RETRY_OPTIONS
        let lastError: string | null = null

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (signal?.aborted) break

            // Yield retry event for UI feedback (maps to gemini-cli's StreamEventType.RETRY)
            if (attempt > 0) {
                yield { type: EventType.Retry, value: { attempt, maxAttempts } }
            }

            // === Connection phase (fetch) ===
            let response: Response
            const requestBody: Record<string, any> = {
                messages,
                tools: tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? 'auto' : undefined,
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: 16384,
                temperature: 0.7,
            }
            // Only include model for non-Azure providers (Azure uses deployment in URL)
            if (cfg.model) {
                requestBody.model = cfg.model
            }
            try {
                response = await fetch(cfg.url, {
                    method: 'POST',
                    headers: cfg.headers,
                    signal,
                    body: JSON.stringify(requestBody),
                })
            } catch (err: any) {
                if (err.name === 'AbortError' || signal?.aborted) {
                    yield { type: EventType.Error, value: 'Request aborted' }
                    return
                }
                // Network error — check if retryable
                if (this.isRetryableError(err) && attempt < maxAttempts - 1) {
                    const delayMs = initialDelayMs * (attempt + 1)
                    await new Promise(res => setTimeout(res, delayMs))
                    lastError = 'Connection failed. Retrying...'
                    continue
                }
                yield { type: EventType.Error, value: 'Connection failed. Check your network and try again.' }
                return
            }

            // HTTP error — check if retryable status
            if (!response.ok) {
                const text = await response.text()
                if (this.isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
                    const delayMs = initialDelayMs * (attempt + 1)
                    await new Promise(res => setTimeout(res, delayMs))
                    lastError = formatApiError(response.status, text)
                    continue
                }
                yield { type: EventType.Error, value: formatApiError(response.status, text) }
                return
            }

            // === Stream phase (SSE parsing) ===
            yield* this.parseSSEStream(response, signal)
            return
        }

        // All retries exhausted
        yield { type: EventType.Error, value: lastError || 'Connection failed after multiple attempts. Please try again.' }
    }

    /**
     * Parse an SSE stream response into StreamEvents.
     * Extracted from streamWithTools for retry clarity.
     */
    private async *parseSSEStream (
        response: Response,
        signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let sseBuffer = ''
        const pendingToolCalls: Map<number, ToolCallRequest> = new Map()
        let sawFinishReason = false
        let sawContent = false

        const appendToolCalls = (toolCalls: any[]): void => {
            for (const tc of toolCalls) {
                const idx = tc.index ?? 0
                if (!pendingToolCalls.has(idx)) {
                    pendingToolCalls.set(idx, {
                        id: tc.id || '',
                        function: { name: '', arguments: '' },
                    })
                }
                const pending = pendingToolCalls.get(idx)!
                if (tc.id) {
                    pending.id = tc.id
                }
                if (tc.function?.name) {
                    pending.function.name += tc.function.name
                }
                if (tc.function?.arguments) {
                    pending.function.arguments += tc.function.arguments
                }
            }
        }

        const appendLegacyFunctionCall = (functionCall: any): void => {
            if (!functionCall) return
            if (!pendingToolCalls.has(0)) {
                pendingToolCalls.set(0, {
                    id: 'legacy_function_call_0',
                    function: { name: '', arguments: '' },
                })
            }
            const pending = pendingToolCalls.get(0)!
            if (functionCall.name) {
                pending.function.name += functionCall.name
            }
            if (functionCall.arguments) {
                pending.function.arguments += functionCall.arguments
            }
        }

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                sseBuffer += decoder.decode(value, { stream: true })

                const lines = sseBuffer.split('\n')
                sseBuffer = lines.pop() || ''

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed.startsWith('data: ')) {
                        continue
                    }
                    const data = trimmed.slice(6).trim()

                    if (data === '[DONE]') {
                        for (const tc of pendingToolCalls.values()) {
                            yield { type: EventType.ToolCall, value: tc }
                        }
                        yield { type: EventType.Finished, value: null }
                        return
                    }

                    let chunk: any
                    try {
                        chunk = JSON.parse(data)
                    } catch {
                        continue
                    }

                    // Usage data (maps to gemini-cli's chunk.usageMetadata)
                    if (chunk.usage) {
                        const usage: TokensSummary = {
                            promptTokens: chunk.usage.prompt_tokens ?? 0,
                            completionTokens: chunk.usage.completion_tokens ?? 0,
                            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                            totalTokens: chunk.usage.total_tokens ?? 0,
                        }
                        yield { type: EventType.Usage, value: usage }
                    }

                    // API-level error in chunk (non-SSE error response)
                    if (chunk.error) {
                        yield { type: EventType.Error, value: formatApiError(chunk.error.code || 400, JSON.stringify({ error: chunk.error })) }
                        return
                    }

                    const choice = chunk.choices?.[0]
                    if (!choice) continue

                    if (choice.finish_reason) {
                        sawFinishReason = true
                    }

                    // Some providers include finalized tool calls on choice.message/tool_calls.
                    if (Array.isArray(choice.message?.tool_calls)) {
                        appendToolCalls(choice.message.tool_calls)
                    }
                    if (Array.isArray(choice.tool_calls)) {
                        appendToolCalls(choice.tool_calls)
                    }
                    if (choice.message?.function_call) {
                        appendLegacyFunctionCall(choice.message.function_call)
                    }
                    if (choice.function_call) {
                        appendLegacyFunctionCall(choice.function_call)
                    }
                    if (typeof choice.message?.content === 'string' && choice.message.content.length > 0) {
                        sawContent = true
                        yield { type: EventType.Content, value: choice.message.content }
                    }

                    const delta = choice.delta
                    if (!delta) continue

                    // Text content chunk
                    if (delta.content) {
                        sawContent = true
                        yield { type: EventType.Content, value: delta.content }
                    }

                    // Tool call fragments — accumulate and splice
                    if (delta.tool_calls) {
                        appendToolCalls(delta.tool_calls)
                    }
                    if (delta.function_call) {
                        appendLegacyFunctionCall(delta.function_call)
                    }
                }
            }
        } finally {
            reader.releaseLock()
        }

        if (!sawFinishReason && !sawContent && pendingToolCalls.size === 0) {
            yield { type: EventType.InvalidStream, value: null }
        }

        // Stream ended without [DONE] — still yield accumulated tool calls
        for (const tc of pendingToolCalls.values()) {
            yield { type: EventType.ToolCall, value: tc }
        }
        yield { type: EventType.Finished, value: null }
    }
}

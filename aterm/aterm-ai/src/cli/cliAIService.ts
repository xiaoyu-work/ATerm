/**
 * Standalone AI service for CLI usage — no Angular dependencies.
 * Implements the same IAIService interface as the Angular AIService.
 */

import { IAIService, ChatMessage, ToolDefinition } from '../ai.service'
import { EventType, StreamEvent, ToolCallRequest, TokensSummary } from '../streamEvents'
import { PROVIDER_PRESETS } from '../providers'

export interface AIConfig {
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    deployment?: string
    apiVersion?: string
}

interface ChatCompletionResponse {
    choices?: {
        message?: {
            content?: string
        }
    }[]
    error?: { message: string }
}

export class CLIAIService implements IAIService {
    constructor (private config: AIConfig) {}

    private resolveConfig (): { url: string; headers: Record<string, string>; model: string; error?: string } {
        const provider = this.config.provider || 'gemini'
        const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom

        let baseUrl = (this.config.baseUrl || preset.baseUrl || '').replace(/\/+$/, '')
        if (!baseUrl) {
            return { url: '', headers: {}, model: '', error: `No API base URL configured for provider "${provider}".` }
        }

        const apiKey = this.config.apiKey || ''
        const model = this.config.model || preset.defaultModel

        if (!apiKey && provider !== 'ollama') {
            return { url: '', headers: {}, model: '', error: 'No API key configured.' }
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' }

        if (provider === 'azure') {
            headers['api-key'] = apiKey
            const deployment = this.config.deployment || model
            const apiVersion = this.config.apiVersion || '2024-12-01-preview'
            const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
            return { url, headers, model: '' }
        }

        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`
        }

        const endpoint = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
        return { url: endpoint, headers, model }
    }

    async query (userQuery: string, terminalContext: string): Promise<string> {
        const cfg = this.resolveConfig()
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
                return `API error (${response.status}): ${text}`
            }

            const data: ChatCompletionResponse = await response.json()
            if (data.error) {
                return `API error: ${data.error.message}`
            }

            return data.choices?.[0]?.message?.content || 'No response from AI.'
        } catch (err: any) {
            return `Request failed: ${err.message}`
        }
    }

    private static readonly RETRY_OPTIONS = {
        maxAttempts: 3,
        initialDelayMs: 500,
    }

    private static readonly RETRYABLE_NETWORK_CODES = new Set([
        'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
        'EAI_AGAIN', 'ECONNREFUSED', 'EPROTO',
        'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
        'ERR_SSL_WRONG_VERSION_NUMBER',
        'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
        'ERR_SSL_BAD_RECORD_MAC',
    ])

    private isRetryableError (err: any): boolean {
        let current = err
        for (let depth = 0; depth < 5; depth++) {
            if (current?.code && CLIAIService.RETRYABLE_NETWORK_CODES.has(current.code)) {
                return true
            }
            if (!current?.cause) break
            current = current.cause
        }
        if (err?.message?.toLowerCase().includes('fetch failed')) {
            return true
        }
        return false
    }

    private isRetryableStatus (status: number): boolean {
        return status === 429 || (status >= 500 && status < 600)
    }

    async *streamWithTools (
        messages: ChatMessage[],
        tools: ToolDefinition[],
        signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
        const cfg = this.resolveConfig()
        if (cfg.error) {
            yield { type: EventType.Error, value: cfg.error }
            return
        }

        const { maxAttempts, initialDelayMs } = CLIAIService.RETRY_OPTIONS
        let lastError: string | null = null

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (signal?.aborted) break

            if (attempt > 0) {
                yield { type: EventType.Retry, value: { attempt, maxAttempts } }
            }

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
                if (this.isRetryableError(err) && attempt < maxAttempts - 1) {
                    const delayMs = initialDelayMs * (attempt + 1)
                    await new Promise(res => setTimeout(res, delayMs))
                    lastError = `Network error: ${err.message}`
                    continue
                }
                yield { type: EventType.Error, value: `Request failed: ${err.message}` }
                return
            }

            if (!response.ok) {
                const text = await response.text()
                if (this.isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
                    const delayMs = initialDelayMs * (attempt + 1)
                    await new Promise(res => setTimeout(res, delayMs))
                    lastError = `API error (${response.status}): ${text}`
                    continue
                }
                yield { type: EventType.Error, value: `API error (${response.status}) [${cfg.url}]: ${text}` }
                return
            }

            yield* this.parseSSEStream(response, signal)
            return
        }

        yield { type: EventType.Error, value: lastError || 'Request failed after all retries' }
    }

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

                    if (chunk.usage) {
                        const usage: TokensSummary = {
                            promptTokens: chunk.usage.prompt_tokens ?? 0,
                            completionTokens: chunk.usage.completion_tokens ?? 0,
                            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                            totalTokens: chunk.usage.total_tokens ?? 0,
                        }
                        yield { type: EventType.Usage, value: usage }
                    }

                    if (chunk.error) {
                        yield { type: EventType.Error, value: `API error: ${chunk.error.message || JSON.stringify(chunk.error)}` }
                        return
                    }

                    const choice = chunk.choices?.[0]
                    if (!choice) continue

                    if (choice.finish_reason) {
                        sawFinishReason = true
                    }

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

                    if (delta.content) {
                        sawContent = true
                        yield { type: EventType.Content, value: delta.content }
                    }

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

        for (const tc of pendingToolCalls.values()) {
            yield { type: EventType.ToolCall, value: tc }
        }
        yield { type: EventType.Finished, value: null }
    }
}

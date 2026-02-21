/**
 * Chat compression service — manages context window by summarizing old history.
 *
 * Mirrors gemini-cli's ChatCompressionService
 * (packages/core/src/services/chatCompressionService.ts)
 *
 * Strategy:
 * 1. Monitor token usage after each turn
 * 2. When history reaches threshold (50% of token limit), compress
 * 3. Keep recent 30% of messages, summarize older ones
 * 4. Use the LLM itself to generate a structured state snapshot
 */

import { AIService, ChatMessage } from '../ai.service'
import { PromptProvider } from '../promptProvider'

/** Compress when history reaches this fraction of token limit */
const COMPRESSION_TOKEN_THRESHOLD = 0.5
/** Preserve this fraction of recent messages after compression */
const COMPRESSION_PRESERVE_THRESHOLD = 0.3
/** Max tokens for tool response before truncation during compression */
const FUNCTION_RESPONSE_TOKEN_BUDGET = 50_000

export enum CompressionStatus {
    COMPRESSED = 1,
    NOOP,
    FAILED_INFLATED,
    FAILED_EMPTY,
    FAILED_ERROR,
}

export interface CompressionResult {
    status: CompressionStatus
    originalTokenEstimate: number
    newTokenEstimate: number
}

/**
 * Heuristic token estimator — mirrors gemini-cli's estimateTextTokens()
 * (packages/core/src/utils/tokenCalculation.ts)
 *
 * ASCII: ~0.25 tokens per char (4 chars per token)
 * Non-ASCII/CJK: ~1.3 tokens per char
 */
function estimateTokens (text: string): number {
    if (!text) return 0
    if (text.length > 100_000) return Math.ceil(text.length / 4)

    let tokens = 0
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code <= 0x7F) {
            tokens += 0.25
        } else {
            tokens += 1.3
        }
    }
    return Math.ceil(tokens)
}

/** Estimate total tokens for a message array */
function estimateMessagesTokens (messages: ChatMessage[]): number {
    let total = 0
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            total += estimateTokens(msg.content)
        }
        if (msg.tool_calls) {
            total += estimateTokens(JSON.stringify(msg.tool_calls))
        }
        total += 4 // message overhead
    }
    return total
}

/**
 * Find a safe split point for compression — split at user turn boundaries.
 * Mirrors gemini-cli's findCompressSplitPoint().
 */
function findCompressSplitPoint (messages: ChatMessage[], preserveCount: number): number {
    // Start from the target split point and walk backward to find a user message
    const targetSplit = messages.length - preserveCount
    for (let i = targetSplit; i >= 1; i--) {
        if (messages[i].role === 'user') {
            return i
        }
    }
    return Math.max(1, targetSplit) // Never split before system message
}

/**
 * Truncate large tool responses in older messages to save tokens.
 * Mirrors gemini-cli's truncateHistoryToBudget() "Reverse Token Budget" strategy.
 */
function truncateOldToolResponses (messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
        if (msg.role === 'tool' && typeof msg.content === 'string') {
            const tokens = estimateTokens(msg.content)
            if (tokens > FUNCTION_RESPONSE_TOKEN_BUDGET) {
                // Keep last 30 lines as a summary
                const lines = msg.content.split('\n')
                const truncated = lines.slice(-30).join('\n')
                return {
                    ...msg,
                    content: `[Content truncated — original ${lines.length} lines, ${tokens} estimated tokens. Last 30 lines preserved:]\n${truncated}`,
                }
            }
        }
        return msg
    })
}

/** The compression prompt — mirrors gemini-cli's getCompressionPrompt() */
const COMPRESSION_PROMPT = new PromptProvider().getCompressionPrompt()

export class ChatCompressionService {
    /** Default token limit — most models support at least 128K */
    private tokenLimit = 128_000

    constructor (
        private ai: AIService,
    ) {}

    /** Set the token limit based on model capabilities */
    setTokenLimit (limit: number): void {
        this.tokenLimit = limit
    }

    /**
     * Check if compression is needed and perform it if so.
     *
     * @param messages Full message array (including system message at index 0)
     * @param lastPromptTokens Token count from the last API response (if available)
     * @returns Updated messages array and compression info
     */
    async compress (
        messages: ChatMessage[],
        lastPromptTokens?: number,
        signal?: AbortSignal,
    ): Promise<{ messages: ChatMessage[]; result: CompressionResult }> {
        // Estimate current token usage
        const currentTokens = lastPromptTokens || estimateMessagesTokens(messages)
        const threshold = this.tokenLimit * COMPRESSION_TOKEN_THRESHOLD

        if (currentTokens < threshold) {
            return {
                messages,
                result: {
                    status: CompressionStatus.NOOP,
                    originalTokenEstimate: currentTokens,
                    newTokenEstimate: currentTokens,
                },
            }
        }

        // Calculate how many messages to preserve
        const preserveCount = Math.max(
            4, // At least 4 recent messages
            Math.floor(messages.length * COMPRESSION_PRESERVE_THRESHOLD),
        )

        // Find safe split point (at user turn boundary)
        const splitIndex = findCompressSplitPoint(messages, preserveCount)

        // Separate system message, old messages, and recent messages
        const systemMsg = messages[0]
        const oldMessages = messages.slice(1, splitIndex)
        const recentMessages = messages.slice(splitIndex)

        if (oldMessages.length < 4) {
            // Not enough old messages to compress
            return {
                messages,
                result: {
                    status: CompressionStatus.NOOP,
                    originalTokenEstimate: currentTokens,
                    newTokenEstimate: currentTokens,
                },
            }
        }

        // Truncate large tool responses in old messages before summarizing
        const truncatedOld = truncateOldToolResponses(oldMessages)

        // Build compression request
        const compressionMessages: ChatMessage[] = [
            { role: 'system', content: COMPRESSION_PROMPT },
            { role: 'user', content: 'Here is the conversation history to summarize:\n\n' + truncatedOld.map(m => `[${m.role}]: ${m.content || '(tool calls)'}`).join('\n\n') },
        ]

        try {
            // Use the AI service to generate the summary
            const summary = await this.ai.query(
                compressionMessages[1].content!,
                COMPRESSION_PROMPT,
            )

            if (!summary || summary.startsWith('Error:') || summary.length < 50) {
                return {
                    messages,
                    result: {
                        status: CompressionStatus.FAILED_EMPTY,
                        originalTokenEstimate: currentTokens,
                        newTokenEstimate: currentTokens,
                    },
                }
            }

            // Build new message array: system + summary + recent
            const summaryMessage: ChatMessage = {
                role: 'user',
                content: `[Previous conversation compressed into state snapshot]\n\n${summary}`,
            }

            const newMessages = [systemMsg, summaryMessage, ...recentMessages]
            const newTokens = estimateMessagesTokens(newMessages)

            // Check if compression actually helped
            if (newTokens >= currentTokens) {
                return {
                    messages,
                    result: {
                        status: CompressionStatus.FAILED_INFLATED,
                        originalTokenEstimate: currentTokens,
                        newTokenEstimate: newTokens,
                    },
                }
            }

            return {
                messages: newMessages,
                result: {
                    status: CompressionStatus.COMPRESSED,
                    originalTokenEstimate: currentTokens,
                    newTokenEstimate: newTokens,
                },
            }
        } catch {
            return {
                messages,
                result: {
                    status: CompressionStatus.FAILED_ERROR,
                    originalTokenEstimate: currentTokens,
                    newTokenEstimate: currentTokens,
                },
            }
        }
    }
}

export { estimateTokens, estimateMessagesTokens }

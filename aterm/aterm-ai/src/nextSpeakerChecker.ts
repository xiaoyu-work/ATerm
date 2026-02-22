/**
 * Next Speaker Check — ported from gemini-cli.
 * Source: gemini-cli/packages/core/src/utils/nextSpeakerChecker.ts
 *
 * When the model returns text without tool calls, this makes a lightweight
 * LLM call to determine if the model should continue or yield to the user.
 */

import { IAIService, ChatMessage } from './ai.service'

// === Ported from gemini-cli nextSpeakerChecker.ts lines 14-18 ===
const CHECK_PROMPT = `Analyze *only* the content and structure of your immediately preceding response (your last turn in the conversation history). Based *strictly* on that response, determine who should logically speak next: the 'user' or the 'model' (you).
**Decision Rules (apply in order):**
1.  **Model Continues:** If your last response explicitly states an immediate next action *you* intend to take (e.g., "Next, I will...", "Now I'll process...", "Moving on to analyze...", indicates an intended tool call that didn't execute), OR if the response seems clearly incomplete (cut off mid-thought without a natural conclusion), then the **'model'** should speak next.
2.  **Question to User:** If your last response ends with a direct question specifically addressed *to the user*, then the **'user'** should speak next.
3.  **Waiting for User:** If your last response completed a thought, statement, or task *and* does not meet the criteria for Rule 1 (Model Continues) or Rule 2 (Question to User), it implies a pause expecting user input or reaction. In this case, the **'user'** should speak next.

Respond with JSON: {"reasoning": "...", "next_speaker": "user" | "model"}`

export interface NextSpeakerResponse {
    reasoning: string
    next_speaker: 'user' | 'model'
}

/**
 * Check if the model should continue speaking.
 *
 * Adapted from gemini-cli — uses aterm-ai's IAIService.query() for a
 * lightweight non-streaming LLM call instead of BaseLlmClient.generateJson().
 */
export async function checkNextSpeaker (
    messages: ChatMessage[],
    ai: IAIService,
    signal: AbortSignal,
): Promise<NextSpeakerResponse | null> {
    if (messages.length === 0) return null

    // Short-circuit: if last message is a tool result, model should continue
    // (ported from gemini-cli lines 73-82)
    const last = messages[messages.length - 1]
    if (last.role === 'tool') {
        return { reasoning: 'Last message was a tool result.', next_speaker: 'model' }
    }

    // Only check when the last message is from the assistant
    if (last.role !== 'assistant') return null

    // If assistant message is empty, model should continue
    // (ported from gemini-cli lines 84-96)
    if (!last.content || (typeof last.content === 'string' && last.content.trim() === '')) {
        return { reasoning: 'Assistant message was empty.', next_speaker: 'model' }
    }

    if (signal.aborted) return null

    try {
        // Build a minimal context string from recent messages for the check call
        const recentMessages = messages.slice(-6)
        const contextString = recentMessages
            .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : '(tool call)'}`)
            .join('\n\n')

        // Use IAIService.query() for a non-streaming call
        const response = await ai.query(CHECK_PROMPT, contextString)

        // Parse JSON from response
        const jsonMatch = response.match(/\{[\s\S]*?"next_speaker"[\s\S]*?\}/)
        if (!jsonMatch) return null

        const parsed: NextSpeakerResponse = JSON.parse(jsonMatch[0])
        if (parsed.next_speaker === 'user' || parsed.next_speaker === 'model') {
            return parsed
        }
        return null
    } catch {
        // On any error, default to yielding to user (don't block the loop)
        return null
    }
}

/**
 * Tool executor — safe execution wrapper for tool invocations.
 *
 * Mirrors gemini-cli's ToolExecutor
 * (packages/core/src/scheduler/tool-executor.ts)
 *
 * Wraps invocation.execute() with error handling and cancellation support.
 */

import { ToolInvocation, ToolResult, ToolContext } from '../tools/types'

export class ToolExecutor {
    /**
     * Execute a tool invocation safely.
     * Catches errors and returns appropriate ToolResult.
     */
    async execute (invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
        try {
            return await invocation.execute(context)
        } catch (err: any) {
            if (err.name === 'AbortError' || context.signal.aborted) {
                return {
                    llmContent: 'Tool execution was cancelled.',
                    error: 'Cancelled',
                }
            }
            return {
                llmContent: `Error: ${err.message}`,
                error: err.message,
            }
        }
    }
}

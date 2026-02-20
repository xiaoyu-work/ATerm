/**
 * Abstract base class for tool invocations.
 *
 * Mirrors gemini-cli's BaseToolInvocation
 * (packages/core/src/tools/tools.ts L290-430)
 *
 * Provides:
 * - Default shouldConfirmExecute() based on ToolKind
 * - Helper methods for creating ToolResult
 */

import { ToolInvocation, ToolResult, ToolContext, ToolKind } from '../types'

export abstract class BaseToolInvocation<TParams = unknown>
    implements ToolInvocation<TParams> {

    constructor (
        public readonly params: TParams,
        public readonly kind: ToolKind,
    ) {}

    abstract getDescription (): string
    abstract execute (context: ToolContext): Promise<ToolResult>

    /**
     * Default policy: read-only/search/think/communicate/plan tools auto-approve,
     * everything else requires user confirmation.
     *
     * Mirrors gemini-cli's getMessageBusDecision() simplified logic.
     */
    shouldConfirmExecute (): boolean {
        switch (this.kind) {
            case ToolKind.Read:
            case ToolKind.Search:
            case ToolKind.Think:
            case ToolKind.Communicate:
            case ToolKind.Plan:
                return false
            default:
                return true
        }
    }

    /** Helper: create a success ToolResult */
    protected success (llmContent: string, data?: Record<string, unknown>): ToolResult {
        return { llmContent, data }
    }

    /** Helper: create an error ToolResult */
    protected error (message: string): ToolResult {
        return { llmContent: `Error: ${message}`, error: message }
    }
}

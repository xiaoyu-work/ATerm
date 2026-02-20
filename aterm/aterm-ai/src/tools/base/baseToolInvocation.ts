/**
 * Abstract base class for tool invocations.
 *
 * Mirrors gemini-cli's BaseToolInvocation
 * (packages/core/src/tools/tools.ts L290-430)
 *
 * Provides:
 * - Default getConfirmationDetails() returning false (no confirmation needed)
 * - Helper methods for creating ToolResult
 *
 * Subclasses override getConfirmationDetails() to provide tool-specific
 * confirmation details (path access, shell commands, edits).
 */

import { ToolInvocation, ToolResult, ToolContext, ToolKind, ConfirmationDetails } from '../types'

export abstract class BaseToolInvocation<TParams = unknown>
    implements ToolInvocation<TParams> {

    constructor (
        public readonly params: TParams,
        public readonly kind: ToolKind,
    ) {}

    abstract getDescription (): string
    abstract execute (context: ToolContext): Promise<ToolResult>

    /**
     * Return confirmation details if this invocation requires user approval.
     *
     * Mirrors gemini-cli's getConfirmationDetails()
     * (packages/core/src/tools/tools.ts L350-380)
     *
     * Default: no confirmation needed. Subclasses override for:
     * - Shell commands → { type: 'exec', command }
     * - Path access outside CWD → { type: 'path_access', resolvedPath }
     * - File edits → { type: 'edit', filePath }
     */
    getConfirmationDetails (_context: ToolContext): ConfirmationDetails | false {
        return false
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

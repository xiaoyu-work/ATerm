/**
 * Session-level path approval tracker.
 *
 * Tracks whether the user has approved accessing files outside the CWD.
 * Lives on AIMiddleware (per-terminal-session) and is passed to tools
 * via ToolContext.
 *
 * When a tool requests access to a file outside CWD:
 * - If isAllowed() → auto-approve (user previously chose "always")
 * - Otherwise → tool triggers interactive confirmation
 * - If user chooses "always" → approveAll() is called
 */
export class PathApprovalTracker {
    private _allowAll = false

    /** Whether all outside-CWD paths are currently auto-approved */
    isAllowed (): boolean {
        return this._allowAll
    }

    /** Mark all outside-CWD paths as approved for this session */
    approveAll (): void {
        this._allowAll = true
    }
}

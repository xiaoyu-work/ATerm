/**
 * Session-level approval tracker.
 *
 * Tracks approvals that should persist only for the current terminal session.
 * Lives on AIMiddleware (per-terminal-session) and is passed to tools
 * via ToolContext.
 *
 * Current tracked approvals:
 * - path access outside the CWD
 * - edit confirmations when the user chose "always"
 */
export class PathApprovalTracker {
    private _allowAll = false
    private _allowEdits = false

    /** Whether all outside-CWD paths are currently auto-approved */
    isAllowed (): boolean {
        return this._allowAll
    }

    /** Mark all outside-CWD paths as approved for this session */
    approveAll (): void {
        this._allowAll = true
    }

    /** Whether edit confirmations are auto-approved for this session */
    areEditsAllowed (): boolean {
        return this._allowEdits
    }

    /** Mark edits as approved for this session */
    approveEdits (): void {
        this._allowEdits = true
    }
}

/**
 * Policy checking and policy updates for tool confirmation.
 *
 * Mirrors gemini-cli's:
 * - packages/core/src/scheduler/policy.ts (checkPolicy, updatePolicy)
 * - packages/core/src/policy/types.ts (PolicyDecision)
 *
 * Determines whether a tool invocation should auto-approve, ask user,
 * or be denied based on confirmation details and session state.
 */

import { ToolInvocation, ConfirmationDetails, ConfirmationOutcome } from '../tools/types'
import { PathApprovalTracker } from '../tools/pathApprovals'

// ─── Policy Decision ─────────────────────────────────────────────────
// Mirrors gemini-cli's PolicyDecision (packages/core/src/policy/types.ts)

export enum PolicyDecision {
    /** Tool is denied — do not execute */
    Deny = 'deny',
    /** Ask the user for approval */
    AskUser = 'ask_user',
    /** Auto-approve without asking */
    Auto = 'auto',
}

/**
 * Check the policy for a tool invocation.
 *
 * Mirrors gemini-cli's checkPolicy()
 * (packages/core/src/scheduler/policy.ts)
 *
 * Decision logic:
 * - No confirmation details → Auto (no user interaction needed)
 * - path_access with session-approved → Auto (user already chose "always")
 * - Otherwise → AskUser
 */
export function checkPolicy (
    details: ConfirmationDetails | false,
    _invocation: ToolInvocation,
    pathApprovals: PathApprovalTracker,
): PolicyDecision {
    if (!details) {
        return PolicyDecision.Auto
    }

    // Path access already approved for this session
    if (details.type === 'path_access' && pathApprovals.isAllowed()) {
        return PolicyDecision.Auto
    }

    return PolicyDecision.AskUser
}

/**
 * Update policy state after user confirmation.
 *
 * Mirrors gemini-cli's updatePolicy()
 * (packages/core/src/scheduler/policy.ts)
 *
 * Handles "always allow" transitions:
 * - path_access + ProceedAlways → pathApprovals.approveAll()
 *
 * Future extensions (matching gemini-cli patterns):
 * - edit + ProceedAlways → setApprovalMode(AUTO_EDIT)
 * - exec + ProceedAlways → addCommandPrefixRule(command)
 */
export function updatePolicy (
    outcome: ConfirmationOutcome,
    details: ConfirmationDetails,
    pathApprovals: PathApprovalTracker,
): void {
    if (outcome !== ConfirmationOutcome.ProceedAlways) return

    switch (details.type) {
        case 'path_access':
            pathApprovals.approveAll()
            break
    }
}

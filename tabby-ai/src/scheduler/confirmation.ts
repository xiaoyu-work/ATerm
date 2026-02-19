/**
 * Policy checking and confirmation resolution.
 *
 * Mirrors gemini-cli's:
 * - packages/core/src/scheduler/policy.ts (checkPolicy)
 * - packages/core/src/scheduler/confirmation.ts (resolveConfirmation, awaitConfirmation)
 *
 * Simplified: no ModifyWithEditor/ModifyInline, only ProceedOnce/Cancel.
 */

import { ToolInvocation, PolicyDecision, ConfirmationOutcome } from '../tools/types'
import {
    MessageBus,
    MessageBusEvent,
    ToolConfirmationRequest,
    ToolConfirmationResponse,
} from '../messageBus'

/**
 * Check the default policy for a tool invocation.
 *
 * Mirrors gemini-cli's checkPolicy():
 * - If the tool does not require confirmation → Auto
 * - Otherwise → AskUser
 */
export function checkPolicy (invocation: ToolInvocation): PolicyDecision {
    if (!invocation.shouldConfirmExecute()) {
        return PolicyDecision.Auto
    }
    return PolicyDecision.AskUser
}

/**
 * Request user confirmation via the message bus.
 *
 * Mirrors gemini-cli's resolveConfirmation() + awaitConfirmation():
 * - Publishes TOOL_CONFIRMATION_REQUEST
 * - Waits for TOOL_CONFIRMATION_RESPONSE with matching callId
 * - Returns the user's decision
 */
export async function resolveConfirmation (
    callId: string,
    toolName: string,
    description: string,
    bus: MessageBus,
): Promise<ConfirmationOutcome> {
    // Publish confirmation request
    bus.emit<ToolConfirmationRequest>(MessageBusEvent.TOOL_CONFIRMATION_REQUEST, {
        callId,
        toolName,
        description,
    })

    // Wait for response matching this callId
    const response = await bus.waitFor<ToolConfirmationResponse>(
        MessageBusEvent.TOOL_CONFIRMATION_RESPONSE,
        (r) => r.callId === callId,
    )

    return response.outcome
}

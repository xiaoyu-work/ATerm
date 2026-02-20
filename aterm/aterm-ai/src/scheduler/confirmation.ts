/**
 * Confirmation resolution — sends structured details to UI, waits for response.
 *
 * Mirrors gemini-cli's:
 * - packages/core/src/scheduler/confirmation.ts (resolveConfirmation, awaitConfirmation)
 *
 * Policy checking has been extracted to scheduler/policy.ts.
 */

import { ConfirmationDetails, ConfirmationOutcome } from '../tools/types'
import {
    MessageBus,
    MessageBusEvent,
    ToolConfirmationRequest,
    ToolConfirmationResponse,
} from '../messageBus'

/**
 * Request user confirmation via the message bus.
 *
 * Mirrors gemini-cli's resolveConfirmation() + awaitConfirmation()
 * (packages/core/src/scheduler/confirmation.ts)
 *
 * Publishes structured ConfirmationDetails to the UI layer,
 * then waits for the user's response.
 */
export async function resolveConfirmation (
    callId: string,
    details: ConfirmationDetails,
    bus: MessageBus,
): Promise<ConfirmationOutcome> {
    // Publish confirmation request with structured details
    bus.emit<ToolConfirmationRequest>(MessageBusEvent.TOOL_CONFIRMATION_REQUEST, {
        callId,
        details,
    })

    // Wait for response matching this callId
    // Mirrors gemini-cli's awaitConfirmation() — races MessageBus listener
    const response = await bus.waitFor<ToolConfirmationResponse>(
        MessageBusEvent.TOOL_CONFIRMATION_RESPONSE,
        (r) => r.callId === callId,
    )

    return response.outcome
}

/**
 * Exit plan mode tool.
 *
 * Mirrors gemini-cli's ExitPlanModeTool
 * (packages/core/src/tools/definitions/exit-plan-mode.ts)
 *
 * Presents plan summary and asks for user approval before
 * unlocking write tools. Uses confirmation flow.
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult, ConfirmationOutcome } from '../types'
import { MessageBusEvent, ToolConfirmationRequest, ToolConfirmationResponse } from '../../messageBus'

export interface ExitPlanModeToolParams {
    summary: string
}

class ExitPlanModeToolInvocation extends BaseToolInvocation<ExitPlanModeToolParams> {
    constructor (params: ExitPlanModeToolParams) {
        super(params, ToolKind.Plan)
    }

    getDescription (): string {
        return 'Exit plan mode — approve plan'
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        // Show plan summary
        context.callbacks.onContent(`\n📋 Plan Summary:\n${this.params.summary}\n`)

        // Ask for approval via the message bus
        const callId = `plan_${Date.now()}`
        context.bus.emit<ToolConfirmationRequest>(MessageBusEvent.TOOL_CONFIRMATION_REQUEST, {
            callId,
            details: { type: 'edit', title: 'Approve plan', filePath: 'plan' },
        })

        const response = await context.bus.waitFor<ToolConfirmationResponse>(
            MessageBusEvent.TOOL_CONFIRMATION_RESPONSE,
            (r) => r.callId === callId,
        )

        if (response.outcome === ConfirmationOutcome.Cancel) {
            return this.success('Plan not approved. Still in plan mode. Revise your plan or ask the user for clarification.')
        }

        return this.success(
            'Plan approved. Exiting plan mode — all tools now available. Proceed with execution.',
            { planMode: false },
        )
    }
}

export class ExitPlanModeTool extends DeclarativeTool<ExitPlanModeToolParams> {
    readonly name = 'exit_plan_mode'
    readonly displayName = 'Exit Plan Mode'
    readonly description = 'Signals that the planning phase is complete and requests user approval to start implementation. Call this after you have explored the codebase and formulated your implementation plan. Present a brief summary and the user will be asked to approve before you proceed with execution. If rejected, iterate on the plan.'
    readonly kind = ToolKind.Plan
    readonly parameters = {
        summary: {
            type: 'string',
            description: 'A brief summary of the plan for the user to review',
        },
    }
    readonly required = ['summary']

    protected createInvocation (params: ExitPlanModeToolParams, _context: ToolContext): ExitPlanModeToolInvocation {
        return new ExitPlanModeToolInvocation(params)
    }
}

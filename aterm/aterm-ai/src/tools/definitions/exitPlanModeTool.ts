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
import * as fs from 'fs/promises'
import * as path from 'path'

export interface ExitPlanModeToolParams {
    plan_path?: string
    summary?: string
}

class ExitPlanModeToolInvocation extends BaseToolInvocation<ExitPlanModeToolParams> {
    constructor (params: ExitPlanModeToolParams) {
        super(params, ToolKind.Plan)
    }

    getDescription (): string {
        return 'Exit plan mode - approve plan'
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        let summary = (this.params.summary || '').trim()

        if (this.params.plan_path) {
            const resolved = path.resolve(context.cwd, this.params.plan_path)
            try {
                summary = (await fs.readFile(resolved, 'utf-8')).trim()
            } catch (err: any) {
                return this.error(`Failed to read plan_path "${this.params.plan_path}": ${err.message}`)
            }
        }

        if (!summary) {
            return this.error('Missing plan content. Provide plan_path (preferred) or summary.')
        }

        // Show plan summary
        context.callbacks.onContent(`\n📋 Plan Summary:\n${summary}\n`)

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
        plan_path: {
            type: 'string',
            description: 'Path to a markdown plan file for user approval.',
        },
        summary: {
            type: 'string',
            description: 'Compatibility fallback: inline summary of the plan.',
        },
    }
    readonly required = ['plan_path']

    protected createInvocation (params: ExitPlanModeToolParams, _context: ToolContext): ExitPlanModeToolInvocation {
        return new ExitPlanModeToolInvocation(params)
    }
}

/**
 * Enter plan mode tool.
 *
 * Mirrors gemini-cli's EnterPlanModeTool
 * (packages/core/src/tools/definitions/enter-plan-mode.ts)
 *
 * Signals the agent loop to restrict tools to read-only subset.
 * Uses data.planMode to communicate state change to AgentLoop.
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'

export interface EnterPlanModeToolParams {
    reason: string
}

class EnterPlanModeToolInvocation extends BaseToolInvocation<EnterPlanModeToolParams> {
    constructor (params: EnterPlanModeToolParams) {
        super(params, ToolKind.Plan)
    }

    getDescription (): string {
        return `Enter plan mode: ${this.params.reason}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        context.callbacks.onContent(
            `\n📋 Plan mode ON: ${this.params.reason}\n(Only read-only tools available. Use exit_plan_mode when ready.)\n`,
        )
        return this.success(
            'Entered plan mode. You can now only use read-only tools (read_file, list_directory, glob, grep_search, ask_user, save_memory, write_todos). When your plan is ready, call exit_plan_mode with a summary.',
            { planMode: true },
        )
    }
}

export class EnterPlanModeTool extends DeclarativeTool<EnterPlanModeToolParams> {
    readonly name = 'enter_plan_mode'
    readonly displayName = 'Enter Plan Mode'
    readonly description = 'Enter planning mode for complex, broad-scope, or ambiguous tasks. In plan mode, you can only use read-only tools to explore the codebase and must produce a detailed implementation plan before making changes. Use this BEFORE making changes when the task involves creating a new feature, complex refactoring, or system-wide analysis. Do NOT use this for straightforward bug fixes or simple questions.'
    readonly kind = ToolKind.Plan
    readonly parameters = {
        reason: {
            type: 'string',
            description: 'Brief explanation of why planning is needed',
        },
    }
    readonly required = ['reason']

    protected createInvocation (params: EnterPlanModeToolParams, _context: ToolContext): EnterPlanModeToolInvocation {
        return new EnterPlanModeToolInvocation(params)
    }
}

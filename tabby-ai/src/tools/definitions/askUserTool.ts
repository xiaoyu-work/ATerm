/**
 * Ask user tool — prompts the user for free-text input.
 *
 * Mirrors gemini-cli's AskUserTool
 * (packages/core/src/tools/definitions/ask-user.ts)
 *
 * Uses MessageBus for async communication with the UI layer.
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { MessageBusEvent, AskUserRequest, AskUserResponse } from '../../messageBus'

export interface AskUserToolParams {
    question: string
}

class AskUserToolInvocation extends BaseToolInvocation<AskUserToolParams> {
    constructor (params: AskUserToolParams) {
        super(params, ToolKind.Communicate)
    }

    getDescription (): string {
        return `Ask user: ${this.params.question}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        // Emit request on the bus
        context.bus.emit<AskUserRequest>(MessageBusEvent.ASK_USER_REQUEST, {
            requestId,
            question: this.params.question,
        })

        // Wait for the response
        const response = await context.bus.waitFor<AskUserResponse>(
            MessageBusEvent.ASK_USER_RESPONSE,
            (r) => r.requestId === requestId,
        )

        return this.success(response.response || '(no response)')
    }
}

export class AskUserTool extends DeclarativeTool<AskUserToolParams> {
    readonly name = 'ask_user'
    readonly displayName = 'Ask User'
    readonly description = 'Ask the user a clarifying question when you need more information to proceed. Use this when the request is ambiguous, critically underspecified, or when a wrong decision would cause significant re-work. Do NOT use this for routine confirmations — those are handled automatically by tool approval.'
    readonly kind = ToolKind.Communicate
    readonly parameters = {
        question: {
            type: 'string',
            description: 'The question to ask the user',
        },
    }
    readonly required = ['question']

    protected createInvocation (params: AskUserToolParams, _context: ToolContext): AskUserToolInvocation {
        return new AskUserToolInvocation(params)
    }
}

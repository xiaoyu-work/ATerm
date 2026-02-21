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

interface AskUserOption {
    label: string
    description?: string
}

interface AskUserQuestion {
    header?: string
    question: string
    options?: AskUserOption[]
}

export interface AskUserToolParams {
    question?: string
    questions?: AskUserQuestion[]
}

class AskUserToolInvocation extends BaseToolInvocation<AskUserToolParams> {
    constructor (params: AskUserToolParams) {
        super(params, ToolKind.Communicate)
    }

    getDescription (): string {
        const firstQuestion = this.params.questions?.[0]?.question || this.params.question || ''
        return `Ask user: ${firstQuestion}`
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const questions = this.params.questions && this.params.questions.length > 0
            ? this.params.questions
            : this.params.question
                ? [{ question: this.params.question }]
                : []

        if (questions.length === 0) {
            return this.error('At least one question is required.')
        }

        const promptText = questions.map((q, index) => {
            const title = q.header ? `${q.header}: ` : ''
            const base = `${index + 1}. ${title}${q.question}`
            if (!q.options || q.options.length === 0) {
                return base
            }
            const options = q.options
                .map((opt, optIndex) => `   ${optIndex + 1}) ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`)
                .join('\n')
            return `${base}\n${options}`
        }).join('\n\n')

        const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        // Emit request on the bus
        context.bus.emit<AskUserRequest>(MessageBusEvent.ASK_USER_REQUEST, {
            requestId,
            question: promptText,
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
        questions: {
            type: 'array',
            description: 'The list of questions to ask the user.',
            items: {
                type: 'object',
                properties: {
                    header: { type: 'string', description: 'Short header for this question.' },
                    question: { type: 'string', description: 'The question text.' },
                    options: {
                        type: 'array',
                        description: 'Optional choice options.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string' },
                                description: { type: 'string' },
                            },
                            required: ['label'],
                        },
                    },
                },
                required: ['question'],
            },
        },
        question: {
            type: 'string',
            description: 'Backward-compatible single question field.',
        },
    }
    readonly required: string[] = []

    protected override validateToolParamValues (params: AskUserToolParams): string | null {
        const hasSingle = typeof params.question === 'string' && params.question.trim().length > 0
        const hasList = Array.isArray(params.questions) && params.questions.length > 0
        if (!hasSingle && !hasList) {
            return 'At least one question is required.'
        }
        return null
    }

    protected createInvocation (params: AskUserToolParams, _context: ToolContext): AskUserToolInvocation {
        return new AskUserToolInvocation(params)
    }
}

/**
 * Write todos tool — creates/updates a task list.
 *
 * Mirrors gemini-cli's WriteTodosTool
 * (packages/core/src/tools/definitions/write-todos.ts)
 *
 * Displays a formatted task list in the terminal.
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'

export interface TodoItem {
    task: string
    status: 'pending' | 'in_progress' | 'done'
}

export interface WriteTodosToolParams {
    todos: TodoItem[]
}

class WriteTodosToolInvocation extends BaseToolInvocation<WriteTodosToolParams> {
    constructor (params: WriteTodosToolParams) {
        super(params, ToolKind.Other)
    }

    getDescription (): string {
        return `Update ${this.params.todos.length} todo(s)`
    }

    /** Todos don't require confirmation */
    override shouldConfirmExecute (): boolean {
        return false
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        if (!this.params.todos || this.params.todos.length === 0) {
            return this.success('No todos provided.')
        }

        const statusIcons: Record<string, string> = {
            pending: '[ ]',
            in_progress: '[~]',
            done: '[x]',
        }

        const lines = this.params.todos.map(t => {
            const icon = statusIcons[t.status] || '[ ]'
            return `${icon} ${t.task}`
        })

        const display = '\n--- Tasks ---\n' + lines.join('\n') + '\n-------------\n'
        context.callbacks.onContent(display)

        return this.success(`Updated ${this.params.todos.length} todo(s).`)
    }
}

export class WriteTodosTool extends DeclarativeTool<WriteTodosToolParams> {
    readonly name = 'write_todos'
    readonly displayName = 'Write Todos'
    readonly description = 'Create or update a task list to track progress on complex multi-step tasks. Each todo has a task description and status. Use this to break down complex requests into trackable subtasks.'
    readonly kind = ToolKind.Other
    readonly parameters = {
        todos: {
            type: 'array',
            description: 'List of todo items',
            items: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Description of the task' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Current status' },
                },
                required: ['task', 'status'],
            },
        },
    }
    readonly required = ['todos']

    protected createInvocation (params: WriteTodosToolParams, _context: ToolContext): WriteTodosToolInvocation {
        return new WriteTodosToolInvocation(params)
    }
}

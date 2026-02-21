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
    description: string
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
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

    async execute (context: ToolContext): Promise<ToolResult> {
        if (!this.params.todos || this.params.todos.length === 0) {
            return this.success('No todos provided.')
        }

        const statusIcons: Record<string, string> = {
            pending: '[ ]',
            in_progress: '[~]',
            completed: '[x]',
            cancelled: '[-]',
        }

        const lines = this.params.todos.map(t => {
            const icon = statusIcons[t.status] || '[ ]'
            return `${icon} ${t.description}`
        })

        const display = '\n--- Tasks ---\n' + lines.join('\n') + '\n-------------\n'
        context.callbacks.onContent(display)

        return this.success(`Updated ${this.params.todos.length} todo(s).`)
    }
}

export class WriteTodosTool extends DeclarativeTool<WriteTodosToolParams> {
    readonly name = 'write_todos'
    readonly displayName = 'Write Todos'
    readonly description = `Lists out the current subtasks required to complete a given user request. Helps track progress, organize complex queries, and ensure no steps are missed. The user can also see your current progress.

Use this tool for complex queries that require multiple steps. If the request is actually complex after starting, create a todo list. DO NOT use this for simple tasks that can be completed in less than 2 steps.

**Task state definitions**:
- pending: Work has not begun on a given subtask.
- in_progress: Marked just prior to beginning work. Only one subtask should be in_progress at a time.
- completed: Subtask was successfully completed with no errors or issues.
- cancelled: Subtask is no longer needed due to the dynamic nature of the task.

**Methodology**:
1. Use this todo list as soon as you receive a complex request.
2. Keep track of every subtask.
3. Mark a subtask as in_progress before you begin working on it.
4. Update the subtask list as you proceed — it should reflect your progress and current plans.
5. Mark a subtask as completed when done.
6. Mark a subtask as cancelled if no longer needed.
7. Update the todo list immediately when you start, stop, or cancel a subtask.`
    readonly kind = ToolKind.Other
    readonly parameters = {
        todos: {
            type: 'array',
            description: 'The complete list of todo items. This will replace the existing list.',
            items: {
                type: 'object',
                properties: {
                    description: { type: 'string', description: 'The description of the task.' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'The current status of the task.' },
                },
                required: ['description', 'status'],
            },
        },
    }
    readonly required = ['todos']

    protected override validateToolParamValues (params: WriteTodosToolParams): string | null {
        if (!params || !Array.isArray(params.todos)) {
            return '`todos` parameter must be an array'
        }
        for (const todo of params.todos) {
            if (!todo || typeof todo.description !== 'string' || !todo.description.trim()) {
                return 'Each todo must have a non-empty description string'
            }
            if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(todo.status)) {
                return 'Each todo must have a valid status (pending, in_progress, completed, cancelled)'
            }
        }
        const inProgressCount = params.todos.filter(t => t.status === 'in_progress').length
        if (inProgressCount > 1) {
            return 'Only one task can be in_progress at a time.'
        }
        return null
    }

    protected createInvocation (params: WriteTodosToolParams, _context: ToolContext): WriteTodosToolInvocation {
        return new WriteTodosToolInvocation(params)
    }
}

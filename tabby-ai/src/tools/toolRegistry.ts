/**
 * Central tool registry — maps tool names to their builders.
 *
 * Mirrors gemini-cli's coreTools.ts tool registration pattern
 * (packages/core/src/tools/definitions/coreTools.ts)
 */

import { ToolDefinition } from '../ai.service'
import { ToolBuilder } from './types'

export class ToolRegistry {
    private builders = new Map<string, ToolBuilder>()

    /** Register a tool builder */
    register (builder: ToolBuilder): void {
        this.builders.set(builder.name, builder)
    }

    /** Get a tool builder by name */
    get (name: string): ToolBuilder | undefined {
        return this.builders.get(name)
    }

    /** Get all registered tool builders */
    getAll (): ToolBuilder[] {
        return Array.from(this.builders.values())
    }

    /** Get OpenAI ToolDefinition schemas for all registered tools */
    getSchemas (): ToolDefinition[] {
        return this.getAll().map(b => b.getSchema())
    }

    /** Get schemas filtered by a set of allowed tool names (for plan mode) */
    getSchemasFiltered (allowedNames: Set<string>): ToolDefinition[] {
        return this.getAll()
            .filter(b => allowedNames.has(b.name))
            .map(b => b.getSchema())
    }
}

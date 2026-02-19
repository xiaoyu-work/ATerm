/**
 * Abstract base class for declarative tool definitions.
 *
 * Mirrors gemini-cli's DeclarativeTool + BaseDeclarativeTool
 * (packages/core/src/tools/tools.ts L432-565)
 *
 * Subclasses define metadata (name, description, kind, parameters)
 * and implement createInvocation(). The base handles:
 * - Schema generation (getSchema → OpenAI ToolDefinition format)
 * - Argument parsing and validation (build → parseAndValidate → createInvocation)
 */

import { ToolDefinition } from '../../ai.service'
import { ToolBuilder, ToolInvocation, ToolContext, ToolKind } from '../types'
import { BaseToolInvocation } from './baseToolInvocation'

export abstract class DeclarativeTool<TParams = unknown>
    implements ToolBuilder<TParams> {

    abstract readonly name: string
    abstract readonly displayName: string
    abstract readonly description: string
    abstract readonly kind: ToolKind

    /** JSON Schema "properties" for the tool parameters */
    abstract readonly parameters: Record<string, unknown>
    /** Required parameter names */
    abstract readonly required: string[]

    /**
     * Generate an OpenAI-compatible ToolDefinition.
     * Mirrors gemini-cli's getSchema() → FunctionDeclaration,
     * adapted for OpenAI format.
     */
    getSchema (): ToolDefinition {
        return {
            type: 'function',
            function: {
                name: this.name,
                description: this.description,
                parameters: {
                    type: 'object',
                    properties: this.parameters,
                    required: this.required,
                },
            },
        }
    }

    /**
     * Build an invocation from raw JSON arguments.
     * Mirrors gemini-cli's BaseDeclarativeTool.build():
     *   validateToolParams → createInvocation
     */
    build (rawArgs: string, context: ToolContext): ToolInvocation<TParams> {
        const params = this.parseAndValidate(rawArgs)
        return this.createInvocation(params, context)
    }

    /**
     * Create the concrete invocation. Subclasses must implement.
     * Mirrors gemini-cli's BaseDeclarativeTool.createInvocation().
     */
    protected abstract createInvocation (
        params: TParams,
        context: ToolContext,
    ): BaseToolInvocation<TParams>

    /**
     * Optional custom validation. Override in subclasses.
     * Mirrors gemini-cli's DeclarativeTool.validateToolParams().
     * Return null if valid, error string if invalid.
     */
    protected validateToolParamValues (_params: TParams): string | null {
        return null
    }

    /**
     * Parse JSON args and validate required fields.
     * Mirrors gemini-cli's BaseDeclarativeTool.validateToolParams():
     *   SchemaValidator.validate() + validateToolParamValues()
     */
    private parseAndValidate (rawArgs: string): TParams {
        let parsed: any
        try {
            parsed = JSON.parse(rawArgs)
        } catch {
            throw new Error(`Invalid tool arguments: ${rawArgs}`)
        }

        // Validate required fields
        for (const field of this.required) {
            if (parsed[field] === undefined || parsed[field] === null) {
                throw new Error(`Missing required parameter: ${field}`)
            }
        }

        // Custom validation
        const customError = this.validateToolParamValues(parsed as TParams)
        if (customError) {
            throw new Error(customError)
        }

        return parsed as TParams
    }
}

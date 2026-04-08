/**
 * MCP Tool Bridge — wraps MCP tools as ATerm ToolBuilder instances.
 *
 * Each MCP tool is wrapped into a ToolBuilder that:
 * - Generates an OpenAI-compatible ToolDefinition schema
 * - Builds invocations that call the MCP server via MCPClientManager
 * - Uses ToolKind.Other (no confirmation needed — MCP servers handle safety)
 */

import { ToolDefinition } from '../ai.service'
import { ToolBuilder, ToolInvocation, ToolContext, ToolKind, ToolResult, ConfirmationDetails } from '../tools/types'
import { MCPClientManager, MCPToolInfo } from './mcpClientManager'

class MCPToolInvocation implements ToolInvocation<Record<string, unknown>> {
    readonly kind = ToolKind.Other

    constructor (
        public readonly params: Record<string, unknown>,
        private readonly toolInfo: MCPToolInfo,
        private readonly mcpManager: MCPClientManager,
    ) {}

    getDescription (): string {
        return `[${this.toolInfo.serverName}] ${this.toolInfo.name}`
    }

    getConfirmationDetails (_context: ToolContext): ConfirmationDetails | false {
        return false
    }

    async execute (_context: ToolContext): Promise<ToolResult> {
        try {
            const result = await this.mcpManager.callTool(
                this.toolInfo.serverName,
                this.toolInfo.name,
                this.params,
            )
            return { llmContent: result || '(no output)' }
        } catch (err: any) {
            return { llmContent: `Error: ${err.message}`, error: err.message }
        }
    }
}

export class MCPToolBridge implements ToolBuilder<Record<string, unknown>> {
    readonly name: string
    readonly displayName: string
    readonly description: string
    readonly kind = ToolKind.Other

    constructor (
        private readonly toolInfo: MCPToolInfo,
        private readonly mcpManager: MCPClientManager,
    ) {
        // Prefix with server name to avoid collisions with built-in tools
        this.name = `mcp_${toolInfo.serverName}_${toolInfo.name}`
        this.displayName = `${toolInfo.name} (${toolInfo.serverName})`
        this.description = toolInfo.description || `MCP tool "${toolInfo.name}" from server "${toolInfo.serverName}"`
    }

    getSchema (): ToolDefinition {
        const schema = this.toolInfo.inputSchema
        return {
            type: 'function',
            function: {
                name: this.name,
                description: this.description,
                parameters: schema,
            },
        }
    }

    build (rawArgs: string, _context: ToolContext): ToolInvocation<Record<string, unknown>> {
        let params: Record<string, unknown>
        try {
            params = JSON.parse(rawArgs)
        } catch {
            params = {}
        }
        return new MCPToolInvocation(params, this.toolInfo, this.mcpManager)
    }
}

/**
 * Create ToolBuilder instances for all tools from a connected MCPClientManager.
 */
export function createMCPToolBuilders (mcpManager: MCPClientManager): MCPToolBridge[] {
    return mcpManager.getAllTools().map(toolInfo => new MCPToolBridge(toolInfo, mcpManager))
}

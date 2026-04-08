/**
 * MCP Client Manager — manages connections to MCP servers.
 *
 * Each configured MCP server gets its own Client instance.
 * Supports stdio (local process) and Streamable HTTP transports.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface MCPServerConfig {
    name: string
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    enabled: boolean
}

export interface MCPToolInfo {
    /** MCP server name this tool belongs to */
    serverName: string
    /** Tool name as declared by the MCP server */
    name: string
    /** Tool description */
    description: string
    /** JSON Schema for the tool's input parameters */
    inputSchema: Record<string, unknown>
}

interface ManagedServer {
    config: MCPServerConfig
    client: Client
    transport: StdioClientTransport | StreamableHTTPClientTransport
    tools: MCPToolInfo[]
}

export class MCPClientManager {
    private servers = new Map<string, ManagedServer>()

    /**
     * Initialize all enabled MCP servers from config.
     * Connects to each server and discovers available tools.
     */
    async initialize (configs: MCPServerConfig[]): Promise<void> {
        const enabled = configs.filter(c => c.enabled)

        await Promise.all(enabled.map(async (cfg) => {
            try {
                await this.connectServer(cfg)
            } catch (err: any) {
                process.stderr.write(`[MCP] Failed to connect to "${cfg.name}": ${err.message}\n`)
            }
        }))
    }

    private async connectServer (cfg: MCPServerConfig): Promise<void> {
        const client = new Client({
            name: 'aterm',
            version: '1.0.0',
        })

        let transport: StdioClientTransport | StreamableHTTPClientTransport

        if (cfg.transport === 'stdio') {
            if (!cfg.command) {
                throw new Error(`MCP server "${cfg.name}": stdio transport requires a command`)
            }
            transport = new StdioClientTransport({
                command: cfg.command,
                args: cfg.args || [],
                env: { ...process.env, ...(cfg.env || {}) } as Record<string, string>,
            })
        } else {
            if (!cfg.url) {
                throw new Error(`MCP server "${cfg.name}": http transport requires a url`)
            }
            transport = new StreamableHTTPClientTransport(
                new URL(cfg.url),
            )
        }

        await client.connect(transport)

        // Discover tools
        const { tools: mcpTools } = await client.listTools()

        const tools: MCPToolInfo[] = (mcpTools || []).map(t => ({
            serverName: cfg.name,
            name: t.name,
            description: t.description || '',
            inputSchema: (t.inputSchema || { type: 'object', properties: {} }) as Record<string, unknown>,
        }))

        this.servers.set(cfg.name, { config: cfg, client, transport, tools })
    }

    /** Get all discovered tools across all connected servers */
    getAllTools (): MCPToolInfo[] {
        const allTools: MCPToolInfo[] = []
        for (const server of this.servers.values()) {
            allTools.push(...server.tools)
        }
        return allTools
    }

    /** Call a tool on the appropriate MCP server */
    async callTool (serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
        const server = this.servers.get(serverName)
        if (!server) {
            throw new Error(`MCP server "${serverName}" not connected`)
        }

        const result = await server.client.callTool({
            name: toolName,
            arguments: args,
        })

        // Extract text content from result
        if (result.content && Array.isArray(result.content)) {
            return result.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n')
        }

        return JSON.stringify(result)
    }

    /** Disconnect all MCP servers and clean up */
    async shutdown (): Promise<void> {
        const shutdowns = Array.from(this.servers.values()).map(async (server) => {
            try {
                await server.client.close()
            } catch {
                // Best effort cleanup
            }
        })
        await Promise.all(shutdowns)
        this.servers.clear()
    }

    /** Get the number of connected servers */
    get connectedCount (): number {
        return this.servers.size
    }
}

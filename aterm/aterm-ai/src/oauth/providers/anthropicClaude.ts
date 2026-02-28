import { OAuthProviderConfig, OAuthFlowType, OAuthToken } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const ANTHROPIC_CLAUDE_CONFIG: OAuthProviderConfig = {
    id: 'claude',
    displayName: 'Claude (Anthropic)',
    flowType: OAuthFlowType.TokenPaste,
    clientId: '',
    scopes: [],
    tokenUrl: '',
    supportsRefresh: false,
    defaultModel: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com/v1/',
}

/**
 * Validate a Claude setup token format.
 * Valid tokens start with 'sk-ant-' and are at least 40 characters.
 */
export function validateClaudeToken (token: string): boolean {
    return token.startsWith('sk-ant-') && token.length >= 40
}

/**
 * Create an OAuthToken from a pasted Claude token.
 */
export function createClaudeToken (token: string): OAuthToken {
    return {
        accessToken: token.trim(),
    }
}

/**
 * Try to sync credentials from Claude Code CLI.
 * Reads from ~/.claude/.credentials.json if it exists.
 */
export function syncFromClaudeCodeCLI (): OAuthToken | null {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json')

    try {
        if (!fs.existsSync(credentialsPath)) {
            return null
        }

        const raw = fs.readFileSync(credentialsPath, 'utf-8')
        const data = JSON.parse(raw)

        // Claude Code CLI stores token directly or under a key
        const token = data.claudeAiOauth?.accessToken
            || data.oauthAccessToken
            || data.apiKey
            || (typeof data === 'string' ? data : null)

        if (token && typeof token === 'string' && token.startsWith('sk-ant-')) {
            return { accessToken: token }
        }

        return null
    } catch {
        return null
    }
}

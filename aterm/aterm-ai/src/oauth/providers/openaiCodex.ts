import { OAuthProviderConfig, OAuthFlowType, OAuthToken } from '../types'
import { OAuthCallbackServer } from '../callbackServer'
import { generatePKCE, buildAuthUrl, exchangeCode, refreshPKCEToken } from '../pkceFlow'
import * as crypto from 'crypto'

/**
 * OpenAI Codex OAuth provider.
 *
 * Uses PKCE flow with a local callback server on port 1455
 * (matching the Codex CLI's redirect URI).
 *
 * Client ID sourced from Codex CLI: app_EMoamEEZ73f0CkXaXp7hrann
 */

const CALLBACK_PATH = '/auth/callback'
const CALLBACK_PORT = 1455

export const OPENAI_CODEX_CONFIG: OAuthProviderConfig = {
    id: 'codex',
    displayName: 'OpenAI Codex',
    flowType: OAuthFlowType.PKCE,
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    supportsRefresh: true,
    defaultModel: 'gpt-4.1',
    baseUrl: 'https://api.openai.com/v1/',
}

/**
 * Run the full OpenAI Codex PKCE flow.
 * Opens a browser for OpenAI login, captures the callback, exchanges the code.
 */
export async function runCodexOAuthFlow (
    openUrl: (url: string) => void,
): Promise<OAuthToken> {
    const { verifier, challenge } = generatePKCE()
    const state = crypto.randomBytes(16).toString('hex')

    // Start callback server on fixed port 1455
    const server = new OAuthCallbackServer()
    const redirectUri = await server.startOnPort(CALLBACK_PORT, CALLBACK_PATH)

    try {
        const authUrl = buildAuthUrl(OPENAI_CODEX_CONFIG, challenge, state, redirectUri)
        openUrl(authUrl)

        const { code } = await server.waitForCallback(state)

        return await exchangeCode(OPENAI_CODEX_CONFIG, code, verifier, redirectUri)
    } finally {
        server.stop()
    }
}

/**
 * Refresh an OpenAI Codex token.
 */
export async function refreshCodexToken (stored: OAuthToken): Promise<OAuthToken> {
    if (!stored.refreshToken) {
        throw new Error('No refresh token available')
    }
    return refreshPKCEToken(OPENAI_CODEX_CONFIG, stored.refreshToken)
}

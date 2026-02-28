import { OAuthProviderConfig, OAuthFlowType, OAuthToken } from '../types'
import { OAuthCallbackServer } from '../callbackServer'
import { generatePKCE, buildAuthUrl, exchangeCode, refreshPKCEToken } from '../pkceFlow'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * Google Gemini OAuth provider.
 *
 * Client credentials are extracted from the installed Gemini CLI
 * (@google/gemini-cli-core) at runtime, following the same approach as OpenClaw.
 *
 * Fallback: environment variables GEMINI_CLI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_SECRET
 */

const CALLBACK_PATH = '/oauth2callback'

function createGeminiConfig (clientId: string): OAuthProviderConfig {
    return {
        id: 'gemini-oauth',
        displayName: 'Google Gemini (OAuth)',
        flowType: OAuthFlowType.PKCE,
        clientId,
        scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ],
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        supportsRefresh: true,
        defaultModel: 'gemini-2.0-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    }
}

export const GOOGLE_GEMINI_CONFIG = createGeminiConfig('')

interface GeminiCredentials {
    clientId: string
    clientSecret: string
}

/**
 * Extract Google OAuth client credentials from the installed Gemini CLI.
 * Searches for @google/gemini-cli-core in common locations and extracts
 * client_id and client_secret from the bundled oauth2.js file.
 */
export function extractGeminiCliCredentials (): GeminiCredentials | null {
    // Check environment variables first
    const envClientId = process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID || process.env.GEMINI_CLI_OAUTH_CLIENT_ID
    const envClientSecret = process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET || process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET
    if (envClientId && envClientSecret) {
        return { clientId: envClientId, clientSecret: envClientSecret }
    }

    // Try to find @google/gemini-cli-core in common npm global locations
    const searchPaths: string[] = []
    const home = process.env.HOME || process.env.USERPROFILE || ''

    // npm global
    if (process.platform === 'win32') {
        searchPaths.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))
        searchPaths.push(path.join(home, 'AppData', 'Local', 'npm-cache', '_npx'))
    } else {
        searchPaths.push('/usr/local/lib/node_modules')
        searchPaths.push('/usr/lib/node_modules')
        searchPaths.push(path.join(home, '.npm-global', 'lib', 'node_modules'))
    }
    // npx cache
    searchPaths.push(path.join(home, '.npm', '_npx'))

    for (const basePath of searchPaths) {
        const creds = searchForCredentials(basePath)
        if (creds) return creds
    }

    return null
}

function searchForCredentials (basePath: string): GeminiCredentials | null {
    try {
        if (!fs.existsSync(basePath)) return null

        // Look for @google/gemini-cli-core package
        const candidates = [
            path.join(basePath, '@google', 'gemini-cli-core'),
            path.join(basePath, '@google', 'gemini-cli'),
        ]

        // Also search in npx cache subdirectories
        try {
            const entries = fs.readdirSync(basePath)
            for (const entry of entries) {
                candidates.push(path.join(basePath, entry, 'node_modules', '@google', 'gemini-cli-core'))
            }
        } catch {
            // Not a directory or permission issue
        }

        for (const candidate of candidates) {
            const creds = extractFromPackage(candidate)
            if (creds) return creds
        }
    } catch {
        // Ignore filesystem errors
    }
    return null
}

function extractFromPackage (packagePath: string): GeminiCredentials | null {
    try {
        if (!fs.existsSync(packagePath)) return null

        // Find oauth2.js or similar files containing credentials
        const distDir = path.join(packagePath, 'dist')
        const srcDir = path.join(packagePath, 'src')

        for (const dir of [distDir, srcDir, packagePath]) {
            const creds = scanDirForCredentials(dir)
            if (creds) return creds
        }
    } catch {
        // Ignore errors
    }
    return null
}

function scanDirForCredentials (dir: string): GeminiCredentials | null {
    try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null

        const files = fs.readdirSync(dir, { recursive: true }) as string[]
        for (const file of files) {
            if (!file.endsWith('.js') && !file.endsWith('.ts')) continue
            const content = fs.readFileSync(path.join(dir, file), 'utf-8')

            // Match Google OAuth client ID pattern
            const clientIdMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/)
            const clientSecretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/)

            if (clientIdMatch && clientSecretMatch) {
                return {
                    clientId: clientIdMatch[1],
                    clientSecret: clientSecretMatch[1],
                }
            }
        }
    } catch {
        // Ignore errors
    }
    return null
}

/**
 * Run the full Gemini OAuth PKCE flow.
 * Opens a browser for Google login, captures the callback, exchanges the code.
 *
 * @param openUrl Function to open a URL in the user's browser
 * @returns The OAuth token, or throws on failure
 */
export async function runGeminiOAuthFlow (
    openUrl: (url: string) => void,
): Promise<OAuthToken> {
    const creds = extractGeminiCliCredentials()
    if (!creds) {
        throw new Error(
            'Google OAuth credentials not found. Please install Gemini CLI (npm install -g @google/gemini-cli) ' +
            'or set GEMINI_CLI_OAUTH_CLIENT_ID and GEMINI_CLI_OAUTH_CLIENT_SECRET environment variables.',
        )
    }

    const config = createGeminiConfig(creds.clientId)
    const { verifier, challenge } = generatePKCE()
    const state = crypto.randomBytes(16).toString('hex')

    // Start callback server
    const server = new OAuthCallbackServer()
    const redirectUri = await server.start(CALLBACK_PATH)

    try {
        // Build auth URL and open browser
        const authUrl = buildAuthUrl(config, challenge, state, redirectUri)
        openUrl(authUrl)

        // Wait for callback
        const { code } = await server.waitForCallback(state)

        // Exchange code for tokens
        const token = await exchangeCode(config, code, verifier, redirectUri, creds.clientSecret)
        token.metadata = { clientSecret: creds.clientSecret }
        return token
    } finally {
        server.stop()
    }
}

/**
 * Refresh a Gemini OAuth token.
 */
export async function refreshGeminiToken (stored: OAuthToken): Promise<OAuthToken> {
    if (!stored.refreshToken) {
        throw new Error('No refresh token available')
    }

    const creds = extractGeminiCliCredentials()
    const clientId = creds?.clientId || ''
    const clientSecret = stored.metadata?.clientSecret || creds?.clientSecret

    const config = createGeminiConfig(clientId)
    const refreshed = await refreshPKCEToken(config, stored.refreshToken, clientSecret)
    refreshed.metadata = { ...stored.metadata }
    return refreshed
}

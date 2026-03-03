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
 * Finds the gemini binary in PATH, then locates oauth2.js relative to it.
 * Falls back to common npm global locations if PATH lookup fails.
 */
export function extractGeminiCliCredentials (): GeminiCredentials | null {
    // Check environment variables first
    const envClientId = process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID || process.env.GEMINI_CLI_OAUTH_CLIENT_ID
    const envClientSecret = process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET || process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET
    if (envClientId && envClientSecret) {
        return { clientId: envClientId, clientSecret: envClientSecret }
    }

    // Strategy 1: Find the gemini binary in PATH and navigate relative to it
    const credsFromPath = extractFromGeminiBinary()
    if (credsFromPath) return credsFromPath

    // Strategy 2: Fall back to searching common npm global locations
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const searchPaths: string[] = []

    if (process.platform === 'win32') {
        searchPaths.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))
        searchPaths.push(path.join(home, 'AppData', 'Local', 'npm-cache', '_npx'))
    } else {
        searchPaths.push('/usr/local/lib/node_modules')
        searchPaths.push('/usr/lib/node_modules')
        searchPaths.push(path.join(home, '.npm-global', 'lib', 'node_modules'))
    }
    searchPaths.push(path.join(home, '.npm', '_npx'))

    for (const basePath of searchPaths) {
        const creds = searchForCredentials(basePath)
        if (creds) return creds
    }

    return null
}

/**
 * Find the gemini binary in PATH and extract credentials from the
 * @google/gemini-cli-core package relative to it.
 */
function extractFromGeminiBinary (): GeminiCredentials | null {
    try {
        const geminiPath = findInPath('gemini')
        if (!geminiPath) return null

        const resolvedPath = fs.realpathSync(geminiPath)
        // gemini binary is at <pkg>/bin/gemini or <prefix>/gemini
        // Navigate up to the package root, then into node_modules
        const geminiCliDir = path.dirname(path.dirname(resolvedPath))

        // Known locations for oauth2.js within gemini-cli-core
        const oauthPaths = [
            path.join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'),
            path.join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'code_assist', 'oauth2.js'),
        ]

        for (const p of oauthPaths) {
            if (fs.existsSync(p)) {
                const creds = extractCredsFromFile(p)
                if (creds) return creds
            }
        }

        // Fallback: recursively search for oauth2.js
        const found = findFile(geminiCliDir, 'oauth2.js', 10)
        if (found) {
            return extractCredsFromFile(found)
        }
    } catch {
        // Gemini CLI not found or extraction failed
    }
    return null
}

/**
 * Search for a binary in the system PATH, checking platform-specific extensions.
 */
function findInPath (name: string): string | null {
    const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : ['']
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        for (const ext of exts) {
            const p = path.join(dir, name + ext)
            if (fs.existsSync(p)) return p
        }
    }
    return null
}

/**
 * Recursively search for a file by name within a directory tree.
 */
function findFile (dir: string, name: string, depth: number): string | null {
    if (depth <= 0) return null
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name)
            if (entry.isFile() && entry.name === name) return p
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const found = findFile(p, name, depth - 1)
                if (found) return found
            }
        }
    } catch {
        // Ignore filesystem errors
    }
    return null
}

/**
 * Extract OAuth client ID and secret from a file's content.
 */
function extractCredsFromFile (filePath: string): GeminiCredentials | null {
    try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const clientIdMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/)
        const clientSecretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/)
        if (clientIdMatch && clientSecretMatch) {
            return { clientId: clientIdMatch[1], clientSecret: clientSecretMatch[1] }
        }
    } catch {
        // Ignore read errors
    }
    return null
}

function searchForCredentials (basePath: string): GeminiCredentials | null {
    try {
        if (!fs.existsSync(basePath)) return null

        // Look for @google/gemini-cli-core as a direct or nested dependency
        const candidates = [
            path.join(basePath, '@google', 'gemini-cli-core'),
            path.join(basePath, '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core'),
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

        // Try known oauth2.js locations first
        const knownPaths = [
            path.join(packagePath, 'dist', 'src', 'code_assist', 'oauth2.js'),
            path.join(packagePath, 'dist', 'code_assist', 'oauth2.js'),
        ]

        for (const p of knownPaths) {
            if (fs.existsSync(p)) {
                const creds = extractCredsFromFile(p)
                if (creds) return creds
            }
        }

        // Fallback: scan dist/, src/, and package root
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
            const creds = extractCredsFromFile(path.join(dir, file))
            if (creds) return creds
        }
    } catch {
        // Ignore errors
    }
    return null
}

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const TIER_FREE = 'free-tier'
const TIER_LEGACY = 'legacy-tier'
const TIER_STANDARD = 'standard-tier'

/**
 * Discover or provision a Google Cloud project for the authenticated user.
 * Required for Gemini API access via OAuth.
 */
async function discoverProject (accessToken: string): Promise<string> {
    const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID
    const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': 'gl-node/aterm',
    }

    const loadBody = {
        cloudaicompanionProject: envProject,
        metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
            duetProject: envProject,
        },
    }

    let data: {
        currentTier?: { id?: string }
        cloudaicompanionProject?: string | { id?: string }
        allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
    } = {}

    const res = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify(loadBody),
    })

    if (!res.ok) {
        const errorPayload = await res.json().catch(() => null) as any
        // VPC Service Controls may block loadCodeAssist
        const isVpcSc = Array.isArray(errorPayload?.error?.details) &&
            errorPayload.error.details.some((d: any) => d?.reason === 'SECURITY_POLICY_VIOLATED')
        if (isVpcSc) {
            data = { currentTier: { id: TIER_STANDARD } }
        } else {
            throw new Error(`loadCodeAssist failed: ${res.status} ${res.statusText}`)
        }
    } else {
        data = await res.json() as typeof data
    }

    // Already onboarded — extract project
    if (data.currentTier) {
        const project = data.cloudaicompanionProject
        if (typeof project === 'string' && project) return project
        if (typeof project === 'object' && project?.id) return project.id
        if (envProject) return envProject
        throw new Error('This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.')
    }

    // Need to onboard — pick default tier
    const defaultTier = data.allowedTiers?.find(t => t.isDefault) ?? { id: TIER_LEGACY }
    const tierId = defaultTier.id || TIER_FREE
    if (tierId !== TIER_FREE && !envProject) {
        throw new Error('This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.')
    }

    const onboardBody: Record<string, any> = {
        tierId,
        metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    }
    if (tierId !== TIER_FREE && envProject) {
        onboardBody.cloudaicompanionProject = envProject
        onboardBody.metadata.duetProject = envProject
    }

    const onboardRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
        method: 'POST',
        headers,
        body: JSON.stringify(onboardBody),
    })
    if (!onboardRes.ok) {
        throw new Error(`onboardUser failed: ${onboardRes.status} ${onboardRes.statusText}`)
    }

    let lro = await onboardRes.json() as {
        done?: boolean
        name?: string
        response?: { cloudaicompanionProject?: { id?: string } }
    }

    // Poll long-running operation
    if (!lro.done && lro.name) {
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5000))
            const pollRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${lro.name}`, { headers })
            if (!pollRes.ok) continue
            lro = await pollRes.json() as typeof lro
            if (lro.done) break
        }
    }

    const projectId = lro.response?.cloudaicompanionProject?.id
    if (projectId) return projectId
    if (envProject) return envProject
    throw new Error('Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.')
}

/**
 * Run the full Gemini OAuth PKCE flow.
 * Opens a browser for Google login, captures the callback, exchanges the code,
 * then discovers/provisions a Google Cloud project.
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

        // Discover Google Cloud project (required for Gemini API access)
        const projectId = await discoverProject(token.accessToken)

        token.metadata = { clientSecret: creds.clientSecret, projectId }
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

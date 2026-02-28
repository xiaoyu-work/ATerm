import { OAuthProviderConfig, OAuthFlowType, OAuthToken } from '../types'

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com'

export const GITHUB_COPILOT_CONFIG: OAuthProviderConfig = {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    flowType: OAuthFlowType.DeviceCode,
    clientId: 'Iv1.b507a08c87ecfe98',
    scopes: ['read:user'],
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    supportsRefresh: true,
    defaultModel: 'gpt-4o',
    baseUrl: DEFAULT_COPILOT_API_BASE_URL,
    deriveBaseUrl: (token: OAuthToken) => {
        return token.metadata?.copilotBaseUrl || DEFAULT_COPILOT_API_BASE_URL
    },
}

/**
 * Parse the Copilot API base URL from a Copilot token.
 * Copilot tokens contain a `proxy-ep=host` parameter that indicates
 * the correct API endpoint.
 */
function deriveCopilotBaseUrl (copilotToken: string): string {
    const match = copilotToken.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)
    if (!match?.[1]) {
        return DEFAULT_COPILOT_API_BASE_URL
    }
    const proxyHost = match[1].trim().replace(/^https?:\/\//, '')
    // Convert proxy.* -> api.*
    const apiHost = proxyHost.replace(/^proxy\./i, 'api.')
    return `https://${apiHost}`
}

/**
 * Exchange a GitHub OAuth token for a Copilot API token.
 * The GitHub token is long-lived; the Copilot API token expires every ~30 minutes.
 */
export async function exchangeForCopilotToken (githubToken: string): Promise<{
    copilotToken: string
    expiresAt: number
    baseUrl: string
}> {
    const res = await fetch(COPILOT_TOKEN_URL, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${githubToken}`,
        },
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Copilot token exchange failed (${res.status}): ${text}`)
    }

    const json = await res.json()
    const copilotToken: string = json.token
    // expires_at is Unix seconds
    const expiresAt = (json.expires_at || 0) * 1000
    const baseUrl = deriveCopilotBaseUrl(copilotToken)

    return { copilotToken, expiresAt, baseUrl }
}

/**
 * Get a ready-to-use Copilot access token.
 * If the cached Copilot token is expired, re-exchanges using the GitHub token.
 * Returns the full OAuthToken with updated metadata.
 */
export async function resolveCopilotToken (storedToken: OAuthToken): Promise<OAuthToken> {
    const githubToken = storedToken.metadata?.githubToken as string
    if (!githubToken) {
        throw new Error('No GitHub token stored. Please reconnect GitHub Copilot.')
    }

    const cachedCopilotToken = storedToken.metadata?.copilotToken as string | undefined
    const cachedExpiresAt = storedToken.metadata?.copilotExpiresAt as number | undefined

    // Use cached token if still valid (with 5-minute safety margin)
    if (cachedCopilotToken && cachedExpiresAt && Date.now() < cachedExpiresAt - 5 * 60 * 1000) {
        return {
            ...storedToken,
            accessToken: cachedCopilotToken,
        }
    }

    // Exchange for a fresh Copilot token
    const { copilotToken, expiresAt, baseUrl } = await exchangeForCopilotToken(githubToken)

    return {
        ...storedToken,
        accessToken: copilotToken,
        expiresAt,
        metadata: {
            ...storedToken.metadata,
            githubToken,
            copilotToken,
            copilotExpiresAt: expiresAt,
            copilotBaseUrl: baseUrl,
        },
    }
}

import * as crypto from 'crypto'
import { OAuthProviderConfig, OAuthToken } from './types'

/**
 * Generate a PKCE code verifier and challenge pair.
 */
export function generatePKCE (): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('hex')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
}

/**
 * Build the OAuth authorization URL with PKCE parameters.
 */
export function buildAuthUrl (
    config: OAuthProviderConfig,
    challenge: string,
    state: string,
    redirectUri: string,
): string {
    if (!config.authUrl) {
        throw new Error(`Provider "${config.id}" does not have an authUrl configured`)
    }

    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: config.scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    })

    if (config.extraAuthParams) {
        for (const [key, value] of Object.entries(config.extraAuthParams)) {
            params.set(key, value)
        }
    }

    return `${config.authUrl}?${params.toString()}`
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode (
    config: OAuthProviderConfig,
    code: string,
    codeVerifier: string,
    redirectUri: string,
    clientSecret?: string,
): Promise<OAuthToken> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
    })

    if (clientSecret) {
        body.set('client_secret', clientSecret)
    }

    const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body,
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Token exchange failed (${res.status}): ${text}`)
    }

    const json = await res.json()
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: json.expires_in
            ? Date.now() + json.expires_in * 1000
            : undefined,
    }
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshPKCEToken (
    config: OAuthProviderConfig,
    refreshToken: string,
    clientSecret?: string,
): Promise<OAuthToken> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        refresh_token: refreshToken,
    })

    if (clientSecret) {
        body.set('client_secret', clientSecret)
    }

    const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body,
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Token refresh failed (${res.status}): ${text}`)
    }

    const json = await res.json()
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || refreshToken,
        expiresAt: json.expires_in
            ? Date.now() + json.expires_in * 1000
            : undefined,
    }
}

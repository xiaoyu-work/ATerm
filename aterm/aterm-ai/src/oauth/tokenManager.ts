import { Injectable } from '@angular/core'
import { ConfigService } from 'aterm-core'
import { OAuthToken } from './types'
import { getOAuthProvider } from './providerRegistry'
import { resolveCopilotToken } from './providers/githubCopilot'
import { refreshMiniMaxToken } from './providers/minimaxProvider'
import { refreshGeminiToken } from './providers/googleGemini'

@Injectable()
export class OAuthTokenManager {
    constructor (private config: ConfigService) {}

    /**
     * Get a valid token for the given provider.
     * Automatically refreshes expired tokens when possible.
     */
    async getToken (providerId: string): Promise<OAuthToken | null> {
        const stored = this.getStoredToken(providerId)
        if (!stored) return null

        const providerConfig = getOAuthProvider(providerId)
        if (!providerConfig) return stored

        // Copilot has special two-tier token management
        if (providerId === 'copilot') {
            try {
                const resolved = await resolveCopilotToken(stored)
                // Update stored token with fresh Copilot token metadata
                this.storeToken(providerId, resolved)
                return resolved
            } catch {
                return null
            }
        }

        // Check if token is expired and needs refresh
        if (stored.expiresAt && Date.now() >= stored.expiresAt - 5 * 60 * 1000) {
            if (providerConfig.supportsRefresh && stored.refreshToken) {
                try {
                    const refreshed = await this.refreshToken(providerId, stored)
                    this.storeToken(providerId, refreshed)
                    return refreshed
                } catch {
                    // Refresh failed — clear token
                    this.clearToken(providerId)
                    return null
                }
            }
            // Expired and no refresh available
            return null
        }

        return stored
    }

    /**
     * Get the stored token synchronously (without refresh).
     * Use for UI status display.
     */
    getStoredToken (providerId: string): OAuthToken | null {
        const tokens = this.config.store.ai?.oauthTokens
        if (!tokens) return null
        const data = tokens[providerId]
        if (!data?.accessToken) return null
        return data as OAuthToken
    }

    /**
     * Store a token after successful authentication.
     */
    storeToken (providerId: string, token: OAuthToken): void {
        if (!this.config.store.ai.oauthTokens) {
            this.config.store.ai.oauthTokens = {}
        }
        this.config.store.ai.oauthTokens[providerId] = token
        this.config.save()
    }

    /**
     * Remove stored token (disconnect).
     */
    clearToken (providerId: string): void {
        if (this.config.store.ai?.oauthTokens) {
            this.config.store.ai.oauthTokens[providerId] = null
            this.config.save()
        }
    }

    /**
     * Check if a valid (non-expired) token exists.
     */
    hasValidToken (providerId: string): boolean {
        const stored = this.getStoredToken(providerId)
        if (!stored) return false
        // If no expiry set, assume valid
        if (!stored.expiresAt) return true
        // For Copilot, the GitHub token is long-lived — consider valid
        if (providerId === 'copilot' && stored.metadata?.githubToken) return true
        return Date.now() < stored.expiresAt
    }

    /**
     * Get the access token for use in API calls.
     * For Copilot, this resolves the Copilot API token (not the GitHub token).
     */
    async getAccessToken (providerId: string): Promise<string | null> {
        const token = await this.getToken(providerId)
        return token?.accessToken || null
    }

    private async refreshToken (providerId: string, stored: OAuthToken): Promise<OAuthToken> {
        if (providerId === 'minimax' && stored.refreshToken) {
            return refreshMiniMaxToken(stored.refreshToken)
        }

        if (providerId === 'gemini-oauth' && stored.refreshToken) {
            return refreshGeminiToken(stored)
        }

        // Generic OAuth refresh for future providers
        const config = getOAuthProvider(providerId)
        if (!config?.tokenUrl || !stored.refreshToken) {
            throw new Error('Refresh not supported')
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: config.clientId,
        })

        const res = await fetch(config.tokenUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        })

        if (!res.ok) {
            throw new Error(`Token refresh failed (${res.status})`)
        }

        const json = await res.json()
        return {
            accessToken: json.access_token,
            refreshToken: json.refresh_token || stored.refreshToken,
            expiresAt: json.expires_in
                ? Date.now() + json.expires_in * 1000
                : undefined,
            metadata: stored.metadata,
        }
    }
}

import { OAuthProviderConfig, OAuthFlowType, OAuthToken, DeviceCodeResponse } from '../types'

export const MINIMAX_CONFIG: OAuthProviderConfig = {
    id: 'minimax',
    displayName: 'MiniMax',
    flowType: OAuthFlowType.DeviceCode,
    clientId: '78257093-7e40-4613-99e0-527b14b39113',
    scopes: ['group_id', 'profile', 'model.completion'],
    deviceCodeUrl: 'https://api.minimax.io/oauth/code',
    tokenUrl: 'https://api.minimax.io/oauth/token',
    supportsRefresh: true,
    defaultModel: 'MiniMax-Text-01',
    baseUrl: 'https://api.minimax.io/v1/',
}

/**
 * Request a device code from MiniMax.
 * MiniMax uses a slightly different request format than standard device flow.
 */
export async function requestMiniMaxDeviceCode (): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
        response_type: 'code',
        client_id: MINIMAX_CONFIG.clientId,
        scope: MINIMAX_CONFIG.scopes.join(' '),
    })

    const res = await fetch(MINIMAX_CONFIG.deviceCodeUrl!, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`MiniMax device code request failed (${res.status}): ${text}`)
    }

    const json = await res.json()
    return {
        deviceCode: json.device_code || json.user_code,
        userCode: json.user_code,
        verificationUri: json.verification_uri || json.verification_url,
        expiresIn: json.expired_in || json.expires_in || 600,
        interval: json.interval || 5,
    }
}

/**
 * Poll MiniMax token endpoint using user_code grant type.
 */
export async function pollMiniMaxToken (
    userCode: string,
    signal?: AbortSignal,
): Promise<OAuthToken> {
    const interval = 5000

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:user_code',
        client_id: MINIMAX_CONFIG.clientId,
        user_code: userCode,
    })

    while (!signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, interval))
        if (signal?.aborted) break

        const res = await fetch(MINIMAX_CONFIG.tokenUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        })

        const json = await res.json()

        if (json.access_token) {
            return {
                accessToken: json.access_token,
                refreshToken: json.refresh_token,
                expiresAt: json.expires_in
                    ? Date.now() + json.expires_in * 1000
                    : undefined,
            }
        }

        const error = json.error || json.status || ''
        if (error === 'pending' || error === 'authorization_pending') {
            continue
        }
        if (error === 'slow_down') {
            await new Promise(resolve => setTimeout(resolve, 5000))
            continue
        }

        if (json.access_token === undefined && !error) {
            continue
        }

        throw new Error(`MiniMax token polling failed: ${json.error_description || error || JSON.stringify(json)}`)
    }

    throw new Error('Authorization cancelled.')
}

/**
 * Refresh a MiniMax token using the stored refresh token.
 */
export async function refreshMiniMaxToken (refreshToken: string): Promise<OAuthToken> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: MINIMAX_CONFIG.clientId,
        refresh_token: refreshToken,
    })

    const res = await fetch(MINIMAX_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`MiniMax token refresh failed (${res.status}): ${text}`)
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

import { OAuthProviderConfig, DeviceCodeResponse, OAuthToken } from './types'

/**
 * Request a device code from the provider's device code endpoint.
 */
export async function requestDeviceCode (config: OAuthProviderConfig): Promise<DeviceCodeResponse> {
    if (!config.deviceCodeUrl) {
        throw new Error(`Provider "${config.id}" does not support device code flow`)
    }

    const body = new URLSearchParams({
        client_id: config.clientId,
        scope: config.scopes.join(' '),
    })

    const res = await fetch(config.deviceCodeUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Device code request failed (${res.status}): ${text}`)
    }

    const json = await res.json()
    return {
        deviceCode: json.device_code,
        userCode: json.user_code,
        verificationUri: json.verification_uri || json.verification_url,
        expiresIn: json.expires_in,
        interval: json.interval || 5,
    }
}

/**
 * Poll the token endpoint until the user authorizes the device.
 * Returns the token on success, or throws on timeout/denial.
 */
export async function pollForToken (
    config: OAuthProviderConfig,
    deviceCode: string,
    interval: number,
    signal?: AbortSignal,
): Promise<OAuthToken> {
    const grantType = 'urn:ietf:params:oauth:grant-type:device_code'

    const body = new URLSearchParams({
        client_id: config.clientId,
        device_code: deviceCode,
        grant_type: grantType,
    })

    let pollInterval = interval * 1000

    while (!signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, pollInterval))
        if (signal?.aborted) break

        const res = await fetch(config.tokenUrl, {
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

        const error = json.error || ''
        if (error === 'authorization_pending') {
            continue
        }
        if (error === 'slow_down') {
            pollInterval += 5000
            continue
        }
        if (error === 'expired_token') {
            throw new Error('Device code expired. Please try again.')
        }
        if (error === 'access_denied') {
            throw new Error('Authorization denied by user.')
        }

        throw new Error(`Token polling failed: ${json.error_description || error || JSON.stringify(json)}`)
    }

    throw new Error('Authorization cancelled.')
}

export interface OAuthToken {
    accessToken: string
    refreshToken?: string
    /** Unix timestamp in milliseconds */
    expiresAt?: number
    /** Provider-specific metadata (e.g., Copilot proxy endpoint, GitHub token) */
    metadata?: Record<string, any>
}

export const enum OAuthFlowType {
    DeviceCode = 'device_code',
    PKCE = 'pkce',
    TokenPaste = 'token_paste',
}

export interface OAuthProviderConfig {
    id: string
    displayName: string
    flowType: OAuthFlowType
    clientId: string
    scopes: string[]
    /** Device flow: device code request URL */
    deviceCodeUrl?: string
    /** Token exchange/refresh URL */
    tokenUrl: string
    /** PKCE: authorization URL */
    authUrl?: string
    /** Extra query parameters to include in the authorization URL */
    extraAuthParams?: Record<string, string>
    /** Whether this provider supports token refresh */
    supportsRefresh: boolean
    /** Default model for this provider */
    defaultModel: string
    /** Default API base URL */
    baseUrl?: string
    /** Derive API base URL from token (e.g., Copilot proxy endpoint) */
    deriveBaseUrl?: (token: OAuthToken) => string | undefined
}

export interface DeviceCodeResponse {
    deviceCode: string
    userCode: string
    verificationUri: string
    expiresIn: number
    /** Polling interval in seconds */
    interval: number
}

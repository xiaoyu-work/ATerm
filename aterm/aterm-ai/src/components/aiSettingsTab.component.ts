import { Component, HostBinding, NgZone } from '@angular/core'
import { ConfigService, PlatformService } from 'aterm-core'
import { PROVIDER_PRESETS } from '../providers'
import { OAuthTokenManager } from '../oauth/tokenManager'
import { isOAuthProvider as checkOAuthProvider, getOAuthProvider } from '../oauth/providerRegistry'
import { DeviceCodeResponse, OAuthFlowType } from '../oauth/types'
import { requestDeviceCode, pollForToken } from '../oauth/deviceFlow'
import { requestMiniMaxDeviceCode, pollMiniMaxToken } from '../oauth/providers/minimaxProvider'
import { validateClaudeToken, createClaudeToken, syncFromClaudeCodeCLI } from '../oauth/providers/anthropicClaude'
import { runGeminiOAuthFlow } from '../oauth/providers/googleGemini'

@Component({
    standalone: false,
    templateUrl: './aiSettingsTab.component.html',
})
export class AISettingsTabComponent {
    @HostBinding('class.content-box') true

    claudeTokenInput = ''
    oauthInProgress = false
    oauthError = ''
    deviceCode: DeviceCodeResponse | null = null
    private abortController: AbortController | null = null

    constructor (
        public config: ConfigService,
        private platform: PlatformService,
        private tokenManager: OAuthTokenManager,
        private zone: NgZone,
    ) {}

    get isOAuthProvider (): boolean {
        return checkOAuthProvider(this.config.store.ai?.provider || '')
    }

    get isConnected (): boolean {
        const provider = this.config.store.ai?.provider || ''
        return this.tokenManager.hasValidToken(provider)
    }

    onProviderChange (): void {
        const provider = this.config.store.ai.provider
        const preset = PROVIDER_PRESETS[provider]
        if (preset) {
            this.config.store.ai.baseUrl = ''
            this.config.store.ai.model = preset.defaultModel
        }
        // Reset OAuth state when switching providers
        this.cancelOAuth()
        this.oauthError = ''
    }

    getBaseUrlPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.baseUrl || 'https://your-endpoint.com/v1/'
    }

    getModelPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.defaultModel || 'model-name'
    }

    getProviderDisplayName (): string {
        const provider = this.config.store.ai?.provider || ''
        const oauthConfig = getOAuthProvider(provider)
        return oauthConfig?.displayName || provider
    }

    // --- OAuth Flow (Device Flow or PKCE) ---

    async startOAuthFlow (): Promise<void> {
        const provider = this.config.store.ai?.provider || ''
        const oauthConfig = getOAuthProvider(provider)
        if (!oauthConfig) return

        if (oauthConfig.flowType === OAuthFlowType.PKCE) {
            return this.startPKCEFlow(provider)
        }

        return this.startDeviceFlow(provider, oauthConfig)
    }

    private async startDeviceFlow (provider: string, oauthConfig: any): Promise<void> {
        this.oauthInProgress = true
        this.oauthError = ''
        this.abortController = new AbortController()

        try {
            if (provider === 'minimax') {
                this.deviceCode = await requestMiniMaxDeviceCode()
            } else {
                this.deviceCode = await requestDeviceCode(oauthConfig)
            }

            let token
            if (provider === 'minimax') {
                token = await pollMiniMaxToken(this.deviceCode.userCode, this.abortController.signal)
            } else {
                token = await pollForToken(oauthConfig, this.deviceCode.deviceCode, this.deviceCode.interval, this.abortController.signal)
            }

            if (provider === 'copilot') {
                token.metadata = { githubToken: token.accessToken }
            }

            this.tokenManager.storeToken(provider, token)
            this.zone.run(() => {
                this.oauthInProgress = false
                this.deviceCode = null
            })
        } catch (err: any) {
            this.zone.run(() => {
                this.oauthError = err.message || 'OAuth flow failed'
                this.oauthInProgress = false
                this.deviceCode = null
            })
        }
    }

    private async startPKCEFlow (provider: string): Promise<void> {
        this.oauthInProgress = true
        this.oauthError = ''

        try {
            if (provider === 'gemini-oauth') {
                const token = await runGeminiOAuthFlow((url) => this.platform.openExternal(url))
                this.tokenManager.storeToken(provider, token)
            }

            this.zone.run(() => {
                this.oauthInProgress = false
            })
        } catch (err: any) {
            this.zone.run(() => {
                this.oauthError = err.message || 'OAuth flow failed'
                this.oauthInProgress = false
            })
        }
    }

    openDeviceUrl (): void {
        if (this.deviceCode?.verificationUri) {
            this.platform.openExternal(this.deviceCode.verificationUri)
        }
    }

    copyDeviceCode (): void {
        if (this.deviceCode?.userCode) {
            navigator.clipboard.writeText(this.deviceCode.userCode)
        }
    }

    cancelOAuth (): void {
        this.abortController?.abort()
        this.abortController = null
        this.oauthInProgress = false
        this.deviceCode = null
    }

    // --- Claude Token Paste ---

    saveClaudeToken (): void {
        const token = this.claudeTokenInput.trim()
        if (!token) return

        if (!validateClaudeToken(token)) {
            this.oauthError = 'Invalid token format. Claude tokens start with sk-ant- and are at least 40 characters.'
            return
        }

        this.tokenManager.storeToken('claude', createClaudeToken(token))
        this.claudeTokenInput = ''
        this.oauthError = ''
    }

    syncFromClaudeCLI (): void {
        const token = syncFromClaudeCodeCLI()
        if (token) {
            this.tokenManager.storeToken('claude', token)
            this.oauthError = ''
        } else {
            this.oauthError = 'Could not find Claude Code CLI credentials. Make sure Claude Code is installed and authenticated.'
        }
    }

    // --- Disconnect ---

    disconnect (): void {
        const provider = this.config.store.ai?.provider || ''
        this.tokenManager.clearToken(provider)
        this.oauthError = ''
    }
}

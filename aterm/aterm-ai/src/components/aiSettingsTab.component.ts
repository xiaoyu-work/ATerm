import { Component, HostBinding, NgZone, OnInit } from '@angular/core'
import { ConfigService, PlatformService } from 'aterm-core'
import { PROVIDER_PRESETS } from '../providers'
import { OAuthTokenManager } from '../oauth/tokenManager'
import { isOAuthProvider as checkOAuthProvider, getOAuthProvider } from '../oauth/providerRegistry'
import { DeviceCodeResponse, OAuthFlowType } from '../oauth/types'
import { requestDeviceCode, pollForToken } from '../oauth/deviceFlow'
import { requestMiniMaxDeviceCode, pollMiniMaxToken } from '../oauth/providers/minimaxProvider'
import { validateClaudeToken, createClaudeToken, syncFromClaudeCodeCLI } from '../oauth/providers/anthropicClaude'
import { runGeminiOAuthFlow } from '../oauth/providers/googleGemini'
import { runCodexOAuthFlow } from '../oauth/providers/openaiCodex'

@Component({
    standalone: false,
    templateUrl: './aiSettingsTab.component.html',
})
export class AISettingsTabComponent implements OnInit {
    @HostBinding('class.content-box') true

    claudeTokenInput = ''
    oauthInProgress = false
    oauthError = ''
    deviceCode: DeviceCodeResponse | null = null
    fetchedModels: string[] = []
    modelsFetching = false
    private abortController: AbortController | null = null
    private modelsCacheKey = ''

    constructor (
        public config: ConfigService,
        private platform: PlatformService,
        private tokenManager: OAuthTokenManager,
        private zone: NgZone,
    ) {}

    ngOnInit (): void {
        this.fetchModelsIfNeeded()
    }

    get isOAuthProvider (): boolean {
        return checkOAuthProvider(this.config.store.ai?.provider || '')
    }

    get isConnected (): boolean {
        const provider = this.config.store.ai?.provider || ''
        return this.tokenManager.hasValidToken(provider)
    }

    get authStatus (): { method: string; ready: boolean } {
        if (this.isOAuthProvider) {
            return { method: 'OAuth', ready: this.isConnected }
        }
        const provider = this.config.store.ai?.provider || ''
        if (provider === 'ollama') {
            return { method: 'None (local)', ready: true }
        }
        return { method: 'API Key', ready: !!this.currentApiKey }
    }

    get currentApiKey (): string {
        const provider = this.config.store.ai?.provider || ''
        return this.config.store.ai?.apiKeys?.[provider] || ''
    }

    set currentApiKey (value: string) {
        const provider = this.config.store.ai?.provider || ''
        if (!this.config.store.ai.apiKeys) {
            this.config.store.ai.apiKeys = {}
        }
        this.config.store.ai.apiKeys[provider] = value
        this.config.save()
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
        this.fetchedModels = []
        this.modelsCacheKey = ''
        this.fetchModelsIfNeeded()
    }

    getBaseUrlPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.baseUrl || 'https://your-endpoint.com/v1/'
    }

    getModelPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.defaultModel || 'model-name'
    }

    get availableModels (): string[] {
        if (this.fetchedModels.length > 0) return this.fetchedModels
        const provider = this.config.store.ai?.provider || ''
        return PROVIDER_PRESETS[provider]?.models || []
    }

    get modelSelectValue (): string {
        const model = this.config.store.ai?.model || ''
        if (this.availableModels.includes(model)) return model
        return '__custom__'
    }

    onModelSelectChange (value: string): void {
        if (value === '__custom__') {
            this.config.store.ai.model = ''
        } else {
            this.config.store.ai.model = value
        }
        this.config.save()
    }

    async fetchModelsIfNeeded (): Promise<void> {
        const provider = this.config.store.ai?.provider || ''
        const preset = PROVIDER_PRESETS[provider]
        if (!preset) return

        // Build cache key from provider + auth state
        const providerApiKey = this.config.store.ai?.apiKeys?.[provider] || ''
        const cacheKey = `${provider}:${this.isConnected}:${providerApiKey}`
        if (cacheKey === this.modelsCacheKey) return
        this.modelsCacheKey = cacheKey

        // Need auth to fetch models
        const hasApiKey = !!providerApiKey
        if (!this.isConnected && !hasApiKey) {
            this.fetchedModels = []
            return
        }

        // Skip providers that don't support /models endpoint
        if (provider === 'azure' || provider === 'custom' || provider === 'copilot') {
            this.fetchedModels = []
            return
        }

        // Resolve base URL and auth
        let baseUrl = (this.config.store.ai?.baseUrl || preset.baseUrl || '').replace(/\/+$/, '')
        let authHeader = ''

        if (preset.oauthId) {
            try {
                const token = await this.tokenManager.getAccessToken(preset.oauthId)
                if (token) {
                    authHeader = `Bearer ${token}`
                    // Copilot may derive base URL from token
                    const oauthConfig = getOAuthProvider(preset.oauthId)
                    if (oauthConfig?.deriveBaseUrl) {
                        const storedToken = this.tokenManager.getStoredToken(preset.oauthId)
                        if (storedToken) {
                            const derived = oauthConfig.deriveBaseUrl(storedToken)
                            if (derived) baseUrl = derived.replace(/\/+$/, '')
                        }
                    }
                }
            } catch {
                // Fall back to static list
            }
        } else if (hasApiKey) {
            authHeader = `Bearer ${providerApiKey}`
        }

        if (!baseUrl || !authHeader) {
            this.fetchedModels = []
            return
        }

        // Fetch /models
        const modelsUrl = `${baseUrl}/models`
        this.modelsFetching = true
        try {
            const res = await fetch(modelsUrl, {
                headers: { Authorization: authHeader },
                signal: AbortSignal.timeout(10000),
            })
            if (!res.ok) {
                this.fetchedModels = []
                return
            }
            const json = await res.json()
            const models: string[] = (json.data || [])
                .map((m: any) => m.id as string)
                .filter((id: string) => !!id)
                .sort()
            this.zone.run(() => {
                this.fetchedModels = models
            })
        } catch {
            // Fetch failed — fall back to static list
            this.fetchedModels = []
        } finally {
            this.zone.run(() => {
                this.modelsFetching = false
            })
        }
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
                this.modelsCacheKey = ''
                this.fetchModelsIfNeeded()
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
            } else if (provider === 'codex') {
                const token = await runCodexOAuthFlow((url) => this.platform.openExternal(url))
                this.tokenManager.storeToken(provider, token)
            }

            this.zone.run(() => {
                this.oauthInProgress = false
                this.modelsCacheKey = ''
                this.fetchModelsIfNeeded()
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
        this.modelsCacheKey = ''
        this.fetchModelsIfNeeded()
    }

    syncFromClaudeCLI (): void {
        const token = syncFromClaudeCodeCLI()
        if (token) {
            this.tokenManager.storeToken('claude', token)
            this.oauthError = ''
            this.modelsCacheKey = ''
            this.fetchModelsIfNeeded()
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

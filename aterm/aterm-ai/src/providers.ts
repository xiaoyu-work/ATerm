/**
 * Shared provider preset configurations.
 * Used by both AIService (runtime) and AISettingsTabComponent (UI).
 *
 * Providers with `oauthId` use OAuth-based authentication instead of API keys.
 */
export interface ProviderPreset {
    baseUrl: string
    defaultModel: string
    /** If set, this provider uses OAuth via the given provider ID */
    oauthId?: string
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
    // --- OAuth Connect providers ---
    copilot: {
        baseUrl: 'https://api.individual.githubcopilot.com/v1/',
        defaultModel: 'gpt-4o',
        oauthId: 'copilot',
    },
    claude: {
        baseUrl: 'https://api.anthropic.com/v1/',
        defaultModel: 'claude-sonnet-4-20250514',
        oauthId: 'claude',
    },
    'gemini-oauth': {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.0-flash',
        oauthId: 'gemini-oauth',
    },
    minimax: {
        baseUrl: 'https://api.minimax.io/v1/',
        defaultModel: 'MiniMax-Text-01',
        oauthId: 'minimax',
    },

    // --- API Key providers ---
    openai: {
        baseUrl: 'https://api.openai.com/v1/',
        defaultModel: 'gpt-4.1',
    },
    gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.0-flash',
    },
    ollama: {
        baseUrl: 'http://localhost:11434/v1/',
        defaultModel: 'llama3.2',
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1/',
        defaultModel: 'deepseek-chat',
    },
    azure: {
        baseUrl: '',
        defaultModel: 'gpt-4.1',
    },
    kimi: {
        baseUrl: 'https://api.moonshot.ai/v1/',
        defaultModel: 'moonshot-v1-8k',
    },
    custom: {
        baseUrl: '',
        defaultModel: '',
    },
}

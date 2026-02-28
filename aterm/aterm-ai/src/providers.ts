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
    /** Known available models for this provider (shown as dropdown) */
    models?: string[]
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
    // --- OAuth Connect providers ---
    copilot: {
        baseUrl: 'https://api.individual.githubcopilot.com/',
        defaultModel: 'claude-sonnet-4.6',
        oauthId: 'copilot',
        models: [
            'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-opus-4.5', 'claude-sonnet-4', 'claude-haiku-4.5',
            'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1', 'gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-4.1',
            'gemini-3-pro',
        ],
    },
    codex: {
        baseUrl: 'https://api.openai.com/v1/',
        defaultModel: 'gpt-4.1',
        oauthId: 'codex',
        models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o3-mini', 'o4-mini'],
    },
    claude: {
        baseUrl: 'https://api.anthropic.com/v1/',
        defaultModel: 'claude-sonnet-4-20250514',
        oauthId: 'claude',
        models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250414'],
    },
    'gemini-oauth': {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.5-flash',
        oauthId: 'gemini-oauth',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    },
    minimax: {
        baseUrl: 'https://api.minimax.io/v1/',
        defaultModel: 'MiniMax-Text-01',
        oauthId: 'minimax',
        models: ['MiniMax-Text-01', 'MiniMax-M1'],
    },

    // --- API Key providers ---
    openai: {
        baseUrl: 'https://api.openai.com/v1/',
        defaultModel: 'gpt-4.1',
        models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o3-mini', 'o4-mini'],
    },
    gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.5-flash',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    },
    ollama: {
        baseUrl: 'http://localhost:11434/v1/',
        defaultModel: 'llama3.2',
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1/',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    azure: {
        baseUrl: '',
        defaultModel: 'gpt-4.1',
    },
    kimi: {
        baseUrl: 'https://api.moonshot.ai/v1/',
        defaultModel: 'moonshot-v1-8k',
        models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    },
    custom: {
        baseUrl: '',
        defaultModel: '',
    },
}

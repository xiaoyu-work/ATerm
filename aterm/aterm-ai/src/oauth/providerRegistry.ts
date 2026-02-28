import { OAuthProviderConfig } from './types'
import { GITHUB_COPILOT_CONFIG } from './providers/githubCopilot'
import { ANTHROPIC_CLAUDE_CONFIG } from './providers/anthropicClaude'
import { MINIMAX_CONFIG } from './providers/minimaxProvider'
import { GOOGLE_GEMINI_CONFIG } from './providers/googleGemini'
import { OPENAI_CODEX_CONFIG } from './providers/openaiCodex'

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
    copilot: GITHUB_COPILOT_CONFIG,
    codex: OPENAI_CODEX_CONFIG,
    claude: ANTHROPIC_CLAUDE_CONFIG,
    'gemini-oauth': GOOGLE_GEMINI_CONFIG,
    minimax: MINIMAX_CONFIG,
}

export function getOAuthProvider (providerId: string): OAuthProviderConfig | null {
    return OAUTH_PROVIDERS[providerId] || null
}

export function isOAuthProvider (providerId: string): boolean {
    return providerId in OAUTH_PROVIDERS
}

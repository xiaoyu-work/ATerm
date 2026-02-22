import { Component } from '@angular/core'
import { ConfigService, PlatformService } from 'aterm-core'

interface AIColorPreset {
    name: string
    content: string
    thinking: string
    command: string
    confirmation: string
    question: string
    error: string
    info: string
}

const AI_COLOR_PRESETS: AIColorPreset[] = [
    { name: 'Default', content: '#4ade80', thinking: '#9ca3af', command: '#6b7280', confirmation: '#facc15', question: '#22d3ee', error: '#f87171', info: '#6b7280' },
    { name: 'Ocean', content: '#67e8f9', thinking: '#94a3b8', command: '#64748b', confirmation: '#fbbf24', question: '#a78bfa', error: '#fb7185', info: '#94a3b8' },
    { name: 'Warm', content: '#fb923c', thinking: '#a8a29e', command: '#78716c', confirmation: '#fde047', question: '#f9a8d4', error: '#ef4444', info: '#a8a29e' },
    { name: 'Mono', content: '#e5e7eb', thinking: '#9ca3af', command: '#6b7280', confirmation: '#d1d5db', question: '#e5e7eb', error: '#f87171', info: '#9ca3af' },
]

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './colorSchemeSettingsTab.component.html',
})
export class ColorSchemeSettingsTabComponent {
    defaultTab = 'dark'
    aiPresets = AI_COLOR_PRESETS

    constructor (
        platform: PlatformService,
        public config: ConfigService,
    ) {
        this.defaultTab = platform.getTheme()
    }

    applyAIPreset (preset: AIColorPreset): void {
        const theme = this.config.store.ai.colorTheme
        theme.preset = preset.name.toLowerCase()
        theme.content = preset.content
        theme.thinking = preset.thinking
        theme.command = preset.command
        theme.confirmation = preset.confirmation
        theme.question = preset.question
        theme.error = preset.error
        theme.info = preset.info
        this.config.save()
    }

    isActiveAIPreset (preset: AIColorPreset): boolean {
        const theme = this.config.store.ai?.colorTheme
        if (!theme) return false
        return theme.content === preset.content &&
            theme.thinking === preset.thinking &&
            theme.command === preset.command &&
            theme.confirmation === preset.confirmation &&
            theme.question === preset.question &&
            theme.error === preset.error &&
            theme.info === preset.info
    }
}

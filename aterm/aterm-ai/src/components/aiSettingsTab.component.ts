import { Component, HostBinding } from '@angular/core'
import { ConfigService } from 'aterm-core'
import { PROVIDER_PRESETS } from '../providers'

@Component({
    standalone: false,
    templateUrl: './aiSettingsTab.component.html',
})
export class AISettingsTabComponent {
    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
    ) {}

    onProviderChange (): void {
        const provider = this.config.store.ai.provider
        const preset = PROVIDER_PRESETS[provider]
        if (preset) {
            // Clear baseUrl so the preset is used, update model to the preset default
            this.config.store.ai.baseUrl = ''
            this.config.store.ai.model = preset.defaultModel
        }
    }

    getBaseUrlPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.baseUrl || 'https://your-endpoint.com/v1/'
    }

    getModelPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.defaultModel || 'model-name'
    }
}

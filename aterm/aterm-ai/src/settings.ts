import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'aterm-settings'

import { AISettingsTabComponent } from './components/aiSettingsTab.component'

@Injectable()
export class AISettingsTabProvider extends SettingsTabProvider {
    id = 'ai'
    icon = 'magic'
    title = 'AI'
    weight = 5

    getComponentType (): any {
        return AISettingsTabComponent
    }
}

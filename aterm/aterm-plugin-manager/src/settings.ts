import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'aterm-settings'

import { PluginsSettingsTabComponent } from './components/pluginsSettingsTab.component'

/** @hidden */
@Injectable()
export class PluginsSettingsTabProvider extends SettingsTabProvider {
    id = 'plugins'
    title = 'Plugins'

    getComponentType (): any {
        return PluginsSettingsTabComponent
    }
}

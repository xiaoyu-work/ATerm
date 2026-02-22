import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'aterm-core'
import { SettingsTabProvider } from 'aterm-settings'

import { ShellSettingsTabComponent } from './components/shellSettingsTab.component'

/** @hidden */
@Injectable()
export class ShellSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-shell'
    icon = 'list-ul'
    title = 'Shell'
    weight = 8

    constructor (private hostApp: HostAppService) {
        super()
    }

    getComponentType (): any {
        if (this.hostApp.platform === Platform.Windows) {
            return ShellSettingsTabComponent
        }
    }
}

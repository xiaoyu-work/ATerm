import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'aterm-settings'

import { SSHSettingsTabComponent } from './components/sshSettingsTab.component'

/** @hidden */
@Injectable()
export class SSHSettingsTabProvider extends SettingsTabProvider {
    id = 'ssh'
    icon = 'globe'
    title = 'SSH'
    weight = 9

    getComponentType (): any {
        return SSHSettingsTabComponent
    }
}

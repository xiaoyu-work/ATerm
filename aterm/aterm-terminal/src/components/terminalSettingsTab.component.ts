import { Component, HostBinding } from '@angular/core'
import { ConfigService, HostAppService, Platform, PlatformService, altKeyName, metaKeyName } from 'aterm-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './terminalSettingsTab.component.html',
})
export class TerminalSettingsTabComponent {
    Platform = Platform
    altKeyName = altKeyName
    metaKeyName = metaKeyName

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        private platform: PlatformService,
    ) { }

    openWSLVolumeMixer (): void {
        this.platform.openPath('sndvol.exe')
        this.platform.exec('wsl.exe', ['tput', 'bel'])
    }
}

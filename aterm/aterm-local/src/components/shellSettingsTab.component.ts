import { Component, HostBinding } from '@angular/core'
import { WIN_BUILD_CONPTY_SUPPORTED, WIN_BUILD_CONPTY_STABLE, isWindowsBuild, ConfigService } from 'aterm-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './shellSettingsTab.component.html',
})
export class ShellSettingsTabComponent {
    isConPTYAvailable: boolean
    isConPTYStable: boolean

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
    ) {
        this.isConPTYAvailable = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED)
        this.isConPTYStable = isWindowsBuild(WIN_BUILD_CONPTY_STABLE)
    }
}

import { Component } from '@angular/core'
import { ConfigService, PlatformService } from 'aterm-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './colorSchemeSettingsTab.component.html',
})
export class ColorSchemeSettingsTabComponent {
    defaultTab = 'dark'

    constructor (
        platform: PlatformService,
        public config: ConfigService,
    ) {
        this.defaultTab = platform.getTheme()
    }
}

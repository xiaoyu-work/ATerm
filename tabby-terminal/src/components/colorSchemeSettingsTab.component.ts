import { Component } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'

/** @hidden */
@Component({
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

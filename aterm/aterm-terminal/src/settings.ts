import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'aterm-settings'

import { AppearanceSettingsTabComponent } from './components/appearanceSettingsTab.component'
import { TerminalSettingsTabComponent } from './components/terminalSettingsTab.component'
import { ColorSchemeSettingsTabComponent } from './components/colorSchemeSettingsTab.component'
import { TranslateService } from 'aterm-core'

/** @hidden */
@Injectable()
export class AppearanceSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-appearance'
    icon = 'swatchbook'
    title = this.translate.instant('Appearance')
    weight = 1

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return AppearanceSettingsTabComponent
    }
}

/** @hidden */
@Injectable()
export class ColorSchemeSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-color-scheme'
    icon = 'palette'
    title = this.translate.instant('Color scheme')
    weight = 2

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return ColorSchemeSettingsTabComponent
    }
}

/** @hidden */
@Injectable()
export class TerminalSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal'
    icon = 'terminal'
    title = this.translate.instant('Terminal')
    weight = 3

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return TerminalSettingsTabComponent
    }
}

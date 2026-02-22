import { Injectable } from '@angular/core'
import { SettingsTabProvider } from './api'
import { HotkeySettingsTabComponent } from './components/hotkeySettingsTab.component'
import { WindowSettingsTabComponent } from './components/windowSettingsTab.component'
import { VaultSettingsTabComponent } from './components/vaultSettingsTab.component'
import { ProfilesSettingsTabComponent } from './components/profilesSettingsTab.component'
import { TranslateService } from 'aterm-core'

/** @hidden */
@Injectable()
export class HotkeySettingsTabProvider extends SettingsTabProvider {
    id = 'hotkeys'
    icon = 'keyboard'
    title = this.translate.instant('Hotkeys')
    weight = 6

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return HotkeySettingsTabComponent
    }
}


/** @hidden */
@Injectable()
export class WindowSettingsTabProvider extends SettingsTabProvider {
    id = 'window'
    icon = 'window-maximize'
    title = this.translate.instant('Window')
    weight = 7

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return WindowSettingsTabComponent
    }
}


/** @hidden */
@Injectable()
export class VaultSettingsTabProvider extends SettingsTabProvider {
    id = 'vault'
    icon = 'key'
    title = 'Vault'
    weight = 10

    getComponentType (): any {
        return VaultSettingsTabComponent
    }
}


/** @hidden */
@Injectable()
export class ProfilesSettingsTabProvider extends SettingsTabProvider {
    id = 'profiles'
    icon = 'window-restore'
    title = this.translate.instant('Profiles & connections')
    weight = 4

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return ProfilesSettingsTabComponent
    }
}


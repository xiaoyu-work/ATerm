/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Inject, Optional } from '@angular/core'
import { LocalProfile, UACService } from '../api'
import { FullyDefined, PlatformService, ProfileSettingsComponent } from 'aterm-core'
import { LocalProfilesService } from '../profiles'


/** @hidden */
@Component({
    standalone: false,
    templateUrl: './localProfileSettings.component.html',
})
export class LocalProfileSettingsComponent implements ProfileSettingsComponent<LocalProfile, LocalProfilesService> {
    profile: FullyDefined<LocalProfile>

    constructor (
        @Optional() @Inject(UACService) public uac: UACService|undefined,
        private platform: PlatformService,
    ) { }

    async pickWorkingDirectory (): Promise<void> {
        const cwd = await this.platform.pickDirectory()
        if (!cwd) {
            return
        }
        this.profile.options.cwd = cwd
    }
}

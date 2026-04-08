/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component } from '@angular/core'

import { FullyDefined, ProfileSettingsComponent } from 'aterm-core'
import { TelnetProfile } from '../session'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './telnetProfileSettings.component.html',
})
export class TelnetProfileSettingsComponent implements ProfileSettingsComponent<TelnetProfile> {
    profile: FullyDefined<TelnetProfile>
}

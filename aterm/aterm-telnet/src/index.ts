import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'
import { FileSizePipe } from 'aterm-core'
import AtermCoreModule, { ConfigProvider, TabRecoveryProvider, HotkeyProvider, ProfileProvider } from 'aterm-core'
import AtermTerminalModule from 'aterm-terminal'

import { TelnetProfileSettingsComponent } from './components/telnetProfileSettings.component'
import { TelnetTabComponent } from './components/telnetTab.component'

import { TelnetConfigProvider } from './config'
import { RecoveryProvider } from './recoveryProvider'
import { TelnetHotkeyProvider } from './hotkeys'
import { TelnetProfilesService } from './profiles'

/** @hidden */
@NgModule({
    imports: [
        NgbModule,
        FileSizePipe,
        CommonModule,
        FormsModule,
        ToastrModule,
        AtermCoreModule,
        AtermTerminalModule,
    ],
    providers: [
        { provide: ConfigProvider, useClass: TelnetConfigProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: RecoveryProvider, multi: true },
        { provide: HotkeyProvider, useClass: TelnetHotkeyProvider, multi: true },
        { provide: ProfileProvider, useExisting: TelnetProfilesService, multi: true },
    ],
    declarations: [
        TelnetProfileSettingsComponent,
        TelnetTabComponent,
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class TelnetModule { }

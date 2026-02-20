/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ConfigProvider } from 'aterm-core'
import { SettingsTabProvider } from 'aterm-settings'
import { TerminalDecorator } from 'aterm-terminal'

import { AIService } from './ai.service'
import { AIDecorator } from './decorator'
import { AIConfigProvider } from './config'
import { AISettingsTabProvider } from './settings'
import { AISettingsTabComponent } from './components/aiSettingsTab.component'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
    ],
    providers: [
        { provide: TerminalDecorator, useClass: AIDecorator, multi: true },
        { provide: ConfigProvider, useClass: AIConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AISettingsTabProvider, multi: true },
        AIService,
    ],
    declarations: [
        AISettingsTabComponent,
    ],
})
export default class TabbyAIModule {}

export { AIService } from './ai.service'
export { AIDecorator } from './decorator'
export { ContextCollector } from './contextCollector'

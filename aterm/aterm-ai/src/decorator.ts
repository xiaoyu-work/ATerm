import { Injectable } from '@angular/core'
import { PlatformService } from 'aterm-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'aterm-terminal'
import { AIMiddleware } from './aiMiddleware'

/**
 * Terminal decorator that attaches the AIMiddleware to every terminal session.
 *
 * The middleware only captures `@ prompt` input and injects `__aterm_ai`
 * shell commands. All AI output flows through ConPTY naturally.
 */
@Injectable()
export class AIDecorator extends TerminalDecorator {
    constructor (
        private platform: PlatformService,
    ) {
        super()
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        let currentSession: any = null

        const attachToSession = () => {
            try {
                if (!tab.session || tab.session === currentSession) {
                    return
                }
                currentSession = tab.session

                const aiMiddleware = new AIMiddleware(this.platform)
                tab.session.middleware.unshift(aiMiddleware)
            } catch (e) {
                console.error('[aterm-ai] Failed to attach AI middleware:', e)
            }
        }

        // Defer initial attach to next tick — matches ZModemDecorator pattern.
        setTimeout(() => {
            attachToSession()

            this.subscribeUntilDetached(tab, tab.sessionChanged$.subscribe(() => {
                attachToSession()
            }))
        })

        // Additional fallback retries for edge cases (slow session restore)
        setTimeout(() => attachToSession(), 500)
        setTimeout(() => attachToSession(), 2000)
    }
}

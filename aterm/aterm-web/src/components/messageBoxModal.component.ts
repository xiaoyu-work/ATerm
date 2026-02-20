import { Component, Input, ElementRef } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseComponent, HotkeysService, MessageBoxOptions } from 'aterm-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './messageBoxModal.component.html',
})
export class MessageBoxModalComponent extends BaseComponent {
    @Input() options: MessageBoxOptions

    constructor (
        hotkeys: HotkeysService,
        private element: ElementRef,
        private modalInstance: NgbActiveModal,
    ) {
        super()
        this.subscribeUntilDestroyed(hotkeys.key, (event: KeyboardEvent) => {
            if (event.type === 'keydown') {
                if (event.key === 'Enter' && this.options.defaultId !== undefined) {
                    this.modalInstance.close(this.options.defaultId)
                }
            }
        })
    }

    ngAfterViewInit (): void {
        this.element.nativeElement.querySelector('button[autofocus]').focus()
    }

    onButton (index: number): void {
        this.modalInstance.close(index)
    }
}

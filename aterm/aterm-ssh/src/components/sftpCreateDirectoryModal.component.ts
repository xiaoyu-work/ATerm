import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseComponent } from 'aterm-core'

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './sftpCreateDirectoryModal.component.html',
})
export class SFTPCreateDirectoryModalComponent extends BaseComponent {
    directoryName: string

    constructor (
        private modalInstance: NgbActiveModal,
    ) {
        super()
    }

    create (): void {
        this.modalInstance.close(this.directoryName)
    }

    cancel (): void {
        this.modalInstance.close('')
    }
}

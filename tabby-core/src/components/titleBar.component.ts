import { Component, Input } from '@angular/core'
import { HostWindowService } from '../api'

/** @hidden */
@Component({
    standalone: false,
    selector: 'title-bar',
    templateUrl: './titleBar.component.html',
    styleUrls: ['./titleBar.component.scss'],
})
export class TitleBarComponent {
    @Input() hideControls: boolean

    constructor (public hostWindow: HostWindowService) { }
}

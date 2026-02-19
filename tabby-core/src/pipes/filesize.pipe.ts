import { Pipe, PipeTransform } from '@angular/core'
import filesize from 'filesize'

@Pipe({
    name: 'filesize',
    standalone: true,
})
export class FileSizePipe implements PipeTransform {
    transform (value: number | number[], options?: any): string | string[] {
        if (Array.isArray(value)) {
            return value.map(v => filesize(v, options) as string)
        }
        return filesize(value, options) as string
    }
}

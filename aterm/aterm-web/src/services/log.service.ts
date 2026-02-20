import { Injectable } from '@angular/core'
import { ConsoleLogger, Logger } from 'aterm-core'

@Injectable({ providedIn: 'root' })
export class ConsoleLogService {
    create (name: string): Logger {
        return new ConsoleLogger(name)
    }
}

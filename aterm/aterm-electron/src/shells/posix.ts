import * as fs from 'mz/fs'
import slugify from 'slugify'
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'aterm-core'

import { ShellProvider, Shell } from 'aterm-local'

/** @hidden */
@Injectable()
export class POSIXShellsProvider extends ShellProvider {
    constructor (
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform === Platform.Windows) {
            return []
        }
        let shellListPath = '/etc/shells'
        try {
            await fs.stat(shellListPath)
        } catch {
            // Solus Linux
            shellListPath = '/usr/share/defaults/etc/shells'
        }
        const lines = (await fs.readFile(shellListPath, { encoding: 'utf-8' }))
            .split('\n')
            .map(x => x.trim())
            .filter(x => x && !x.startsWith('#'))

        // Deduplicate shells that resolve to the same real path (e.g. /bin/bash → /usr/bin/bash)
        const seen = new Set<string>()
        const unique: string[] = []
        for (const line of lines) {
            try {
                const real = await fs.realpath(line)
                if (!seen.has(real)) {
                    seen.add(real)
                    unique.push(line)
                }
            } catch {
                // Shell doesn't exist, skip
            }
        }

        return unique.map(x => ({
                id: slugify(x),
                name: x.split('/').pop()!,
                icon: 'fas fa-terminal',
                command: x,
                args: ['-l'],
                env: {},
            }))
    }
}

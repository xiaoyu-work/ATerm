import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = Buffer.from('\x1b]')
const OSCSuffixes = [Buffer.from('\x07'), Buffer.from('\x1b\\')]

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get promptStart$ (): Observable<void> { return this.promptStart }
    get commandInputStart$ (): Observable<void> { return this.commandInputStart }
    get commandExecuted$ (): Observable<void> { return this.commandExecuted }
    get commandFinished$ (): Observable<{ exitCode: number }> { return this.commandFinished }

    private cwdReported = new Subject<string>()
    private promptStart = new Subject<void>()
    private commandInputStart = new Subject<void>()
    private commandExecuted = new Subject<void>()
    private commandFinished = new Subject<{ exitCode: number }>()

    feedFromSession (data: Buffer): void {
        let startIndex = 0
        // Collect byte ranges to strip (OSC 133 sequences should not reach xterm.js)
        const stripRanges: [number, number][] = []

        while (data.includes(OSCPrefix, startIndex)) {
            const si = startIndex
            if (!OSCSuffixes.some(s => data.includes(s, si))) {
                break
            }

            const oscStart = data.indexOf(OSCPrefix, startIndex)
            const params = data.subarray(oscStart + OSCPrefix.length)

            const [closesSuffix, closestSuffixIndex] = OSCSuffixes
                .map((suffix): [Buffer, number] => [suffix, params.indexOf(suffix)])
                .filter(([_, index]) => index !== -1)
                .sort(([_, a], [__, b]) => a - b)[0]

            const oscString = params.subarray(0, closestSuffixIndex).toString()

            const oscEnd = oscStart + OSCPrefix.length + closestSuffixIndex + closesSuffix.length
            startIndex = oscEnd

            const [oscCodeString, ...oscParams] = oscString.split(';')
            const oscCode = parseInt(oscCodeString)

            if (oscCode === 133) {
                stripRanges.push([oscStart, oscEnd])
                const param = oscParams[0]
                switch (param) {
                    case 'A':
                        this.promptStart.next()
                        break
                    case 'B':
                        this.commandInputStart.next()
                        break
                    case 'C':
                        this.commandExecuted.next()
                        break
                    case 'D': {
                        const exitCode = parseInt(oscParams[1] || '0')
                        this.commandFinished.next({ exitCode: isNaN(exitCode) ? 0 : exitCode })
                        break
                    }
                }
            } else if (oscCode === 1337) {
                const paramString = oscParams.join(';')
                if (paramString.startsWith('CurrentDir=')) {
                    let reportedCWD = paramString.split('=')[1]
                    if (reportedCWD.startsWith('~')) {
                        reportedCWD = os.homedir() + reportedCWD.substring(1)
                    }
                    this.cwdReported.next(reportedCWD)
                } else {
                    console.debug('Unsupported OSC 1337 parameter:', paramString)
                }
            } else {
                continue
            }
        }

        // Strip OSC 133 sequences from data before passing downstream
        if (stripRanges.length > 0) {
            const chunks: Buffer[] = []
            let pos = 0
            for (const [start, end] of stripRanges) {
                if (start > pos) {
                    chunks.push(data.subarray(pos, start))
                }
                pos = end
            }
            if (pos < data.length) {
                chunks.push(data.subarray(pos))
            }
            const filtered = Buffer.concat(chunks)
            if (filtered.length > 0) {
                super.feedFromSession(filtered)
            }
        } else {
            super.feedFromSession(data)
        }
    }

    close (): void {
        this.cwdReported.complete()
        this.promptStart.complete()
        this.commandInputStart.complete()
        this.commandExecuted.complete()
        this.commandFinished.complete()
        super.close()
    }
}

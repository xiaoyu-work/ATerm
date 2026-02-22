import { Subject, Observable } from 'rxjs'
import { SubscriptionContainer } from 'aterm-core'

export class SessionMiddleware {
    get outputToSession$ (): Observable<Buffer> { return this.outputToSession }
    get outputToTerminal$ (): Observable<Buffer> { return this.outputToTerminal }
    get resizeRequested$ (): Observable<{ columns: number, rows: number }> { return this.resizeRequested }

    protected outputToSession = new Subject<Buffer>()
    protected outputToTerminal = new Subject<Buffer>()
    protected resizeRequested = new Subject<{ columns: number, rows: number }>()

    feedFromSession (data: Buffer): void {
        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
        this.outputToSession.next(data)
    }

    // Optional hook for terminal resize notifications.
    // Middleware can override this to react to UI resizes.
    // Return false to defer the resize (prevent session.resize() from being called).
    onTerminalResize (_columns: number, _rows: number): boolean {
        return true
    }

    close (): void {
        this.outputToSession.complete()
        this.outputToTerminal.complete()
        this.resizeRequested.complete()
    }
}

export class SessionMiddlewareStack extends SessionMiddleware {
    private stack: SessionMiddleware[] = []
    private subs = new SubscriptionContainer()

    constructor () {
        super()
        this.push(new SessionMiddleware())
    }

    push (middleware: SessionMiddleware): void {
        this.stack.push(middleware)
        this.relink()
    }

    unshift (middleware: SessionMiddleware): void {
        this.stack.unshift(middleware)
        this.relink()
    }

    remove (middleware: SessionMiddleware): void {
        this.stack = this.stack.filter(m => m !== middleware)
        this.relink()
    }

    replace (middleware: SessionMiddleware, newMiddleware: SessionMiddleware): void {
        const index = this.stack.indexOf(middleware)
        if (index >= 0) {
            this.stack[index].close()
            this.stack[index] = newMiddleware
        } else {
            this.stack.push(newMiddleware)
        }
        this.relink()
    }

    feedFromSession (data: Buffer): void {
        this.stack[0].feedFromSession(data)
    }

    feedFromTerminal (data: Buffer): void {
        this.stack[this.stack.length - 1].feedFromTerminal(data)
    }

    notifyTerminalResize (columns: number, rows: number): boolean {
        let shouldResize = true
        for (const middleware of this.stack) {
            if (!middleware.onTerminalResize(columns, rows)) {
                shouldResize = false
            }
        }
        return shouldResize
    }

    close (): void {
        for (const m of this.stack) {
            m.close()
        }
        this.subs.cancelAll()
        super.close()
    }

    private relink () {
        this.subs.cancelAll()

        for (let i = 0; i < this.stack.length - 1; i++) {
            this.subs.subscribe(
                this.stack[i].outputToTerminal$,
                x => this.stack[i + 1].feedFromSession(x),
            )
        }
        this.subs.subscribe(
            this.stack[this.stack.length - 1].outputToTerminal$,
            x => this.outputToTerminal.next(x),
        )

        for (let i = this.stack.length - 2; i >= 0; i--) {
            this.subs.subscribe(
                this.stack[i + 1].outputToSession$,
                x => this.stack[i].feedFromTerminal(x),
            )
        }
        this.subs.subscribe(
            this.stack[0].outputToSession$,
            x => this.outputToSession.next(x),
        )

        // Aggregate resize requests from all middleware
        for (const mw of this.stack) {
            this.subs.subscribe(
                mw.resizeRequested$,
                req => this.resizeRequested.next(req),
            )
        }
    }
}

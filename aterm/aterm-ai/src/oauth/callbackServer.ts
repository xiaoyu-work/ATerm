import * as http from 'http'

/**
 * Ephemeral HTTP server that captures an OAuth redirect callback.
 * Binds to 127.0.0.1 on a random port for security.
 */
export class OAuthCallbackServer {
    private server: http.Server | null = null
    private _port = 0

    get port (): number {
        return this._port
    }

    /**
     * Start the server on a random port and return the redirect URI.
     * @param callbackPath  The path to listen on (e.g., '/oauth2callback')
     * @returns The full redirect URI (e.g., 'http://127.0.0.1:12345/oauth2callback')
     */
    async start (callbackPath: string): Promise<string> {
        return this.startOnPort(0, callbackPath)
    }

    /**
     * Start the server on a specific port (or 0 for random) and return the redirect URI.
     * @param hostname Hostname to use in the redirect URI (default '127.0.0.1').
     *                 The server always binds to 127.0.0.1 regardless of this value.
     */
    async startOnPort (port: number, callbackPath: string, hostname = '127.0.0.1'): Promise<string> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer()
            this.server.once('error', reject)
            this.server.listen(port, '127.0.0.1', () => {
                const addr = this.server!.address()
                if (typeof addr === 'object' && addr) {
                    this._port = addr.port
                }
                resolve(`http://${hostname}:${this._port}${callbackPath}`)
            })
        })
    }

    /**
     * Wait for the OAuth callback.
     * Returns the authorization code and state from the query parameters.
     * @param expectedState The expected state value for CSRF validation
     * @param timeoutMs     Timeout in milliseconds (default 3 minutes)
     */
    waitForCallback (expectedState: string, timeoutMs = 180000): Promise<{ code: string; state: string }> {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                return reject(new Error('Server not started'))
            }

            const timeout = setTimeout(() => {
                this.stop()
                reject(new Error('OAuth callback timeout'))
            }, timeoutMs)

            this.server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
                try {
                    const url = new URL(req.url || '/', `http://127.0.0.1:${this._port}`)
                    const code = url.searchParams.get('code')?.trim()
                    const state = url.searchParams.get('state')?.trim()

                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' })
                        res.end('Missing authorization code')
                        return
                    }

                    if (state !== expectedState) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' })
                        res.end('Invalid state parameter')
                        return
                    }

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end('<!doctype html><html><body><h2>Authorization complete</h2><p>You can close this window and return to ATerm.</p></body></html>')

                    clearTimeout(timeout)
                    this.stop()
                    resolve({ code, state })
                } catch (err) {
                    clearTimeout(timeout)
                    this.stop()
                    reject(err)
                }
            })
        })
    }

    /**
     * Stop the server.
     */
    stop (): void {
        try {
            this.server?.close()
        } catch {
            // Ignore close errors
        }
        this.server = null
    }
}

import { app, ipcMain, Menu, dialog } from 'electron'

// set userData Path on portable version
import './portable'

// set defaults of environment variables
import 'dotenv/config'
process.env.ATERM_PLUGINS ??= ''
process.env.ATERM_CONFIG_DIRECTORY ??= app.getPath('userData')


import 'v8-compile-cache'
import 'source-map-support/register'
import './sentry'
import './lru'
import { parseArgs } from './cli'
import { Application } from './app'
import { loadConfig } from './config'


const argv = parseArgs(process.argv, process.cwd())

// eslint-disable-next-line @typescript-eslint/init-declarations
let configStore: any

try {
    configStore = loadConfig()
} catch (err) {
    dialog.showErrorBox('Could not read config', err.message)
    app.exit(1)
}

process.mainModule = module

const application = new Application(configStore)

// Register aterm:// URL scheme
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('aterm', process.execPath, [process.argv[1]])
    }
} else {
    app.setAsDefaultProtocolClient('aterm')
}

ipcMain.on('app:new-window', () => {
    application.newWindow()
})

process.on('uncaughtException' as any, err => {
    console.log(err)
    application.broadcast('uncaughtException', err)
})

if (argv.d) {
    // Manually set up dev tools without electron-debug,
    // because electron-debug registers CommandOrControl+R as reload
    // which conflicts with terminal reverse-i-search (Ctrl+R in bash).
    const { BrowserWindow } = require('electron')
    const localShortcut = require('electron-localshortcut')

    app.on('browser-window-created', (_event, win) => {
        win.webContents.once('dom-ready', () => {
            win.webContents.openDevTools({ mode: 'undocked' })
        })
    })

    app.whenReady().then(() => {
        localShortcut.register('CommandOrControl+Shift+C', () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) {
                if (win.webContents.isDevToolsOpened()) {
                    win.webContents.devToolsWebContents?.executeJavaScript('DevToolsAPI.enterInspectElementMode()')
                } else {
                    win.webContents.once('devtools-opened', () => {
                        win.webContents.devToolsWebContents?.executeJavaScript('DevToolsAPI.enterInspectElementMode()')
                    })
                    win.webContents.openDevTools()
                }
            }
        })
        localShortcut.register(process.platform === 'darwin' ? 'Command+Alt+I' : 'Control+Shift+I', () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) {
                if (win.webContents.isDevToolsOpened()) {
                    win.webContents.closeDevTools()
                } else {
                    win.webContents.openDevTools({ mode: 'undocked' })
                }
            }
        })
        localShortcut.register('F12', () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) {
                if (win.webContents.isDevToolsOpened()) {
                    win.webContents.closeDevTools()
                } else {
                    win.webContents.openDevTools({ mode: 'undocked' })
                }
            }
        })
        // Intentionally NOT registering CommandOrControl+R and F5
        // to allow terminal apps (bash reverse-i-search) to use Ctrl+R
    })
}

app.on('activate', async () => {
    if (!application.hasWindows()) {
        application.newWindow()
    } else {
        application.focus()
    }
})

// Handle URL scheme on macOS
app.on('open-url', async (event, url) => {
    event.preventDefault()
    console.log('Received open-url event:', url)
    if (!application.hasWindows()) {
        process.argv.push(url)
    } else {
        await app.whenReady()
        application.handleSecondInstance([url], process.cwd())
    }
})

app.on('second-instance', async (_event, newArgv, cwd) => {
    application.handleSecondInstance(newArgv, cwd)
})

if (!app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

app.on('ready', async () => {
    if (process.platform === 'darwin') {
        app.dock.setMenu(Menu.buildFromTemplate([
            {
                label: 'New window',
                click () {
                    this.app.newWindow()
                },
            },
        ]))
    }

    application.init()

    const window = await application.newWindow({ hidden: argv.hidden })
    await window.ready
    window.passCliArguments(process.argv, process.cwd(), false)
    window.focus()
})

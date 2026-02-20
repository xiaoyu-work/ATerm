/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-extraneous-class */

import './polyfills.buffer'
import { Duplex } from 'stream-browserify'

const Aterm = window['Aterm']

export class SocketProxy extends Duplex {
    socket: any

    constructor (...args: any[]) {
        super({
            allowHalfOpen: false,
        })
        this.socket = window['__connector__'].createSocket(...args)
        this.socket.connect$.subscribe(() => this['emit']('connect'))
        this.socket.data$.subscribe(data => this['emit']('data', Buffer.from(data)))
        this.socket.error$.subscribe(error => this['emit']('error', error))
    }

    connect (...args: any[]) {
        this.socket.connect(...args)
    }

    setNoDelay () { }

    setTimeout () { }

    _read (_size: number): void { }

    _write (chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
        this.socket.write(chunk)
        callback()
    }

    _destroy (error: Error|null, callback: (error: Error|null) => void): void {
        this.socket.close(error)
        callback(error)
    }
}

Aterm.registerMock('fs', {
    rmdirSync: () => null,
    realpathSync: () => null,
    readdir: () => null,
    stat: () => null,
    appendFile: () => null,
    constants: {},
})
Aterm.registerMock('fs/promises', {})
Aterm.registerMock('tls', {})
Aterm.registerMock('module', {
    globalPaths: [],
    prototype: { require: window['require'] },
})

Aterm.registerMock('http', {
    Agent: class {},
    request: {},
})
Aterm.registerMock('https', {
    Agent: class {},
    request: {},
})
Aterm.registerMock('querystring', {})
Aterm.registerMock('tty', { isatty: () => false })
Aterm.registerMock('child_process', {})
Aterm.registerMock('readable-stream', {})
Aterm.registerMock('os', {
    arch: () => 'web',
    platform: () => 'web',
    homedir: () => '/home',
    tmpdir: () => '/tmp',
    constants: {
        errno: {},
    },
})
Aterm.registerModule('buffer', {
    Buffer: window['Buffer'],
})
Aterm.registerModule('crypto', {
    ...require('crypto-browserify'),
    getHashes () {
        return ['sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'md5', 'rmd160']
    },
    timingSafeEqual (a, b) {
        return a.equals(b)
    },
})
Aterm.registerMock('dns', {})
Aterm.registerMock('@luminati-io/socksv5', {})
Aterm.registerMock('util', require('util/'))
Aterm.registerMock('keytar', {
    getPassword: () => null,
})
Aterm.registerMock('@serialport/bindings', {})
Aterm.registerMock('@serialport/bindings-cpp', {})
Aterm.registerMock('tmp', {})

Aterm.registerModule('net', {
    Socket: SocketProxy,
})
Aterm.registerModule('events', require('events'))
Aterm.registerModule('path', require('path-browserify'))
Aterm.registerModule('url', {
    ...require('url'),
    pathToFileURL: x => `file://${x}`,
})
Aterm.registerModule('zlib', {
    ...require('browserify-zlib'),
    constants: require('browserify-zlib'),
})
Aterm.registerModule('assert', Object.assign(
    require('assert'),
    {
        assertNotStrictEqual: () => true,
        notStrictEqual: () => true,
    },
))
Aterm.registerModule('constants', require('constants-browserify'))
Aterm.registerModule('stream', require('stream-browserify'))
Aterm.registerModule('readline', {
    ...require('readline-browserify'),
    cursorTo: () => null,
    clearLine: stream => stream.write('\r'),
})

Aterm.registerModule('@angular/core', require('@angular/core'))
Aterm.registerModule('@angular/cdk', require('@angular/cdk'))
Aterm.registerModule('@angular/cdk/clipboard', require('@angular/cdk/clipboard'))
Aterm.registerModule('@angular/cdk/drag-drop', require('@angular/cdk/drag-drop'))
Aterm.registerModule('@angular/compiler', require('@angular/compiler'))
Aterm.registerModule('@angular/common', require('@angular/common'))
Aterm.registerModule('@angular/forms', require('@angular/forms'))
Aterm.registerModule('@angular/platform-browser', require('@angular/platform-browser'))
Aterm.registerModule('@angular/platform-browser/animations', require('@angular/platform-browser/animations'))
Aterm.registerModule('@angular/platform-browser-dynamic', require('@angular/platform-browser-dynamic'))
Aterm.registerModule('@angular/animations', require('@angular/animations'))
Aterm.registerModule('@angular/localize', require('@angular/localize'))
Aterm.registerModule('@angular/localize/init', require('@angular/localize/init'))
Aterm.registerModule('@ng-bootstrap/ng-bootstrap', require('@ng-bootstrap/ng-bootstrap'))
Aterm.registerModule('ngx-toastr', require('ngx-toastr'))
Aterm.registerModule('deepmerge', require('deepmerge'))
Aterm.registerModule('rxjs', require('rxjs'))
Aterm.registerModule('rxjs/operators', require('rxjs'))
Aterm.registerModule('string_decoder', require('string_decoder'))
Aterm.registerModule('js-yaml', require('js-yaml'))
Aterm.registerModule('zone.js/dist/zone.js', require('zone.js'))
Aterm.registerModule('zone.js', require('zone.js'))
Aterm.registerModule('any-promise', require('any-promise'))

Object.assign(window, {
    __dirname: '__dirname',
    setImmediate: setTimeout as any,
})

process.addListener = () => null

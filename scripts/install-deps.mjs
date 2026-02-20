#!/usr/bin/env node
import sh from 'shelljs'
import * as vars from './vars.mjs'
import log from 'npmlog'

log.info('patch')
sh.exec(`yarn patch-package`, { fatal: true })

log.info('deps', 'app')

sh.cd('app')
sh.exec(`yarn install --mode=skip-build`, { fatal: true })
sh.exec(`yarn postinstall`, { fatal: false })
sh.cd('..')

sh.cd('web')
sh.exec(`yarn install`, { fatal: true })
sh.exec(`yarn patch-package`, { fatal: true })
sh.cd('..')

vars.allPackages.forEach(plugin => {
    log.info('deps', plugin)
    const pluginDir = plugin === 'web' ? plugin : 'aterm/' + plugin
    sh.cd(pluginDir)
    sh.exec(`yarn install`, { fatal: true })
    if (sh.test('-d', 'patches')) {
        sh.exec(`yarn patch-package`, { fatal: false })
    }
    sh.cd(plugin === 'web' ? '..' : '../..')
})

if (['darwin', 'linux'].includes(process.platform)) {
    sh.cd('node_modules')
    for (let x of vars.builtinPlugins) {
        sh.ln('-fs', '../aterm/' + x, x)
    }
    sh.cd('..')
}

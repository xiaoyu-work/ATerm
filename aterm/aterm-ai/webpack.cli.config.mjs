/**
 * Webpack config for the aterm-ai CLI bundle.
 * Produces a standalone Node.js script (dist/cli.js) with no Angular/Electron deps.
 */
import * as path from 'path'
import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

export default () => ({
    target: 'node',
    entry: './src/cli/main.ts',
    context: __dirname,
    devtool: 'source-map',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'cli.js',
        libraryTarget: 'commonjs2',
    },
    mode: process.env.ATERM_DEV ? 'development' : 'production',
    optimization: {
        minimize: false,
    },
    resolve: {
        modules: ['.', 'src', 'node_modules', '../../app/node_modules', '../../node_modules'],
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        transpileOnly: true,
                        compilerOptions: {
                            module: 'es2022',
                            target: 'es2022',
                            moduleResolution: 'node',
                            esModuleInterop: true,
                            allowSyntheticDefaultImports: true,
                            experimentalDecorators: true,
                            emitDecoratorMetadata: true,
                            skipLibCheck: true,
                            strictNullChecks: true,
                            noImplicitAny: false,
                        },
                    },
                },
            },
        ],
    },
    externals: [
        'child_process',
        'fs',
        'os',
        'path',
        'readline',
        'stream',
        'net',
        'crypto',
        'util',
    ],
})

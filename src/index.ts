import fs from 'fs'
import { AddressInfo } from 'net'
import os from 'os'
import { fileURLToPath } from 'url'
import path from 'path'
import colors from 'picocolors'
import { Plugin, loadEnv, UserConfig, ConfigEnv, ResolvedConfig, PluginOption } from 'vite'
import fullReload, { Config as FullReloadConfig } from 'vite-plugin-full-reload'
import { InputOption } from "rollup"

interface PluginConfig {
    /**
     * The path or paths of the entry points to compile.
     */
    input: InputOption

    /**
     * Spring's public directory.
     *
     * @default 'src/main/resources/static/''
     */
    publicDirectory?: string

    /**
     * The public subdirectory where compiled assets should be written.
     *
     * @default 'build'
     */
    buildDirectory?: string

    /**
     * The path to the "hot" file.
     *
     * @default `${publicDirectory}/hot`
     */
    hotFile?: string

    /**
     * Configuration for performing full page refresh (or other) file changes.
     *
     * {@link https://github.com/ElMassimo/vite-plugin-full-reload}
     * @default false
     */
    refresh?: boolean|string|string[]|RefreshConfig|RefreshConfig[]

    /**
     * Utilise the Herd or Valet TLS certificates.
     *
     * @default null
     */
    detectTls?: string|boolean|null,

    /**
     * Utilise the Herd or Valet TLS certificates.
     *
     * @default null
     * @deprecated use "detectTls" instead
     */
    valetTls?: string|boolean|null,

    /**
     * Transform the code while serving.
     */
    transformOnServe?: (code: string, url: DevServerUrl) => string,
}

interface RefreshConfig {
    paths: string[],
    config?: FullReloadConfig,
}

interface SpringPlugin extends Plugin {
    config: (config: UserConfig, env: ConfigEnv) => UserConfig
}

type DevServerUrl = `${'http'|'https'}://${string}:${number}`

let exitHandlersBound = false

export const refreshPaths = [
    'src/main/**',
    'frontend/**',
].filter(path => fs.existsSync(path.replace(/\*\*$/, '')))

/**
 * Spring plugin for Vite.
 *
 * @param config - A config object or relative path(s) of the scripts to be compiled.
 */
export default function spring(config: string|string[]|PluginConfig): [SpringPlugin, ...Plugin[]]  {
    const pluginConfig = resolvePluginConfig(config)

    return [
        resolveSpringPlugin(pluginConfig),
        ...resolveFullReloadConfig(pluginConfig) as Plugin[],
    ];
}

/**
 * Resolve the Spring Plugin configuration.
 */
function resolveSpringPlugin(pluginConfig: Required<PluginConfig>): SpringPlugin {
    let viteDevServerUrl: DevServerUrl
    let resolvedConfig: ResolvedConfig
    let userConfig: UserConfig

    const defaultAliases: Record<string, string> = {
        '@': '/frontend/src',
    };

    return {
        name: 'spring',
        enforce: 'post',
        config: (config, { command, mode }) => {
            userConfig = config
            const env = loadEnv(mode, userConfig.envDir || process.cwd(), '')
            const assetUrl = env.ASSET_URL ?? ''
            const serverConfig = command === 'serve'
                ? (resolveDevelopmentEnvironmentServerConfig(pluginConfig.detectTls) ?? resolveEnvironmentServerConfig(env))
                : undefined

            ensureCommandShouldRunInEnvironment(command, env)

            return {
                base: userConfig.base ?? (command === 'build' ? resolveBase(pluginConfig, assetUrl) : ''),
                publicDir: userConfig.publicDir ?? false,
                build: {
                    manifest: userConfig.build?.manifest ?? ('manifest.json'),
                    outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig),
                    rollupOptions: {
                        input: userConfig.build?.rollupOptions?.input ?? resolveInput(pluginConfig)
                    },
                    assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
                },
                server: {
                    origin: userConfig.server?.origin ?? '__spring_vite_placeholder__',
                    ...(serverConfig ? {
                        host: userConfig.server?.host ?? serverConfig.host,
                        hmr: userConfig.server?.hmr === false ? false : {
                            ...serverConfig.hmr,
                            ...(userConfig.server?.hmr === true ? {} : userConfig.server?.hmr),
                        },
                        https: userConfig.server?.https ?? serverConfig.https,
                    } : undefined),
                },
                resolve: {
                    alias: Array.isArray(userConfig.resolve?.alias)
                        ? [
                            ...userConfig.resolve?.alias ?? [],
                            ...Object.keys(defaultAliases).map(alias => ({
                                find: alias,
                                replacement: defaultAliases[alias]
                            }))
                        ]
                        : {
                            ...defaultAliases,
                            ...userConfig.resolve?.alias,
                        }
                },
            }
        },
        configResolved(config) {
            resolvedConfig = config
        },
        transform(code) {
            if (resolvedConfig.command === 'serve') {
                code = code.replace(/__spring_vite_placeholder__/g, viteDevServerUrl)

                return pluginConfig.transformOnServe(code, viteDevServerUrl)
            }
        },
        configureServer(server) {
            server.httpServer?.once('listening', () => {
                const address = server.httpServer?.address()

                const isAddressInfo = (x: string|AddressInfo|null|undefined): x is AddressInfo => typeof x === 'object'
                if (isAddressInfo(address)) {
                    viteDevServerUrl = userConfig.server?.origin ? userConfig.server.origin as DevServerUrl : resolveDevServerUrl(address, server.config, userConfig)

                    fs.writeFileSync(pluginConfig.hotFile, `${viteDevServerUrl}${server.config.base.replace(/\/$/, '')}`)

                    setTimeout(() => {
                        server.config.logger.info(`\n  ${colors.green(`${colors.bold('Spring')}`)}  ${colors.dim('plugin')} ${colors.bold(`v${pluginVersion()}`)}`)
                        server.config.logger.info('')

                        if (typeof resolvedConfig.server.https === 'object' && typeof resolvedConfig.server.https.key === 'string') {
                            if (resolvedConfig.server.https.key.startsWith(herdMacConfigPath()) || resolvedConfig.server.https.key.startsWith(herdWindowsConfigPath())) {
                                server.config.logger.info(`  ${colors.green('➜')}  Using Herd certificate to secure Vite.`)
                            }

                            if (resolvedConfig.server.https.key.startsWith(valetConfigPath())) {
                                server.config.logger.info(`  ${colors.green('➜')}  Using Valet certificate to secure Vite.`)
                            }
                        }
                    }, 100)
                }
            })

            if (! exitHandlersBound) {
                const clean = () => {
                    if (fs.existsSync(pluginConfig.hotFile)) {
                        fs.rmSync(pluginConfig.hotFile)
                    }
                }

                process.on('exit', clean)
                process.on('SIGINT', () => process.exit())
                process.on('SIGTERM', () => process.exit())
                process.on('SIGHUP', () => process.exit())

                exitHandlersBound = true
            }

            return () => server.middlewares.use((req, res, next) => {
                if (req.url === '/index.html') {
                    res.statusCode = 404

                    res.end(
                        fs.readFileSync(path.join(dirname(), 'dev-server-index.html')).toString()
                    )
                }

                next()
            })
        }
    }
}

/**
 * Validate the command can run in the given environment.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ensureCommandShouldRunInEnvironment(command: 'build'|'serve', env: Record<string, string>): void {
    // todo implement logic for Spring
}


/**
 * The version of the Spring Vite plugin being run.
 */
function pluginVersion(): string {
    try {
        return JSON.parse(fs.readFileSync(path.join(dirname(), '../package.json')).toString())?.version
    } catch {
        return ''
    }
}

/**
 * Convert the users configuration into a standard structure with defaults.
 */
function resolvePluginConfig(config: string|string[]|PluginConfig): Required<PluginConfig> {
    if (typeof config === 'undefined') {
        throw new Error('spring-vite-plugin: missing configuration.')
    }

    if (typeof config === 'string' || Array.isArray(config)) {
        config = { input: config }
    }

    if (typeof config.input === 'undefined') {
        throw new Error('spring-vite-plugin: missing configuration for "input".')
    }

    if (typeof config.publicDirectory === 'string') {
        config.publicDirectory = config.publicDirectory.trim().replace(/^\/+/, '')

        if (config.publicDirectory === '') {
            throw new Error('spring-vite-plugin: publicDirectory must be a subdirectory. E.g. \'public\'.')
        }
    }

    if (typeof config.buildDirectory === 'string') {
        config.buildDirectory = config.buildDirectory.trim().replace(/^\/+/, '').replace(/\/+$/, '')

        if (config.buildDirectory === '') {
            throw new Error('spring-vite-plugin: buildDirectory must be a subdirectory. E.g. \'build\'.')
        }
    }

    if (config.refresh === true) {
        config.refresh = [{ paths: refreshPaths }]
    }

    return {
        input: config.input,
        publicDirectory: config.publicDirectory ?? 'public',
        buildDirectory: config.buildDirectory ?? 'build',
        refresh: config.refresh ?? false,
        hotFile: config.hotFile ?? path.join((config.publicDirectory ?? 'public'), 'hot'),
        valetTls: config.valetTls ?? null,
        detectTls: config.detectTls ?? config.valetTls ?? null,
        transformOnServe: config.transformOnServe ?? ((code) => code),
    }
}

/**
 * Resolve the Vite base option from the configuration.
 */
function resolveBase(config: Required<PluginConfig>, assetUrl: string): string {
    return assetUrl + (! assetUrl.endsWith('/') ? '/' : '') + config.buildDirectory + '/'
}

/**
 * Resolve the Vite input path from the configuration.
 */
function resolveInput(config: Required<PluginConfig>): InputOption|undefined {

    return config.input
}

/**
 * Resolve the Vite outDir path from the configuration.
 */
function resolveOutDir(config: Required<PluginConfig>): string|undefined {
    return path.join(config.publicDirectory, config.buildDirectory)
}

function resolveFullReloadConfig({ refresh: config }: Required<PluginConfig>): PluginOption[]{
    if (typeof config === 'boolean') {
        return [];
    }

    if (typeof config === 'string') {
        config = [{ paths: [config]}]
    }

    if (! Array.isArray(config)) {
        config = [config]
    }

    if (config.some(c => typeof c === 'string')) {
        config = [{ paths: config }] as RefreshConfig[]
    }

    return (config as RefreshConfig[]).flatMap(c => {
        const plugin = fullReload(c.paths, c.config)

        /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
        /** @ts-ignore */
        plugin.__spring_plugin_config = c

        return plugin
    })
}

/**
 * Resolve the dev server URL from the server address and configuration.
 */
function resolveDevServerUrl(address: AddressInfo, config: ResolvedConfig, userConfig: UserConfig): DevServerUrl {
    const configHmrProtocol = typeof config.server.hmr === 'object' ? config.server.hmr.protocol : null
    const clientProtocol = configHmrProtocol ? (configHmrProtocol === 'wss' ? 'https' : 'http') : null
    const serverProtocol = config.server.https ? 'https' : 'http'
    const protocol = clientProtocol ?? serverProtocol

    const configHmrHost = typeof config.server.hmr === 'object' ? config.server.hmr.host : null
    const configHost = typeof config.server.host === 'string' ? config.server.host : null
    const userHost = userConfig.server?.host ? 'localhost' : null
    const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address
    const host = configHmrHost ?? userHost ?? configHost ?? serverAddress

    const configHmrClientPort = typeof config.server.hmr === 'object' ? config.server.hmr.clientPort : null
    const port = configHmrClientPort ?? address.port

    return `${protocol}://${host}:${port}`
}

function isIpv6(address: AddressInfo): boolean {
    return address.family === 'IPv6'
        // In node >=18.0 <18.4 this was an integer value. This was changed in a minor version.
        // See: https://github.com/laravel/vite-plugin/issues/103
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore-next-line
        || address.family === 6;
}

/**
 * Resolve the server config from the environment.
 */
function resolveEnvironmentServerConfig(env: Record<string, string>): {
    hmr?: { host: string }
    host?: string,
    https?: { cert: Buffer, key: Buffer }
}|undefined {
    if (! env.VITE_DEV_SERVER_KEY && ! env.VITE_DEV_SERVER_CERT) {
        return
    }

    if (! fs.existsSync(env.VITE_DEV_SERVER_KEY) || ! fs.existsSync(env.VITE_DEV_SERVER_CERT)) {
        throw Error(`Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`)
    }

    const host = resolveHostFromEnv(env)

    if (! host) {
        throw Error(`Unable to determine the host from the environment's APP_URL: [${env.APP_URL}].`)
    }

    return {
        hmr: { host },
        host,
        https: {
            key: fs.readFileSync(env.VITE_DEV_SERVER_KEY),
            cert: fs.readFileSync(env.VITE_DEV_SERVER_CERT),
        },
    }
}

/**
 * Resolve the host name from the environment.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function resolveHostFromEnv(env: Record<string, string>): string|undefined
{
    // todo implement logic for Spring
    return
}

/**
 * Resolve the Herd or Valet server config for the given host.
 */
function resolveDevelopmentEnvironmentServerConfig(host: string|boolean|null): {
    hmr?: { host: string }
    host?: string,
    https?: { cert: string, key: string }
}|undefined {
    if (host === false) {
        return
    }

    const configPath = determineDevelopmentEnvironmentConfigPath();

    if (typeof configPath === 'undefined' && host === null) {
        return
    }

    if (typeof configPath === 'undefined') {
        throw Error(`Unable to find the Herd or Valet configuration directory. Please check they are correctly installed.`)
    }

    const resolvedHost = host === true || host === null
        ? path.basename(process.cwd()) + '.' + resolveDevelopmentEnvironmentTld(configPath)
        : host

    const keyPath = path.resolve(configPath, 'Certificates', `${resolvedHost}.key`)
    const certPath = path.resolve(configPath, 'Certificates', `${resolvedHost}.crt`)

    if (! fs.existsSync(keyPath) || ! fs.existsSync(certPath)) {
        if (host === null) {
            return
        }

        if (configPath === herdMacConfigPath() || configPath === herdWindowsConfigPath()) {
            throw Error(`Unable to find certificate files for your host [${resolvedHost}] in the [${configPath}/Certificates] directory. Ensure you have secured the site via the Herd UI.`)
        } else if (typeof host === 'string') {
            throw Error(`Unable to find certificate files for your host [${resolvedHost}] in the [${configPath}/Certificates] directory. Ensure you have secured the site by running \`valet secure ${host}\`.`)
        } else {
            throw Error(`Unable to find certificate files for your host [${resolvedHost}] in the [${configPath}/Certificates] directory. Ensure you have secured the site by running \`valet secure\`.`)
        }
    }

    return {
        hmr: { host: resolvedHost },
        host: resolvedHost,
        https: {
            key: keyPath,
            cert: certPath,
        },
    }
}

/**
 * Resolve the path to the Herd or Valet configuration directory.
 */
function determineDevelopmentEnvironmentConfigPath(): string|undefined {
    if (fs.existsSync(herdMacConfigPath())) {
        return herdMacConfigPath()
    }

    if (fs.existsSync(herdWindowsConfigPath())) {
        return herdWindowsConfigPath()
    }

    if (fs.existsSync(valetConfigPath())) {
        return valetConfigPath()
    }
}

/**
 * Resolve the TLD via the config path.
 */
function resolveDevelopmentEnvironmentTld(configPath: string): string {
    const configFile = path.resolve(configPath, 'config.json')

    if (! fs.existsSync(configFile)) {
        throw Error(`Unable to find the configuration file [${configFile}].`)
    }

    const config: { tld: string } = JSON.parse(fs.readFileSync(configFile, 'utf-8'))

    return config.tld
}

/**
 * The directory of the current file.
 */
function dirname(): string {
    return fileURLToPath(new URL('.', import.meta.url))
}

/**
 * Herd's Mac configuration directory.
 */
function herdMacConfigPath(): string {
    return path.resolve(os.homedir(), 'Library', 'Application Support', 'Herd', 'config', 'valet')
}

/**
 * Herd's Windows configuration directory.
 */
function herdWindowsConfigPath(): string {
    return path.resolve(os.homedir(), ".config", "herd", "config", "valet")
}

/**
 * Valet's configuration directory.
 */
function valetConfigPath(): string {
    return path.resolve(os.homedir(), '.config', 'valet')
}

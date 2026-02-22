/**
 * Static command risk classifier for shell commands.
 *
 * Uses a whitelist approach (inspired by codex-rs shell-command/src/command_safety/)
 * to classify shell commands as Safe, Unknown, or Dangerous.
 *
 * Safe commands auto-execute without user confirmation.
 * Unknown/Dangerous commands require user approval.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export enum CommandRisk {
    /** Command is read-only and safe to auto-execute */
    Safe = 'safe',
    /** Command is not recognized — requires user confirmation */
    Unknown = 'unknown',
    /** Command is known to be dangerous — requires user confirmation */
    Dangerous = 'dangerous',
}

// ─── Whitelist Data ─────────────────────────────────────────────────────

/**
 * Commands that are safe regardless of arguments.
 * These are all read-only by nature.
 */
const UNCONDITIONALLY_SAFE = new Set([
    // File content reading
    'cat', 'head', 'tail', 'less', 'more', 'nl', 'tac',

    // File/directory listing & info
    'ls', 'dir', 'll', 'pwd', 'stat', 'file', 'which', 'whereis', 'type',

    // Output
    'echo', 'printf',

    // Text processing (read-only)
    'wc', 'sort', 'uniq', 'cut', 'tr', 'rev', 'paste',
    'column', 'fold', 'expand', 'unexpand', 'fmt', 'pr',
    'comm', 'diff', 'cmp', 'strings', 'od',

    // Search (read-only)
    'grep', 'egrep', 'fgrep',

    // System info
    'uname', 'hostname', 'whoami', 'id', 'groups',
    'date', 'uptime', 'arch', 'nproc', 'free', 'lsb_release',

    // Boolean / math
    'true', 'false', 'expr', 'seq', 'bc',

    // Environment (read-only)
    'env', 'printenv', 'getconf',

    // Path utilities
    'basename', 'dirname', 'readlink', 'realpath',

    // Checksums
    'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum',

    // Disk info
    'du', 'df',

    // Misc read-only
    'numfmt', 'locate', 'whatis', 'apropos',
])

/**
 * Commands that are safe only with specific argument patterns.
 * The validator returns true if the command is safe with the given tokens.
 */
const CONDITIONALLY_SAFE = new Map<string, (tokens: string[]) => boolean>([
    // git: only read-only subcommands
    ['git', (tokens) => isGitSafe(tokens)],

    // find: safe without execution/deletion flags
    ['find', (tokens) => {
        const unsafeOptions = [
            '-exec', '-execdir', '-ok', '-okdir',
            '-delete',
            '-fls', '-fprint', '-fprint0', '-fprintf',
        ]
        return !tokens.slice(1).some(t => unsafeOptions.includes(t))
    }],

    // sed: only safe in read-only print mode (sed -n <addr>p)
    ['sed', (tokens) => {
        // Only allow: sed -n '<addr>p' [file...]
        if (tokens.length < 3) return false
        if (tokens[1] !== '-n') return false
        const pattern = tokens[2].replace(/^['"]|['"]$/g, '')
        return /^(\d+,)?\d+p$/.test(pattern)
    }],

    // rg (ripgrep): safe without external command execution options
    ['rg', (tokens) => {
        const unsafeOptions = ['--pre', '--hostname-bin', '--search-zip', '-z']
        return !tokens.slice(1).some(t =>
            unsafeOptions.includes(t) ||
            t.startsWith('--pre=') ||
            t.startsWith('--hostname-bin='),
        )
    }],

    // base64: safe without output file option
    ['base64', (tokens) => {
        return !tokens.slice(1).some(t =>
            t === '-o' || t === '--output' || t.startsWith('--output='),
        )
    }],

    // hexdump / xxd: safe without revert mode
    ['xxd', (tokens) => {
        return !tokens.slice(1).some(t => t === '-r' || t === '-revert')
    }],
    ['hexdump', () => true],

    // Version checks — only <cmd> --version or <cmd> -v/-V
    ['node', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['python', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-V')],
    ['python3', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-V')],
    ['ruby', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['java', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-version')],
    ['cargo', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-V')],
    ['rustc', (tokens) => tokens.length === 2 && tokens[1] === '--version'],
    ['go', (tokens) => tokens.length === 2 && tokens[1] === 'version'],
    ['npm', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['yarn', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['pnpm', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['dotnet', (tokens) => tokens.length === 2 && tokens[1] === '--version'],
    ['gcc', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['g++', (tokens) => tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')],
    ['clang', (tokens) => tokens.length === 2 && tokens[1] === '--version'],
    ['make', (tokens) => tokens.length === 2 && tokens[1] === '--version'],
    ['cmake', (tokens) => tokens.length === 2 && tokens[1] === '--version'],
])

/**
 * Commands known to be dangerous (destructive, network, privilege escalation).
 */
const KNOWN_DANGEROUS = new Set([
    // Destructive
    'rm', 'rmdir', 'mkfs', 'fdisk', 'dd',

    // Permissions / ownership
    'chmod', 'chown', 'chgrp',

    // Process control
    'kill', 'killall', 'pkill',

    // System control
    'shutdown', 'reboot', 'halt',

    // Privilege escalation
    'su', 'sudo',

    // Network access
    'curl', 'wget', 'ssh', 'scp', 'rsync',

    // Package managers (can execute arbitrary code)
    'npm', 'npx', 'yarn', 'pnpm',
    'pip', 'pip3', 'pipx',
    'gem', 'cargo',
    'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew',

    // Container/VM
    'docker', 'podman',

    // System services
    'systemctl', 'service',

    // Firewall
    'iptables', 'ufw',

    // Mount/unmount
    'mount', 'umount',

    // User management
    'useradd', 'userdel', 'usermod',

    // Cron
    'crontab',

    // Shell builtins that execute code
    'eval', 'exec',
])

// ─── Git Subcommand Validation ──────────────────────────────────────────

/** Git subcommands that are read-only */
const SAFE_GIT_SUBCOMMANDS = new Set([
    'status', 'log', 'diff', 'show', 'cat-file',
])

/** Git flags that should always be rejected (execute external tools) */
const UNSAFE_GIT_FLAGS = new Set([
    '--output', '--ext-diff', '--textconv', '--exec', '--paginate',
])

/** Git branch flags that indicate read-only mode */
const SAFE_GIT_BRANCH_FLAGS = new Set([
    '--list', '-l', '--show-current',
    '-a', '--all', '-r', '--remotes',
    '-v', '-vv', '--verbose',
    '--no-color', '--color',
])

function isGitSafe (tokens: string[]): boolean {
    // Reject if has config override: git -c key=value ...
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (t === '-c' || t === '--config-env' || t.startsWith('--config-env=')) {
            return false
        }
        if (t.startsWith('-c') && t.length > 2) {
            return false
        }
    }

    // Find the subcommand (skip global options like -C, --git-dir, etc.)
    const globalOptionsWithValue = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'])
    let subcommand: string | null = null
    let subcommandIdx = -1

    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (globalOptionsWithValue.has(t)) {
            i++ // skip the value
            continue
        }
        if (t.startsWith('-')) continue
        subcommand = t
        subcommandIdx = i
        break
    }

    if (!subcommand) return false

    // Check unsafe flags in remaining args
    const args = tokens.slice(subcommandIdx + 1)
    if (args.some(a => UNSAFE_GIT_FLAGS.has(a))) return false

    // Simple safe subcommands
    if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) return true

    // git branch: only safe in list/query mode
    if (subcommand === 'branch') {
        return args.every(a => {
            if (a.startsWith('--format=')) return true
            if (SAFE_GIT_BRANCH_FLAGS.has(a)) return true
            return false
        })
    }

    // git remote: only "remote" with no args or "remote -v"
    if (subcommand === 'remote') {
        return args.length === 0 || (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose'))
    }

    // git stash: only "stash list"
    if (subcommand === 'stash') {
        return args.length === 1 && args[0] === 'list'
    }

    return false
}

// ─── Command Tokenizer ─────────────────────────────────────────────────

/**
 * Check if the raw command contains dangerous shell constructs
 * that prevent safe static analysis.
 */
function hasDangerousShellConstructs (raw: string): boolean {
    // Command substitution: $(...) or `...`
    if (/\$\(/.test(raw) || /`/.test(raw)) return true

    // Variable expansion: ${...} or $VAR
    if (/\$\{/.test(raw) || /\$[A-Za-z_]/.test(raw)) return true

    // Redirections: >, >>, <, 2>, 2>&1, etc.
    // But not => (arrow functions in echoed code) or -> or >=, <=
    if (/(?:^|[^=!<>-])(?:\d*>>?|<(?!<))/.test(raw)) return true

    // Here-docs: <<
    if (/<</.test(raw)) return true

    // Background execution: single & (but not &&)
    if (/(?<![&])&(?![&])/.test(raw)) return true

    // Subshells / grouping: ( or )
    if (/[()]/.test(raw)) return true

    return false
}

/**
 * Split a raw command string into sub-commands by shell operators (&&, ||, ;, |).
 * Returns null if the command contains dangerous constructs.
 */
function splitCompoundCommand (raw: string): string[] | null {
    if (hasDangerousShellConstructs(raw)) return null

    // Split by &&, ||, ;, | (but not ||= or &&=)
    // We need to be careful with pipes: | but not ||
    const parts: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let i = 0

    while (i < raw.length) {
        const ch = raw[i]

        // Handle quoting
        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote
            current += ch
            i++
            continue
        }
        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote
            current += ch
            i++
            continue
        }

        // Inside quotes, take everything literally
        if (inSingleQuote || inDoubleQuote) {
            current += ch
            i++
            continue
        }

        // Check for operators outside quotes
        if (ch === '&' && raw[i + 1] === '&') {
            parts.push(current)
            current = ''
            i += 2
            continue
        }
        if (ch === '|' && raw[i + 1] === '|') {
            parts.push(current)
            current = ''
            i += 2
            continue
        }
        if (ch === '|') {
            parts.push(current)
            current = ''
            i++
            continue
        }
        if (ch === ';') {
            parts.push(current)
            current = ''
            i++
            continue
        }

        current += ch
        i++
    }

    // Unbalanced quotes → unsafe
    if (inSingleQuote || inDoubleQuote) return null

    parts.push(current)
    return parts.map(p => p.trim()).filter(p => p.length > 0)
}

/**
 * Tokenize a single command string into an array of tokens,
 * handling basic quoting (single and double quotes).
 */
function tokenizeSingle (cmd: string): string[] {
    const tokens: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let i = 0

    while (i < cmd.length) {
        const ch = cmd[i]

        if (ch === '\\' && !inSingleQuote && i + 1 < cmd.length) {
            // Escaped character
            current += cmd[i + 1]
            i += 2
            continue
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote
            i++
            continue
        }
        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote
            i++
            continue
        }

        if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
            if (current.length > 0) {
                tokens.push(current)
                current = ''
            }
            i++
            continue
        }

        current += ch
        i++
    }

    if (current.length > 0) {
        tokens.push(current)
    }

    return tokens
}

/**
 * Extract the base command name from a token, stripping path prefixes.
 * e.g. "/usr/bin/ls" → "ls", "./script.sh" → "./script.sh"
 */
function extractBaseName (token: string): string {
    // Relative paths (./foo, ../foo) are not safe — keep as-is
    if (token.startsWith('./') || token.startsWith('../')) return token

    // Absolute paths: extract basename
    const lastSlash = token.lastIndexOf('/')
    if (lastSlash >= 0) return token.slice(lastSlash + 1)

    // Windows absolute paths
    const lastBackslash = token.lastIndexOf('\\')
    if (lastBackslash >= 0) return token.slice(lastBackslash + 1)

    return token
}

// ─── Main Classification Function ───────────────────────────────────────

/**
 * Classify a single tokenized command.
 */
function classifySingleTokenized (tokens: string[]): CommandRisk {
    if (tokens.length === 0) return CommandRisk.Unknown

    const cmd = extractBaseName(tokens[0])

    // Relative scripts are unknown
    if (cmd.startsWith('./') || cmd.startsWith('../')) return CommandRisk.Unknown

    // Environment variable assignment prefix (FOO=bar cmd) → unknown
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return CommandRisk.Unknown

    if (UNCONDITIONALLY_SAFE.has(cmd)) return CommandRisk.Safe

    const validator = CONDITIONALLY_SAFE.get(cmd)
    if (validator && validator(tokens)) {
        return CommandRisk.Safe
    }

    if (KNOWN_DANGEROUS.has(cmd)) return CommandRisk.Dangerous

    // Conditionally safe command that failed validation → Unknown
    if (validator) return CommandRisk.Unknown

    return CommandRisk.Unknown
}

/**
 * Classify a raw shell command string.
 *
 * @param rawCommand - The shell command string as passed to bash -c
 * @returns CommandRisk - Safe, Unknown, or Dangerous
 */
export function classifyCommand (rawCommand: string): CommandRisk {
    const trimmed = rawCommand.trim()

    // Empty or whitespace-only
    if (trimmed.length === 0) return CommandRisk.Unknown

    // Very long commands are likely complex — don't attempt classification
    if (trimmed.length > 2000) return CommandRisk.Unknown

    // Split compound command
    const subCommands = splitCompoundCommand(trimmed)
    if (subCommands === null) return CommandRisk.Unknown
    if (subCommands.length === 0) return CommandRisk.Unknown

    let hasDangerous = false

    for (const sub of subCommands) {
        const tokens = tokenizeSingle(sub)
        const risk = classifySingleTokenized(tokens)

        if (risk === CommandRisk.Unknown) return CommandRisk.Unknown
        if (risk === CommandRisk.Dangerous) hasDangerous = true
    }

    return hasDangerous ? CommandRisk.Dangerous : CommandRisk.Safe
}

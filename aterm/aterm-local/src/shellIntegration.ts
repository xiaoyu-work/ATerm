import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

// ── Shell integration scripts ───────────────────────────────────
// Each script emits OSC 133 sequences to mark command boundaries:
//   ESC ] 133 ; A BEL  — prompt start
//   ESC ] 133 ; B BEL  — command input start (end of prompt)
//   ESC ] 133 ; C BEL  — command executed (output begins)
//   ESC ] 133 ; D ; <exit_code> BEL  — command finished

const BASH_INTEGRATION = `
# Tabby shell integration — do not edit
if [ -n "$__TABBY_SHELL_INTEGRATION_ACTIVE" ]; then return; fi
__TABBY_SHELL_INTEGRATION_ACTIVE=1

__tabby_precmd() {
    local ec=$?
    printf '\\e]133;D;%d\\a' "$ec"
    printf '\\e]133;A\\a'
}

__tabby_preexec() {
    printf '\\e]133;C\\a'
}

if [[ ! "$PROMPT_COMMAND" == *"__tabby_precmd"* ]]; then
    PROMPT_COMMAND="__tabby_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
trap '__tabby_preexec' DEBUG

# Append 133;B marker to PS1
if [[ ! "$PS1" == *"133;B"* ]]; then
    PS1="\${PS1}\\[\\e]133;B\\a\\]"
fi
`

const ZSH_INTEGRATION = `
# Tabby shell integration — do not edit
if [[ -n "$__TABBY_SHELL_INTEGRATION_ACTIVE" ]]; then return; fi
__TABBY_SHELL_INTEGRATION_ACTIVE=1

__tabby_precmd() {
    local ec=$?
    printf '\\e]133;D;%d\\a' "$ec"
    printf '\\e]133;A\\a'
}

__tabby_preexec() {
    printf '\\e]133;C\\a'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __tabby_precmd
add-zsh-hook preexec __tabby_preexec

# Append 133;B marker to PS1
PS1="\${PS1}%{$(printf '\\e]133;B\\a')%}"
`

const FISH_INTEGRATION = `
# Tabby shell integration — do not edit
if set -q __TABBY_SHELL_INTEGRATION_ACTIVE
    exit 0
end
set -g __TABBY_SHELL_INTEGRATION_ACTIVE 1

function __tabby_postexec --on-event fish_postexec
    printf '\\e]133;D;%d\\a' $status
end

function __tabby_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
end

function __tabby_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
end
`

const PWSH_INTEGRATION = `
# Tabby shell integration — do not edit
if ($env:__TABBY_SHELL_INTEGRATION_ACTIVE) { return }
$env:__TABBY_SHELL_INTEGRATION_ACTIVE = "1"

$__tabbyOrigPrompt = $function:prompt
function prompt {
    $exitCode = if ($global:?) { 0 } else { 1 }
    [Console]::Write("$([char]0x1b)]133;D;$exitCode$([char]0x07)")
    [Console]::Write("$([char]0x1b)]133;A$([char]0x07)")
    $result = & $__tabbyOrigPrompt
    [Console]::Write("$([char]0x1b)]133;B$([char]0x07)")
    return $result
}
`

type ShellType = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'unknown'

export function detectShellType (command: string): ShellType {
    const base = path.basename(command).toLowerCase().replace(/\.exe$/i, '')
    if (base === 'bash' || base === 'sh') return 'bash'
    if (base === 'zsh') return 'zsh'
    if (base === 'fish') return 'fish'
    if (base === 'pwsh' || base === 'powershell') return 'pwsh'
    return 'unknown'
}

/**
 * Prepare shell integration injection for a local session.
 * Returns env vars to merge and optional extra args to prepend.
 */
export function getShellIntegration (
    command: string,
    args: string[],
    env: Record<string, string>,
): { env: Record<string, string>; args: string[] } {
    const shell = detectShellType(command)
    const result = { env: {} as Record<string, string>, args: [...args] }

    switch (shell) {
        case 'bash': {
            // Write a temp init file that sources user's bashrc then our integration
            const initFile = path.join(os.tmpdir(), `aterm-bash-init-${process.pid}.sh`)
            const content = [
                '# Tabby bash init wrapper',
                '[ -f /etc/profile ] && . /etc/profile',
                '[ -f ~/.bash_profile ] && . ~/.bash_profile || { [ -f ~/.bash_login ] && . ~/.bash_login || [ -f ~/.profile ] && . ~/.profile; }',
                '[ -f ~/.bashrc ] && . ~/.bashrc',
                BASH_INTEGRATION,
            ].join('\n')
            try {
                fs.writeFileSync(initFile, content, 'utf-8')
                // --rcfile replaces default init; our file sources user's config first
                // Only add if not already using --rcfile or --init-file
                if (!result.args.some(a => a === '--rcfile' || a === '--init-file')) {
                    result.args.unshift('--rcfile', initFile)
                }
            } catch (e) {
                console.warn('[aterm-local] Failed to write bash init file:', e)
            }
            break
        }
        case 'zsh': {
            // Create a temp ZDOTDIR with a .zshrc that sources the real one + our integration
            const tmpZdotdir = path.join(os.tmpdir(), `aterm-zsh-${process.pid}`)
            try {
                fs.mkdirSync(tmpZdotdir, { recursive: true })
                const realZdotdir = env.ZDOTDIR || process.env.ZDOTDIR || os.homedir()
                const content = [
                    '# Tabby zsh init wrapper',
                    `ZDOTDIR="${realZdotdir}"`,
                    '[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"',
                    '[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"',
                    ZSH_INTEGRATION,
                ].join('\n')
                fs.writeFileSync(path.join(tmpZdotdir, '.zshrc'), content, 'utf-8')
                result.env.ZDOTDIR = tmpZdotdir
                // Save real ZDOTDIR so the wrapper can restore it
                if (realZdotdir !== os.homedir()) {
                    result.env.__TABBY_ORIGINAL_ZDOTDIR = realZdotdir
                }
            } catch (e) {
                console.warn('[aterm-local] Failed to write zsh init dir:', e)
            }
            break
        }
        case 'fish': {
            // Fish supports --init-command for inline initialization
            if (!result.args.some(a => a === '--init-command' || a === '-C')) {
                result.args.unshift('--init-command', FISH_INTEGRATION.trim())
            }
            break
        }
        case 'pwsh': {
            // PowerShell: use -NoExit -Command to source integration
            if (!result.args.some(a => a === '-NoExit')) {
                result.args.unshift('-NoExit', '-Command', PWSH_INTEGRATION.trim())
            }
            break
        }
    }

    return result
}

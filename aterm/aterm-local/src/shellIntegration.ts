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
# Aterm shell integration — do not edit
if [ -n "$__ATERM_SHELL_INTEGRATION_ACTIVE" ]; then return; fi
__ATERM_SHELL_INTEGRATION_ACTIVE=1

__aterm_precmd() {
    local ec=$?
    printf '\\e]133;D;%d\\a' "$ec"
    printf '\\e]133;A\\a'
}

__aterm_preexec() {
    printf '\\e]133;C\\a'
}

if [[ ! "$PROMPT_COMMAND" == *"__aterm_precmd"* ]]; then
    PROMPT_COMMAND="__aterm_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
trap '__aterm_preexec' DEBUG

# Append 133;B marker to PS1
if [[ ! "$PS1" == *"133;B"* ]]; then
    PS1="\${PS1}\\[\\e]133;B\\a\\]"
fi

# Ensure commands with leading space are not saved to history (for AI command hiding)
case "$HISTCONTROL" in
    *ignorespace*|*ignoreboth*) ;;
    *) HISTCONTROL="\${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;;
esac

# AI assistant function — invoked as " __aterm_ai <queryId>" by middleware.
# Query file is at $ATERM_AI_TMP/aq-<queryId>.txt
__aterm_ai() {
    if [ -n "$ATERM_AI_CLI_PATH" ] && [ -n "$ATERM_AI_TMP" ]; then
        local qfile="$ATERM_AI_TMP/aq-$1.txt"
        # Overwrite the echo line in ConPTY buffer with clean "@ <prompt>" display.
        # Must happen before node starts to survive terminal resize.
        local fl
        if [ -f "$qfile" ] && read -r fl < "$qfile" && [ -n "$fl" ]; then
            if [ \${#fl} -gt 80 ]; then fl="\${fl:0:80}..."; fi
            printf '\\e[A\\r\\e[2K\\e[36m@ \\e[39m%s\\n' "$fl"
        fi
        node "$ATERM_AI_CLI_PATH" --file "$qfile"
    else
        echo "aterm-ai: CLI not configured"
    fi
}
`

const ZSH_INTEGRATION = `
# Aterm shell integration — do not edit
if [[ -n "$__ATERM_SHELL_INTEGRATION_ACTIVE" ]]; then return; fi
__ATERM_SHELL_INTEGRATION_ACTIVE=1

__aterm_precmd() {
    local ec=$?
    printf '\\e]133;D;%d\\a' "$ec"
    printf '\\e]133;A\\a'
}

__aterm_preexec() {
    printf '\\e]133;C\\a'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __aterm_precmd
add-zsh-hook preexec __aterm_preexec

# Append 133;B marker to PS1
PS1="\${PS1}%{$(printf '\\e]133;B\\a')%}"

# Ensure commands with leading space are not saved to history (for AI command hiding)
setopt HIST_IGNORE_SPACE

# AI assistant function
__aterm_ai() {
    if [[ -n "$ATERM_AI_CLI_PATH" ]] && [[ -n "$ATERM_AI_TMP" ]]; then
        local qfile="$ATERM_AI_TMP/aq-$1.txt"
        # Overwrite echo line in ConPTY buffer with clean display
        local fl
        if [[ -f "$qfile" ]] && read -r fl < "$qfile" && [[ -n "$fl" ]]; then
            if [[ \${#fl} -gt 80 ]]; then fl="\${fl:0:80}..."; fi
            printf '\\e[A\\r\\e[2K\\e[36m@ \\e[39m%s\\n' "$fl"
        fi
        node "$ATERM_AI_CLI_PATH" --file "$qfile"
    else
        echo "aterm-ai: CLI not configured"
    fi
}
`

const FISH_INTEGRATION = `
# Aterm shell integration — do not edit
if set -q __ATERM_SHELL_INTEGRATION_ACTIVE
    exit 0
end
set -g __ATERM_SHELL_INTEGRATION_ACTIVE 1

function __aterm_postexec --on-event fish_postexec
    printf '\\e]133;D;%d\\a' $status
end

function __aterm_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
end

function __aterm_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
end

# AI assistant function
function __aterm_ai
    if set -q ATERM_AI_CLI_PATH; and set -q ATERM_AI_TMP
        set -l qfile "$ATERM_AI_TMP/aq-$argv[1].txt"
        # Overwrite echo line in ConPTY buffer with clean display
        if test -f $qfile
            set -l fl (head -1 $qfile)
            if test (string length -- "$fl") -gt 80
                set fl (string sub -l 80 -- $fl)"..."
            end
            if test -n "$fl"
                printf '\\e[A\\r\\e[2K\\e[36m@ \\e[39m%s\\n' $fl
            end
        end
        node $ATERM_AI_CLI_PATH --file $qfile
    else
        echo "aterm-ai: CLI not configured"
    end
end
`

const PWSH_INTEGRATION = `
# Aterm shell integration — do not edit
if ($env:__ATERM_SHELL_INTEGRATION_ACTIVE) { return }
$env:__ATERM_SHELL_INTEGRATION_ACTIVE = "1"

# Ensure UTF-8 output for ConPTY (xterm.js expects UTF-8)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$__atermOrigPrompt = $function:prompt
function prompt {
    $exitCode = if ($global:?) { 0 } else { 1 }
    [Console]::Write("$([char]0x1b)]133;D;$exitCode$([char]0x07)")
    [Console]::Write("$([char]0x1b)]133;A$([char]0x07)")
    $result = & $__atermOrigPrompt
    [Console]::Write("$([char]0x1b)]133;B$([char]0x07)")
    return $result
}

# Filter __aterm_ai from PSReadLine history (prevents Up arrow from showing it)
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    Set-PSReadLineOption -AddToHistoryHandler {
        param([string]$line)
        if ($line.Trim() -match '^__aterm_ai') { return $false }
        return $true
    }
}

# AI assistant function
function __aterm_ai {
    if ($env:ATERM_AI_CLI_PATH -and $env:ATERM_AI_TMP) {
        $qfile = Join-Path $env:ATERM_AI_TMP "aq-$($args[0]).txt"
        # Overwrite echo line in ConPTY buffer with clean display
        try {
            $fl = [System.IO.File]::ReadAllText($qfile, [System.Text.Encoding]::UTF8).Split([char]10)[0].TrimEnd([char]13)
            if ($fl.Length -gt 80) { $fl = $fl.Substring(0, 80) + "..." }
            if ($fl) {
                [Console]::Write("$([char]0x1b)[A$([char]13)$([char]0x1b)[2K$([char]0x1b)[36m@ $([char]0x1b)[39m" + $fl + [char]10)
            }
        } catch {}
        & node $env:ATERM_AI_CLI_PATH --file $qfile
    } else {
        Write-Host "aterm-ai: CLI not configured"
    }
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
                '# Aterm bash init wrapper',
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
                    '# Aterm zsh init wrapper',
                    `ZDOTDIR="${realZdotdir}"`,
                    '[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"',
                    '[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"',
                    ZSH_INTEGRATION,
                ].join('\n')
                fs.writeFileSync(path.join(tmpZdotdir, '.zshrc'), content, 'utf-8')
                result.env.ZDOTDIR = tmpZdotdir
                // Save real ZDOTDIR so the wrapper can restore it
                if (realZdotdir !== os.homedir()) {
                    result.env.__ATERM_ORIGINAL_ZDOTDIR = realZdotdir
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

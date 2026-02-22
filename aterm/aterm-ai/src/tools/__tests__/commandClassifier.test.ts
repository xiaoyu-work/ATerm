/**
 * Tests for the command classifier.
 *
 * Run with: npx tsx src/tools/__tests__/commandClassifier.test.ts
 * Or with vitest if installed: npx vitest run src/tools/__tests__/commandClassifier.test.ts
 */

import { classifyCommand, CommandRisk } from '../commandClassifier'

let passed = 0
let failed = 0

function assert (description: string, actual: CommandRisk, expected: CommandRisk): void {
    if (actual === expected) {
        passed++
    } else {
        failed++
        console.error(`  FAIL: ${description}`)
        console.error(`    expected: ${expected}, got: ${actual}`)
    }
}

function section (name: string): void {
    console.log(`\n--- ${name} ---`)
}

// ─── Unconditionally Safe ───────────────────────────────────────────────

section('Unconditionally safe commands')
assert('ls', classifyCommand('ls'), CommandRisk.Safe)
assert('ls -la', classifyCommand('ls -la'), CommandRisk.Safe)
assert('ls -la /tmp', classifyCommand('ls -la /tmp'), CommandRisk.Safe)
assert('cat file.txt', classifyCommand('cat file.txt'), CommandRisk.Safe)
assert('head -n 20 file.txt', classifyCommand('head -n 20 file.txt'), CommandRisk.Safe)
assert('tail -f log.txt', classifyCommand('tail -f log.txt'), CommandRisk.Safe)
assert('grep -r "pattern" src/', classifyCommand('grep -r "pattern" src/'), CommandRisk.Safe)
assert('grep -rn "TODO" .', classifyCommand('grep -rn "TODO" .'), CommandRisk.Safe)
assert('wc -l file.txt', classifyCommand('wc -l file.txt'), CommandRisk.Safe)
assert('echo "hello world"', classifyCommand('echo "hello world"'), CommandRisk.Safe)
assert('printf "%s\\n" hello', classifyCommand('printf "%s\\n" hello'), CommandRisk.Safe)
assert('pwd', classifyCommand('pwd'), CommandRisk.Safe)
assert('whoami', classifyCommand('whoami'), CommandRisk.Safe)
assert('uname -a', classifyCommand('uname -a'), CommandRisk.Safe)
assert('date', classifyCommand('date'), CommandRisk.Safe)
assert('diff file1 file2', classifyCommand('diff file1 file2'), CommandRisk.Safe)
assert('sort file.txt', classifyCommand('sort file.txt'), CommandRisk.Safe)
assert('uniq file.txt', classifyCommand('uniq file.txt'), CommandRisk.Safe)
assert('cut -d: -f1 /etc/passwd', classifyCommand('cut -d: -f1 /etc/passwd'), CommandRisk.Safe)
assert('which node', classifyCommand('which node'), CommandRisk.Safe)
assert('stat file.txt', classifyCommand('stat file.txt'), CommandRisk.Safe)
assert('du -sh .', classifyCommand('du -sh .'), CommandRisk.Safe)
assert('df -h', classifyCommand('df -h'), CommandRisk.Safe)
assert('md5sum file', classifyCommand('md5sum file'), CommandRisk.Safe)
assert('basename /path/to/file', classifyCommand('basename /path/to/file'), CommandRisk.Safe)
assert('dirname /path/to/file', classifyCommand('dirname /path/to/file'), CommandRisk.Safe)
assert('env', classifyCommand('env'), CommandRisk.Safe)
assert('true', classifyCommand('true'), CommandRisk.Safe)
assert('false', classifyCommand('false'), CommandRisk.Safe)
assert('seq 1 10', classifyCommand('seq 1 10'), CommandRisk.Safe)
assert('expr 1 + 2', classifyCommand('expr 1 + 2'), CommandRisk.Safe)

// Path prefix: /usr/bin/ls → safe
assert('/usr/bin/ls', classifyCommand('/usr/bin/ls'), CommandRisk.Safe)
assert('/usr/bin/cat file', classifyCommand('/usr/bin/cat file'), CommandRisk.Safe)

// ─── Conditionally Safe: git ────────────────────────────────────────────

section('Git - safe subcommands')
assert('git status', classifyCommand('git status'), CommandRisk.Safe)
assert('git log', classifyCommand('git log'), CommandRisk.Safe)
assert('git log --oneline -10', classifyCommand('git log --oneline -10'), CommandRisk.Safe)
assert('git diff', classifyCommand('git diff'), CommandRisk.Safe)
assert('git diff HEAD~1', classifyCommand('git diff HEAD~1'), CommandRisk.Safe)
assert('git diff --stat', classifyCommand('git diff --stat'), CommandRisk.Safe)
assert('git show HEAD', classifyCommand('git show HEAD'), CommandRisk.Safe)
assert('git show HEAD:file.txt', classifyCommand('git show HEAD:file.txt'), CommandRisk.Safe)
assert('git branch', classifyCommand('git branch'), CommandRisk.Safe)
assert('git branch --list', classifyCommand('git branch --list'), CommandRisk.Safe)
assert('git branch -a', classifyCommand('git branch -a'), CommandRisk.Safe)
assert('git branch -r', classifyCommand('git branch -r'), CommandRisk.Safe)
assert('git branch -vv', classifyCommand('git branch -vv'), CommandRisk.Safe)
assert('git branch --show-current', classifyCommand('git branch --show-current'), CommandRisk.Safe)
assert('git remote', classifyCommand('git remote'), CommandRisk.Safe)
assert('git remote -v', classifyCommand('git remote -v'), CommandRisk.Safe)
assert('git stash list', classifyCommand('git stash list'), CommandRisk.Safe)
assert('git -C /tmp status', classifyCommand('git -C /tmp status'), CommandRisk.Safe)

section('Git - unsafe subcommands / flags')
assert('git push', classifyCommand('git push'), CommandRisk.Unknown)
assert('git push origin main', classifyCommand('git push origin main'), CommandRisk.Unknown)
assert('git commit -m "msg"', classifyCommand('git commit -m "msg"'), CommandRisk.Unknown)
assert('git checkout -b new', classifyCommand('git checkout -b new'), CommandRisk.Unknown)
assert('git branch new-branch', classifyCommand('git branch new-branch'), CommandRisk.Unknown)
assert('git branch -d old', classifyCommand('git branch -d old'), CommandRisk.Unknown)
assert('git branch -D old', classifyCommand('git branch -D old'), CommandRisk.Unknown)
assert('git merge feature', classifyCommand('git merge feature'), CommandRisk.Unknown)
assert('git rebase main', classifyCommand('git rebase main'), CommandRisk.Unknown)
assert('git reset --hard', classifyCommand('git reset --hard'), CommandRisk.Unknown)
assert('git stash', classifyCommand('git stash'), CommandRisk.Unknown)
assert('git stash pop', classifyCommand('git stash pop'), CommandRisk.Unknown)
assert('git -c core.pager=evil status', classifyCommand('git -c core.pager=evil status'), CommandRisk.Unknown)
assert('git --config-env=FOO status', classifyCommand('git --config-env=FOO status'), CommandRisk.Unknown)
assert('git diff --ext-diff', classifyCommand('git diff --ext-diff'), CommandRisk.Unknown)
assert('git log --exec /bin/evil', classifyCommand('git log --exec /bin/evil'), CommandRisk.Unknown)

// ─── Conditionally Safe: find ───────────────────────────────────────────

section('find - safe/unsafe')
assert('find . -name "*.ts"', classifyCommand('find . -name "*.ts"'), CommandRisk.Safe)
assert('find . -type f', classifyCommand('find . -type f'), CommandRisk.Safe)
assert('find . -name "*.ts" -type f', classifyCommand('find . -name "*.ts" -type f'), CommandRisk.Safe)
assert('find . -name "*.tmp" -delete', classifyCommand('find . -name "*.tmp" -delete'), CommandRisk.Unknown)
assert('find . -exec rm {} ;', classifyCommand('find . -exec rm {} ;'), CommandRisk.Unknown)
assert('find . -execdir cat {} ;', classifyCommand('find . -execdir cat {} ;'), CommandRisk.Unknown)

// ─── Conditionally Safe: sed ────────────────────────────────────────────

section('sed - safe/unsafe')
assert('sed -n 5p file', classifyCommand('sed -n 5p file'), CommandRisk.Safe)
assert('sed -n 1,5p file', classifyCommand('sed -n 1,5p file'), CommandRisk.Safe)
assert("sed -n '10p' file", classifyCommand("sed -n '10p' file"), CommandRisk.Safe)
assert('sed -i s/foo/bar/ file', classifyCommand('sed -i s/foo/bar/ file'), CommandRisk.Unknown)
assert('sed s/foo/bar/ file', classifyCommand('sed s/foo/bar/ file'), CommandRisk.Unknown)

// ─── Conditionally Safe: rg ────────────────────────────────────────────

section('rg - safe/unsafe')
assert('rg pattern', classifyCommand('rg pattern'), CommandRisk.Safe)
assert('rg -n "TODO" src/', classifyCommand('rg -n "TODO" src/'), CommandRisk.Safe)
assert('rg --pre evil pattern', classifyCommand('rg --pre evil pattern'), CommandRisk.Unknown)
assert('rg --pre=evil pattern', classifyCommand('rg --pre=evil pattern'), CommandRisk.Unknown)
assert('rg -z pattern', classifyCommand('rg -z pattern'), CommandRisk.Unknown)

// ─── Version Checks ────────────────────────────────────────────────────

section('Version checks')
assert('node --version', classifyCommand('node --version'), CommandRisk.Safe)
assert('node -v', classifyCommand('node -v'), CommandRisk.Safe)
assert('python3 --version', classifyCommand('python3 --version'), CommandRisk.Safe)
assert('go version', classifyCommand('go version'), CommandRisk.Safe)
assert('npm --version', classifyCommand('npm --version'), CommandRisk.Safe)
assert('cargo --version', classifyCommand('cargo --version'), CommandRisk.Safe)
assert('rustc --version', classifyCommand('rustc --version'), CommandRisk.Safe)
assert('dotnet --version', classifyCommand('dotnet --version'), CommandRisk.Safe)

// But not: node script.js (would run code)
assert('node script.js', classifyCommand('node script.js'), CommandRisk.Unknown)
assert('python3 script.py', classifyCommand('python3 script.py'), CommandRisk.Unknown)
assert('npm install', classifyCommand('npm install'), CommandRisk.Dangerous)
assert('npm run build', classifyCommand('npm run build'), CommandRisk.Dangerous)

// ─── Compound Commands ─────────────────────────────────────────────────

section('Compound commands - safe')
assert('ls && pwd', classifyCommand('ls && pwd'), CommandRisk.Safe)
assert('cat file | grep pattern', classifyCommand('cat file | grep pattern'), CommandRisk.Safe)
assert('cat file | grep pat | wc -l', classifyCommand('cat file | grep pat | wc -l'), CommandRisk.Safe)
assert('git status && git log --oneline -5', classifyCommand('git status && git log --oneline -5'), CommandRisk.Safe)
assert('ls -la | sort | head -20', classifyCommand('ls -la | sort | head -20'), CommandRisk.Safe)
assert('echo hello ; echo world', classifyCommand('echo hello ; echo world'), CommandRisk.Safe)
assert('ls || true', classifyCommand('ls || true'), CommandRisk.Safe)
assert('grep -r "TODO" . | wc -l', classifyCommand('grep -r "TODO" . | wc -l'), CommandRisk.Safe)

section('Compound commands - unsafe')
assert('ls && rm foo.txt', classifyCommand('ls && rm foo.txt'), CommandRisk.Dangerous)
assert('cat file | curl -X POST', classifyCommand('cat file | curl -X POST'), CommandRisk.Dangerous)
assert('git status && npm install', classifyCommand('git status && npm install'), CommandRisk.Dangerous)

// ─── Dangerous Shell Constructs ─────────────────────────────────────────

section('Dangerous shell constructs')
assert('echo $(whoami)', classifyCommand('echo $(whoami)'), CommandRisk.Unknown)
assert('echo `date`', classifyCommand('echo `date`'), CommandRisk.Unknown)
assert('ls > out.txt', classifyCommand('ls > out.txt'), CommandRisk.Unknown)
assert('cat file >> log.txt', classifyCommand('cat file >> log.txt'), CommandRisk.Unknown)
assert('(ls)', classifyCommand('(ls)'), CommandRisk.Unknown)
assert('ls &', classifyCommand('ls &'), CommandRisk.Unknown)
assert('echo $HOME', classifyCommand('echo $HOME'), CommandRisk.Unknown)
assert('echo ${PATH}', classifyCommand('echo ${PATH}'), CommandRisk.Unknown)
assert('cat << EOF', classifyCommand('cat << EOF'), CommandRisk.Unknown)
assert('FOO=bar ls', classifyCommand('FOO=bar ls'), CommandRisk.Unknown)

// ─── Known Dangerous Commands ───────────────────────────────────────────

section('Known dangerous commands')
assert('rm -rf /', classifyCommand('rm -rf /'), CommandRisk.Dangerous)
assert('rm foo.txt', classifyCommand('rm foo.txt'), CommandRisk.Dangerous)
assert('sudo apt install foo', classifyCommand('sudo apt install foo'), CommandRisk.Dangerous)
assert('curl https://example.com', classifyCommand('curl https://example.com'), CommandRisk.Dangerous)
assert('wget https://example.com', classifyCommand('wget https://example.com'), CommandRisk.Dangerous)
assert('docker run --rm ubuntu', classifyCommand('docker run --rm ubuntu'), CommandRisk.Dangerous)
assert('chmod 755 script.sh', classifyCommand('chmod 755 script.sh'), CommandRisk.Dangerous)
assert('kill -9 1234', classifyCommand('kill -9 1234'), CommandRisk.Dangerous)

// ─── Edge Cases ─────────────────────────────────────────────────────────

section('Edge cases')
assert('empty string', classifyCommand(''), CommandRisk.Unknown)
assert('whitespace only', classifyCommand('   '), CommandRisk.Unknown)
assert('./script.sh', classifyCommand('./script.sh'), CommandRisk.Unknown)
assert('../script.sh', classifyCommand('../script.sh'), CommandRisk.Unknown)
assert('unknown_command', classifyCommand('unknown_command'), CommandRisk.Unknown)

// Quoted operators inside strings should NOT split
assert('echo "hello && world"', classifyCommand('echo "hello && world"'), CommandRisk.Safe)
assert("echo 'ls | rm'", classifyCommand("echo 'ls | rm'"), CommandRisk.Safe)

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
    console.log('SOME TESTS FAILED')
    process.exit(1)
} else {
    console.log('ALL TESTS PASSED')
}

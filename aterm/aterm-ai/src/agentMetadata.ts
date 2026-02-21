import fs from 'fs'
import os from 'os'
import path from 'path'
import { AgentSkillOptions, SubAgentOptions } from './geminiPrompt'

const MAX_SKILL_SCAN_FILES = 300

export interface ResolvedAgentSkill extends AgentSkillOptions {
    resolvedPath: string
}

function safeReadUtf8 (filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, 'utf8')
    } catch {
        return null
    }
}

function normalizeFsPath (rawPath: string, baseDir: string): string {
    let candidate = rawPath.trim().replace(/^['"]|['"]$/g, '')
    if (candidate === '~') {
        candidate = os.homedir()
    } else if (candidate.startsWith('~/')) {
        candidate = path.join(os.homedir(), candidate.slice(2))
    }
    return path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(baseDir, candidate)
}

function dedupeByName<T extends { name: string }> (items: T[]): T[] {
    const seen = new Set<string>()
    const out: T[] = []
    for (const item of items) {
        const key = item.name.trim().toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(item)
    }
    return out
}

function parseSkillsFromJson (
    rawJson: string | undefined,
    baseDir: string,
): ResolvedAgentSkill[] {
    if (!rawJson || !rawJson.trim()) return []
    try {
        const parsed = JSON.parse(rawJson)
        if (!Array.isArray(parsed)) return []

        const skills: ResolvedAgentSkill[] = []
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue
            const rawName = (item as any).name
            const rawLocation = (item as any).location
            if (typeof rawName !== 'string' || typeof rawLocation !== 'string') continue

            const name = rawName.trim()
            const description = typeof (item as any).description === 'string'
                ? (item as any).description.trim()
                : ''
            if (!name) continue

            const resolvedPath = normalizeFsPath(rawLocation, baseDir)
            skills.push({
                name,
                description: description || 'No description provided.',
                location: resolvedPath,
                resolvedPath,
            })
        }
        return skills
    } catch {
        return []
    }
}

function parseSubAgentsFromJson (rawJson: string | undefined): SubAgentOptions[] {
    if (!rawJson || !rawJson.trim()) return []
    try {
        const parsed = JSON.parse(rawJson)
        if (!Array.isArray(parsed)) return []
        const agents: SubAgentOptions[] = []

        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue
            const rawName = (item as any).name
            if (typeof rawName !== 'string' || !rawName.trim()) continue
            const rawDescription = (item as any).description
            agents.push({
                name: rawName.trim(),
                description: typeof rawDescription === 'string' && rawDescription.trim()
                    ? rawDescription.trim()
                    : 'No description provided.',
            })
        }
        return agents
    } catch {
        return []
    }
}

function parseSkillsFromAgentsMarkdown (
    content: string,
    baseDir: string,
): ResolvedAgentSkill[] {
    const skills: ResolvedAgentSkill[] = []
    const skillLineRegex = /^\s*-\s*([^:\n]+?)\s*:\s*(.*?)\s*\(file:\s*([^)]+)\)\s*$/gm
    let match: RegExpExecArray | null
    while ((match = skillLineRegex.exec(content)) !== null) {
        const name = (match[1] || '').trim()
        const description = (match[2] || '').trim()
        const locationRaw = (match[3] || '').trim()
        if (!name || !locationRaw) continue

        const resolvedPath = normalizeFsPath(locationRaw, baseDir)
        skills.push({
            name,
            description: description || 'No description provided.',
            location: resolvedPath,
            resolvedPath,
        })
    }
    return skills
}

function parseSubAgentsFromAgentsMarkdown (content: string): SubAgentOptions[] {
    const out: SubAgentOptions[] = []

    const xmlRegex = /<subagent>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<\/subagent>/gm
    let xmlMatch: RegExpExecArray | null
    while ((xmlMatch = xmlRegex.exec(content)) !== null) {
        const name = (xmlMatch[1] || '').trim()
        const description = (xmlMatch[2] || '').trim()
        if (!name) continue
        out.push({
            name,
            description: description || 'No description provided.',
        })
    }

    return out
}

function collectAncestorAgentsFiles (cwd: string): string[] {
    const files: string[] = []
    let current = path.resolve(cwd)

    while (true) {
        const candidate = path.join(current, 'AGENTS.md')
        if (fs.existsSync(candidate)) {
            files.push(candidate)
        }
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
    }

    return files
}

function extractSkillDescription (skillBody: string): string {
    const lines = skillBody.split(/\r?\n/)
    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        return line.length > 240 ? `${line.slice(0, 237)}...` : line
    }

    const heading = lines.find(l => l.trim().startsWith('#'))
    if (heading) {
        return heading.replace(/^#+\s*/, '').trim() || 'No description provided.'
    }
    return 'No description provided.'
}

function discoverCodexSkills (): ResolvedAgentSkill[] {
    const skillsRoot = path.join(os.homedir(), '.codex', 'skills')
    if (!fs.existsSync(skillsRoot)) return []

    const out: ResolvedAgentSkill[] = []
    const stack = [skillsRoot]
    let scannedSkillFiles = 0

    while (stack.length > 0 && scannedSkillFiles < MAX_SKILL_SCAN_FILES) {
        const dir = stack.pop() as string
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            continue
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue
                stack.push(fullPath)
                continue
            }

            if (!entry.isFile() || entry.name.toLowerCase() !== 'skill.md') continue
            scannedSkillFiles++

            const body = safeReadUtf8(fullPath) || ''
            const name = path.basename(path.dirname(fullPath))
            if (!name) continue
            out.push({
                name,
                description: extractSkillDescription(body),
                location: fullPath,
                resolvedPath: fullPath,
            })
        }
    }

    return out
}

function discoverResolvedSkillsFromAgentsFiles (cwd: string): ResolvedAgentSkill[] {
    const files = collectAncestorAgentsFiles(cwd)
    const out: ResolvedAgentSkill[] = []
    for (const filePath of files) {
        const content = safeReadUtf8(filePath)
        if (!content) continue
        out.push(...parseSkillsFromAgentsMarkdown(content, path.dirname(filePath)))
    }
    return out
}

function discoverSubAgentsFromAgentsFiles (cwd: string): SubAgentOptions[] {
    const files = collectAncestorAgentsFiles(cwd)
    const out: SubAgentOptions[] = []
    for (const filePath of files) {
        const content = safeReadUtf8(filePath)
        if (!content) continue
        out.push(...parseSubAgentsFromAgentsMarkdown(content))
    }
    return out
}

export function discoverResolvedAgentSkills (cwd: string): ResolvedAgentSkill[] {
    const envSkills = parseSkillsFromJson(process.env['ATERM_AI_SKILLS_JSON'], cwd)

    const localSkillsFile = path.join(cwd, '.aterm', 'skills.json')
    const localSkills = parseSkillsFromJson(
        safeReadUtf8(localSkillsFile) || undefined,
        path.dirname(localSkillsFile),
    )

    const skillsFromAgents = discoverResolvedSkillsFromAgentsFiles(cwd)
    const codexSkills = discoverCodexSkills()

    return dedupeByName([
        ...envSkills,
        ...localSkills,
        ...skillsFromAgents,
        ...codexSkills,
    ])
}

export function discoverAgentSkills (cwd: string): AgentSkillOptions[] {
    return discoverResolvedAgentSkills(cwd).map(({ name, description, location }) => ({
        name,
        description,
        location,
    }))
}

export function discoverSubAgents (cwd: string): SubAgentOptions[] {
    const envSubAgents = parseSubAgentsFromJson(process.env['ATERM_AI_SUBAGENTS_JSON'])

    const localFile = path.join(cwd, '.aterm', 'subagents.json')
    const localSubAgents = parseSubAgentsFromJson(safeReadUtf8(localFile) || undefined)

    const fromAgentsFiles = discoverSubAgentsFromAgentsFiles(cwd)

    return dedupeByName([
        ...envSubAgents,
        ...localSubAgents,
        ...fromAgentsFiles,
    ])
}

export function resolveAgentSkillByName (
    skillName: string,
    cwd: string,
): ResolvedAgentSkill | undefined {
    const needle = skillName.trim().toLowerCase()
    if (!needle) return undefined

    return discoverResolvedAgentSkills(cwd)
        .find(skill => skill.name.trim().toLowerCase() === needle)
}

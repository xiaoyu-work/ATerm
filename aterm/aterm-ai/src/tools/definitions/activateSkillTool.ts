/**
 * Activate skill tool.
 *
 * Gemini-compatible skill activation with local skill discovery.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { Dirent } from 'fs'
import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'
import { discoverAgentSkills, resolveAgentSkillByName } from '../../agentMetadata'

export interface ActivateSkillToolParams {
    name?: string
    skill_name?: string
}

function normalizeSkillName (params: ActivateSkillToolParams): string {
    return (params.name ?? params.skill_name ?? '').trim()
}

function escapeXml (value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

async function getFolderStructure (
    rootDir: string,
    maxDepth = 3,
    maxEntries = 150,
): Promise<string> {
    const lines: string[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (lines.length >= maxEntries) return
        let entries: Dirent[]
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }

        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
            if (lines.length >= maxEntries) return
            const fullPath = path.join(dir, entry.name)
            const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
            const indent = '  '.repeat(depth)

            if (entry.isDirectory()) {
                lines.push(`${indent}${relPath}/`)
                if (depth < maxDepth) {
                    await walk(fullPath, depth + 1)
                }
                continue
            }
            lines.push(`${indent}${relPath}`)
        }
    }

    await walk(rootDir, 0)
    if (lines.length === 0) return '(no resources found)'
    if (lines.length >= maxEntries) lines.push('... (truncated)')
    return lines.join('\n')
}

class ActivateSkillToolInvocation extends BaseToolInvocation<ActivateSkillToolParams> {
    constructor (params: ActivateSkillToolParams) {
        super(params, ToolKind.Other)
    }

    getDescription (): string {
        const name = normalizeSkillName(this.params) || '(unknown)'
        return `Activate skill: ${name}`
    }

    getConfirmationDetails (): false {
        return false
    }

    async execute (context: ToolContext): Promise<ToolResult> {
        const skillName = normalizeSkillName(this.params)
        if (!skillName) {
            return this.error('Missing required parameter: name')
        }

        const skill = resolveAgentSkillByName(skillName, context.cwd)
        if (!skill) {
            const available = discoverAgentSkills(context.cwd).map(s => s.name).join(', ')
            const suffix = available ? ` Available skills: ${available}` : ''
            return this.error(`Skill "${skillName}" not found.${suffix}`)
        }

        let body: string
        try {
            body = await fs.readFile(skill.resolvedPath, 'utf-8')
        } catch (err: any) {
            return this.error(`Failed to read skill file: ${err.message}`)
        }

        const resources = await getFolderStructure(path.dirname(skill.resolvedPath))
        return this.success(
            `<activated_skill name="${escapeXml(skill.name)}">
  <instructions>
${escapeXml(body.trim())}
  </instructions>
  <available_resources>
${escapeXml(resources)}
  </available_resources>
</activated_skill>`,
        )
    }
}

export class ActivateSkillTool extends DeclarativeTool<ActivateSkillToolParams> {
    readonly name = 'activate_skill'
    readonly displayName = 'Activate Skill'
    readonly description = 'Activates a named skill so the agent can use skill-specific instructions and resources.'
    readonly kind = ToolKind.Other
    readonly parameters = {
        name: {
            type: 'string',
            description: 'The skill name to activate.',
        },
        skill_name: {
            type: 'string',
            description: 'Legacy alias of name. The skill name to activate.',
        },
    }
    readonly required: string[] = []

    protected createInvocation (params: ActivateSkillToolParams, _context: ToolContext): BaseToolInvocation<ActivateSkillToolParams> {
        return new ActivateSkillToolInvocation(params)
    }

    protected validateToolParamValues (params: ActivateSkillToolParams): string | null {
        if (!normalizeSkillName(params)) {
            return 'Missing required parameter: name'
        }
        return null
    }
}

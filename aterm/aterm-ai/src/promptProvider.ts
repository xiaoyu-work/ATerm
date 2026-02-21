/**
 * Prompt provider adapted from gemini-cli promptProvider.ts.
 *
 * Keeps prompt orchestration in one place so middleware only passes runtime context.
 */

import fs from 'fs'
import path from 'path'
import {
    AgentSkillOptions,
    SubAgentOptions,
    getCoreSystemPrompt,
    renderFinalShell,
    getCompressionPrompt,
    renderAgentSkills,
    renderSubAgents,
} from './geminiPrompt'
import { discoverAgentSkills, discoverSubAgents } from './agentMetadata'

export interface PromptProviderOptions {
    cwd?: string
    memory?: string
    context: string
    interactive?: boolean
    interactiveShellEnabled?: boolean
    planMode?: boolean
    isYoloMode?: boolean
    modelId?: string
    approvedPlanPath?: string
    availableTools?: string[]
    skills?: AgentSkillOptions[]
    subAgents?: SubAgentOptions[]
}

interface ResolvedPath {
    value?: string
    isSwitch: boolean
    isDisabled: boolean
}

function resolvePathFromEnv (raw?: string): ResolvedPath {
    if (!raw || !raw.trim()) {
        return { isSwitch: false, isDisabled: false }
    }
    const value = raw.trim()
    const lowered = value.toLowerCase()

    if (['0', 'false', 'off', 'no'].includes(lowered)) {
        return { isSwitch: false, isDisabled: true }
    }
    if (['1', 'true', 'on', 'yes'].includes(lowered)) {
        return { isSwitch: true, isDisabled: false }
    }

    return {
        value: path.resolve(value),
        isSwitch: false,
        isDisabled: false,
    }
}

function applyPromptTemplateSubstitutions (
    template: string,
    options: PromptProviderOptions,
): string {
    const availableTools = options.availableTools && options.availableTools.length > 0
        ? options.availableTools
        : [
            'run_shell_command', 'read_file', 'read_many_files', 'write_file',
            'replace', 'list_directory', 'glob', 'grep_search', 'ask_user',
            'save_memory', 'write_todos', 'enter_plan_mode', 'exit_plan_mode',
            'google_web_search', 'web_fetch', 'get_internal_docs', 'activate_skill',
        ]
    const availableToolsList = availableTools.map(name => `- ${name}`).join('\n')
    const skillsPrompt = renderAgentSkills(options.skills)
    const subAgentsPrompt = renderSubAgents(options.subAgents)
    const toolNameReplacements: Record<string, string> = {}
    for (const toolName of availableTools) {
        toolNameReplacements[`${toolName}_ToolName`] = toolName
    }
    if (availableTools.includes('google_web_search')) {
        toolNameReplacements['web_search_ToolName'] = 'google_web_search'
    }

    let result = template
        .replace(/\{\{TERMINAL_CONTEXT\}\}/g, options.context)
        .replace(/\{\{CONTEXT\}\}/g, options.context)
        .replace(/\$\{AgentSkills\}/g, skillsPrompt)
        .replace(/\$\{SubAgents\}/g, subAgentsPrompt)
        .replace(/\$\{AvailableTools\}/g, availableToolsList)

    for (const [key, value] of Object.entries(toolNameReplacements)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        result = result.replace(new RegExp(`\\$\\{${escaped}\\}`, 'g'), value)
    }

    return result
}

function isSectionEnabled (key: string): boolean {
    const value = process.env[`GEMINI_PROMPT_${key.toUpperCase()}`]
    const lowered = value?.trim().toLowerCase()
    return lowered !== '0' && lowered !== 'false'
}

function supportsModernFeatures (modelId?: string): boolean {
    if (!modelId) return true
    const m = modelId.toLowerCase()
    if (m.includes('legacy')) return false
    if (m.includes('gemini-1.0') || m.includes('gemini-1.5')) return false
    if (m.includes('gpt-3.5')) return false
    return true
}

function getSandboxMode (): 'macos-seatbelt' | 'generic' | 'outside' {
    if (process.env['SANDBOX'] === 'sandbox-exec') return 'macos-seatbelt'
    if (process.env['SANDBOX']) return 'generic'
    return 'outside'
}

export class PromptProvider {
    private withSection<T> (key: string, factory: () => T, guard = true): T | undefined {
        return guard && isSectionEnabled(key) ? factory() : undefined
    }

    private isGitRepository (cwd: string): boolean {
        return fs.existsSync(path.join(cwd, '.git'))
    }

    getCoreSystemPrompt (options: PromptProviderOptions): string {
        const cwd = options.cwd || process.cwd()
        const resolvedSkills = options.skills && options.skills.length > 0
            ? options.skills
            : discoverAgentSkills(cwd)
        const discoveredSubAgents = options.subAgents && options.subAgents.length > 0
            ? options.subAgents
            : discoverSubAgents(cwd)
        const availableToolSet = new Set(options.availableTools || [])
        const resolvedSubAgents = availableToolSet.size > 0
            ? discoveredSubAgents.filter(agent => availableToolSet.has(agent.name))
            : discoveredSubAgents
        const resolvedOptions: PromptProviderOptions = {
            ...options,
            cwd,
            skills: resolvedSkills,
            subAgents: resolvedSubAgents,
        }
        const systemMdResolution = resolvePathFromEnv(process.env['GEMINI_SYSTEM_MD'])
        const defaultSystemMdPath = path.resolve(path.join(cwd, '.gemini', 'system.md'))
        const interactive = resolvedOptions.interactive ?? true
        const planMode = resolvedOptions.planMode ?? false
        const isYoloMode = resolvedOptions.isYoloMode ?? false
        const modernModel = supportsModernFeatures(resolvedOptions.modelId)

        let basePrompt: string
        if ((systemMdResolution.value || systemMdResolution.isSwitch) && !systemMdResolution.isDisabled) {
            const systemMdPath = systemMdResolution.isSwitch
                ? defaultSystemMdPath
                : systemMdResolution.value as string
            if (!fs.existsSync(systemMdPath)) {
                throw new Error(`missing system prompt file '${systemMdPath}'`)
            }
            basePrompt = applyPromptTemplateSubstitutions(
                fs.readFileSync(systemMdPath, 'utf8'),
                resolvedOptions,
            )
        } else {
            basePrompt = getCoreSystemPrompt({
                preamble: this.withSection('preamble', () => ({ interactive })),
                coreMandates: this.withSection('coreMandates', () => ({ interactive })),
                subAgents: this.withSection(
                    'agentContexts',
                    () => resolvedSubAgents,
                    resolvedSubAgents.length > 0,
                ),
                agentSkills: this.withSection(
                    'agentSkills',
                    () => resolvedSkills,
                    resolvedSkills.length > 0,
                ),
                primaryWorkflows: this.withSection(
                    'primaryWorkflows',
                    () => ({
                        interactive,
                        approvedPlanPath: resolvedOptions.approvedPlanPath,
                    }),
                    !planMode,
                ),
                planningWorkflow: this.withSection(
                    'planningWorkflow',
                    () => ({
                        plansDir: '.aterm/plans',
                        approvedPlanPath: resolvedOptions.approvedPlanPath,
                    }),
                    planMode,
                ),
                operationalGuidelines: this.withSection(
                    'operationalGuidelines',
                    () => ({
                        interactive,
                        interactiveShellEnabled: resolvedOptions.interactiveShellEnabled ?? false,
                    }),
                ),
                hookContext: this.withSection('hookContext', () => true),
                sandbox: this.withSection('sandbox', () => getSandboxMode()),
                interactiveYoloMode: this.withSection(
                    'interactiveYoloMode',
                    () => true,
                    isYoloMode && interactive,
                ),
                gitRepo: this.withSection(
                    'git',
                    () => ({ interactive }),
                    this.isGitRepository(cwd),
                ),
                finalReminder: !modernModel
                    ? this.withSection('finalReminder', () => ({ readFileToolName: 'read_file' }))
                    : undefined,
            })
        }

        const finalPrompt = renderFinalShell(basePrompt, resolvedOptions.memory)
        const sanitizedPrompt = finalPrompt.replace(/\n{3,}/g, '\n\n')
        const output = `
${sanitizedPrompt}

# Terminal Context
${resolvedOptions.context}
`.trim()

        this.maybeWriteSystemMd(output, defaultSystemMdPath)
        return output
    }

    getCompressionPrompt (): string {
        return getCompressionPrompt()
    }

    private maybeWriteSystemMd (prompt: string, defaultPath: string): void {
        const resolution = resolvePathFromEnv(process.env['GEMINI_WRITE_SYSTEM_MD'])
        if ((!resolution.value && !resolution.isSwitch) || resolution.isDisabled) {
            return
        }
        const outPath = resolution.isSwitch ? defaultPath : resolution.value as string
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, prompt, 'utf8')
    }
}

/**
 * Web fetch tool.
 *
 * Compatible tool name/schema with gemini-cli's web_fetch declaration.
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'

export interface WebFetchToolParams {
    prompt: string
}

function extractUrls (text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s)>\]"']+/g) || []
    const deduped: string[] = []
    for (const u of matches) {
        if (!deduped.includes(u)) deduped.push(u)
        if (deduped.length >= 20) break
    }
    return deduped
}

class WebFetchToolInvocation extends BaseToolInvocation<WebFetchToolParams> {
    constructor (params: WebFetchToolParams) {
        super(params, ToolKind.Fetch)
    }

    getDescription (): string {
        return 'Fetch and process web content'
    }

    getConfirmationDetails (): false {
        return false
    }

    async execute (_context: ToolContext): Promise<ToolResult> {
        const urls = extractUrls(this.params.prompt || '')
        if (urls.length === 0) {
            return this.error('No valid URLs found in prompt. Include one or more full http(s):// URLs.')
        }

        const sections: string[] = []
        for (const url of urls) {
            try {
                const ac = new AbortController()
                const timer = setTimeout(() => ac.abort(), 15000)
                const res = await fetch(url, { signal: ac.signal })
                clearTimeout(timer)

                if (!res.ok) {
                    sections.push(`URL: ${url}\nStatus: HTTP ${res.status}`)
                    continue
                }

                const contentType = res.headers.get('content-type') || ''
                const raw = await res.text()
                const text = raw.replace(/\s+/g, ' ').trim().slice(0, 8000)
                sections.push(
                    `URL: ${url}\nContent-Type: ${contentType || '(unknown)'}\nContent:\n${text || '(empty body)'}`,
                )
            } catch (err: any) {
                sections.push(`URL: ${url}\nError: ${err.message}`)
            }
        }

        return this.success(sections.join('\n\n---\n\n'))
    }
}

export class WebFetchTool extends DeclarativeTool<WebFetchToolParams> {
    readonly name = 'web_fetch'
    readonly displayName = 'Web Fetch'
    readonly description = 'Processes content from URL(s) embedded in a prompt. Include URLs and instructions directly in the prompt parameter.'
    readonly kind = ToolKind.Fetch
    readonly parameters = {
        prompt: {
            type: 'string',
            description: 'Prompt including one or more URLs and instructions for how to process their content.',
        },
    }
    readonly required = ['prompt']

    protected createInvocation (params: WebFetchToolParams, _context: ToolContext): BaseToolInvocation<WebFetchToolParams> {
        return new WebFetchToolInvocation(params)
    }
}


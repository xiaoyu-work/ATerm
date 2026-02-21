/**
 * Google web search tool.
 *
 * Gemini CLI uses provider-native search; ATerm provides a compatible tool
 * that can use either:
 * 1) a custom endpoint via ATERM_AI_WEB_SEARCH_ENDPOINT
 * 2) a built-in DuckDuckGo HTML fallback parser.
 */

import { DeclarativeTool } from '../base/declarativeTool'
import { BaseToolInvocation } from '../base/baseToolInvocation'
import { ToolKind, ToolContext, ToolResult } from '../types'

export interface WebSearchToolParams {
    query: string
    num_results?: number
}

interface SearchResultItem {
    title: string
    url: string
    snippet?: string
}

const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10
const REQUEST_TIMEOUT_MS = 15000

function clampResultCount (raw?: number): number {
    if (!Number.isFinite(raw)) return DEFAULT_RESULTS
    const n = Math.floor(raw as number)
    return Math.max(1, Math.min(MAX_RESULTS, n))
}

function decodeHtmlEntities (text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&#(\d+);/g, (_m, n) => {
            const cp = Number.parseInt(n, 10)
            return Number.isFinite(cp) ? String.fromCharCode(cp) : _m
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => {
            const cp = Number.parseInt(n, 16)
            return Number.isFinite(cp) ? String.fromCharCode(cp) : _m
        })
}

function stripHtml (html: string): string {
    return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeUrl (url: string): string {
    try {
        if (url.startsWith('//')) {
            return `https:${url}`
        }
        const u = new URL(url)
        if (u.hostname.includes('duckduckgo.com') && u.pathname.startsWith('/l/')) {
            const uddg = u.searchParams.get('uddg')
            if (uddg) {
                return decodeURIComponent(uddg)
            }
        }
        return u.toString()
    } catch {
        return url
    }
}

async function fetchTextWithTimeout (url: string, init?: RequestInit): Promise<string> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
    try {
        const res = await fetch(url, {
            ...init,
            signal: ac.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; aterm-ai/1.0)',
                ...(init?.headers || {}),
            },
        })
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`)
        }
        return await res.text()
    } finally {
        clearTimeout(timer)
    }
}

function formatResults (query: string, results: SearchResultItem[]): string {
    if (results.length === 0) {
        return `No web search results found for "${query}".`
    }

    const lines: string[] = [`Search results for "${query}":`]
    results.forEach((item, idx) => {
        lines.push(`${idx + 1}. ${item.title}`)
        lines.push(`   URL: ${item.url}`)
        if (item.snippet) {
            lines.push(`   Snippet: ${item.snippet}`)
        }
    })
    return lines.join('\n')
}

function parseDuckDuckGoHtml (html: string, maxResults: number): SearchResultItem[] {
    const out: SearchResultItem[] = []
    const anchorRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let match: RegExpExecArray | null

    while ((match = anchorRe.exec(html)) !== null && out.length < maxResults) {
        const rawUrl = (match[1] || '').trim()
        const title = stripHtml(match[2] || '')
        if (!rawUrl || !title) continue

        const url = normalizeUrl(decodeHtmlEntities(rawUrl))

        // Try to capture snippet close to the match.
        const tail = html.slice(anchorRe.lastIndex, Math.min(html.length, anchorRe.lastIndex + 1200))
        const snippetMatch = tail.match(/<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        const snippetRaw = snippetMatch ? (snippetMatch[1] || snippetMatch[2] || '') : ''
        const snippet = stripHtml(snippetRaw)

        out.push({
            title,
            url,
            snippet: snippet || undefined,
        })
    }

    return out
}

async function searchViaCustomEndpoint (
    endpoint: string,
    query: string,
    maxResults: number,
): Promise<SearchResultItem[]> {
    const body = JSON.stringify({
        query,
        num_results: maxResults,
        numResults: maxResults,
    })
    const raw = await fetchTextWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body,
    })

    let parsed: any
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('Custom web search endpoint returned non-JSON response')
    }

    const candidates = Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.items)
            ? parsed.items
            : Array.isArray(parsed)
                ? parsed
                : []

    const results: SearchResultItem[] = []
    for (const item of candidates) {
        if (!item || typeof item !== 'object') continue
        const title = String(item.title || item.name || '').trim()
        const url = String(item.url || item.link || '').trim()
        const snippet = String(item.snippet || item.description || item.summary || '').trim()
        if (!title || !url) continue
        results.push({ title, url, snippet: snippet || undefined })
        if (results.length >= maxResults) break
    }
    return results
}

async function searchViaDuckDuckGo (
    query: string,
    maxResults: number,
): Promise<SearchResultItem[]> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const html = await fetchTextWithTimeout(url)
    return parseDuckDuckGoHtml(html, maxResults)
}

class WebSearchToolInvocation extends BaseToolInvocation<WebSearchToolParams> {
    private readonly maxResults: number

    constructor (params: WebSearchToolParams) {
        super(params, ToolKind.Fetch)
        this.maxResults = clampResultCount(params.num_results)
    }

    getDescription (): string {
        return `Web search: ${this.params.query} (${this.maxResults} results)`
    }

    getConfirmationDetails (): false {
        return false
    }

    async execute (_context: ToolContext): Promise<ToolResult> {
        const query = (this.params.query || '').trim()
        if (!query) {
            return this.error('Missing required parameter: query')
        }

        const customEndpoint = (process.env['ATERM_AI_WEB_SEARCH_ENDPOINT'] || '').trim()
        try {
            const results = customEndpoint
                ? await searchViaCustomEndpoint(customEndpoint, query, this.maxResults)
                : await searchViaDuckDuckGo(query, this.maxResults)
            return this.success(formatResults(query, results))
        } catch (err: any) {
            return this.error(`Web search failed: ${err.message}`)
        }
    }
}

export class WebSearchTool extends DeclarativeTool<WebSearchToolParams> {
    readonly name = 'google_web_search'
    readonly displayName = 'Google Web Search'
    readonly description = 'Performs a web search and returns results. Use this when you need to find information on the public internet.'
    readonly kind = ToolKind.Fetch
    readonly parameters = {
        query: {
            type: 'string',
            description: 'The search query to find information on the web.',
        },
        num_results: {
            type: 'number',
            description: `Number of results to return (1-${MAX_RESULTS}).`,
        },
    }
    readonly required = ['query']

    protected createInvocation (params: WebSearchToolParams, _context: ToolContext): BaseToolInvocation<WebSearchToolParams> {
        return new WebSearchToolInvocation(params)
    }
}

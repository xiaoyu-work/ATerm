import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

marked.use(markedTerminal())

export function renderMarkdown (md: string): string {
    return marked(md) as string
}

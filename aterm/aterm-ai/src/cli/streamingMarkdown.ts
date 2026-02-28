/**
 * Streaming markdown renderer for terminal output.
 *
 * Buffers AI content chunks and renders complete blocks (paragraphs,
 * code fences, lists, headings) through marked + marked-terminal
 * as soon as a block boundary is detected.
 *
 * Strategy:
 * - Buffer incoming text until we see a double-newline (\n\n) which
 *   signals a paragraph/block boundary in Markdown.
 * - Track code fence state (``` pairs) so we never split inside a
 *   fenced code block.
 * - On flush() (called when streaming ends), render whatever remains.
 */

import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

export class StreamingMarkdownRenderer {
    private buffer = ''
    private fenceOpen = false
    private writer: (rendered: string) => void

    /**
     * @param writer  callback that receives rendered ANSI text
     * @param colorFn optional function that wraps text in the user's
     *                configured AI content color (e.g. trueColor('#4ade80'))
     */
    constructor (writer: (rendered: string) => void, colorFn?: (s: string) => string) {
        this.writer = writer

        // Configure marked-terminal with the user's content color so that
        // paragraph text, list items, etc. use the configured AI color
        // instead of chalk.reset (which strips all color).
        const textStyle = colorFn || ((s: string) => s)
        marked.use(markedTerminal({
            paragraph: textStyle,
            listitem: textStyle,
            text: (s: string) => s, // text inside paragraphs — don't double-color
        }))
    }

    /**
     * Feed a streaming chunk into the renderer.
     * Complete blocks are rendered and written immediately.
     */
    push (chunk: string): void {
        this.buffer += chunk

        // Try to emit complete blocks
        this.drain()
    }

    /**
     * Flush any remaining buffered content (call on stream end).
     */
    flush (): void {
        if (this.buffer.length > 0) {
            this.render(this.buffer)
            this.buffer = ''
            this.fenceOpen = false
        }
    }

    private drain (): void {
        // Keep trying to find block boundaries to render
        while (true) {
            const boundary = this.findBlockBoundary()
            if (boundary < 0) break

            // Extract the complete block (including the \n\n separator)
            const block = this.buffer.slice(0, boundary)
            this.buffer = this.buffer.slice(boundary)

            // Remove leading newlines from remainder
            this.buffer = this.buffer.replace(/^\n+/, '')

            if (block.trim().length > 0) {
                this.render(block)
            }
        }
    }

    /**
     * Check whether the text before a given position is inside a list context.
     * We look backwards for the nearest blank-line-delimited block start and
     * check whether that block began with a list marker.
     */
    private isInsideList (pos: number): boolean {
        // Walk backwards from pos to find the start of the current block
        let blockStart = 0
        for (let j = pos - 1; j > 0; j--) {
            // A previous \n\n marks the end of the prior block
            if (this.buffer[j] === '\n' && this.buffer[j - 1] === '\n') {
                blockStart = j + 1
                break
            }
        }
        const blockHead = this.buffer.slice(blockStart, pos).trimStart()
        // List markers: *, -, +, or digit(s) followed by . or )
        return /^(?:[*\-+]|\d+[.)]) /.test(blockHead)
    }

    /**
     * Find the next safe block boundary in the buffer.
     * Returns the index past which we can split, or -1 if none found.
     *
     * A safe boundary is a \n\n that is NOT inside a fenced code block
     * and NOT inside a list (where loose items are separated by blank lines).
     */
    private findBlockBoundary (): number {
        let i = 0
        let localFenceOpen = this.fenceOpen

        while (i < this.buffer.length) {
            // Check for code fence (``` at start of line or after newline)
            if (this.buffer.startsWith('```', i)) {
                localFenceOpen = !localFenceOpen
                i += 3
                continue
            }

            // Check for block boundary: \n\n outside of code fence
            if (!localFenceOpen && this.buffer.startsWith('\n\n', i)) {
                const afterBreak = i + 2
                // Peek at text after the \n\n — if it continues a list or is
                // indented continuation, this is NOT a true block boundary.
                const rest = this.buffer.slice(afterBreak)
                const nextLineIsList = /^[\t ]*(?:[*\-+]|\d+[.)]) /.test(rest)
                const insideList = this.isInsideList(i)

                if (!nextLineIsList || !insideList) {
                    // True block boundary
                    this.fenceOpen = localFenceOpen
                    return afterBreak
                }
                // Otherwise skip past this \n\n — it's a loose list gap
                i = afterBreak
                continue
            }

            i++
        }

        return -1
    }

    private render (text: string): void {
        try {
            const rendered = marked(text) as string
            // marked-terminal adds trailing newlines; write as-is
            this.writer(rendered)
        } catch {
            // Fallback: output raw text if rendering fails
            this.writer(text)
        }
    }
}

/**
 * LLM Edit Fixer — ported from gemini-cli.
 * Source: gemini-cli/packages/core/src/utils/llm-edit-fixer.ts
 *
 * When an edit tool's old_string fails to match, this calls the LLM
 * to produce a corrected search string that will match the file content.
 */

import { IAIService } from '../ai.service'

// === Ported from gemini-cli llm-edit-fixer.ts lines 18-39 ===
const EDIT_SYS_PROMPT = `
You are an expert code-editing assistant specializing in debugging and correcting failed search-and-replace operations.

# Primary Goal
Your task is to analyze a failed edit attempt and provide a corrected \`search\` string that will match the text in the file precisely. The correction should be as minimal as possible, staying very close to the original, failed \`search\` string. Do NOT invent a completely new edit based on the instruction; your job is to fix the provided parameters.

It is important that you do not try to figure out if the instruction is correct. DO NOT GIVE ADVICE. Your only goal here is to do your best to perform the search and replace task!

# Input Context
You will be given:
1. The high-level instruction for the original edit.
2. The exact \`search\` and \`replace\` strings that failed.
3. The error message that was produced.
4. The full content of the latest version of the source file.

# Rules for Correction
1.  **Minimal Correction:** Your new \`search\` string must be a close variation of the original. Focus on fixing issues like whitespace, indentation, line endings, or small contextual differences.
2.  **Explain the Fix:** Your \`explanation\` MUST state exactly why the original \`search\` failed and how your new \`search\` string resolves that specific failure.
3.  **Preserve the \`replace\` String:** Do NOT modify the \`replace\` string unless the instruction explicitly requires it and it was the source of the error. Do not escape any characters in \`replace\`.
4.  **No Changes Case:** CRUCIAL: if the change is already present in the file, set \`noChangesRequired\` to true and explain why in the \`explanation\`.
5.  **Exactness:** The final \`search\` field must be the EXACT literal text from the file. Do not escape characters.

Respond with JSON: {"search": "...", "replace": "...", "noChangesRequired": false, "explanation": "..."}`

// === Ported from gemini-cli llm-edit-fixer.ts lines 41-68 ===
const EDIT_USER_PROMPT = `
# Goal of the Original Edit
<instruction>
{instruction}
</instruction>

# Failed Attempt Details
- **Original \`search\` parameter (failed):**
<search>
{old_string}
</search>
- **Original \`replace\` parameter:**
<replace>
{new_string}
</replace>
- **Error Encountered:**
<error>
{error}
</error>

# Full File Content
<file_content>
{current_content}
</file_content>

# Your Task
Based on the error and the file content, provide a corrected \`search\` string that will succeed. Remember to keep your correction minimal and explain the precise reason for the failure in your \`explanation\`.`

export interface SearchReplaceEdit {
    search: string
    replace: string
    noChangesRequired: boolean
    explanation: string
}

/**
 * Attempt to fix a failed edit by using an LLM to generate a corrected
 * search/replace pair.
 *
 * Ported from gemini-cli's FixLLMEditWithInstruction.
 */
export async function fixLLMEdit (
    instruction: string,
    oldString: string,
    newString: string,
    error: string,
    currentContent: string,
    ai: IAIService,
    signal: AbortSignal,
): Promise<SearchReplaceEdit | null> {
    const userPrompt = EDIT_USER_PROMPT
        .replace('{instruction}', instruction)
        .replace('{old_string}', oldString)
        .replace('{new_string}', newString)
        .replace('{error}', error)
        .replace('{current_content}', currentContent)

    try {
        const response = await ai.query(userPrompt, EDIT_SYS_PROMPT)

        // Parse JSON from response — look for the object with "search" key
        const jsonMatch = response.match(/\{[\s\S]*?"search"[\s\S]*?\}/)
        if (!jsonMatch) return null

        const parsed = JSON.parse(jsonMatch[0]) as SearchReplaceEdit
        if (parsed.search !== undefined && parsed.replace !== undefined) {
            return parsed
        }
        return null
    } catch {
        return null
    }
}

/**
 * Core type definitions for the tool system.
 *
 * Mirrors gemini-cli's type hierarchy:
 * - packages/core/src/tools/tools.ts (ToolResult, ToolInvocation, ToolBuilder, Kind)
 * - packages/core/src/scheduler/types.ts (ToolCallStatus, discriminated unions)
 */

import { ToolDefinition } from '../ai.service'
import { ContextCollector } from '../contextCollector'
import { ShellResult } from '../shellExecutor'
import { MessageBus } from '../messageBus'
import { PathApprovalTracker } from './pathApprovals'

// ─── Tool Result ─────────────────────────────────────────────────────
// Mirrors gemini-cli's ToolResult (packages/core/src/tools/tools.ts)
// Simplified: llmContent is string (OpenAI format) instead of Part[]

export interface ToolResult {
    /** Content returned to the LLM as the tool call result */
    llmContent: string
    /** Error message if the tool failed */
    error?: string
    /** Arbitrary structured data for inter-tool communication */
    data?: Record<string, unknown>
}

// ─── Confirmation Details ────────────────────────────────────────────
// Mirrors gemini-cli's SerializableConfirmationDetails
// (packages/core/src/confirmation-bus/types.ts)

export type ConfirmationDetails =
    | { type: 'exec'; title: string; command: string }
    | { type: 'edit'; title: string; filePath: string }
    | { type: 'path_access'; title: string; resolvedPath: string }

// ─── Tool Kind ───────────────────────────────────────────────────────
// Mirrors gemini-cli's Kind enum (packages/core/src/tools/tools.ts)

export enum ToolKind {
    Read = 'read',
    Edit = 'edit',
    Delete = 'delete',
    Move = 'move',
    Search = 'search',
    Execute = 'execute',
    Think = 'think',
    Fetch = 'fetch',
    Communicate = 'communicate',
    Plan = 'plan',
    Other = 'other',
}

/** Kinds that mutate state — mirrors gemini-cli's MUTATOR_KINDS */
export const MUTATOR_KINDS: ToolKind[] = [
    ToolKind.Edit,
    ToolKind.Delete,
    ToolKind.Move,
    ToolKind.Execute,
]

// ─── Tool Context ────────────────────────────────────────────────────
// Simplified from gemini-cli's ToolContext — carries execution dependencies

export interface ToolContext {
    /** Current working directory */
    cwd: string
    /** Abort signal for cancellation */
    signal: AbortSignal
    /** Terminal context collector */
    collector: ContextCollector
    /** UI callbacks for tool interaction */
    callbacks: AgentCallbacks
    /** Message bus for async communication (confirmation, ask_user) */
    bus: MessageBus
    /** Session-level path approval tracker for outside-CWD access */
    pathApprovals: PathApprovalTracker
}

// ─── Agent Callbacks ─────────────────────────────────────────────────
// UI layer callbacks — implemented by AIMiddleware

export interface AgentCallbacks {
    onContent: (text: string) => void
    onThinking: (text: string) => void
    onConfirmCommand: (description: string, type: ConfirmationDetails['type']) => void
    waitForApproval: () => Promise<ConfirmationOutcome>
    onAskUser: (question: string) => void
    waitForUserResponse: () => Promise<string>
    onToolStart: (toolName: string, description: string) => void
    onToolDone: (toolName: string, success: boolean, error?: string) => void
    onCommandStart: (cmd: string) => void
    onCommandOutput: (chunk: string) => void
    onCommandDone: (result: ShellResult) => void
    onDone: () => void
    onError: (err: string) => void
}

// ─── Tool Invocation ─────────────────────────────────────────────────
// Mirrors gemini-cli's ToolInvocation (packages/core/src/tools/tools.ts)

export interface ToolInvocation<TParams = unknown> {
    /** The parsed parameters for this invocation */
    params: TParams
    /** Tool kind — exposed for scheduler policy decisions */
    kind: ToolKind
    /** Human-readable description of what this invocation will do */
    getDescription(): string
    /**
     * Return confirmation details if this invocation requires user approval.
     * Mirrors gemini-cli's getConfirmationDetails()
     * (packages/core/src/tools/tools.ts L350-380)
     */
    getConfirmationDetails(context: ToolContext): ConfirmationDetails | false
    /** Execute the tool and return the result */
    execute(context: ToolContext): Promise<ToolResult>
}

// ─── Tool Builder ────────────────────────────────────────────────────
// Mirrors gemini-cli's ToolBuilder (packages/core/src/tools/tools.ts)

export interface ToolBuilder<TParams = unknown> {
    /** Unique tool name (matches function.name in API calls) */
    name: string
    /** Human-friendly display name */
    displayName: string
    /** Description for the LLM */
    description: string
    /** Tool kind for policy/scheduling decisions */
    kind: ToolKind
    /** Return the OpenAI ToolDefinition schema */
    getSchema(): ToolDefinition
    /** Build an invocation from raw JSON arguments string */
    build(rawArgs: string, context: ToolContext): ToolInvocation<TParams>
}

// ─── Scheduler State Types ──────────────────────────────────────────
// Mirrors gemini-cli's scheduler/types.ts — discriminated unions

export enum ToolCallStatus {
    Validating = 'validating',
    Scheduled = 'scheduled',
    AwaitingApproval = 'awaiting_approval',
    Executing = 'executing',
    Success = 'success',
    Error = 'error',
    Cancelled = 'cancelled',
}

export interface ToolCallInfo {
    /** The original tool call ID from the API response */
    callId: string
    /** Tool name */
    toolName: string
    /** Raw arguments JSON string */
    rawArgs: string
}

export interface ValidatingToolCall extends ToolCallInfo {
    status: ToolCallStatus.Validating
}

export interface ScheduledToolCall extends ToolCallInfo {
    status: ToolCallStatus.Scheduled
    invocation: ToolInvocation
    description: string
}

export interface AwaitingApprovalToolCall extends ToolCallInfo {
    status: ToolCallStatus.AwaitingApproval
    invocation: ToolInvocation
    description: string
}

export interface ExecutingToolCall extends ToolCallInfo {
    status: ToolCallStatus.Executing
    invocation: ToolInvocation
    description: string
}

export interface SuccessfulToolCall extends ToolCallInfo {
    status: ToolCallStatus.Success
    result: ToolResult
}

export interface ErroredToolCall extends ToolCallInfo {
    status: ToolCallStatus.Error
    error: string
}

export interface CancelledToolCall extends ToolCallInfo {
    status: ToolCallStatus.Cancelled
    reason: string
}

export type CompletedToolCall = SuccessfulToolCall | ErroredToolCall | CancelledToolCall
export type ActiveToolCall = ValidatingToolCall | ScheduledToolCall | AwaitingApprovalToolCall | ExecutingToolCall
export type AnyToolCall = ActiveToolCall | CompletedToolCall

// ─── Confirmation Outcome ────────────────────────────────────────────
// Mirrors gemini-cli's ToolConfirmationOutcome (packages/core/src/tools/tools.ts)

export enum ConfirmationOutcome {
    ProceedOnce = 'proceed_once',
    ProceedAlways = 'proceed_always',
    Cancel = 'cancel',
}

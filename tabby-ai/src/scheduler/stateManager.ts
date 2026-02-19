/**
 * Scheduler state manager — manages the queue of tool calls and their state transitions.
 *
 * Mirrors gemini-cli's SchedulerStateManager
 * (packages/core/src/scheduler/state-manager.ts)
 *
 * State machine: Validating → Scheduled → Executing → Success/Error/Cancelled
 *                                       ↓
 *                                AwaitingApproval
 */

import {
    ToolCallInfo,
    ToolCallStatus,
    ValidatingToolCall,
    ScheduledToolCall,
    AwaitingApprovalToolCall,
    ExecutingToolCall,
    SuccessfulToolCall,
    ErroredToolCall,
    CancelledToolCall,
    CompletedToolCall,
    AnyToolCall,
    ToolInvocation,
    ToolResult,
} from '../tools/types'

export class SchedulerStateManager {
    private calls: AnyToolCall[] = []

    /** Add a new tool call in Validating state */
    enqueue (info: ToolCallInfo): ValidatingToolCall {
        const call: ValidatingToolCall = {
            ...info,
            status: ToolCallStatus.Validating,
        }
        this.calls.push(call)
        return call
    }

    /** Transition to Scheduled state */
    updateToScheduled (callId: string, invocation: ToolInvocation, description: string): ScheduledToolCall {
        const idx = this.findIndex(callId)
        const call: ScheduledToolCall = {
            ...this.calls[idx],
            status: ToolCallStatus.Scheduled,
            invocation,
            description,
        }
        this.calls[idx] = call
        return call
    }

    /** Transition to AwaitingApproval state */
    updateToAwaitingApproval (callId: string): AwaitingApprovalToolCall {
        const idx = this.findIndex(callId)
        const prev = this.calls[idx] as ScheduledToolCall
        const call: AwaitingApprovalToolCall = {
            ...prev,
            status: ToolCallStatus.AwaitingApproval,
        }
        this.calls[idx] = call
        return call
    }

    /** Transition to Executing state */
    updateToExecuting (callId: string): ExecutingToolCall {
        const idx = this.findIndex(callId)
        const prev = this.calls[idx] as ScheduledToolCall | AwaitingApprovalToolCall
        const call: ExecutingToolCall = {
            ...prev,
            status: ToolCallStatus.Executing,
        }
        this.calls[idx] = call
        return call
    }

    /** Finalize as Success */
    finalizeSuccess (callId: string, result: ToolResult): SuccessfulToolCall {
        const idx = this.findIndex(callId)
        const call: SuccessfulToolCall = {
            callId: this.calls[idx].callId,
            toolName: this.calls[idx].toolName,
            rawArgs: this.calls[idx].rawArgs,
            status: ToolCallStatus.Success,
            result,
        }
        this.calls[idx] = call
        return call
    }

    /** Finalize as Error */
    finalizeError (callId: string, error: string): ErroredToolCall {
        const idx = this.findIndex(callId)
        const call: ErroredToolCall = {
            callId: this.calls[idx].callId,
            toolName: this.calls[idx].toolName,
            rawArgs: this.calls[idx].rawArgs,
            status: ToolCallStatus.Error,
            error,
        }
        this.calls[idx] = call
        return call
    }

    /** Finalize as Cancelled */
    finalizeCancelled (callId: string, reason: string): CancelledToolCall {
        const idx = this.findIndex(callId)
        const call: CancelledToolCall = {
            callId: this.calls[idx].callId,
            toolName: this.calls[idx].toolName,
            rawArgs: this.calls[idx].rawArgs,
            status: ToolCallStatus.Cancelled,
            reason,
        }
        this.calls[idx] = call
        return call
    }

    /** Cancel all queued (non-terminal) calls */
    cancelAllQueued (): void {
        for (let i = 0; i < this.calls.length; i++) {
            const call = this.calls[i]
            if (
                call.status === ToolCallStatus.Validating ||
                call.status === ToolCallStatus.Scheduled ||
                call.status === ToolCallStatus.AwaitingApproval
            ) {
                this.calls[i] = {
                    callId: call.callId,
                    toolName: call.toolName,
                    rawArgs: call.rawArgs,
                    status: ToolCallStatus.Cancelled,
                    reason: 'Batch cancelled',
                } as CancelledToolCall
            }
        }
    }

    /** Get all completed (terminal) calls */
    getCompletedCalls (): CompletedToolCall[] {
        return this.calls.filter(c =>
            c.status === ToolCallStatus.Success ||
            c.status === ToolCallStatus.Error ||
            c.status === ToolCallStatus.Cancelled,
        ) as CompletedToolCall[]
    }

    /** Get all calls (snapshot) */
    getSnapshot (): AnyToolCall[] {
        return [...this.calls]
    }

    /** Get scheduled calls (ready for execution) */
    getScheduledCalls (): ScheduledToolCall[] {
        return this.calls.filter(
            c => c.status === ToolCallStatus.Scheduled,
        ) as ScheduledToolCall[]
    }

    /** Clear all state for a new batch */
    clear (): void {
        this.calls = []
    }

    private findIndex (callId: string): number {
        const idx = this.calls.findIndex(c => c.callId === callId)
        if (idx === -1) {
            throw new Error(`Tool call ${callId} not found in state manager`)
        }
        return idx
    }
}

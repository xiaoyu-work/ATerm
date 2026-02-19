/**
 * Tool call scheduler — orchestrates tool execution with state machine.
 *
 * Mirrors gemini-cli's Scheduler
 * (packages/core/src/scheduler/scheduler.ts)
 *
 * Flow: validate → build invocations → partition (read-only/write)
 *       → execute read-only in parallel → execute write sequentially with confirmation
 *       → return completed calls
 */

import { ToolCallRequest } from '../streamEvents'
import { ToolRegistry } from '../tools/toolRegistry'
import {
    ToolContext,
    CompletedToolCall,
    ScheduledToolCall,
    ConfirmationOutcome,
    PolicyDecision,
} from '../tools/types'
import { SchedulerStateManager } from './stateManager'
import { ToolExecutor } from './toolExecutor'
import { checkPolicy, resolveConfirmation } from './confirmation'
import { MessageBus, MessageBusEvent } from '../messageBus'

export class Scheduler {
    private stateManager = new SchedulerStateManager()
    private executor = new ToolExecutor()

    constructor (
        private registry: ToolRegistry,
        private bus: MessageBus,
    ) {}

    /**
     * Schedule and execute a batch of tool calls.
     *
     * Mirrors gemini-cli's Scheduler.schedule():
     * 1. _startBatch(): Validate & build invocations
     * 2. _processQueue(): Partition into read-only (parallel) and write (sequential)
     * 3. _processToolCall(): checkPolicy → resolveConfirmation → _execute
     * 4. Return completed calls
     */
    async schedule (
        toolCalls: ToolCallRequest[],
        context: ToolContext,
    ): Promise<CompletedToolCall[]> {
        this.stateManager.clear()

        // === _startBatch(): Validate all tool calls ===
        const items = toolCalls.map(tc => ({
            callId: tc.id,
            toolName: tc.function.name,
            rawArgs: tc.function.arguments,
        }))

        for (const item of items) {
            this.stateManager.enqueue(item)
        }

        // Build invocations
        for (const item of items) {
            const builder = this.registry.get(item.toolName)
            if (!builder) {
                this.stateManager.finalizeError(item.callId, `Unknown tool: ${item.toolName}`)
                continue
            }

            try {
                const invocation = builder.build(item.rawArgs, context)
                const description = invocation.getDescription()
                this.stateManager.updateToScheduled(item.callId, invocation, description)
            } catch (err: any) {
                this.stateManager.finalizeError(item.callId, err.message)
            }
        }

        // === _processQueue(): Partition and execute ===
        const scheduled = this.stateManager.getScheduledCalls()

        // Read-only tools can run in parallel (no confirmation needed)
        const readOnlyCalls = scheduled.filter(c => !c.invocation.shouldConfirmExecute())
        const writeCalls = scheduled.filter(c => c.invocation.shouldConfirmExecute())

        // Execute read-only tools in parallel
        if (readOnlyCalls.length > 0 && !context.signal.aborted) {
            await Promise.all(
                readOnlyCalls.map(call => this.processToolCall(call, context)),
            )
        }

        // Execute write tools sequentially with confirmation
        for (const call of writeCalls) {
            if (context.signal.aborted) {
                this.stateManager.finalizeCancelled(call.callId, 'Aborted')
                continue
            }
            await this.processToolCall(call, context)
        }

        // Emit final update
        this.bus.emit(MessageBusEvent.TOOL_CALLS_UPDATE, this.stateManager.getSnapshot())

        return this.stateManager.getCompletedCalls()
    }

    /** Cancel all pending tool calls */
    cancelAll (): void {
        this.stateManager.cancelAllQueued()
    }

    /**
     * Process a single tool call through the full pipeline.
     *
     * Mirrors gemini-cli's Scheduler._processToolCall():
     * 1. checkPolicy → DENY/AUTO/ASK_USER
     * 2. If ASK_USER → resolveConfirmation
     * 3. If approved → _execute
     */
    private async processToolCall (
        call: ScheduledToolCall,
        context: ToolContext,
    ): Promise<void> {
        const { callId, invocation, description, toolName } = call

        // === Policy check ===
        const policy = checkPolicy(invocation)

        if (policy === PolicyDecision.Deny) {
            this.stateManager.finalizeCancelled(callId, 'Denied by policy')
            return
        }

        if (policy === PolicyDecision.AskUser) {
            this.stateManager.updateToAwaitingApproval(callId)

            const outcome = await resolveConfirmation(
                callId, toolName, description, this.bus,
            )

            if (outcome === ConfirmationOutcome.Cancel) {
                this.stateManager.finalizeCancelled(callId, 'User declined')
                return
            }
        }

        // === Execute ===
        this.stateManager.updateToExecuting(callId)
        const result = await this.executor.execute(invocation, context)

        if (result.error) {
            this.stateManager.finalizeError(callId, result.error)
        } else {
            this.stateManager.finalizeSuccess(callId, result)
        }
    }
}

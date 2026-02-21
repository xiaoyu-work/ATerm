/**
 * Tool call scheduler — orchestrates tool execution with policy + confirmation.
 *
 * Mirrors gemini-cli's CoreToolScheduler
 * (packages/core/src/scheduler/scheduler.ts)
 *
 * Flow: validate → build invocations → partition (auto/confirm)
 *       → execute auto-group in parallel
 *       → process confirm-group sequentially:
 *         getConfirmationDetails → checkPolicy → resolveConfirmation → updatePolicy → execute
 *       → return completed calls
 */

import { ToolCallRequest } from '../streamEvents'
import { ToolRegistry } from '../tools/toolRegistry'
import {
    ToolContext,
    CompletedToolCall,
    ScheduledToolCall,
    ConfirmationOutcome,
    MUTATOR_KINDS,
} from '../tools/types'
import { SchedulerStateManager } from './stateManager'
import { ToolExecutor } from './toolExecutor'
import { PolicyDecision, checkPolicy, updatePolicy } from './policy'
import { resolveConfirmation } from './confirmation'
import { MessageBus, MessageBusEvent } from '../messageBus'

export class Scheduler {
    private stateManager = new SchedulerStateManager()
    private executor = new ToolExecutor()
    private isProcessing = false
    private isCancelling = false
    private requestQueue: Array<{
        toolCalls: ToolCallRequest[]
        context: ToolContext
        resolve: (value: CompletedToolCall[]) => void
        reject: (reason?: Error) => void
    }> = []

    constructor (
        private registry: ToolRegistry,
        private bus: MessageBus,
    ) {}

    /**
     * Schedule and execute a batch of tool calls.
     *
     * Mirrors gemini-cli's CoreToolScheduler.schedule():
     * 1. _startBatch(): Validate & build invocations
     * 2. _processQueue(): Partition into auto (parallel) and confirm (sequential)
     * 3. _processToolCall(): getConfirmationDetails → checkPolicy → resolveConfirmation → execute
     * 4. Return completed calls
     */
    async schedule (
        toolCalls: ToolCallRequest[],
        context: ToolContext,
    ): Promise<CompletedToolCall[]> {
        if (this.isProcessing) {
            return this.enqueueRequest(toolCalls, context)
        }
        return this.startBatch(toolCalls, context)
    }

    private enqueueRequest (
        toolCalls: ToolCallRequest[],
        context: ToolContext,
    ): Promise<CompletedToolCall[]> {
        return new Promise<CompletedToolCall[]>((resolve, reject) => {
            const abortHandler = () => {
                const idx = this.requestQueue.findIndex(item => item.toolCalls === toolCalls)
                if (idx >= 0) {
                    this.requestQueue.splice(idx, 1)
                    reject(new Error('Tool call cancelled while in queue.'))
                }
            }

            if (context.signal.aborted) {
                reject(new Error('Operation cancelled'))
                return
            }

            context.signal.addEventListener('abort', abortHandler, { once: true })
            this.requestQueue.push({
                toolCalls,
                context,
                resolve: (result) => {
                    context.signal.removeEventListener('abort', abortHandler)
                    resolve(result)
                },
                reject: (err) => {
                    context.signal.removeEventListener('abort', abortHandler)
                    reject(err)
                },
            })
        })
    }

    private async startBatch (
        toolCalls: ToolCallRequest[],
        context: ToolContext,
    ): Promise<CompletedToolCall[]> {
        this.isProcessing = true
        this.isCancelling = false
        this.stateManager.clear()
        try {
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

            // Partition: tools that MIGHT need confirmation go to sequential group,
            // tools that definitely don't need confirmation run in parallel.
            //
            // Mirrors gemini-cli's partitioning of read-only vs write tools.
            const autoGroup: ScheduledToolCall[] = []
            const confirmGroup: ScheduledToolCall[] = []

            for (const call of scheduled) {
                const details = call.invocation.getConfirmationDetails(context)
                if (!details && !MUTATOR_KINDS.includes(call.invocation.kind)) {
                    autoGroup.push(call)
                } else {
                    confirmGroup.push(call)
                }
            }

            // Execute auto-group in parallel (no confirmation needed)
            if (autoGroup.length > 0 && !context.signal.aborted) {
                await Promise.all(
                    autoGroup.map(call => this.executeDirect(call, context)),
                )
            }

            // Execute confirm-group sequentially (may need user interaction)
            for (const call of confirmGroup) {
                if (context.signal.aborted) {
                    this.stateManager.finalizeCancelled(call.callId, 'Aborted')
                    continue
                }
                await this.processToolCall(call, context)
            }

            // Emit final update
            this.bus.emit(MessageBusEvent.TOOL_CALLS_UPDATE, this.stateManager.getSnapshot())
            return this.stateManager.getCompletedCalls()
        } finally {
            this.isProcessing = false
            this.processNextInQueue()
        }
    }

    /** Cancel all pending tool calls */
    cancelAll (): void {
        if (this.isCancelling) return
        this.isCancelling = true

        while (this.requestQueue.length > 0) {
            const next = this.requestQueue.shift()
            next?.reject(new Error('Operation cancelled by user'))
        }

        this.stateManager.cancelAllQueued()
    }

    private processNextInQueue (): void {
        if (this.isProcessing) return
        if (this.requestQueue.length === 0) return

        const next = this.requestQueue.shift()
        if (!next) return

        void this.startBatch(next.toolCalls, next.context)
            .then(next.resolve)
            .catch(err => next.reject(err instanceof Error ? err : new Error(String(err))))
    }

    /**
     * Process a single tool call through the full pipeline.
     *
     * Mirrors gemini-cli's CoreToolScheduler._processToolCall():
     * 1. getConfirmationDetails(context) → get structured details
     * 2. checkPolicy(details, invocation, pathApprovals) → DENY/AUTO/ASK_USER
     * 3. If ASK_USER → resolveConfirmation(callId, details, bus) → user responds
     * 4. updatePolicy(outcome, details, pathApprovals) → handle "always allow"
     * 5. execute(invocation, context)
     */
    private async processToolCall (
        call: ScheduledToolCall,
        context: ToolContext,
    ): Promise<void> {
        const { callId, invocation } = call

        // 1. Get confirmation details — re-computed each time because
        //    pathApprovals state may have changed from earlier approvals in this batch
        const details = invocation.getConfirmationDetails(context)

        // 2. Check policy
        const policy = checkPolicy(details, invocation, context.pathApprovals)

        if (policy === PolicyDecision.Deny) {
            this.stateManager.finalizeCancelled(callId, 'Denied by policy')
            return
        }

        if (policy === PolicyDecision.AskUser && details) {
            this.stateManager.updateToAwaitingApproval(callId)

            const confirmation = await resolveConfirmation(callId, details, this.bus)
            const outcome = confirmation.outcome

            if (outcome === ConfirmationOutcome.Cancel) {
                this.stateManager.finalizeCancelled(callId, 'User declined')
                return
            }

            let invocation = call.invocation
            if (confirmation.payload && typeof confirmation.payload.updatedArgs === 'object' && confirmation.payload.updatedArgs !== null) {
                const builder = this.registry.get(call.toolName)
                if (!builder) {
                    this.stateManager.finalizeError(callId, `Unknown tool: ${call.toolName}`)
                    return
                }
                try {
                    invocation = builder.build(JSON.stringify(confirmation.payload.updatedArgs), context)
                    const description = invocation.getDescription()
                    this.stateManager.updateToScheduled(callId, invocation, description)
                    call = { ...call, invocation, description }
                } catch (err: any) {
                    this.stateManager.finalizeError(callId, `Invalid modified args: ${err.message}`)
                    return
                }
            }

            // 3. Update policy — handle "always allow" transitions
            updatePolicy(outcome, details, context.pathApprovals)
        }

        // 4. Execute
        await this.executeDirect(call, context)
    }

    /**
     * Execute a tool call directly (no confirmation).
     */
    private async executeDirect (
        call: ScheduledToolCall,
        context: ToolContext,
    ): Promise<void> {
        this.stateManager.updateToExecuting(call.callId)
        const result = await this.executor.execute(call.invocation, context)

        if (result.error) {
            this.stateManager.finalizeError(call.callId, result.error)
        } else {
            this.stateManager.finalizeSuccess(call.callId, result)
        }
    }
}

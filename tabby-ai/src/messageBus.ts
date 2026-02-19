/**
 * RxJS-based MessageBus for cross-component communication.
 *
 * Mirrors gemini-cli's MessageBus (packages/core/src/confirmation-bus/message-bus.ts)
 * and MessageBusType (packages/core/src/confirmation-bus/types.ts).
 *
 * gemini-cli uses Node EventEmitter; we use RxJS Subject (Angular ecosystem).
 * Same interface: publish/emit, subscribe/on, request/once.
 */

import { Subject } from 'rxjs'
import { filter, map, take } from 'rxjs/operators'
import { firstValueFrom } from 'rxjs'
import { ConfirmationOutcome } from './tools/types'

// ─── Event Types ─────────────────────────────────────────────────────
// Mirrors gemini-cli's MessageBusType enum

export enum MessageBusEvent {
    /** Scheduler requests user confirmation for a tool call */
    TOOL_CONFIRMATION_REQUEST = 'tool_confirmation_request',
    /** UI responds with approval/denial */
    TOOL_CONFIRMATION_RESPONSE = 'tool_confirmation_response',
    /** Tool calls state update (for UI sync) */
    TOOL_CALLS_UPDATE = 'tool_calls_update',
    /** Tool requests free-text user input */
    ASK_USER_REQUEST = 'ask_user_request',
    /** UI responds with user's text */
    ASK_USER_RESPONSE = 'ask_user_response',
}

// ─── Payload Types ───────────────────────────────────────────────────

export interface ToolConfirmationRequest {
    callId: string
    toolName: string
    description: string
}

export interface ToolConfirmationResponse {
    callId: string
    outcome: ConfirmationOutcome
}

export interface AskUserRequest {
    requestId: string
    question: string
}

export interface AskUserResponse {
    requestId: string
    response: string
}

// ─── Bus Message ─────────────────────────────────────────────────────

interface BusMessage {
    type: MessageBusEvent
    payload: unknown
}

// ─── MessageBus ──────────────────────────────────────────────────────

export class MessageBus {
    private subject = new Subject<BusMessage>()

    /**
     * Publish a message to the bus.
     * Mirrors gemini-cli's messageBus.publish().
     */
    emit<T> (type: MessageBusEvent, payload: T): void {
        this.subject.next({ type, payload })
    }

    /**
     * Subscribe to messages of a specific type.
     * Returns a callback for the payload (not the full message).
     * Mirrors gemini-cli's messageBus.subscribe().
     */
    on<T> (type: MessageBusEvent, callback: (payload: T) => void): { unsubscribe: () => void } {
        const subscription = this.subject.pipe(
            filter(msg => msg.type === type),
            map(msg => msg.payload as T),
        ).subscribe(callback)

        return { unsubscribe: () => subscription.unsubscribe() }
    }

    /**
     * Wait for a single message of a specific type (one-shot).
     * Mirrors gemini-cli's awaitConfirmation() pattern.
     */
    once<T> (type: MessageBusEvent): Promise<T> {
        return firstValueFrom(
            this.subject.pipe(
                filter(msg => msg.type === type),
                map(msg => msg.payload as T),
                take(1),
            ),
        )
    }

    /**
     * Wait for a message matching a specific type and predicate.
     */
    waitFor<T> (type: MessageBusEvent, predicate: (payload: T) => boolean): Promise<T> {
        return firstValueFrom(
            this.subject.pipe(
                filter(msg => msg.type === type),
                map(msg => msg.payload as T),
                filter(predicate),
                take(1),
            ),
        )
    }

    /**
     * Clean up the bus.
     */
    destroy (): void {
        this.subject.complete()
    }
}

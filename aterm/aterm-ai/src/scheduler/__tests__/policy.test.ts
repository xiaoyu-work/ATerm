/**
 * Regression tests for scheduler approval scoping.
 *
 * Run with:
 * node --experimental-strip-types aterm\\aterm-ai\\src\\scheduler\\__tests__\\policy.test.ts
 */

import { PathApprovalTracker } from '../../tools/pathApprovals'
import { PolicyDecision, checkPolicy, updatePolicy } from '../policy'
import {
    ConfirmationDetails,
    ConfirmationOutcome,
    ToolInvocation,
    ToolKind,
    ToolResult,
} from '../../tools/types'

let passed = 0
let failed = 0

function assertDecision (description: string, actual: PolicyDecision, expected: PolicyDecision): void {
    if (actual === expected) {
        passed++
    } else {
        failed++
        console.error(`  FAIL: ${description}`)
        console.error(`    expected: ${expected}, got: ${actual}`)
    }
}

function section (name: string): void {
    console.log(`\n--- ${name} ---`)
}

const dummyInvocation: ToolInvocation = {
    params: {},
    kind: ToolKind.Edit,
    getDescription: () => 'dummy invocation',
    getConfirmationDetails: () => false,
    execute: async (): Promise<ToolResult> => ({ llmContent: 'ok' }),
}

const editDetails: ConfirmationDetails = {
    type: 'edit',
    title: 'Edit file',
    filePath: 'src/example.ts',
}

const pathDetails: ConfirmationDetails = {
    type: 'path_access',
    title: 'Read outside cwd',
    resolvedPath: 'C:\\outside\\file.txt',
}

section('Edit approvals are session scoped')
{
    const sessionA = new PathApprovalTracker()
    const sessionB = new PathApprovalTracker()

    assertDecision(
        'fresh session asks before edit',
        checkPolicy(editDetails, dummyInvocation, sessionA),
        PolicyDecision.AskUser,
    )

    updatePolicy(ConfirmationOutcome.ProceedAlways, editDetails, sessionA)

    assertDecision(
        'same session auto-approves edit after always allow',
        checkPolicy(editDetails, dummyInvocation, sessionA),
        PolicyDecision.Auto,
    )

    assertDecision(
        'different session still asks before edit',
        checkPolicy(editDetails, dummyInvocation, sessionB),
        PolicyDecision.AskUser,
    )
}

section('Proceed once does not persist')
{
    const session = new PathApprovalTracker()
    updatePolicy(ConfirmationOutcome.ProceedOnce, editDetails, session)

    assertDecision(
        'proceed once keeps future edits gated',
        checkPolicy(editDetails, dummyInvocation, session),
        PolicyDecision.AskUser,
    )
}

section('Path approval remains independent from edit approval')
{
    const pathSession = new PathApprovalTracker()
    updatePolicy(ConfirmationOutcome.ProceedAlways, pathDetails, pathSession)

    assertDecision(
        'path approval auto-approves future path access',
        checkPolicy(pathDetails, dummyInvocation, pathSession),
        PolicyDecision.Auto,
    )

    assertDecision(
        'path approval does not auto-approve edits',
        checkPolicy(editDetails, dummyInvocation, pathSession),
        PolicyDecision.AskUser,
    )
}

section('Edit approval remains independent from path approval')
{
    const editSession = new PathApprovalTracker()
    updatePolicy(ConfirmationOutcome.ProceedAlways, editDetails, editSession)

    assertDecision(
        'edit approval auto-approves future edits',
        checkPolicy(editDetails, dummyInvocation, editSession),
        PolicyDecision.Auto,
    )

    assertDecision(
        'edit approval does not auto-approve path access',
        checkPolicy(pathDetails, dummyInvocation, editSession),
        PolicyDecision.AskUser,
    )
}

console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
    console.log('SOME TESTS FAILED')
    process.exit(1)
} else {
    console.log('ALL TESTS PASSED')
}

/**
 * Tool definitions barrel export and default registry factory.
 *
 * Mirrors gemini-cli's coreTools.ts createCoreTools() pattern
 * (packages/core/src/tools/definitions/coreTools.ts)
 */

import { ToolRegistry } from '../toolRegistry'
import { ShellTool } from './shellTool'
import { ReadFileTool } from './readFileTool'
import { WriteFileTool } from './writeFileTool'
import { EditTool } from './editTool'
import { ListDirectoryTool } from './listDirectoryTool'
import { GlobTool } from './globTool'
import { GrepTool } from './grepTool'
import { AskUserTool } from './askUserTool'
import { MemoryTool } from './memoryTool'
import { WriteTodosTool } from './writeTodosTool'
import { EnterPlanModeTool } from './enterPlanModeTool'
import { ExitPlanModeTool } from './exitPlanModeTool'

/**
 * Create a registry with all default tools registered.
 * Called once per AgentLoop instance.
 */
export function createDefaultRegistry (): ToolRegistry {
    const registry = new ToolRegistry()

    registry.register(new ShellTool())
    registry.register(new ReadFileTool())
    registry.register(new WriteFileTool())
    registry.register(new EditTool())
    registry.register(new ListDirectoryTool())
    registry.register(new GlobTool())
    registry.register(new GrepTool())
    registry.register(new AskUserTool())
    registry.register(new MemoryTool())
    registry.register(new WriteTodosTool())
    registry.register(new EnterPlanModeTool())
    registry.register(new ExitPlanModeTool())

    return registry
}

export {
    ShellTool,
    ReadFileTool,
    WriteFileTool,
    EditTool,
    ListDirectoryTool,
    GlobTool,
    GrepTool,
    AskUserTool,
    MemoryTool,
    WriteTodosTool,
    EnterPlanModeTool,
    ExitPlanModeTool,
}

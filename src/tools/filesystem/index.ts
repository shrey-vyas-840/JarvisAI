import type { AppConfig } from '../../config.js';
import type { ToolDefinition, ToolRegistry } from '../../core/tool-registry.js';
import { createGetFileInfoTool } from './get-file-info.js';
import { createListDirectoryTool } from './list-directory.js';
import { PathGuard } from './path-guard.js';
import { createReadTextFileTool } from './read-text-file.js';
import { createSearchTextTool } from './search-text.js';

export interface CreateFilesystemToolsOptions {
  readonly guard?: PathGuard;
}

export function createFilesystemTools(
  config: AppConfig,
  options: CreateFilesystemToolsOptions = {},
): ToolDefinition[] {
  const guard =
    options.guard ??
    new PathGuard({
      workspace: config.paths.workspace,
      exports: config.paths.exports,
    });

  return [
    createListDirectoryTool({ guard }),
    createReadTextFileTool({ guard }),
    createSearchTextTool({ guard }),
    createGetFileInfoTool({ guard }),
  ];
}

export function registerFilesystemTools(
  registry: ToolRegistry,
  config: AppConfig,
  options: CreateFilesystemToolsOptions = {},
): ToolDefinition[] {
  const tools = createFilesystemTools(config, options);

  for (const tool of tools) {
    registry.register(tool);
  }

  return tools;
}

export { createGetFileInfoTool } from './get-file-info.js';
export { createListDirectoryTool } from './list-directory.js';
export { createReadTextFileTool } from './read-text-file.js';
export { createSearchTextTool } from './search-text.js';
export { PathGuard, FilesystemError } from './path-guard.js';
export type { FilesystemErrorCode, PathGuardRoots, ResolvedPath, RootId } from './path-guard.js';

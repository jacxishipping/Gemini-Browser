import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExecutionTools } from './execution.js';
import { registerInteractionTools } from './interaction.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerNavigationTools } from './navigation.js';
import { registerPerceptionTools } from './perception.js';
import type { ToolContext } from './define.js';

export type { ToolContext } from './define.js';

export function registerAllTools(server: McpServer, context: ToolContext): void {
  registerLifecycleTools(server, context);
  registerNavigationTools(server, context);
  registerPerceptionTools(server, context);
  registerInteractionTools(server, context);
  registerExecutionTools(server, context);
}

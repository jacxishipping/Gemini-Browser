import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserManager } from '../browser-manager.js';
import { errorResult } from '../result.js';

export interface ToolContext {
  manager: BrowserManager;
}

export interface ToolSpec<Shape extends ZodRawShapeCompat> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  handler: (
    input: ShapeOutput<Shape>,
    context: ToolContext
  ) => Promise<CallToolResult> | CallToolResult;
}

/**
 * Registers a single tool and funnels all failures through the shared error
 * formatter, so clients always receive an `isError` result with a recovery hint
 * instead of an opaque protocol error.
 */
export function registerTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  context: ToolContext,
  spec: ToolSpec<Shape>
): void {
  // The SDK's callback type is a deferred conditional on the generic shape,
  // which TypeScript cannot relate to this helper's callback. The cast is safe:
  // input is validated by the SDK using the same schema before invocation.
  const callback = (async (input: ShapeOutput<Shape>): Promise<CallToolResult> => {
    try {
      return await spec.handler(input, context);
    } catch (error) {
      return errorResult(error);
    }
  }) as unknown as ToolCallback<Shape>;

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.annotations ? { annotations: spec.annotations } : {})
    },
    callback
  );
}

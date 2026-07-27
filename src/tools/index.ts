import { connectCompanyTool } from "./connect_company.js";
import { disconnectCompanyTool } from "./disconnect_company.js";
import { getDevicesTool } from "./get_devices.js";
import { getSensorHistoryTool } from "./get_sensor_history.js";
import { getWeatherTool } from "./get_weather.js";
import { companyInfoTool } from "./company_info.js";
import { healthcheckTool } from "./healthcheck.js";
import type { ToolResult } from "../types/index.js";
import { logger, auditLog } from "../logger/index.js";
import { sessionManager } from "../sessions/manager.js";

/**
 * Definición de un Tool MCP.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Registro centralizado de tools.
 * Para agregar un nuevo tool, solo importar y agregar al array.
 */
export const tools: McpToolDefinition[] = [
  connectCompanyTool as unknown as McpToolDefinition,
  disconnectCompanyTool as unknown as McpToolDefinition,
  getDevicesTool as unknown as McpToolDefinition,
  getSensorHistoryTool as unknown as McpToolDefinition,
  getWeatherTool as unknown as McpToolDefinition,
  companyInfoTool as unknown as McpToolDefinition,
  healthcheckTool as unknown as McpToolDefinition,
];

/**
 * Ejecuta un tool por nombre con logging y auditoría.
 */
export async function executeTool(
  name: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    return {
      content: [{ type: "text", text: `Herramienta "${name}" no encontrada.` }],
      isError: true,
    };
  }

  const startTime = Date.now();
  const session = sessionManager.getActiveSession();

  try {
    logger.debug(`Tool call: ${name}`, { params: sanitizeParams(params) });

    const result = await tool.handler(params);

    const duration = Date.now() - startTime;
    auditLog(name, session?.sessionId ?? null, !result.isError, duration);

    return result;
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : "Error interno";

    logger.error(`Tool error: ${name}`, { error: message });
    auditLog(name, session?.sessionId ?? null, false, duration);

    return {
      content: [
        {
          type: "text",
          text: `Error al ejecutar "${name}": ${message}. Intenta de nuevo.`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Sanitiza parámetros para logging (oculta API Keys).
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...params };
  if (sanitized.api_key && typeof sanitized.api_key === "string") {
    sanitized.api_key = "***REDACTED***";
  }
  return sanitized;
}

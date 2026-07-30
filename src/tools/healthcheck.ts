import { apiClient } from "../api/client.js";
import { sessionManager } from "../sessions/manager.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult } from "../types/index.js";

export const healthcheckTool = {
  name: "qc_healthcheck",
  description:
    "Verifica el estado del servidor **QualityControl** MCP, la conectividad con la API y las estadísticas de sesión y caché.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },

  async handler(_params: Record<string, never>): Promise<ToolResult> {
    const apiReachable = await apiClient.healthcheck();
    const sessionStats = sessionManager.getStats();
    const cacheStats = cacheManager.stats();

    let text = "**Estado del Servidor MCP QualityControl**\n\n";

    text += `- **MCP Server:** ✅ Activo\n`;
    text += `- **API REST:** ${apiReachable ? "✅ Conectada" : "❌ No alcanzable"}\n`;
    text += `- **Sesiones activas:** ${sessionStats.active}\n`;
    text += `- **Sesiones expiradas:** ${sessionStats.expired}\n`;
    text += `- **Sesiones revocadas:** ${sessionStats.revoked}\n`;
    text += `- **Caché:** ${cacheStats.entries}/${cacheStats.maxEntries} entradas\n`;

    const session = sessionManager.getActiveSession();
    if (session) {
      text += `\n**Sesión actual:**\n`;
      text += `- Empresa: ${session.companyName ?? "N/A"}\n`;
      text += `- Estado: ${session.status}\n`;
      text += `- Expira: ${session.expiresAt}\n`;
    } else {
      text += `\nNo hay sesión activa actualmente.\n`;
    }

    return { content: [{ type: "text", text }] };
  },
};

import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, BinsData } from "../types/index.js";

export const getBinsTodayTool = {
  name: "get_bins_today",
  description:
    "Obtiene el conteo de bins recolectados en el día actual. " +
    "Puede filtrar por variedad. Muestra total y desglose.",
  inputSchema: {
    type: "object" as const,
    properties: {
      variedad: {
        type: "string",
        description: "Filtrar por variedad específica (ej: Santina, Lapins, Regina). Opcional.",
      },
    },
    required: [],
  },

  async handler(params: { variedad?: string }): Promise<ToolResult> {
    const session = sessionManager.getActiveSession();
    if (!session) {
      return {
        content: [
          { type: "text", text: "No hay empresa conectada. Usa connect_company primero." },
        ],
        isError: true,
      };
    }

    const apiKey = sessionManager.getApiKey(session.sessionId);
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Error al recuperar la sesión. Reconéctate." }],
        isError: true,
      };
    }

    const queryParams: Record<string, string> = { fecha: "hoy" };
    if (params.variedad) queryParams.variedad = params.variedad;

    const cacheKey = cacheManager.buildKey(session.sessionId, "bins", queryParams);
    const cached = cacheManager.get<BinsData>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: formatBins(cached, params.variedad) }] };
    }

    const response = await apiClient.get<BinsData>({
      endpoint: "api_clientes_bins.php",
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener bins: ${response.error}` }],
        isError: true,
      };
    }

    const bins = response.data;
    if (bins) {
      cacheManager.set(cacheKey, bins, 60); // Cache 1 minuto (datos cambian rápido)
    }

    return {
      content: [{ type: "text", text: formatBins(bins ?? { total: 0 }, params.variedad) }],
    };
  },
};

function formatBins(data: BinsData, variedad?: string): string {
  let text = "**Bins del día**\n\n";

  text += `- **Total:** ${data.total} bins\n`;

  if (variedad) {
    text += `- **Filtro:** ${variedad}\n`;
  }

  if (data.por_variedad && data.por_variedad.length > 0) {
    text += `\n**Desglose por variedad:**\n`;
    for (const item of data.por_variedad) {
      text += `- ${item.variedad}: ${item.cantidad} bins (${item.kilos.toLocaleString()} kg)\n`;
    }
  }

  return text;
}

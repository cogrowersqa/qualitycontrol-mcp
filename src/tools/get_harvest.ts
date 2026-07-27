import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, HarvestData } from "../types/index.js";

export const getHarvestTool = {
  name: "get_harvest",
  description:
    "Obtiene información de cosecha de la empresa. " +
    "Puede filtrar por variedad y fecha. Incluye kilos, bins, rendimiento y avance de temporada.",
  inputSchema: {
    type: "object" as const,
    properties: {
      variedad: {
        type: "string",
        description: "Filtrar por variedad (ej: Santina, Lapins, Regina). Opcional.",
      },
      fecha: {
        type: "string",
        description: "Fecha específica en formato YYYY-MM-DD. Opcional (muestra temporada completa si no se indica).",
      },
    },
    required: [],
  },

  async handler(params: { variedad?: string; fecha?: string }): Promise<ToolResult> {
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

    const queryParams: Record<string, string> = {};
    if (params.variedad) queryParams.variedad = params.variedad;
    if (params.fecha) queryParams.fecha = params.fecha;

    const cacheKey = cacheManager.buildKey(session.sessionId, "cosecha", queryParams);
    const cached = cacheManager.get<HarvestData>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: formatHarvest(cached) }] };
    }

    const response = await apiClient.get<HarvestData>({
      endpoint: "api_clientes_cosecha.php",
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener cosecha: ${response.error}` }],
        isError: true,
      };
    }

    const harvest = response.data;
    if (harvest) {
      cacheManager.set(cacheKey, harvest, 120); // Cache 2 minutos
    }

    return {
      content: [
        { type: "text", text: formatHarvest(harvest ?? { total_kilos: 0, total_bins: 0 }) },
      ],
    };
  },
};

function formatHarvest(data: HarvestData): string {
  let text = "**Información de Cosecha**\n\n";

  if (data.variedad) text += `- **Variedad:** ${data.variedad}\n`;
  if (data.temporada) text += `- **Temporada:** ${data.temporada}\n`;
  text += `- **Total acumulado:** ${data.total_kilos.toLocaleString()} kg en ${data.total_bins} bins\n`;

  if (data.kilos_hoy !== undefined) {
    text += `- **Hoy:** ${data.kilos_hoy.toLocaleString()} kg en ${data.bins_hoy ?? 0} bins\n`;
  }
  if (data.rendimiento_promedio !== undefined) {
    text += `- **Rendimiento promedio:** ${data.rendimiento_promedio.toFixed(1)} kg/bin\n`;
  }
  if (data.porcentaje_avance !== undefined) {
    text += `- **Avance de temporada:** ${data.porcentaje_avance.toFixed(1)}%\n`;
  }
  if (data.ultima_actualizacion) {
    text += `- **Última actualización:** ${data.ultima_actualizacion}\n`;
  }

  return text;
}

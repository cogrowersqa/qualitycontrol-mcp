import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, ExportsData } from "../types/index.js";

export const getExportsTool = {
  name: "get_exports",
  description:
    "Obtiene información de exportaciones de la empresa. " +
    "Puede filtrar por rango de fechas. Muestra kilos exportados y destinos.",
  inputSchema: {
    type: "object" as const,
    properties: {
      fecha_inicio: {
        type: "string",
        description: "Fecha de inicio en formato YYYY-MM-DD. Opcional.",
      },
      fecha_fin: {
        type: "string",
        description: "Fecha de fin en formato YYYY-MM-DD. Opcional.",
      },
    },
    required: [],
  },

  async handler(params: { fecha_inicio?: string; fecha_fin?: string }): Promise<ToolResult> {
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
    if (params.fecha_inicio) queryParams.desde = params.fecha_inicio;
    if (params.fecha_fin) queryParams.hasta = params.fecha_fin;

    const cacheKey = cacheManager.buildKey(session.sessionId, "exportaciones", queryParams);
    const cached = cacheManager.get<ExportsData>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: formatExports(cached) }] };
    }

    const response = await apiClient.get<ExportsData>({
      endpoint: "api_clientes_exportaciones.php",
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener exportaciones: ${response.error}` }],
        isError: true,
      };
    }

    const exports = response.data;
    if (exports) {
      cacheManager.set(cacheKey, exports, 300); // Cache 5 minutos
    }

    return {
      content: [
        { type: "text", text: formatExports(exports ?? { total_kilos: 0 }) },
      ],
    };
  },
};

function formatExports(data: ExportsData): string {
  let text = "**Exportaciones**\n\n";

  text += `- **Total exportado:** ${data.total_kilos.toLocaleString()} kg\n`;

  if (data.fecha_inicio || data.fecha_fin) {
    text += `- **Período:** ${data.fecha_inicio ?? "inicio"} a ${data.fecha_fin ?? "hoy"}\n`;
  }

  if (data.destinos && data.destinos.length > 0) {
    text += `\n**Por destino:**\n`;
    for (const destino of data.destinos) {
      text += `- ${destino.destino}: ${destino.kilos.toLocaleString()} kg\n`;
    }
  }

  return text;
}

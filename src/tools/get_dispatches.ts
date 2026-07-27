import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, Dispatch } from "../types/index.js";

export const getDispatchesTool = {
  name: "get_dispatches",
  description:
    "Obtiene información de despachos de la empresa. " +
    "Puede filtrar por estado: pendiente, completado o todos.",
  inputSchema: {
    type: "object" as const,
    properties: {
      estado: {
        type: "string",
        description: "Filtrar por estado: 'pendiente', 'completado' o 'todos'. Por defecto muestra todos.",
        enum: ["pendiente", "completado", "todos"],
      },
    },
    required: [],
  },

  async handler(params: { estado?: string }): Promise<ToolResult> {
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
    if (params.estado && params.estado !== "todos") {
      queryParams.estado = params.estado;
    }

    const cacheKey = cacheManager.buildKey(session.sessionId, "despachos", queryParams);
    const cached = cacheManager.get<Dispatch[]>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: formatDispatches(cached, params.estado) }] };
    }

    const response = await apiClient.get<Dispatch[]>({
      endpoint: "api_clientes_despachos.php",
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener despachos: ${response.error}` }],
        isError: true,
      };
    }

    const dispatches = response.data ?? [];
    cacheManager.set(cacheKey, dispatches, 120); // Cache 2 minutos

    return { content: [{ type: "text", text: formatDispatches(dispatches, params.estado) }] };
  },
};

function formatDispatches(dispatches: Dispatch[], estado?: string): string {
  if (dispatches.length === 0) {
    return `No se encontraron despachos${estado ? ` con estado "${estado}"` : ""}.`;
  }

  let text = `**Despachos** (${dispatches.length} registros)`;
  if (estado && estado !== "todos") text += ` — Estado: ${estado}`;
  text += `\n\n`;

  const totalKilos = dispatches.reduce((sum, d) => sum + (d.kilos ?? 0), 0);
  text += `**Total:** ${totalKilos.toLocaleString()} kg\n\n`;

  for (const dispatch of dispatches.slice(0, 15)) {
    const variedad = dispatch.variedad ? ` (${dispatch.variedad})` : "";
    text += `- **${dispatch.destino}**${variedad}: ${dispatch.kilos.toLocaleString()} kg — ${dispatch.estado} — ${dispatch.fecha}\n`;
  }

  if (dispatches.length > 15) {
    text += `\n... y ${dispatches.length - 15} despachos más.`;
  }

  return text;
}

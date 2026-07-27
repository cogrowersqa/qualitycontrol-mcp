import { sessionManager } from "../sessions/manager.js";
import { cacheManager } from "../cache/manager.js";
import { logger } from "../logger/index.js";
import type { ToolResult } from "../types/index.js";

export const disconnectCompanyTool = {
  name: "disconnect_company",
  description:
    "Desconecta la empresa actual y elimina la sesión. " +
    "Usar cuando el usuario quiere cerrar sesión o cambiar de empresa.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },

  async handler(_params: Record<string, never>): Promise<ToolResult> {
    const session = sessionManager.getActiveSession();

    if (!session) {
      return {
        content: [
          {
            type: "text",
            text: "No hay ninguna empresa conectada actualmente.",
          },
        ],
      };
    }

    const companyName = session.companyName;

    // Invalidar caché de la sesión
    cacheManager.invalidateSession(session.sessionId);

    // Revocar sesión
    sessionManager.disconnect(session.sessionId);

    logger.info(`Sesión desconectada (${session.deviceCount} dispositivos)`);

    return {
      content: [
        {
          type: "text",
          text:
            `✅ **Sesión cerrada correctamente.**\n\n` +
            (companyName ? `Empresa: ${companyName}\n` : "") +
            `Si deseas conectar otra empresa, proporciona una nueva API Key.`,
        },
      ],
    };
  },
};

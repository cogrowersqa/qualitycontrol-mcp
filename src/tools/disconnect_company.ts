import { sessionManager } from "../sessions/manager.js";
import { cacheManager } from "../cache/manager.js";
import { logger } from "../logger/index.js";
import { revokeAllTokens } from "../auth/token-store.js";
import type { ToolResult } from "../types/index.js";

export const disconnectCompanyTool = {
  name: "disconnect_company",
  description:
    "Desconecta la empresa actual y cierra sesión completamente. " +
    "Revoca tokens, limpia caché y fuerza re-autenticación. " +
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
    const sessionId = session.sessionId;

    logger.info(`=== DISCONNECT INICIADO (empresa: ${companyName}, session: ${sessionId}) ===`);

    // 1. Invalidar caché de la sesión
    cacheManager.invalidateSession(sessionId);
    logger.info(`Disconnect: Caché de sesión ${sessionId} invalidado`);

    // 2. Revocar TODAS las sesiones (garantiza limpieza total)
    sessionManager.disconnectAll();
    logger.info("Disconnect: Todas las sesiones revocadas");

    // 3. Revocar TODOS los tokens OAuth → fuerza re-auth en la siguiente request
    revokeAllTokens();
    logger.info("Disconnect: Todos los tokens revocados, re-auth flag activado");

    // 4. Limpiar todo el caché global (por seguridad)
    cacheManager.clear();
    logger.info("Disconnect: Caché global limpiado");

    logger.info("=== DISCONNECT COMPLETADO ===");

    return {
      content: [
        {
          type: "text",
          text:
            `✅ **Sesión cerrada completamente.**\n\n` +
            (companyName ? `Empresa desconectada: ${companyName}\n\n` : "") +
            `Se eliminaron:\n` +
            `- Token de acceso\n` +
            `- Sesión del servidor\n` +
            `- Caché de datos\n\n` +
            `Para iniciar sesión con otra empresa, dime "conectar" y se abrirá el formulario para ingresar la nueva API Key.`,
        },
      ],
    };
  },
};

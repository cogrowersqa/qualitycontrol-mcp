import { sessionManager } from "../sessions/manager.js";
import { cacheManager } from "../cache/manager.js";
import { logger } from "../logger/index.js";
import { revokeAllTokens } from "../auth/token-store.js";
import type { ToolResult } from "../types/index.js";

export const disconnectCompanyTool = {
  name: "qc_disconnect",
  description:
    "Desconecta la empresa actual del sistema **QualityControl** y cierra la sesión completamente. " +
    "Revoca tokens de QualityControl, limpia caché de QualityControl y fuerza re-autenticación. " +
    "Usar únicamente cuando el usuario quiere cerrar sesión en QualityControl o cambiar de empresa en QualityControl. " +
    "NO afecta otras aplicaciones como AgroClimate.",
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
            text: "No hay ninguna empresa conectada actualmente en QualityControl.",
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

    // 2. Revocar TODAS las sesiones
    sessionManager.disconnectAll();
    logger.info("Disconnect: Todas las sesiones revocadas");

    // 3. Revocar TODOS los tokens OAuth → fuerza re-auth en la siguiente request
    revokeAllTokens();
    logger.info("Disconnect: Todos los tokens revocados, re-auth flag activado");

    // 4. Limpiar todo el caché global
    cacheManager.clear();
    logger.info("Disconnect: Caché global limpiado");

    logger.info("=== DISCONNECT COMPLETADO ===");

    return {
      content: [
        {
          type: "text",
          text:
            `✅ **Sesión de QualityControl cerrada completamente.**\n\n` +
            (companyName ? `Empresa desconectada de QualityControl: ${companyName}\n\n` : "") +
            `Se eliminaron:\n` +
            `- Token de acceso de QualityControl\n` +
            `- Sesión del servidor QualityControl\n` +
            `- Caché de datos de QualityControl\n\n` +
            `Para iniciar sesión en QualityControl con otra empresa, dime "conectar en QualityControl" y se abrirá el formulario para ingresar la nueva API Key.`,
        },
      ],
    };
  },
};

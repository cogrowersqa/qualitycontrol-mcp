import { sessionManager } from "../sessions/manager.js";
import { cacheManager } from "../cache/manager.js";
import { logger } from "../logger/index.js";
import type { ToolResult } from "../types/index.js";

export const disconnectCompanyTool = {
  name: "qc_disconnect",
  description:
    "Cierra la sesión activa de QualityControl y limpia el caché del servidor. " +
    "Úsala para refrescar la conexión, limpiar datos en caché o cuando el usuario quiere reiniciar el contexto de QualityControl. " +
    "IMPORTANTE: si el conector fue configurado con un 'OAuth Client ID' (API key directa), Claude se reconectará automáticamente " +
    "a la misma empresa al usar cualquier herramienta. Para cambiar de empresa o cerrar sesión completamente, " +
    "el usuario debe ir a Configuración → Conectores → editar el conector y cambiar el OAuth Client ID. " +
    "NO afecta otras aplicaciones como AgroClimate.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },

  async handler(_params: Record<string, never>): Promise<ToolResult> {
    const session = sessionManager.getSession();

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

    // 2. Revocar SOLO la sesión del usuario actual (no afecta a otros usuarios)
    sessionManager.disconnectCurrent();
    logger.info("Disconnect: Sesión del usuario actual revocada");

    // 3. Limpiar caché
    cacheManager.clear();
    logger.info("Disconnect: Caché limpiado");

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

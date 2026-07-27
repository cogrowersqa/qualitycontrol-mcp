import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { logger } from "../logger/index.js";
import { revokeAllTokens } from "../auth/token-store.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, Device } from "../types/index.js";

export const connectCompanyTool = {
  name: "connect_company",
  description:
    "Conecta una empresa al sistema usando su API Key. " +
    "Normalmente la empresa se conecta automáticamente al iniciar la sesión (via OAuth). " +
    "Solo usar esta herramienta si se necesita reconectar o cambiar de empresa.",
  inputSchema: {
    type: "object" as const,
    properties: {
      api_key: {
        type: "string",
        description:
          "La API Key del cliente obtenida desde el Portal Web (sección 'API para Clientes'). " +
          "Si el usuario no la ha proporcionado, dejar vacío para abrir el formulario de autenticación.",
      },
    },
    required: [],
  },

  async handler(params: { api_key?: string }): Promise<ToolResult> {
    // Si ya hay una sesión activa y NO se proporcionó nueva key → informar
    if (sessionManager.hasActiveSession() && (!params.api_key || params.api_key.trim() === "")) {
      const session = sessionManager.getActiveSession();
      const desc = session?.companyName
        ? `empresa **${session.companyName}**`
        : `API Key (${session?.deviceCount ?? 0} dispositivos)`;
      return {
        content: [
          {
            type: "text",
            text: `Ya hay una sesión activa con la ${desc}.\n\n` +
              `Si deseas cambiar de empresa, usa "desconectar" primero y luego "conectar".`,
          },
        ],
      };
    }

    // Si no se proporcionó API Key → forzar re-autenticación OAuth completa
    if (!params.api_key || params.api_key.trim() === "") {
      // Limpiar todo estado anterior antes de re-auth
      sessionManager.disconnectAll();
      cacheManager.clear();
      revokeAllTokens();

      logger.info("connect_company sin API Key: limpieza total + re-autenticación OAuth");
      return {
        content: [
          {
            type: "text",
            text:
              "Se abrirá el formulario de autenticación para ingresar tu API Key.\n\n" +
              "Toda sesión anterior ha sido eliminada.",
          },
        ],
      };
    }

    const apiKey = params.api_key.trim();

    // Si hay sesión activa con OTRA empresa → desconectar primero
    if (sessionManager.hasActiveSession()) {
      const existingSession = sessionManager.getActiveSession();
      logger.info(`connect_company: Desconectando empresa anterior (${existingSession?.companyName}) para cambiar`);
      sessionManager.disconnectAll();
      cacheManager.clear();
    }

    // Validar la API Key contra la API
    logger.info("connect_company: Validando API Key...");
    const response = await apiClient.validateApiKey(apiKey);

    if (!response.success) {
      return {
        content: [
          {
            type: "text",
            text:
              `La API Key proporcionada no es válida o no tiene permisos.\n\n` +
              `Error: ${response.error ?? "Sin detalle"}\n\n` +
              `Verifica que copiaste correctamente la API Key desde el Portal Web.`,
          },
        ],
        isError: true,
      };
    }

    // Extraer información de la empresa desde respuesta real
    // La empresa viene dentro de cada dispositivo, no a nivel superior
    const devices = (response.dispositivos as Device[]) ?? (response.data as Device[]) ?? [];
    const companyName = devices.length > 0 ? devices[0].empresa : null;
    const userName = response.usuario ?? null;
    const role = response.rol ?? null;
    const deviceCount = response.total ?? devices.length;

    // Crear sesión
    sessionManager.connectCompany(
      apiKey,
      companyName,
      userName,
      role,
      deviceCount
    );

    logger.info(`connect_company: Empresa "${companyName}" conectada (${deviceCount} dispositivos)`);

    // Construir respuesta
    let responseText = "✅ **Empresa conectada correctamente.**\n\n";

    if (companyName) responseText += `- **Empresa:** ${companyName}\n`;
    if (userName) responseText += `- **Usuario:** ${userName}\n`;
    if (role) responseText += `- **Rol:** ${role}\n`;
    responseText += `- **Dispositivos:** ${deviceCount}\n`;
    responseText += `\nLa sesión está activa. Ya puedes consultar dispositivos, historial, clima y más.`;

    return {
      content: [{ type: "text", text: responseText }],
    };
  },
};

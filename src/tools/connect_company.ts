import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { logger } from "../logger/index.js";
import type { ToolResult, Device } from "../types/index.js";

export const connectCompanyTool = {
  name: "connect_company",
  description:
    "Conecta una empresa al sistema. Si no se proporciona API Key, solicita al usuario que la pegue. " +
    "Si se proporciona, valida la key contra la API y crea una sesión.",
  inputSchema: {
    type: "object" as const,
    properties: {
      api_key: {
        type: "string",
        description:
          "La API Key del cliente obtenida desde el Portal Web (sección 'API para Clientes'). " +
          "Si el usuario no la ha proporcionado, dejar vacío.",
      },
    },
    required: [],
  },

  async handler(params: { api_key?: string }): Promise<ToolResult> {
    // Si ya hay una sesión activa, informar
    if (sessionManager.hasActiveSession()) {
      const session = sessionManager.getActiveSession();
      const desc = session?.companyName
        ? `empresa **${session.companyName}**`
        : `API Key (${session?.deviceCount ?? 0} dispositivos)`;
      return {
        content: [
          {
            type: "text",
            text: `Ya hay una sesión activa con la ${desc}.\n` +
              `Si deseas cambiar de empresa, usa la herramienta disconnect_company primero.`,
          },
        ],
      };
    }

    // Si no se proporcionó API Key, solicitarla
    if (!params.api_key || params.api_key.trim() === "") {
      return {
        content: [
          {
            type: "text",
            text:
              "Para conectar tu empresa necesito tu API Key.\n\n" +
              "Puedes obtenerla desde el Portal Web en la sección **'API para Clientes'**.\n\n" +
              "Por favor, pega tu API Key aquí.",
          },
        ],
      };
    }

    const apiKey = params.api_key.trim();

    // Validar la API Key contra la API
    logger.info("Validando API Key...");
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
    // La API retorna: { ok, endpoint, total, dispositivos: [...] }
    const devices = (response.dispositivos as Device[]) ?? (response.data as Device[]) ?? [];
    const companyName = response.empresa ?? null;
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

    logger.info(`Empresa conectada (${deviceCount} dispositivos)`);

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

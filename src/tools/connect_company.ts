import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { logger } from "../logger/index.js";
import { getRequestApiKey } from "./request-context.js";
import type { ToolResult } from "../types/index.js";

type GenericRecord = Record<string, unknown>;

export const connectCompanyTool = {
  name: "qc_connect",
  description:
    "Conecta la empresa al sistema **QualityControl** usando la API Key configurada en el conector. " +
    "Usar cuando el usuario quiere iniciar sesión, verificar la conexión o reconectarse a QualityControl. " +
    "NO acepta API Keys como parámetro: la clave se configura en el conector de Claude, no en el chat. " +
    "Para cambiar de empresa hay que editar o eliminar el conector en Configuración → Conectores. " +
    "NO afecta otras aplicaciones como AgroClimate.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },

  async handler(_params: Record<string, never>): Promise<ToolResult> {
    // Si ya hay sesión activa PARA ESTE USUARIO → informar sin reconectar
    if (sessionManager.hasSession()) {
      const session = sessionManager.getSession();
      const desc = session?.companyName
        ? `**${session.companyName}**`
        : "empresa desconocida";
      return {
        content: [
          {
            type: "text",
            text:
              `Ya estás conectado a **QualityControl** con la empresa ${desc}.\n\n` +
              `Para cambiar de empresa, ve a Configuración → Conectores en Claude, elimina el conector actual y agrégalo nuevamente con la API Key de la nueva empresa.`,
          },
        ],
      };
    }

    // Obtener API key del contexto OAuth (inyectada por server.ts desde el token)
    const apiKey = getRequestApiKey();
    if (!apiKey) {
      return {
        content: [
          {
            type: "text",
            text:
              "No se encontró una API Key en la sesión de QualityControl.\n\n" +
              "Asegúrate de haber configurado el **OAuth Client ID** con tu API Key al agregar el conector en Claude.\n" +
              "Si usas el flujo con formulario, reconéctate desde Configuración → Conectores.",
          },
        ],
        isError: true,
      };
    }

    logger.info("qc_connect: Validando API Key desde token OAuth...");
    const response = await apiClient.validateApiKey(apiKey);

    if (!response.success) {
      return {
        content: [
          {
            type: "text",
            text:
              `La API Key del conector no es válida o no tiene permisos.\n\n` +
              `Error: ${response.error ?? "Sin detalle"}\n\n` +
              `Verifica la API Key en Configuración → Conectores → OAuth Client ID.`,
          },
        ],
        isError: true,
      };
    }

    const payload = response as unknown as GenericRecord;
    const meta = (payload.meta && typeof payload.meta === "object") ? payload.meta as GenericRecord : {};
    const data = Array.isArray(payload.data) ? payload.data as GenericRecord[] : [];

    const companyName = (
      typeof meta.empresa === "string" && meta.empresa.trim()
        ? meta.empresa.trim()
        : data.length > 0 && typeof data[0].empresa === "string"
          ? (data[0].empresa as string).trim()
          : null
    );

    const deviceCount = typeof meta.total === "number" ? meta.total : data.length;

    sessionManager.connectCompany(apiKey, companyName, null, null, deviceCount);
    logger.info(`qc_connect: Empresa "${companyName}" conectada (${deviceCount} registros)`);

    let responseText = "Empresa conectada correctamente a **QualityControl**.\n\n";
    if (companyName) responseText += `- Empresa: ${companyName}\n`;
    responseText += `- Registros disponibles: ${deviceCount}\n`;
    responseText += `\nSesión de QualityControl activa. Ya puedes consultar inspecciones y resúmenes de calidad.`;

    return {
      content: [{ type: "text", text: responseText }],
    };
  },
};
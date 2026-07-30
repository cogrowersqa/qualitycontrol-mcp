import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { logger } from "../logger/index.js";
import { revokeAllTokens } from "../auth/token-store.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult } from "../types/index.js";

type GenericRecord = Record<string, unknown>;

export const connectCompanyTool = {
  name: "qc_connect",
  description:
    "Conecta una empresa al sistema **QualityControl** usando su API Key. " +
    "Normalmente la empresa se conecta automáticamente al iniciar la sesión de QualityControl (via OAuth). " +
    "Solo usar esta herramienta si se necesita reconectar o cambiar de empresa en QualityControl. " +
    "NO afecta otras aplicaciones como AgroClimate.",
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
    // Si ya hay sesion activa y NO se proporciono nueva key -> informar
    if (sessionManager.hasActiveSession() && (!params.api_key || params.api_key.trim() === "")) {
      const session = sessionManager.getActiveSession();
      const desc = session?.companyName
        ? `empresa **${session.companyName}**`
        : `API Key (${session?.deviceCount ?? 0} registros)`;
      return {
        content: [
          {
            type: "text",
            text: `Ya hay una sesión activa en **QualityControl** con la ${desc}.\n\nSi deseas cambiar de empresa en QualityControl, usa "desconectar de QualityControl" primero y luego "conectar en QualityControl".`,
          },
        ],
      };
    }

    // Si no se proporciono API Key -> forzar re-autenticacion OAuth completa
    if (!params.api_key || params.api_key.trim() === "") {
      sessionManager.disconnectAll();
      cacheManager.clear();
      revokeAllTokens();
      logger.info("connect_company sin API Key: limpieza total + re-autenticacion OAuth");
      return {
        content: [
          {
            type: "text",
            text:
              "Se abrirá el formulario de autenticación de **QualityControl** para ingresar tu API Key.\n\n" +
              "Toda sesión anterior de QualityControl ha sido eliminada.",
          },
        ],
      };
    }

    const apiKey = params.api_key.trim();

    // Si hay sesion activa con OTRA empresa -> desconectar primero
    if (sessionManager.hasActiveSession()) {
      const existingSession = sessionManager.getActiveSession();
      logger.info(`connect_company: Desconectando empresa anterior (${existingSession?.companyName})`);
      sessionManager.disconnectAll();
      cacheManager.clear();
    }

    logger.info("connect_company: Validando API Key...");
    const response = await apiClient.validateApiKey(apiKey);

    if (!response.success) {
      return {
        content: [
          {
            type: "text",
            text: `La API Key proporcionada no es valida o no tiene permisos.\n\nError: ${response.error ?? "Sin detalle"}\n\nVerifica que copiaste correctamente la API Key desde el Portal Web.`,
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
    logger.info(`connect_company: Empresa "${companyName}" conectada (${deviceCount} registros)`);

    let responseText = "Empresa conectada correctamente a **QualityControl**.\n\n";
    if (companyName) responseText += `- Empresa: ${companyName}\n`;
    responseText += `- Registros disponibles: ${deviceCount}\n`;
    responseText += `\nSesión de QualityControl activa. Ya puedes consultar inspecciones y resúmenes de calidad.`;

    return {
      content: [{ type: "text", text: responseText }],
    };
  },
};

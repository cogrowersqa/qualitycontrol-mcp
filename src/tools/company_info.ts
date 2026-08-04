import { sessionManager } from "../sessions/manager.js";
import type { ToolResult } from "../types/index.js";

export const companyInfoTool = {
  name: "company_info",
  description:
    "Muestra la información de la empresa actualmente conectada. " +
    "Incluye nombre, usuario, rol, cantidad de dispositivos y estado de la sesión.",
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
            text: "No hay ninguna empresa conectada.\nUsa connect_company con tu API Key para comenzar.",
          },
        ],
      };
    }

    let text = "**Información de la Sesión Activa**\n\n";

    if (session.companyName) text += `- **Empresa:** ${session.companyName}\n`;
    if (session.userName) text += `- **Usuario:** ${session.userName}\n`;
    if (session.role) text += `- **Rol:** ${session.role}\n`;
    text += `- **Dispositivos:** ${session.deviceCount}\n`;
    text += `- **Sesión creada:** ${session.createdAt}\n`;
    text += `- **Último acceso:** ${session.lastAccess}\n`;
    text += `- **Expira:** ${session.expiresAt}\n`;
    text += `- **Estado:** ${session.status}\n`;

    return { content: [{ type: "text", text }] };
  },
};

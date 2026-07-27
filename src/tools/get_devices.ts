import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, Device } from "../types/index.js";

export const getDevicesTool = {
  name: "get_devices",
  description:
    "Obtiene la lista de dispositivos y sensores de la empresa conectada. " +
    "Retorna: código, nombre, campo, temperatura actual, humedad actual, " +
    "horas frío acumuladas, porciones frío acumuladas, coordenadas GPS (latitud/longitud) " +
    "y fecha de última conexión de cada dispositivo.",
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
            text: "No hay empresa conectada. Usa connect_company para conectar tu empresa primero.",
          },
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

    // Verificar caché
    const cacheKey = cacheManager.buildKey(session.sessionId, "dispositivos");
    const cached = cacheManager.get<Device[]>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: formatDevices(cached) }] };
    }

    // Llamar a la API
    const response = await apiClient.get<Device[]>({
      endpoint: "api_clientes_dispositivos.php",
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener dispositivos: ${response.error}` }],
        isError: true,
      };
    }

    // La API retorna dispositivos en campo "dispositivos"
    const devices = (response.dispositivos as Device[]) ?? (response.data as Device[]) ?? [];
    cacheManager.set(cacheKey, devices, 120); // Cache 2 minutos

    return { content: [{ type: "text", text: formatDevices(devices) }] };
  },
};

function formatDevices(devices: Device[]): string {
  if (devices.length === 0) {
    return "No se encontraron dispositivos registrados para tu empresa.";
  }

  let text = `**Dispositivos de la empresa (${devices.length} total):**\n\n`;

  for (const device of devices) {
    const campo = device.campo ? ` — Campo: ${device.campo}` : "";
    const temp = device.temperatura_actual !== null ? `${device.temperatura_actual}°C` : "N/A";
    const hum = device.humedad_actual !== null ? `${device.humedad_actual}%` : "N/A";
    const hf = device.horas_frio_acumuladas ?? "N/A";
    const pf = device.porciones_frio_acumuladas !== undefined
      ? Number(device.porciones_frio_acumuladas).toFixed(2)
      : "N/A";
    const lat = device.latitud ?? "N/A";
    const lon = device.longitud ?? "N/A";
    const conexion = device.fecha_ultima_conexion ?? "Sin conexión";

    text += `- **${device.nombre_dispositivo}** (${device.codigo_dispositivo})${campo}\n`;
    text += `  Temp: ${temp} | Hum: ${hum} | Horas frío: ${hf} | Porciones frío: ${pf}\n`;
    text += `  Ubicación: lat ${lat}, lon ${lon} | Última conexión: ${conexion}\n`;
  }

  return text;
}

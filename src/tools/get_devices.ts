import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, Device } from "../types/index.js";

export const getDevicesTool = {
  name: "get_devices",
  description:
    "Obtiene el estado actual de dispositivos y sensores de la empresa conectada. " +
    "Incluye análisis automático: resumen general, rankings (temperatura, humedad, horas frío, porciones frío), " +
    "estado de conexión, extremos geográficos y detalle por dispositivo.",
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

  // Extraer nombre de empresa del primer dispositivo
  const empresa = devices[0]?.empresa ?? "Empresa";
  const campos = Array.from(new Set(devices.map((d) => d.campo).filter((c): c is string => !!c))).sort();

  const withTemp = devices.filter((d) => d.temperatura_actual !== null);
  const withHum = devices.filter((d) => d.humedad_actual !== null);
  const withCoords = devices.filter((d) => d.latitud !== null && d.longitud !== null);

  const tempProm = withTemp.length > 0
    ? withTemp.reduce((acc, d) => acc + (d.temperatura_actual ?? 0), 0) / withTemp.length
    : null;
  const humProm = withHum.length > 0
    ? withHum.reduce((acc, d) => acc + (d.humedad_actual ?? 0), 0) / withHum.length
    : null;

  const masFrio = withTemp.length > 0
    ? [...withTemp].sort((a, b) => (a.temperatura_actual ?? 0) - (b.temperatura_actual ?? 0))[0]
    : null;
  const masCaliente = withTemp.length > 0
    ? [...withTemp].sort((a, b) => (b.temperatura_actual ?? 0) - (a.temperatura_actual ?? 0))[0]
    : null;
  const masHumedo = withHum.length > 0
    ? [...withHum].sort((a, b) => (b.humedad_actual ?? 0) - (a.humedad_actual ?? 0))[0]
    : null;
  const masSeco = withHum.length > 0
    ? [...withHum].sort((a, b) => (a.humedad_actual ?? 0) - (b.humedad_actual ?? 0))[0]
    : null;

  const topHorasFrio = [...devices].sort((a, b) => b.horas_frio_acumuladas - a.horas_frio_acumuladas)[0];
  const topPorciones = [...devices].sort((a, b) => b.porciones_frio_acumuladas - a.porciones_frio_acumuladas)[0];

  const withConnection = devices
    .filter((d) => !!d.fecha_ultima_conexion)
    .map((d) => ({
      device: d,
      date: new Date((d.fecha_ultima_conexion as string).replace(" ", "T")),
    }))
    .filter((x) => !Number.isNaN(x.date.getTime()));

  const ultimoConectado = withConnection.length > 0
    ? [...withConnection].sort((a, b) => b.date.getTime() - a.date.getTime())[0]
    : null;
  const masTiempoSinConexion = withConnection.length > 0
    ? [...withConnection].sort((a, b) => a.date.getTime() - b.date.getTime())[0]
    : null;

  const now = Date.now();
  const desconectados6h = withConnection.filter((x) => now - x.date.getTime() > 6 * 60 * 60 * 1000);

  const masNorte = withCoords.length > 0
    ? [...withCoords].sort((a, b) => (b.latitud ?? -Infinity) - (a.latitud ?? -Infinity))[0]
    : null;
  const masSur = withCoords.length > 0
    ? [...withCoords].sort((a, b) => (a.latitud ?? Infinity) - (b.latitud ?? Infinity))[0]
    : null;
  const masEste = withCoords.length > 0
    ? [...withCoords].sort((a, b) => (b.longitud ?? -Infinity) - (a.longitud ?? -Infinity))[0]
    : null;
  const masOeste = withCoords.length > 0
    ? [...withCoords].sort((a, b) => (a.longitud ?? Infinity) - (b.longitud ?? Infinity))[0]
    : null;

  let text = `**Dispositivos de ${empresa} (${devices.length} total):**\n\n`;

  text += `**Resumen general:**\n`;
  text += `- Empresa: ${empresa}\n`;
  text += `- Total dispositivos: ${devices.length}\n`;
  text += `- Campos: ${campos.length > 0 ? campos.join(", ") : "N/A"}\n`;
  if (tempProm !== null) text += `- Temperatura promedio actual: ${tempProm.toFixed(2)}°C\n`;
  if (humProm !== null) text += `- Humedad promedio actual: ${humProm.toFixed(2)}%\n`;
  text += `\n`;

  text += `**Rankings actuales:**\n`;
  if (masFrio) text += `- Más frío: ${masFrio.nombre_dispositivo} (${masFrio.temperatura_actual}°C)\n`;
  if (masCaliente) text += `- Más caliente: ${masCaliente.nombre_dispositivo} (${masCaliente.temperatura_actual}°C)\n`;
  if (masHumedo) text += `- Mayor humedad: ${masHumedo.nombre_dispositivo} (${masHumedo.humedad_actual}%)\n`;
  if (masSeco) text += `- Menor humedad: ${masSeco.nombre_dispositivo} (${masSeco.humedad_actual}%)\n`;
  if (topHorasFrio) text += `- Más horas frío: ${topHorasFrio.nombre_dispositivo} (${topHorasFrio.horas_frio_acumuladas})\n`;
  if (topPorciones) text += `- Más porciones frío: ${topPorciones.nombre_dispositivo} (${topPorciones.porciones_frio_acumuladas.toFixed(2)})\n`;
  text += `\n`;

  text += `**Conectividad:**\n`;
  if (ultimoConectado) {
    text += `- Último conectado: ${ultimoConectado.device.nombre_dispositivo} (${ultimoConectado.device.fecha_ultima_conexion})\n`;
  }
  if (masTiempoSinConexion) {
    text += `- Más tiempo sin conexión: ${masTiempoSinConexion.device.nombre_dispositivo} (${masTiempoSinConexion.device.fecha_ultima_conexion})\n`;
  }
  text += `- Sensores con más de 6h sin conexión: ${desconectados6h.length}\n\n`;

  text += `**Extremos geográficos:**\n`;
  if (masNorte) text += `- Más al norte: ${masNorte.nombre_dispositivo} (lat ${masNorte.latitud})\n`;
  if (masSur) text += `- Más al sur: ${masSur.nombre_dispositivo} (lat ${masSur.latitud})\n`;
  if (masEste) text += `- Más al este: ${masEste.nombre_dispositivo} (lon ${masEste.longitud})\n`;
  if (masOeste) text += `- Más al oeste: ${masOeste.nombre_dispositivo} (lon ${masOeste.longitud})\n`;
  text += `\n`;

  text += `**Detalle por dispositivo:**\n`;

  for (const device of devices) {
    const campo = device.campo ? ` — Campo: ${device.campo}` : "";
    const temp = device.temperatura_actual !== null ? `${device.temperatura_actual}°C` : "N/A";
    const hum = device.humedad_actual !== null ? `${device.humedad_actual}%` : "N/A";
    const hf = device.horas_frio_acumuladas ?? "N/A";
    const fechaHf = device.fecha_horas_frio ?? "N/A";
    const pf = device.porciones_frio_acumuladas !== undefined
      ? Number(device.porciones_frio_acumuladas).toFixed(2)
      : "N/A";
    const lat = device.latitud ?? "N/A";
    const lon = device.longitud ?? "N/A";
    const conexion = device.fecha_ultima_conexion ?? "Sin conexión";

    text += `- **${device.nombre_dispositivo}** (${device.codigo_dispositivo})${campo}\n`;
    text += `  Temp: ${temp} | Hum: ${hum} | Horas frío: ${hf} (desde ${fechaHf}) | Porciones frío: ${pf}\n`;
    text += `  Ubicación: lat ${lat}, lon ${lon} | Última conexión: ${conexion}\n`;
  }

  return text;
}

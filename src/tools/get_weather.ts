import { sessionManager } from "../sessions/manager.js";
import { getRequestApiKey } from "./request-context.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import { config } from "../config/index.js";
import type { ToolResult, WeatherData } from "../types/index.js";

export const getWeatherTool = {
  name: "get_weather",
  description:
    "Obtiene información climática actual y pronóstico para la ubicación de la empresa. " +
    "Incluye temperatura, humedad, viento y pronóstico.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ubicacion: {
        type: "string",
        description: "Ubicación específica a consultar (opcional, usa la ubicación principal si no se indica).",
      },
    },
    required: [],
  },

  async handler(params: { ubicacion?: string }): Promise<ToolResult> {
    // API key: fuente primaria = token OAuth (AsyncLocalStorage)
    const apiKey = getRequestApiKey();
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "No hay API Key en el contexto. Reconéctate desde Configuración → Conectores." }],
        isError: true,
      };
    }
    const session = sessionManager.getSession();

    const queryParams: Record<string, string> = {};
    if (params.ubicacion) queryParams.ubicacion = params.ubicacion;

    const cacheKeyId = session?.sessionId ?? apiKey.slice(-8);
    const cacheKey = cacheManager.buildKey(cacheKeyId, "clima", queryParams);
    const cached = cacheManager.get<WeatherData>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: formatWeather(cached) }] };
    }

    const response = await apiClient.get<WeatherData>({
      endpoint: config.API_WEATHER_ENDPOINT,
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener clima: ${response.error}` }],
        isError: true,
      };
    }

    const weather = (response.data as WeatherData | undefined) ?? (response as unknown as WeatherData);
    if (weather) {
      cacheManager.set(cacheKey, weather, 600); // Cache 10 minutos (clima cambia lento)
    }

    return { content: [{ type: "text", text: formatWeather(weather ?? {}) }] };
  },
};

function formatWeather(data: WeatherData): string {
  if (data.temperatura === undefined && data.humedad === undefined) {
    return "No hay datos climáticos disponibles en este momento.";
  }

  let text = "**Información Climática**\n\n";

  if (data.ubicacion) text += `📍 **Ubicación:** ${data.ubicacion}\n`;
  if (data.fecha) text += `🕐 **Fecha:** ${data.fecha}\n`;
  if (data.temperatura !== undefined) text += `🌡️ **Temperatura:** ${data.temperatura}°C\n`;
  if (data.humedad !== undefined) text += `💧 **Humedad:** ${data.humedad}%\n`;
  if (data.viento !== undefined) text += `💨 **Viento:** ${data.viento} km/h\n`;
  if (data.presion !== undefined) text += `📊 **Presión:** ${data.presion} hPa\n`;
  if (data.pronostico) text += `\n📋 **Pronóstico:** ${data.pronostico}\n`;

  return text;
}

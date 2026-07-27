import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, HistoryEntry } from "../types/index.js";

/**
 * Cache de historial de 30 días por dispositivo.
 * Key: `${sessionId}:${dispositivo}` → HistoryEntry[]
 * TTL: 10 minutos (las mediciones se actualizan cada ~30 min)
 */
const HISTORY_CACHE_TTL = 600; // 10 minutos

export const getSensorHistoryTool = {
  name: "get_sensor_history",
  description:
    "Obtiene estadísticas de temperatura y humedad de un dispositivo. " +
    "Siempre consulta los últimos 30 días de la API y filtra según el período solicitado. " +
    "El LLM debe interpretar la pregunta del usuario y pasar fecha_desde y/o fecha_hasta para filtrar. " +
    "Si no se pasan fechas, muestra estadísticas de las últimas 24 horas por defecto.",
  inputSchema: {
    type: "object" as const,
    properties: {
      dispositivo: {
        type: "string",
        description: "Código del dispositivo a consultar (codigo_dispositivo). Obligatorio.",
      },
      fecha_desde: {
        type: "string",
        description:
          "Fecha/hora de inicio del filtro en formato ISO 8601 (YYYY-MM-DD o YYYY-MM-DD HH:mm). " +
          "Opcional. Si no se indica, se asumen las últimas 24 horas.",
      },
      fecha_hasta: {
        type: "string",
        description:
          "Fecha/hora de fin del filtro en formato ISO 8601 (YYYY-MM-DD o YYYY-MM-DD HH:mm). " +
          "Opcional. Si no se indica, se asume el momento actual.",
      },
    },
    required: ["dispositivo"],
  },

  async handler(params: {
    dispositivo: string;
    fecha_desde?: string;
    fecha_hasta?: string;
  }): Promise<ToolResult> {
    const session = sessionManager.getActiveSession();
    if (!session) {
      return {
        content: [
          { type: "text", text: "No hay empresa conectada. Usa connect_company primero." },
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

    // ─── 1. Obtener historial completo (30 días) — usar caché ────────────────
    const allEntries = await fetchFullHistory(session.sessionId, params.dispositivo, apiKey);

    if (allEntries === null) {
      return {
        content: [{ type: "text", text: "Error al obtener historial del dispositivo." }],
        isError: true,
      };
    }

    if (allEntries.length === 0) {
      return {
        content: [{ type: "text", text: "No hay lecturas disponibles para este dispositivo en los últimos 30 días." }],
      };
    }

    // ─── 2. Filtrar según el período solicitado ──────────────────────────────
    const now = new Date();
    const desde = params.fecha_desde
      ? parseUserDate(params.fecha_desde)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000); // últimas 24h
    const hasta = params.fecha_hasta
      ? parseUserDate(params.fecha_hasta, true)
      : now;

    const filtered = allEntries.filter((entry) => {
      const entryDate = new Date(entry.fecha.replace(" ", "T"));
      return entryDate >= desde && entryDate <= hasta;
    });

    // ─── 3. Calcular estadísticas y formatear ────────────────────────────────
    return {
      content: [
        {
          type: "text",
          text: formatStats(filtered, params.dispositivo, desde, hasta, allEntries.length),
        },
      ],
    };
  },
};

/**
 * Obtiene los 30 días de historial, usando caché si está disponible.
 */
async function fetchFullHistory(
  sessionId: string,
  dispositivo: string,
  apiKey: string
): Promise<HistoryEntry[] | null> {
  const cacheKey = cacheManager.buildKey(sessionId, "historial30d", { dispositivo });
  const cached = cacheManager.get<HistoryEntry[]>(cacheKey);

  if (cached) {
    return cached;
  }

  // Pedir los últimos 29 días (la API rechaza exactamente 30 por conteo inclusivo)
  const now = new Date();
  const daysBack = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);

  const fecha_desde = daysBack.toISOString().slice(0, 10);
  const fecha_hasta = now.toISOString().slice(0, 10);

  const response = await apiClient.get<HistoryEntry[]>({
    endpoint: "api_clientes_historial.php",
    params: { dispositivo, fecha_desde, fecha_hasta },
    apiKey,
  });

  if (!response.success) {
    return null;
  }

  const history =
    (response.lecturas as HistoryEntry[]) ??
    (response.historial as HistoryEntry[]) ??
    (response.data as HistoryEntry[]) ??
    [];

  // Cachear por 10 minutos
  cacheManager.set(cacheKey, history, HISTORY_CACHE_TTL);

  return history;
}

/**
 * Parsea una fecha del usuario. Acepta:
 * - YYYY-MM-DD
 * - YYYY-MM-DD HH:mm
 * - YYYY-MM-DDTHH:mm
 * Si es fecha fin (isEnd=true) y no tiene hora, se asume 23:59:59
 */
function parseUserDate(input: string, isEnd = false): Date {
  const trimmed = input.trim();

  // Si solo es fecha sin hora
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (isEnd) {
      return new Date(`${trimmed}T23:59:59`);
    }
    return new Date(`${trimmed}T00:00:00`);
  }

  // Con hora
  const normalized = trimmed.replace(" ", "T");
  return new Date(normalized);
}

/**
 * Formatea las estadísticas del período filtrado.
 */
function formatStats(
  entries: HistoryEntry[],
  dispositivo: string,
  desde: Date,
  hasta: Date,
  totalDisponibles: number
): string {
  const desdeStr = formatDateLocal(desde);
  const hastaStr = formatDateLocal(hasta);

  if (entries.length === 0) {
    return (
      `No se encontraron lecturas para **${dispositivo}** en el período solicitado.\n\n` +
      `- Período consultado: ${desdeStr} → ${hastaStr}\n` +
      `- Total de lecturas disponibles (30 días): ${totalDisponibles}`
    );
  }

  const temps = entries.map((e) => e.temperatura);
  const hums = entries.map((e) => e.humedad);

  const tempMin = Math.min(...temps);
  const tempMax = Math.max(...temps);
  const tempAvg = temps.reduce((a, b) => a + b, 0) / temps.length;

  const humMin = Math.min(...hums);
  const humMax = Math.max(...hums);
  const humAvg = hums.reduce((a, b) => a + b, 0) / hums.length;

  let text = `**Estadísticas — ${dispositivo}**\n`;
  text += `Período: ${desdeStr} → ${hastaStr}\n`;
  text += `Mediciones en período: ${entries.length}\n\n`;

  text += `**🌡️ Temperatura:**\n`;
  text += `- Mínima: ${tempMin.toFixed(2)}°C\n`;
  text += `- Máxima: ${tempMax.toFixed(2)}°C\n`;
  text += `- Promedio: ${tempAvg.toFixed(2)}°C\n\n`;

  text += `**💧 Humedad:**\n`;
  text += `- Mínima: ${humMin.toFixed(2)}%\n`;
  text += `- Máxima: ${humMax.toFixed(2)}%\n`;
  text += `- Promedio: ${humAvg.toFixed(2)}%\n\n`;

  // Mostrar últimas lecturas del período
  const recentCount = Math.min(entries.length, 5);
  text += `**Últimas ${recentCount} lecturas del período:**\n`;
  for (const entry of entries.slice(0, recentCount)) {
    text += `- ${entry.fecha}: ${entry.temperatura}°C | ${entry.humedad}%\n`;
  }

  if (entries.length > 5) {
    text += `\n_(${entries.length - 5} lecturas más disponibles en el período)_`;
  }

  return text;
}

function formatDateLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}


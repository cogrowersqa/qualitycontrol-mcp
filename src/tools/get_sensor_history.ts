import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import type { ToolResult, HistoryEntry, PorcionesFrioEntry } from "../types/index.js";

/**
 * Cache de historial de 30 días por dispositivo.
 * Key: `${sessionId}:${dispositivo}` → HistoryEntry[]
 * TTL: 10 minutos (las mediciones se actualizan cada ~30 min)
 */
const HISTORY_CACHE_TTL = 600; // 10 minutos

interface HistoryPayload {
  lecturas: HistoryEntry[];
  lecturasPorcionesFrio: PorcionesFrioEntry[];
  totalLecturas: number;
  totalLecturasPorcionesFrio: number;
  rango?: { fecha_desde: string; fecha_hasta: string };
}

export const getSensorHistoryTool = {
  name: "get_sensor_history",
  description:
    "Obtiene estadísticas de temperatura, humedad, horas frío y porciones frío de un dispositivo. " +
    "Siempre consulta los últimos 30 días de la API y filtra según el período solicitado. " +
    "Permite análisis en bloques horarios configurables (por ejemplo 3, 4, 5 o 24 horas). " +
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
          "También acepta: hoy, ayer, esta semana, semana pasada, este mes, mes pasado, este año, año pasado. " +
          "Opcional. Si no se indica, se asumen las últimas 24 horas.",
      },
      fecha_hasta: {
        type: "string",
        description:
          "Fecha/hora de fin del filtro en formato ISO 8601 (YYYY-MM-DD o YYYY-MM-DD HH:mm). " +
          "También acepta: hoy, ayer, esta semana, semana pasada, este mes, mes pasado, este año, año pasado. " +
          "Opcional. Si no se indica, se asume el momento actual.",
      },
      intervalo_horas: {
        type: "number",
        description:
          "Tamaño de bloque para análisis de porciones frío (en horas). " +
          "Ejemplos: 3, 4, 5, 24. Opcional. Por defecto: 3.",
      },
    },
    required: ["dispositivo"],
  },

  async handler(params: {
    dispositivo: string;
    fecha_desde?: string;
    fecha_hasta?: string;
    intervalo_horas?: number;
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
    const historyPayload = await fetchFullHistory(session.sessionId, params.dispositivo, apiKey);

    if (historyPayload === null) {
      return {
        content: [{ type: "text", text: "Error al obtener historial del dispositivo." }],
        isError: true,
      };
    }

    const allEntries = historyPayload.lecturas;
    const allPorciones = historyPayload.lecturasPorcionesFrio;

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

    const filteredPorciones = allPorciones.filter((entry) => {
      const entryDate = new Date(entry.fecha.replace(" ", "T"));
      return entryDate >= desde && entryDate <= hasta;
    });

    const intervaloHoras =
      typeof params.intervalo_horas === "number" && params.intervalo_horas >= 1
        ? Math.floor(params.intervalo_horas)
        : 3;

    // ─── 3. Calcular estadísticas y formatear ────────────────────────────────
    return {
      content: [
        {
          type: "text",
          text: formatStats(
            filtered,
            filteredPorciones,
            params.dispositivo,
            desde,
            hasta,
            historyPayload.totalLecturas,
            historyPayload.totalLecturasPorcionesFrio,
            intervaloHoras
          ),
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
): Promise<HistoryPayload | null> {
  const cacheKey = cacheManager.buildKey(sessionId, "historial30d", { dispositivo });
  const cached = cacheManager.get<HistoryPayload>(cacheKey);

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

  const rawPorciones = response.lecturas_porciones_frio as unknown;
  const lecturasPorcionesFrio = Array.isArray(rawPorciones)
    ? (rawPorciones as PorcionesFrioEntry[])
    : [];

  const payload: HistoryPayload = {
    lecturas: history,
    lecturasPorcionesFrio,
    totalLecturas: response.total_lecturas ?? history.length,
    totalLecturasPorcionesFrio: response.total_lecturas_porciones_frio ?? lecturasPorcionesFrio.length,
    rango: response.rango,
  };

  // Cachear por 10 minutos
  cacheManager.set(cacheKey, payload, HISTORY_CACHE_TTL);

  return payload;
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
  const normalizedText = trimmed.toLowerCase();

  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
  const startOfWeek = (d: Date) => {
    const base = new Date(d);
    const day = base.getDay();
    const diff = day === 0 ? -6 : 1 - day; // semana inicia lunes
    base.setDate(base.getDate() + diff);
    return startOfDay(base);
  };
  const endOfWeek = (d: Date) => {
    const s = startOfWeek(d);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return endOfDay(e);
  };

  if (normalizedText === "hoy") {
    return isEnd ? endOfDay(now) : startOfDay(now);
  }

  if (normalizedText === "ayer") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return isEnd ? endOfDay(y) : startOfDay(y);
  }

  if (normalizedText === "esta semana") {
    return isEnd ? endOfWeek(now) : startOfWeek(now);
  }

  if (normalizedText === "semana pasada") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return isEnd ? endOfWeek(d) : startOfWeek(d);
  }

  if (normalizedText === "este mes") {
    if (isEnd) {
      return endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    }
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  }

  if (normalizedText === "mes pasado") {
    const month = now.getMonth() - 1;
    if (isEnd) {
      return endOfDay(new Date(now.getFullYear(), month + 1, 0));
    }
    return new Date(now.getFullYear(), month, 1, 0, 0, 0);
  }

  if (normalizedText === "este año" || normalizedText === "este anio") {
    if (isEnd) {
      return endOfDay(new Date(now.getFullYear(), 11, 31));
    }
    return new Date(now.getFullYear(), 0, 1, 0, 0, 0);
  }

  if (normalizedText === "año pasado" || normalizedText === "anio pasado") {
    const year = now.getFullYear() - 1;
    if (isEnd) {
      return endOfDay(new Date(year, 11, 31));
    }
    return new Date(year, 0, 1, 0, 0, 0);
  }

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
  porcionesEntries: PorcionesFrioEntry[],
  dispositivo: string,
  desde: Date,
  hasta: Date,
  totalLecturasApi: number,
  totalLecturasPorcionesApi: number,
  intervaloHoras: number
): string {
  const desdeStr = formatDateLocal(desde);
  const hastaStr = formatDateLocal(hasta);

  if (entries.length === 0) {
    return (
      `No se encontraron lecturas para **${dispositivo}** en el período solicitado.\n\n` +
      `- Período consultado: ${desdeStr} → ${hastaStr}\n` +
      `- Total de lecturas disponibles (API): ${totalLecturasApi}\n` +
      `- Total de lecturas de porciones frío (API): ${totalLecturasPorcionesApi}`
    );
  }

  const temps = entries.map((e) => e.temperatura);
  const hums = entries.map((e) => e.humedad);
  const horasFrio = entries.map((e) => e.horas_frio ?? 0);

  const sortedTemps = [...temps].sort((a, b) => a - b);
  const sortedHums = [...hums].sort((a, b) => a - b);

  const tempMin = Math.min(...temps);
  const tempMax = Math.max(...temps);
  const tempAvg = temps.reduce((a, b) => a + b, 0) / temps.length;
  const tempMedian = sortedTemps.length % 2 === 0
    ? (sortedTemps[sortedTemps.length / 2 - 1] + sortedTemps[sortedTemps.length / 2]) / 2
    : sortedTemps[Math.floor(sortedTemps.length / 2)];
  const tempStd = Math.sqrt(temps.reduce((acc, t) => acc + ((t - tempAvg) ** 2), 0) / temps.length);

  const humMin = Math.min(...hums);
  const humMax = Math.max(...hums);
  const humAvg = hums.reduce((a, b) => a + b, 0) / hums.length;
  const humMedian = sortedHums.length % 2 === 0
    ? (sortedHums[sortedHums.length / 2 - 1] + sortedHums[sortedHums.length / 2]) / 2
    : sortedHums[Math.floor(sortedHums.length / 2)];
  const humStd = Math.sqrt(hums.reduce((acc, h) => acc + ((h - humAvg) ** 2), 0) / hums.length);

  const totalHorasFrio = horasFrio.reduce((a, b) => a + b, 0);
  const horasFrioMax = Math.max(...horasFrio);
  const horasFrioMin = Math.min(...horasFrio);

  const firstTemp = entries[entries.length - 1]?.temperatura;
  const lastTemp = entries[0]?.temperatura;
  const firstHum = entries[entries.length - 1]?.humedad;
  const lastHum = entries[0]?.humedad;
  const deltaTemp = firstTemp !== undefined && lastTemp !== undefined ? lastTemp - firstTemp : 0;
  const deltaHum = firstHum !== undefined && lastHum !== undefined ? lastHum - firstHum : 0;
  const trendTemp = deltaTemp > 0 ? "subiendo" : deltaTemp < 0 ? "bajando" : "estable";
  const trendHum = deltaHum > 0 ? "subiendo" : deltaHum < 0 ? "bajando" : "estable";

  let text = `**Estadísticas — ${dispositivo}**\n`;
  text += `Período: ${desdeStr} → ${hastaStr}\n`;
  text += `Mediciones en período: ${entries.length}\n`;
  text += `Total de lecturas disponibles (API): ${totalLecturasApi}\n\n`;

  text += `**🌡️ Temperatura:**\n`;
  text += `- Mínima: ${tempMin.toFixed(2)}°C\n`;
  text += `- Máxima: ${tempMax.toFixed(2)}°C\n`;
  text += `- Promedio: ${tempAvg.toFixed(2)}°C\n\n`;
  text += `- Mediana: ${tempMedian.toFixed(2)}°C\n`;
  text += `- Desviación estándar: ${tempStd.toFixed(2)}\n`;
  text += `- Amplitud térmica: ${(tempMax - tempMin).toFixed(2)}°C\n`;
  text += `- Tendencia período: ${trendTemp} (${deltaTemp >= 0 ? "+" : ""}${deltaTemp.toFixed(2)}°C)\n\n`;

  text += `**💧 Humedad:**\n`;
  text += `- Mínima: ${humMin.toFixed(2)}%\n`;
  text += `- Máxima: ${humMax.toFixed(2)}%\n`;
  text += `- Promedio: ${humAvg.toFixed(2)}%\n`;
  text += `- Mediana: ${humMedian.toFixed(2)}%\n`;
  text += `- Desviación estándar: ${humStd.toFixed(2)}\n`;
  text += `- Tendencia período: ${trendHum} (${deltaHum >= 0 ? "+" : ""}${deltaHum.toFixed(2)}%)\n\n`;

  if (totalHorasFrio > 0) {
    text += `**❄️ Horas frío:**\n`;
    text += `- Acumulado en período: ${totalHorasFrio}\n`;
    text += `- Máximo lectura: ${horasFrioMax}\n`;
    text += `- Mínimo lectura: ${horasFrioMin}\n\n`;
  }

  if (porcionesEntries.length > 0) {
    const porcionesActual = porcionesEntries[0]?.porciones_frio;
    const porcionesInicial = porcionesEntries[porcionesEntries.length - 1]?.porciones_frio;
    const porcionesMin = Math.min(...porcionesEntries.map((e) => e.porciones_frio));
    const porcionesMax = Math.max(...porcionesEntries.map((e) => e.porciones_frio));
    const deltaPorciones =
      porcionesActual !== undefined && porcionesInicial !== undefined
        ? porcionesActual - porcionesInicial
        : 0;
    text += `**🧊 Porciones frío:**\n`;
    if (porcionesActual !== undefined) {
      text += `- Valor actual: ${porcionesActual.toFixed(2)}\n`;
    }
    if (porcionesInicial !== undefined) {
      text += `- Valor inicial del período: ${porcionesInicial.toFixed(2)}\n`;
      text += `- Incremento en período: ${deltaPorciones >= 0 ? "+" : ""}${deltaPorciones.toFixed(2)}\n`;
    }
    text += `- Mínimo período: ${porcionesMin.toFixed(2)}\n`;
    text += `- Máximo período: ${porcionesMax.toFixed(2)}\n`;
    text += `- Lecturas porciones en período: ${porcionesEntries.length}\n`;
    text += `- Total lecturas porciones disponibles (API): ${totalLecturasPorcionesApi}\n\n`;

    const bloques = buildPorcionesBlocks(porcionesEntries, intervaloHoras);
    if (bloques.length > 0) {
      text += `**Bloques de ${intervaloHoras} horas (porciones frío):**\n`;
      for (const b of bloques) {
        const signo = b.incremento >= 0 ? "+" : "";
        text += `- ${b.inicio} → ${b.fin}: ${b.valorInicio.toFixed(2)} → ${b.valorFin.toFixed(2)} (${signo}${b.incremento.toFixed(2)})\n`;
      }

      const mayor = [...bloques].sort((a, b) => b.incremento - a.incremento)[0];
      const bloquesCero = bloques.filter((b) => Math.abs(b.incremento) < 1e-9).length;
      if (mayor) {
        const signoMayor = mayor.incremento >= 0 ? "+" : "";
        text += `\n- Mayor incremento (${intervaloHoras}h): ${mayor.inicio} → ${mayor.fin} (${signoMayor}${mayor.incremento.toFixed(2)})\n`;
        text += `- Bloques con incremento 0.00: ${bloquesCero} de ${bloques.length}\n\n`;
      }
    }
  }

  // Mostrar últimas lecturas del período
  const recentCount = Math.min(entries.length, 5);
  text += `**Últimas ${recentCount} lecturas del período:**\n`;
  for (const entry of entries.slice(0, recentCount)) {
    const hf = entry.horas_frio ? ` | HF: ${entry.horas_frio}` : "";
    text += `- ${entry.fecha}: ${entry.temperatura}°C | ${entry.humedad}%${hf}\n`;
  }

  if (entries.length > 5) {
    text += `\n_(${entries.length - 5} lecturas más disponibles en el período)_`;
  }

  if (porcionesEntries.length > 0) {
    const recentPorciones = porcionesEntries.slice(0, Math.min(porcionesEntries.length, 3));
    text += `\n\n**Últimas lecturas de porciones frío:**\n`;
    for (const p of recentPorciones) {
      text += `- ${p.fecha}: ${p.porciones_frio.toFixed(2)}\n`;
    }
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

function buildPorcionesBlocks(entries: PorcionesFrioEntry[], intervaloHoras: number): Array<{
  inicio: string;
  fin: string;
  valorInicio: number;
  valorFin: number;
  incremento: number;
}> {
  if (entries.length < 2) {
    return [];
  }

  // Orden cronológico ascendente
  const asc = [...entries].sort(
    (a, b) => new Date(a.fecha.replace(" ", "T")).getTime() - new Date(b.fecha.replace(" ", "T")).getTime()
  );

  const blocks: Array<{
    inicio: string;
    fin: string;
    valorInicio: number;
    valorFin: number;
    incremento: number;
  }> = [];

  const step = Math.max(1, Math.floor(intervaloHoras));

  for (let i = 0; i < asc.length - 1; i += step) {
    const start = asc[i];
    const endIndex = Math.min(i + step, asc.length - 1);
    const end = asc[endIndex];

    blocks.push({
      inicio: start.fecha,
      fin: end.fecha,
      valorInicio: start.porciones_frio,
      valorFin: end.porciones_frio,
      incremento: end.porciones_frio - start.porciones_frio,
    });
  }

  return blocks;
}


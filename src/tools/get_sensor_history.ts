import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import { logger } from "../logger/index.js";
import { config } from "../config/index.js";
import type { ToolResult, HistoryEntry, PorcionesFrioEntry } from "../types/index.js";

/**
 * Cache de historial por rango y dispositivo.
 * TTL: 10 minutos (las mediciones se actualizan cada ~30 min)
 */
const HISTORY_CACHE_TTL = 600; // 10 minutos

interface HistoryPayload {
  lecturas: HistoryEntry[];
  lecturasPorcionesFrio: PorcionesFrioEntry[];
  totalLecturas: number;
  totalLecturasPorcionesFrio: number;
  ventanasConsultadas: number;
  rango?: { fecha_desde: string; fecha_hasta: string };
}

interface HistoryFetchResult {
  payload: HistoryPayload | null;
  error?: string;
}

export const getSensorHistoryTool = {
  name: "get_sensor_history",
  description:
    "Obtiene estadísticas de temperatura, humedad, horas frío y porciones frío de un dispositivo. " +
    "Para rangos largos, consulta automáticamente la API en múltiples ventanas mensuales y consolida resultados. " +
    "Permite análisis en bloques horarios configurables (por ejemplo 3, 4, 5 o 24 horas). " +
    "Si el usuario pide detalle día por día, usar desglose_diario='si'. " +
    "Puede generar desglose mensual basado en lecturas reales del historial (no en totales agregados). " +
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
      desglose_mensual: {
        type: "string",
        description:
          "Si es 'si', agrega un desglose mensual calculado desde lecturas del historial. " +
          "Útil para preguntas como 'por mes', 'mayo vs junio', etc. Opcional.",
      },
      desglose_diario: {
        type: "string",
        description:
          "Si es 'si', agrega detalle por día (día por día) con métricas diarias e incremento de porciones. " +
          "Útil para preguntas como 'detallado', 'día por día' o 'sin resumen acumulado'. Opcional.",
      },
      mostrar_lecturas: {
        type: "string",
        description:
          "Si es 'si', incluye todas las lecturas individuales del período en la salida. " +
          "Útil para auditoría fila por fila. Opcional.",
      },
    },
    required: ["dispositivo"],
  },

  async handler(params: {
    dispositivo: string;
    fecha_desde?: string;
    fecha_hasta?: string;
    intervalo_horas?: number;
    desglose_mensual?: string;
    desglose_diario?: string;
    mostrar_lecturas?: string;
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

    // ─── 1. Definir rango solicitado ──────────────────────────────────────────
    const now = getNowInChile();
    const desde = params.fecha_desde
      ? parseUserDate(params.fecha_desde, false, now)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000); // últimas 24h
    let hasta = params.fecha_hasta
      ? parseUserDate(params.fecha_hasta, true, now)
      : now;

    // Nunca consultar al futuro: si el usuario cierra en un período vigente
    // (hoy/esta semana/este mes), se recorta a la hora actual de Chile.
    if (hasta.getTime() > now.getTime()) {
      hasta = now;
    }

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      return {
        content: [{
          type: "text",
          text:
            "Formato de fecha inválido. Usa `YYYY-MM-DD` (ej: 2026-06-01) o expresiones como: hoy, ayer, esta semana, mes pasado, último mes.",
        }],
        isError: true,
      };
    }

    if (desde > hasta) {
      return {
        content: [{ type: "text", text: "El rango es inválido: fecha_desde debe ser menor o igual a fecha_hasta." }],
        isError: true,
      };
    }

    // ─── 2. Obtener historial del rango (con chunking mensual si aplica) ─────
    const historyResult = await fetchHistoryForRange(
      session.sessionId,
      params.dispositivo,
      apiKey,
      desde,
      hasta,
      Boolean(params.fecha_hasta)
    );

    const historyPayload = historyResult.payload;

    if (historyPayload === null) {
      return {
        content: [{ type: "text", text: historyResult.error ?? "Error al obtener historial del dispositivo." }],
        isError: true,
      };
    }

    const allEntries = historyPayload.lecturas;
    const allPorciones = historyPayload.lecturasPorcionesFrio;

    if (allEntries.length === 0) {
      return {
        content: [{ type: "text", text: "No hay lecturas disponibles para este dispositivo en el período solicitado." }],
      };
    }

    // ─── 3. Filtrar estrictamente por rango (la API puede expandir límites) ──

    const desdeMs = toLocalEpochMs(desde);
    const hastaMs = toLocalEpochMs(hasta);

    const filtered = allEntries.filter((entry) => isWithinRange(entry.fecha, desdeMs, hastaMs));
    const filteredPorciones = allPorciones.filter((entry) => isWithinRange(entry.fecha, desdeMs, hastaMs));

    logger.info("history_filter_result", {
      dispositivo: params.dispositivo,
      requestedDesde: formatDateLocal(desde),
      requestedHasta: formatDateLocal(hasta),
      totalLecturasRaw: allEntries.length,
      totalLecturasFiltradas: filtered.length,
      totalPorcionesRaw: allPorciones.length,
      totalPorcionesFiltradas: filteredPorciones.length,
      ventanasConsultadas: historyPayload.ventanasConsultadas,
    });

    const intervaloHoras =
      typeof params.intervalo_horas === "number" && params.intervalo_horas >= 1
        ? Math.floor(params.intervalo_horas)
        : 3;

    const desgloseMensual = (params.desglose_mensual ?? "").trim().toLowerCase() === "si";
    const desgloseDiarioSolicitado = (params.desglose_diario ?? "").trim().toLowerCase() === "si";
    const mostrarLecturasSolicitado = (params.mostrar_lecturas ?? "").trim().toLowerCase() === "si";
    const rangoDias = Math.floor((hasta.getTime() - desde.getTime()) / (24 * 60 * 60 * 1000));
    const rangoHoras = (hasta.getTime() - desde.getTime()) / (60 * 60 * 1000);
    const rangoExplicito = Boolean(params.fecha_desde && params.fecha_hasta);
    // Si el usuario pide un rango explícito de más de 1 día, activar diario por defecto.
    const desgloseDiario = desgloseDiarioSolicitado || (rangoExplicito && rangoDias >= 1);
    // Para rangos cortos explícitos (por ejemplo un día), incluir lecturas completas automáticamente.
    const mostrarLecturasCompletas = mostrarLecturasSolicitado || (rangoExplicito && rangoHoras <= 36);

    // ─── 4. Calcular estadísticas y formatear ────────────────────────────────
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
            intervaloHoras,
            desgloseMensual,
            historyPayload.ventanasConsultadas,
            desgloseDiario,
            mostrarLecturasCompletas
          ),
        },
      ],
    };
  },
};

/**
 * Obtiene historial del rango solicitado.
 * Si el rango cruza más de un mes, divide automáticamente en ventanas mensuales
 * para respetar el límite de 31 días del endpoint.
 */
async function fetchHistoryForRange(
  sessionId: string,
  dispositivo: string,
  apiKey: string,
  desde: Date,
  hasta: Date,
  allowCache = true
): Promise<HistoryFetchResult> {
  const desdeKey = formatDateOnly(desde);
  const hastaKey = formatDateOnly(hasta);
  const cacheKey = cacheManager.buildKey(sessionId, "historialRango", {
    dispositivo,
    fecha_desde: desdeKey,
    fecha_hasta: hastaKey,
  });

  if (allowCache) {
    const cached = cacheManager.get<HistoryPayload>(cacheKey);
    if (cached) {
      return { payload: cached };
    }
  }

  const ventanas = splitRangeByMonth(desde, hasta);

  let history: HistoryEntry[] = [];
  let lecturasPorcionesFrio: PorcionesFrioEntry[] = [];

  for (const ventana of ventanas) {
    logger.info("history_window_request", {
      dispositivo,
      fecha_desde: formatDateOnly(ventana.desde),
      fecha_hasta: formatDateOnly(ventana.hasta),
    });

    const response = await apiClient.get<HistoryEntry[]>({
      endpoint: config.API_HISTORY_ENDPOINT,
      params: {
        dispositivo,
        fecha_desde: formatDateOnly(ventana.desde),
        fecha_hasta: formatDateOnly(ventana.hasta),
      },
      apiKey,
    });

    if (!response.success) {
      const errorMsg =
        `Error al obtener historial para ${dispositivo} en ` +
        `${formatDateOnly(ventana.desde)} → ${formatDateOnly(ventana.hasta)}: ` +
        `${response.error ?? "sin detalle"}`;

      logger.warn("history_window_failed", {
        dispositivo,
        fecha_desde: formatDateOnly(ventana.desde),
        fecha_hasta: formatDateOnly(ventana.hasta),
        error: response.error ?? "sin detalle",
      });

      return { payload: null, error: errorMsg };
    }

    const chunkHistory =
      (response.lecturas as HistoryEntry[]) ??
      (response.historial as HistoryEntry[]) ??
      (response.data as HistoryEntry[]) ??
      [];

    const rawPorciones = response.lecturas_porciones_frio as unknown;
    const chunkPorciones = Array.isArray(rawPorciones)
      ? (rawPorciones as PorcionesFrioEntry[])
      : [];

    logger.info("history_window_response", {
      dispositivo,
      fecha_desde: formatDateOnly(ventana.desde),
      fecha_hasta: formatDateOnly(ventana.hasta),
      lecturas: chunkHistory.length,
      porciones: chunkPorciones.length,
      apiTotalLecturas: response.total_lecturas,
      apiTotalPorciones: response.total_lecturas_porciones_frio,
      success: response.success,
    });

    history = history.concat(chunkHistory);
    lecturasPorcionesFrio = lecturasPorcionesFrio.concat(chunkPorciones);
  }

  history = dedupeHistoryEntries(history).sort(
    (a, b) => new Date(b.fecha.replace(" ", "T")).getTime() - new Date(a.fecha.replace(" ", "T")).getTime()
  );

  lecturasPorcionesFrio = dedupePorcionesEntries(lecturasPorcionesFrio).sort(
    (a, b) => new Date(b.fecha.replace(" ", "T")).getTime() - new Date(a.fecha.replace(" ", "T")).getTime()
  );

  const payload: HistoryPayload = {
    lecturas: history,
    lecturasPorcionesFrio,
    totalLecturas: history.length,
    totalLecturasPorcionesFrio: lecturasPorcionesFrio.length,
    ventanasConsultadas: ventanas.length,
    rango: {
      fecha_desde: `${desdeKey} 00:00:00`,
      fecha_hasta: `${hastaKey} 23:59:59`,
    },
  };

  // Evitar cachear payload vacío para no congelar falsos negativos transitorios.
  if (allowCache && (payload.lecturas.length > 0 || payload.lecturasPorcionesFrio.length > 0)) {
    cacheManager.set(cacheKey, payload, HISTORY_CACHE_TTL);
  }

  return { payload };
}

/**
 * Parsea una fecha del usuario. Acepta:
 * - YYYY-MM-DD
 * - YYYY-MM-DD HH:mm
 * - YYYY-MM-DDTHH:mm
 * Si es fecha fin (isEnd=true) y no tiene hora, se asume 23:59:59
 */
function parseUserDate(input: string, isEnd = false, nowRef?: Date): Date {
  const trimmed = input.trim();
  const normalizedText = normalizeDateExpression(trimmed);

  const now = nowRef ?? getNowInChile();
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
    return isEnd ? now : startOfDay(now);
  }

  if (normalizedText === "ayer") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return isEnd ? endOfDay(y) : startOfDay(y);
  }

  if (normalizedText === "esta semana") {
    return isEnd ? now : startOfWeek(now);
  }

  if (normalizedText === "semana pasada") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return isEnd ? endOfWeek(d) : startOfWeek(d);
  }

  if (normalizedText === "este mes") {
    if (isEnd) return now;
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  }

  if (normalizedText === "mes pasado") {
    const month = now.getMonth() - 1;
    if (isEnd) {
      return endOfDay(new Date(now.getFullYear(), month + 1, 0));
    }
    return new Date(now.getFullYear(), month, 1, 0, 0, 0);
  }

  if (
    normalizedText === "ultimo mes" ||
    normalizedText === "ultimos 30 dias" ||
    normalizedText === "ultimas 4 semanas"
  ) {
    if (isEnd) return now;
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return startOfDay(d);
  }

  if (normalizedText === "este año" || normalizedText === "este anio") {
    if (isEnd) return now;
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
    const [yRaw, mRaw, dRaw] = trimmed.split("-");
    const y = Number(yRaw);
    const m = Number(mRaw);
    const d = Number(dRaw);

    const isTodayInChile =
      y === now.getFullYear() &&
      m === now.getMonth() + 1 &&
      d === now.getDate();

    if (isEnd) {
      if (isTodayInChile) return now;
      return new Date(`${trimmed}T23:59:59`);
    }
    return new Date(`${trimmed}T00:00:00`);
  }

  // Si viene año-mes (YYYY-MM), asumir inicio/fin de ese mes
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const [yRaw, mRaw] = trimmed.split("-");
    const year = Number(yRaw);
    const monthIndex = Number(mRaw) - 1;
    if (isEnd) {
      return endOfDay(new Date(year, monthIndex + 1, 0));
    }
    return new Date(year, monthIndex, 1, 0, 0, 0);
  }

  // Con hora
  const normalized = trimmed.replace(" ", "T");
  return new Date(normalized);
}

function normalizeDateExpression(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Retorna la hora actual de Chile como Date "naive local" para alinear
 * el cálculo de rangos con fechas API sin zona horaria explícita.
 */
function getNowInChile(): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const map = new Map(parts.map((p) => [p.type, p.value]));
  const y = map.get("year") ?? "1970";
  const m = map.get("month") ?? "01";
  const d = map.get("day") ?? "01";
  const hh = map.get("hour") ?? "00";
  const mm = map.get("minute") ?? "00";
  const ss = map.get("second") ?? "00";

  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
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
  intervaloHoras: number,
  desgloseMensual: boolean,
  ventanasConsultadas: number,
  desgloseDiario: boolean,
  mostrarLecturasCompletas: boolean
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
  if (ventanasConsultadas > 1) {
    text += `_Consulta consolidada en ${ventanasConsultadas} ventanas mensuales por límite de 31 días._\n\n`;
  }

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

  if (desgloseDiario) {
    const resumenDias = buildDailyBreakdown(entries, porcionesEntries);
    if (resumenDias.length > 0) {
      text += `**📆 Detalle día por día:**\n`;
      for (const d of resumenDias) {
        text += `- ${d.dia}: ${d.lecturas} lecturas | Temp ${d.tempMin.toFixed(2)}°C .. ${d.tempMax.toFixed(2)}°C (prom ${d.tempProm.toFixed(2)}°C) | Hum prom ${d.humProm.toFixed(2)}% | Horas frío ${d.horasFrio.toFixed(2)}`;
        if (d.porcionesInicio !== null && d.porcionesFin !== null) {
          const delta = d.porcionesFin - d.porcionesInicio;
          const signo = delta >= 0 ? "+" : "";
          text += ` | Porciones ${d.porcionesInicio.toFixed(2)} → ${d.porcionesFin.toFixed(2)} (${signo}${delta.toFixed(2)})`;
        }
        text += "\n";
      }
      text += "\n";
    }
  }

  if (desgloseMensual) {
    const resumenMeses = buildMonthlyBreakdown(entries, porcionesEntries);

    if (resumenMeses.length > 0) {
      text += `**📅 Desglose mensual (desde lecturas reales):**\n`;
      for (const m of resumenMeses) {
        text += `- ${m.mes}: ${m.lecturas} lecturas | Temp prom ${m.tempProm.toFixed(2)}°C | Hum prom ${m.humProm.toFixed(2)}% | Horas frío acum ${m.horasFrio.toFixed(2)}`;
        if (m.porcionesInicio !== null && m.porcionesFin !== null) {
          const delta = m.porcionesFin - m.porcionesInicio;
          const signo = delta >= 0 ? "+" : "";
          text += ` | Porciones ${m.porcionesInicio.toFixed(2)} → ${m.porcionesFin.toFixed(2)} (${signo}${delta.toFixed(2)})`;
        }
        text += "\n";
      }
      text += "\n";
    }
  }

  if (mostrarLecturasCompletas) {
    text += `**Lecturas individuales del período (${entries.length}):**\n`;
    for (const entry of entries) {
      const hf = entry.horas_frio ? ` | HF: ${entry.horas_frio}` : "";
      text += `- ${entry.fecha}: ${entry.temperatura}°C | ${entry.humedad}%${hf}\n`;
    }
  } else {
    // Muestra parcial para evitar respuestas gigantes en rangos largos.
    const recentCount = Math.min(entries.length, 5);
    text += `**Últimas ${recentCount} lecturas del período (muestra parcial):**\n`;
    for (const entry of entries.slice(0, recentCount)) {
      const hf = entry.horas_frio ? ` | HF: ${entry.horas_frio}` : "";
      text += `- ${entry.fecha}: ${entry.temperatura}°C | ${entry.humedad}%${hf}\n`;
    }

    if (entries.length > 5) {
      text += `\n_Se recibieron ${entries.length} lecturas en total; para listar todas, usar mostrar_lecturas='si'._`;
    }
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

function buildMonthlyBreakdown(
  entries: HistoryEntry[],
  porcionesEntries: PorcionesFrioEntry[]
): Array<{
  mes: string;
  lecturas: number;
  tempProm: number;
  humProm: number;
  horasFrio: number;
  porcionesInicio: number | null;
  porcionesFin: number | null;
}> {
  const monthLabel = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  };

  const monthName = (month: string): string => {
    const [y, m] = month.split("-");
    const names = [
      "enero",
      "febrero",
      "marzo",
      "abril",
      "mayo",
      "junio",
      "julio",
      "agosto",
      "septiembre",
      "octubre",
      "noviembre",
      "diciembre",
    ];
    const idx = Number(m) - 1;
    return `${names[idx] ?? m} ${y}`;
  };

  const groupedHistory = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const d = new Date(e.fecha.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) continue;
    const key = monthLabel(d);
    const arr = groupedHistory.get(key) ?? [];
    arr.push(e);
    groupedHistory.set(key, arr);
  }

  const groupedPorciones = new Map<string, PorcionesFrioEntry[]>();
  for (const p of porcionesEntries) {
    const d = new Date(p.fecha.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) continue;
    const key = monthLabel(d);
    const arr = groupedPorciones.get(key) ?? [];
    arr.push(p);
    groupedPorciones.set(key, arr);
  }

  const keys = Array.from(groupedHistory.keys()).sort();
  const result: Array<{
    mes: string;
    lecturas: number;
    tempProm: number;
    humProm: number;
    horasFrio: number;
    porcionesInicio: number | null;
    porcionesFin: number | null;
  }> = [];

  for (const key of keys) {
    const rows = groupedHistory.get(key) ?? [];
    if (rows.length === 0) continue;

    const tempProm = rows.reduce((acc, r) => acc + r.temperatura, 0) / rows.length;
    const humProm = rows.reduce((acc, r) => acc + r.humedad, 0) / rows.length;
    const horasFrio = rows.reduce((acc, r) => acc + (r.horas_frio ?? 0), 0);

    const porRows = [...(groupedPorciones.get(key) ?? [])].sort(
      (a, b) => new Date(a.fecha.replace(" ", "T")).getTime() - new Date(b.fecha.replace(" ", "T")).getTime()
    );

    const porcionesInicio = porRows.length > 0 ? porRows[0].porciones_frio : null;
    const porcionesFin = porRows.length > 0 ? porRows[porRows.length - 1].porciones_frio : null;

    result.push({
      mes: monthName(key),
      lecturas: rows.length,
      tempProm,
      humProm,
      horasFrio,
      porcionesInicio,
      porcionesFin,
    });
  }

  return result;
}

function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function splitRangeByMonth(desde: Date, hasta: Date): Array<{ desde: Date; hasta: Date }> {
  const windows: Array<{ desde: Date; hasta: Date }> = [];

  let cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate(), 0, 0, 0);
  const end = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate(), 23, 59, 59);

  while (cursor <= end) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
    const chunkEnd = monthEnd < end ? monthEnd : end;

    windows.push({ desde: new Date(cursor), hasta: new Date(chunkEnd) });

    const next = new Date(chunkEnd);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    cursor = next;
  }

  return windows;
}

function dedupeHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const map = new Map<string, HistoryEntry>();
  for (const e of entries) {
    const key = `${e.codigo_dispositivo}|${e.fecha}`;
    if (!map.has(key)) {
      map.set(key, e);
    }
  }
  return Array.from(map.values());
}

function dedupePorcionesEntries(entries: PorcionesFrioEntry[]): PorcionesFrioEntry[] {
  const map = new Map<string, PorcionesFrioEntry>();
  for (const e of entries) {
    const key = `${e.codigo_dispositivo}|${e.fecha}`;
    if (!map.has(key)) {
      map.set(key, e);
    }
  }
  return Array.from(map.values());
}

function buildDailyBreakdown(
  entries: HistoryEntry[],
  porcionesEntries: PorcionesFrioEntry[]
): Array<{
  dia: string;
  lecturas: number;
  tempMin: number;
  tempMax: number;
  tempProm: number;
  humProm: number;
  horasFrio: number;
  porcionesInicio: number | null;
  porcionesFin: number | null;
}> {
  const dayLabel = (ms: number): string => {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const groupedHistory = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const ms = parseApiDateToLocalEpochMs(e.fecha);
    if (ms === null) continue;
    const key = dayLabel(ms);
    const arr = groupedHistory.get(key) ?? [];
    arr.push(e);
    groupedHistory.set(key, arr);
  }

  const groupedPorciones = new Map<string, PorcionesFrioEntry[]>();
  for (const p of porcionesEntries) {
    const ms = parseApiDateToLocalEpochMs(p.fecha);
    if (ms === null) continue;
    const key = dayLabel(ms);
    const arr = groupedPorciones.get(key) ?? [];
    arr.push(p);
    groupedPorciones.set(key, arr);
  }

  const keys = Array.from(groupedHistory.keys()).sort();
  const result: Array<{
    dia: string;
    lecturas: number;
    tempMin: number;
    tempMax: number;
    tempProm: number;
    humProm: number;
    horasFrio: number;
    porcionesInicio: number | null;
    porcionesFin: number | null;
  }> = [];

  for (const key of keys) {
    const rows = groupedHistory.get(key) ?? [];
    if (rows.length === 0) continue;

    const temps = rows.map((r) => r.temperatura);
    const tempMin = Math.min(...temps);
    const tempMax = Math.max(...temps);
    const tempProm = temps.reduce((acc, t) => acc + t, 0) / temps.length;
    const humProm = rows.reduce((acc, r) => acc + r.humedad, 0) / rows.length;
    const horasFrio = rows.reduce((acc, r) => acc + (r.horas_frio ?? 0), 0);

    const porRows = [...(groupedPorciones.get(key) ?? [])].sort((a, b) => {
      const aMs = parseApiDateToLocalEpochMs(a.fecha) ?? 0;
      const bMs = parseApiDateToLocalEpochMs(b.fecha) ?? 0;
      return aMs - bMs;
    });

    const porcionesInicio = porRows.length > 0 ? porRows[0].porciones_frio : null;
    const porcionesFin = porRows.length > 0 ? porRows[porRows.length - 1].porciones_frio : null;

    result.push({
      dia: key,
      lecturas: rows.length,
      tempMin,
      tempMax,
      tempProm,
      humProm,
      horasFrio,
      porcionesInicio,
      porcionesFin,
    });
  }

  return result;
}

function isWithinRange(rawFecha: string, desdeMs: number, hastaMs: number): boolean {
  const parsedMs = parseApiDateToLocalEpochMs(rawFecha);
  if (parsedMs !== null) {
    return parsedMs >= desdeMs && parsedMs <= hastaMs;
  }

  // Fallback: si no se puede parsear, no excluir por error de formato.
  return true;
}

function parseApiDateToLocalEpochMs(raw: string): number | null {
  const normalized = raw.trim().replace("T", " ");
  const m = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!m) {
    return null;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? "0");
  const minute = Number(m[5] ?? "0");
  const second = Number(m[6] ?? "0");

  const d = new Date(year, month - 1, day, hour, minute, second);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function toLocalEpochMs(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  ).getTime();
}


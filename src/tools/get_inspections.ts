import { sessionManager } from "../sessions/manager.js";
import { getRequestApiKey } from "./request-context.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import { config } from "../config/index.js";
import type { ToolResult } from "../types/index.js";

type InspectionRecord = Record<string, unknown>;

const PAGE_SIZE = 100;

/** Fecha local en zona horaria del servidor (offset configurable via TZ_OFFSET_HOURS). */
function localDate(): Date {
  const now = new Date();
  return new Date(now.getTime() + config.TZ_OFFSET_HOURS * 60 * 60 * 1000);
}

export const getInspectionsTool = {
  name: "qc_get_inspections",
  description:
    "Obtiene las planillas de control de calidad de **QualityControl** registradas en la empresa. " +
    "Incluye especie, variedad, campo, cuartel, cantidad muestreada, brix, calibre, color " +
    "y defectos de calidad y condición. " +
    "Si no se indica rango de fechas, usa por defecto el mes actual. " +
    "Muestra hasta 100 registros por página; usa offset para ver los siguientes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      desde: {
        type: "string",
        description: "Fecha inicial (YYYY-MM-DD). Por defecto: primer día del mes actual.",
      },
      hasta: {
        type: "string",
        description: "Fecha final (YYYY-MM-DD). Por defecto: hoy.",
      },
      offset: {
        type: "number",
        description: "Registro desde el que empezar (0 = primero). Usar para paginar: si hay más de 100, pasar offset=100 para el siguiente lote.",
      },
      decode_json: {
        type: "string",
        description:
          "Si es 'si', decodifica los campos JSON embebidos " +
          "(calibrepeso_row, brix_row, defecto_calidad_row, defecto_condicion_row). " +
          "Por defecto: 'si'.",
      },
    },
    required: [],
  },

  async handler(params: {
    desde?: string;
    hasta?: string;
    offset?: number;
    decode_json?: string;
  }): Promise<ToolResult> {
    // API key: fuente primaria = token OAuth (siempre disponible via AsyncLocalStorage)
    // No dependemos de que la sesión exista para tener la key.
    const apiKey = getRequestApiKey();
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "No hay API Key en el contexto. Reconéctate desde Configuración → Conectores." }],
        isError: true,
      };
    }
    // Sesión: opcional, usada para cacheKey y metadata
    const session = sessionManager.getSession();

    // Default: mes actual
    const defaults = getDefaultDateRange();
    const desde = params.desde?.trim() || defaults.desde;
    const hasta = params.hasta?.trim() || defaults.hasta;
    const offset = (typeof params.offset === "number" && params.offset >= 0) ? Math.floor(params.offset) : 0;

    const queryParams: Record<string, string> = { desde, hasta };

    // Clave de caché por rango (sin offset — cacheamos la respuesta completa del API)
    const cacheKeyId = session?.sessionId ?? apiKey.slice(-8);
    const cacheKey = cacheManager.buildKey(cacheKeyId, "inspecciones", queryParams);
    let payload = cacheManager.get<Record<string, unknown>>(cacheKey);

    if (!payload) {
      const response = await apiClient.get<Record<string, unknown>>({
        endpoint: config.API_DEVICES_ENDPOINT,
        params: queryParams,
        apiKey,
      });

      if (!response.success) {
        return {
          content: [{ type: "text", text: `Error al obtener inspecciones: ${response.error}` }],
          isError: true,
        };
      }

      const shouldDecodeJson = (params.decode_json ?? "si").trim().toLowerCase() === "si";
      payload = normalizePayload(response as unknown, shouldDecodeJson);
      cacheManager.set(cacheKey, payload, 120);
    }

    return { content: buildPayloadContent(payload, desde, hasta, offset) };
  },
};

function getDefaultDateRange(): { desde: string; hasta: string } {
  const now = localDate();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return { desde: `${y}-${m}-01`, hasta: `${y}-${m}-${d}` };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePayload(raw: unknown, decodeJson: boolean): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { data: [] };

  const payload = raw as Record<string, unknown>;
  const cloned: Record<string, unknown> = { ...payload };
  const data = extractDataArray(payload);
  cloned.data = decodeJson ? data.map(decodeEmbeddedJsonFields) : data;
  return cloned;
}

function extractDataArray(payload: Record<string, unknown>): InspectionRecord[] {
  const candidates = [payload.data, payload.planillas, payload.registros, payload.items];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((r): r is InspectionRecord => typeof r === "object" && r !== null);
    }
  }
  if (Array.isArray(payload)) return payload as InspectionRecord[];
  return [];
}

function decodeEmbeddedJsonFields(record: InspectionRecord): InspectionRecord {
  const out: InspectionRecord = { ...record };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { out[key] = JSON.parse(trimmed); } catch { /* keep original */ }
    }
  }
  return out;
}

function buildPayloadContent(
  payload: Record<string, unknown>,
  desde: string,
  hasta: string,
  offset: number
): Array<{ type: "text"; text: string }> {
  const meta = (typeof payload.meta === "object" && payload.meta !== null)
    ? payload.meta as Record<string, unknown>
    : {} as Record<string, unknown>;

  const allData = extractDataArray(payload);
  const total = typeof meta.total === "number" ? meta.total : allData.length;
  const empresa = getEmpresaFromData(allData) ?? "N/A";

  // Paginación client-side
  const page = allData.slice(offset, offset + PAGE_SIZE);
  const hasMore = offset + page.length < allData.length;
  const nextOffset = offset + page.length;

  const lines = [
    "**Planillas de Control de Calidad**",
    `Empresa: ${empresa} | Período: ${desde} → ${hasta}`,
    `Mostrando: ${offset + 1}–${offset + page.length} de ${total} registro(s) en este rango`,
  ];

  if (hasMore) {
    lines.push(`▶ Hay más registros → llama de nuevo con offset=${nextOffset}`);
  } else {
    lines.push("✅ Fin del listado para este período.");
  }

  // Resumen de especies del lote completo
  const especieMap = new Map<string, number>();
  for (const r of allData) {
    const esp = String(r.especie ?? "Sin especie");
    especieMap.set(esp, (especieMap.get(esp) ?? 0) + 1);
  }
  if (especieMap.size > 0) {
    lines.push("", "**Especies en el período:**");
    for (const [esp, count] of [...especieMap.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${esp}: ${count} planillas`);
    }
  }

  // Registros en JSON compacto (sin indentación)
  lines.push("", "**Registros:**");
  lines.push("```json");
  lines.push(JSON.stringify(page));
  lines.push("```");

  return [{ type: "text", text: lines.join("\n") }];
}

function getEmpresaFromData(data: InspectionRecord[]): string | null {
  if (data.length === 0) return null;
  const val = data[0].empresa;
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}



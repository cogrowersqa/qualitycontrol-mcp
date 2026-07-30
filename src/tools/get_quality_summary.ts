import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import { config } from "../config/index.js";
import type { ToolResult } from "../types/index.js";

type InspectionRecord = Record<string, unknown>;

export const getQualitySummaryTool = {
  name: "qc_get_quality_summary",
  description:
    "Analiza las planillas de **QualityControl** y genera un resumen estadístico. " +
    "Incluye desglose por especie y variedad, promedio de brix, distribución de calibres " +
    "y los defectos de calidad y condición más frecuentes. " +
    "Si no se indica rango de fechas, usa por defecto el mes actual.",
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
    },
    required: [],
  },

  async handler(params: {
    desde?: string;
    hasta?: string;
  }): Promise<ToolResult> {
    const session = sessionManager.getActiveSession();
    if (!session) {
      return {
        content: [{ type: "text", text: "No hay sesión activa. Llama a connect_company para iniciar sesión antes de obtener el resumen de calidad." }],
        isError: true,
      };
    }

    const apiKey = sessionManager.getApiKey(session.sessionId);
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Error de sesión. Reconéctate." }],
        isError: true,
      };
    }

    // Default: mes actual
    const defaults = getDefaultDateRange();
    const desde = params.desde?.trim() || defaults.desde;
    const hasta = params.hasta?.trim() || defaults.hasta;

    const queryParams: Record<string, string> = { desde, hasta };

    const cacheKey = cacheManager.buildKey(session.sessionId, "quality_summary", queryParams);
    const cached = cacheManager.get<string>(cacheKey);
    if (cached) {
      return { content: [{ type: "text", text: cached as unknown as string }] };
    }

    const response = await apiClient.get<Record<string, unknown>>({
      endpoint: config.API_DEVICES_ENDPOINT,
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener datos: ${response.error}` }],
        isError: true,
      };
    }

    const payload = response as unknown as Record<string, unknown>;
    const data = extractDataArray(payload);

    if (data.length === 0) {
      return {
        content: [{ type: "text", text: "No se encontraron planillas para el período solicitado." }],
      };
    }

    const summary = buildSummary(data, payload, desde, hasta);
    cacheManager.set(cacheKey, summary as unknown as Record<string, unknown>, 120);

    return { content: [{ type: "text", text: summary }] };
  },
};

function getDefaultDateRange(): { desde: string; hasta: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return { desde: `${y}-${m}-01`, hasta: `${y}-${m}-${d}` };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDataArray(payload: Record<string, unknown>): InspectionRecord[] {
  const candidates = [payload.data, payload.planillas, payload.registros, payload.items];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((r): r is InspectionRecord => typeof r === "object" && r !== null);
    }
  }
  return [];
}

function parseJsonField(value: unknown): Record<string, number> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, number>;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function buildSummary(data: InspectionRecord[], payload: Record<string, unknown>, desde: string, hasta: string): string {
  const meta = (typeof payload.meta === "object" && payload.meta !== null)
    ? payload.meta as Record<string, unknown>
    : {} as Record<string, unknown>;

  const empresa = typeof data[0]?.empresa === "string" ? data[0].empresa.trim() : "N/A";
  const total = Number(meta.total ?? data.length);

  const lines: string[] = [
    "# Resumen de Control de Calidad",
    "",
    `**Empresa:** ${empresa}`,
    `**Período:** ${desde} → ${hasta}`,
    `**Total planillas:** ${total}`,
    `**Analizadas:** ${data.length}`,
  ];
  if (meta.generado) lines.push(`**Generado:** ${String(meta.generado)}`);

  // ── Desglose por especie y variedad ──
  const especieMap = new Map<string, Map<string, number>>();
  for (const r of data) {
    const esp = String(r.especie ?? "Sin especie");
    const va = String(r.variedad ?? "Sin variedad");
    if (!especieMap.has(esp)) especieMap.set(esp, new Map());
    const varMap = especieMap.get(esp)!;
    varMap.set(va, (varMap.get(va) ?? 0) + 1);
  }
  lines.push("", "## Desglose por Especie");
  for (const [esp, varMap] of [...especieMap.entries()].sort((a, b) => {
    const sa = [...a[1].values()].reduce((x, y) => x + y, 0);
    const sb = [...b[1].values()].reduce((x, y) => x + y, 0);
    return sb - sa;
  })) {
    const total = [...varMap.values()].reduce((a, b) => a + b, 0);
    lines.push(`- **${esp}** (${total} planillas)`);
    for (const [va, cnt] of [...varMap.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${va}: ${cnt}`);
    }
  }

  // ── Cantidad total muestreada ──
  let totalCantidad = 0;
  for (const r of data) {
    const c = Number(r.cantidad);
    if (Number.isFinite(c)) totalCantidad += c;
  }
  if (totalCantidad > 0) {
    lines.push("", `## Muestras totales analizadas: ${totalCantidad} frutos`);
  }

  // ── Brix promedio ──
  const brixValues: number[] = [];
  for (const r of data) {
    const brix = parseJsonField(r.brix_row);
    const prom = Number(brix.PROMEDIO ?? brix.promedio);
    if (Number.isFinite(prom) && prom > 0) brixValues.push(prom);
  }
  if (brixValues.length > 0) {
    const avgBrix = brixValues.reduce((a, b) => a + b, 0) / brixValues.length;
    const minBrix = Math.min(...brixValues);
    const maxBrix = Math.max(...brixValues);
    lines.push(
      "",
      "## Brix",
      `- Promedio: **${avgBrix.toFixed(1)}°**`,
      `- Mínimo: ${minBrix.toFixed(1)}°`,
      `- Máximo: ${maxBrix.toFixed(1)}°`,
      `- Planillas con dato: ${brixValues.length}`,
    );
  }

  // ── Defectos de calidad ──
  const defCalidad = new Map<string, number>();
  for (const r of data) {
    const def = parseJsonField(r.defecto_calidad_row);
    for (const [key, val] of Object.entries(def)) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) {
        defCalidad.set(key.trim(), (defCalidad.get(key.trim()) ?? 0) + n);
      }
    }
  }
  if (defCalidad.size > 0) {
    lines.push("", "## Principales Defectos de Calidad");
    const sorted = [...defCalidad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [defecto, total] of sorted) {
      lines.push(`- ${defecto}: **${total}**`);
    }
  }

  // ── Defectos de condición ──
  const defCondicion = new Map<string, number>();
  for (const r of data) {
    const def = parseJsonField(r.defecto_condicion_row);
    for (const [key, val] of Object.entries(def)) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) {
        defCondicion.set(key.trim(), (defCondicion.get(key.trim()) ?? 0) + n);
      }
    }
  }
  if (defCondicion.size > 0) {
    lines.push("", "## Principales Defectos de Condición");
    const sorted = [...defCondicion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [defecto, total] of sorted) {
      lines.push(`- ${defecto}: **${total}**`);
    }
  }

  // ── Distribución de calibres ──
  const calibreTotal = new Map<string, number>();
  for (const r of data) {
    const cal = parseJsonField(r.calibrepeso_row);
    for (const [key, val] of Object.entries(cal)) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0 && key !== "precalibre" && key !== "sobrecalibre") {
        calibreTotal.set(key, (calibreTotal.get(key) ?? 0) + n);
      }
    }
  }
  if (calibreTotal.size > 0) {
    lines.push("", "## Distribución de Calibres (frutos totales)");
    const sorted = [...calibreTotal.entries()].sort((a, b) => {
      const na = parseFloat(a[0]), nb = parseFloat(b[0]);
      return Number.isNaN(na) || Number.isNaN(nb) ? a[0].localeCompare(b[0]) : na - nb;
    });
    for (const [cal, cnt] of sorted) {
      lines.push(`- Calibre ${cal}: ${cnt}`);
    }
  }

  // ── Campos y cuarteles ──
  const campoSet = new Set<string>();
  for (const r of data) {
    if (typeof r.nombre_campo === "string" && r.nombre_campo.trim()) {
      campoSet.add(r.nombre_campo.trim());
    }
  }
  if (campoSet.size > 0) {
    lines.push("", `## Campos evaluados (${campoSet.size})`);
    for (const campo of [...campoSet].sort()) {
      lines.push(`- ${campo}`);
    }
  }

  return lines.join("\n");
}

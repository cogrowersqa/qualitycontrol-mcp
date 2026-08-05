import { sessionManager } from "../sessions/manager.js";
import { getRequestApiKey } from "./request-context.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import { config } from "../config/index.js";
import type { ToolResult } from "../types/index.js";

type InspectionRecord = Record<string, unknown>;

export const getInspectionByIdTool = {
  name: "qc_get_inspection_by_id",
  description:
    "Busca y muestra una planilla de control de calidad específica en **QualityControl** por su ID. " +
    "Permite consultar directamente una planilla conocida sin necesidad de indicar rango de fechas. " +
    "Busca en los campos `id` (ID de muestra) e `id_planilla` (número de planilla). " +
    "Úsala cuando el usuario pide 'muéstrame la planilla 17688' o 'busca el registro 17688'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "number",
        description:
          "ID numérico de la planilla o muestra a buscar. " +
          "Se busca en ambos campos: `id` (ID único de muestra) e `id_planilla` (número de planilla que agrupa muestras).",
      },
    },
    required: ["id"],
  },

  async handler(params: { id?: number }): Promise<ToolResult> {
    // API key: fuente primaria = token OAuth (AsyncLocalStorage)
    const apiKey = getRequestApiKey();
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "No hay API Key en el contexto. Reconéctate desde Configuración → Conectores." }],
        isError: true,
      };
    }
    // Sesión: opcional, para cacheKey y metadata
    const session = sessionManager.getSession();

    const searchId = typeof params.id === "number" ? params.id : Number(params.id);
    if (!searchId || isNaN(searchId) || searchId <= 0) {
      return {
        content: [{ type: "text", text: "El parámetro `id` debe ser un número entero positivo." }],
        isError: true,
      };
    }

    // Clave de caché: todos los registros sin filtro de fecha (compartida con otras consultas sin fecha)
    const cacheKeyId = session?.sessionId ?? apiKey.slice(-8);
    const cacheKey = cacheManager.buildKey(cacheKeyId, "inspecciones-all", {});
    let allRecords = cacheManager.get<InspectionRecord[]>(cacheKey);

    if (!allRecords) {
      // Llamar a la API sin fechas — devuelve todos los registros (como en Postman)
      const response = await apiClient.get<Record<string, unknown>>({
        endpoint: config.API_DEVICES_ENDPOINT,
        params: {},
        apiKey,
      });

      if (!response.success) {
        return {
          content: [
            { type: "text", text: `Error al consultar el API: ${response.error}` },
          ],
          isError: true,
        };
      }

      const payload = response as unknown as Record<string, unknown>;
      allRecords = extractAndDecodeData(payload);
      // Cachear 5 minutos
      cacheManager.set(cacheKey, allRecords, 300);
    }

    // Buscar en ambos campos: id y id_planilla
    const matches = allRecords.filter(
      (r) =>
        Number(r["id"]) === searchId ||
        Number(r["id_planilla"]) === searchId
    );

    if (matches.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `No se encontró ningún registro con id=${searchId} o id_planilla=${searchId}.\n` +
              `La base de datos tiene ${allRecords.length} registro(s) en total.\n` +
              `Verifica que el ID sea correcto y que la empresa conectada sea la que contiene ese registro.`,
          },
        ],
      };
    }

    // Detectar si buscó por id_planilla (múltiples muestras bajo la misma planilla)
    const byPlanilla = matches.filter((r) => Number(r["id_planilla"]) === searchId);
    const byId = matches.filter((r) => Number(r["id"]) === searchId && Number(r["id_planilla"]) !== searchId);

    const lines: string[] = [];

    if (byPlanilla.length > 0) {
      const primera = byPlanilla[0];
      lines.push(`**Planilla #${searchId}**`);
      lines.push(`Empresa: ${primera["empresa"] ?? "N/A"} | Especie: ${primera["especie"] ?? "N/A"} | Variedad: ${primera["variedad"] ?? "N/A"}`);
      lines.push(`Campo: ${primera["nombre_campo"] ?? "N/A"} | Fecha: ${primera["fecha"] ?? "N/A"}`);
      lines.push(`Total de muestras en esta planilla: ${byPlanilla.length}`);
      lines.push("", "**Muestras:**");
      lines.push("```json");
      lines.push(JSON.stringify(byPlanilla.map(decodeEmbeddedJsonFields)));
      lines.push("```");
    }

    if (byId.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`**Registro con id=${searchId}:**`);
      lines.push("```json");
      lines.push(JSON.stringify(byId.map(decodeEmbeddedJsonFields)));
      lines.push("```");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractAndDecodeData(payload: Record<string, unknown>): InspectionRecord[] {
  const candidates = [payload["data"], payload["planillas"], payload["registros"], payload["items"]];
  let records: InspectionRecord[] = [];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      records = c.filter((r): r is InspectionRecord => typeof r === "object" && r !== null);
      break;
    }
  }
  if (records.length === 0 && Array.isArray(payload)) {
    records = (payload as unknown[]).filter(
      (r): r is InspectionRecord => typeof r === "object" && r !== null
    );
  }
  return records;
}

function decodeEmbeddedJsonFields(record: InspectionRecord): InspectionRecord {
  const out: InspectionRecord = { ...record };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        out[key] = JSON.parse(trimmed);
      } catch {
        /* keep original */
      }
    }
  }
  return out;
}

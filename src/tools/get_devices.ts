import { sessionManager } from "../sessions/manager.js";
import { apiClient } from "../api/client.js";
import { cacheManager } from "../cache/manager.js";
import { config } from "../config/index.js";
import type { ToolResult, Device } from "../types/index.js";

type GenericDevice = Partial<Device> & Record<string, unknown>;
type GenericRecord = Record<string, unknown>;

const MAX_CHUNK_SIZE = 12000;

export const getDevicesTool = {
  name: "get_devices",
  description:
    "Obtiene datos completos desde la API de la empresa conectada. " +
    "Devuelve todo el payload recibido (meta + data) y un resumen rápido.",
  inputSchema: {
    type: "object" as const,
    properties: {
      desde: {
        type: "string",
        description: "Fecha inicial opcional para filtrar (YYYY-MM-DD o YYYY-MM-DD HH:mm).",
      },
      hasta: {
        type: "string",
        description: "Fecha final opcional para filtrar (YYYY-MM-DD o YYYY-MM-DD HH:mm).",
      },
      limit: {
        type: "number",
        description: "Límite opcional de registros devueltos por la API.",
      },
      offset: {
        type: "number",
        description: "Offset opcional para paginar resultados.",
      },
      decode_json: {
        type: "string",
        description:
          "Si es 'si', intenta decodificar campos de texto que contienen JSON (por ejemplo *_row). " +
          "Por defecto: 'si'.",
      },
    },
    required: [],
  },

  async handler(params: {
    desde?: string;
    hasta?: string;
    limit?: number;
    offset?: number;
    decode_json?: string;
  }): Promise<ToolResult> {
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

    const queryParams: Record<string, string> = {};
    if (params.desde?.trim()) queryParams.desde = params.desde.trim();
    if (params.hasta?.trim()) queryParams.hasta = params.hasta.trim();
    if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      queryParams.limit = String(Math.floor(params.limit));
    }
    if (typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset >= 0) {
      queryParams.offset = String(Math.floor(params.offset));
    }

    // Verificar caché
    const cacheKey = cacheManager.buildKey(session.sessionId, "dispositivos", queryParams);
    const cached = cacheManager.get<GenericRecord>(cacheKey);
    if (cached) {
      return { content: buildFullPayloadContent(cached) };
    }

    // Llamar a la API
    const response = await apiClient.get<GenericRecord | GenericDevice[]>({
      endpoint: config.API_DEVICES_ENDPOINT,
      params: queryParams,
      apiKey,
    });

    if (!response.success) {
      return {
        content: [{ type: "text", text: `Error al obtener dispositivos: ${response.error}` }],
        isError: true,
      };
    }

    const shouldDecodeJson = (params.decode_json ?? "si").trim().toLowerCase() === "si";
    const normalizedPayload = normalizePayload(response as unknown, shouldDecodeJson);
    cacheManager.set(cacheKey, normalizedPayload, 120); // Cache 2 minutos

    return { content: buildFullPayloadContent(normalizedPayload) };
  },
};

function normalizePayload(raw: unknown, decodeJsonFields: boolean): GenericRecord {
  if (Array.isArray(raw)) {
    const normalizedData = raw
      .filter((item): item is GenericRecord => typeof item === "object" && item !== null)
      .map((item) => (decodeJsonFields ? decodeEmbeddedJsonFields(item) : item));
    return { data: normalizedData };
  }

  if (!raw || typeof raw !== "object") {
    return { data: [] };
  }

  const payload = raw as GenericRecord;
  const cloned: GenericRecord = { ...payload };
  const dataArray = extractDeviceArray(payload);
  cloned.data = decodeJsonFields ? dataArray.map(decodeEmbeddedJsonFields) : dataArray;

  return cloned;
}

function decodeEmbeddedJsonFields(device: GenericRecord): GenericRecord {
  const output: GenericRecord = { ...device };

  for (const [key, value] of Object.entries(output)) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    const looksLikeJson =
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"));

    if (!looksLikeJson) {
      continue;
    }

    try {
      output[key] = JSON.parse(trimmed);
    } catch {
      // Mantener texto original si no se puede decodificar
    }
  }

  return output;
}

function buildFullPayloadContent(payload: GenericRecord): Array<{ type: "text"; text: string }> {
  const data = extractDeviceArray(payload);
  const meta = extractMeta(payload);
  const dataCount = data.length;
  const total = toNullableNumber(meta.total) ?? toNullableNumber(payload.total) ?? dataCount;
  const returned = toNullableNumber(meta.returned) ?? dataCount;
  const empresa = extractCompanyName(payload, data) ?? "N/A";

  const summaryLines = [
    "**Datos completos de API recibidos**",
    "",
    `- Empresa: ${empresa}`,
    `- Registros retornados: ${returned}`,
    `- Total informado por API: ${total}`,
  ];

  if (meta.generado) {
    summaryLines.push(`- Generado: ${String(meta.generado)}`);
  }

  if (meta.has_more !== undefined) {
    summaryLines.push(`- has_more: ${String(meta.has_more)}`);
  }

  const summaryText = summaryLines.join("\n");
  const fullJson = JSON.stringify(payload, null, 2);
  const chunks = splitText(fullJson, MAX_CHUNK_SIZE);

  const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: summaryText }];

  for (let i = 0; i < chunks.length; i++) {
    const title = `**Payload JSON completo (bloque ${i + 1}/${chunks.length})**`;
    content.push({
      type: "text",
      text: `${title}\n\n\`\`\`json\n${chunks[i]}\n\`\`\``,
    });
  }

  return content;
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxLength, text.length);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function extractMeta(payload: GenericRecord): GenericRecord {
  const meta = payload.meta;
  if (meta && typeof meta === "object") {
    return meta as GenericRecord;
  }
  return {};
}

function extractCompanyName(payload: GenericRecord, devices: GenericDevice[]): string | null {
  const meta = extractMeta(payload);
  const fromTop = firstString(payload.empresa, meta.empresa, payload.company, payload.company_name);
  if (fromTop) {
    return fromTop;
  }

  if (devices.length > 0 && typeof devices[0].empresa === "string" && devices[0].empresa.trim().length > 0) {
    return devices[0].empresa.trim();
  }

  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractDeviceArray(response: Record<string, unknown>): GenericDevice[] {
  const topLevelCandidates = [
    response.dispositivos,
    response.data,
    response.items,
    response.results,
    response.records,
  ];

  for (const candidate of topLevelCandidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is GenericDevice => typeof item === "object" && item !== null);
    }
  }

  const data = response.data;
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    const nestedCandidates = [nested.dispositivos, nested.items, nested.results, nested.records];
    for (const candidate of nestedCandidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((item): item is GenericDevice => typeof item === "object" && item !== null);
      }
    }
  }

  return [];
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

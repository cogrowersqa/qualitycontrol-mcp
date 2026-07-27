// ─────────────────────────────────────────────
// Tipos e interfaces del servidor MCP AgroClimate
// ─────────────────────────────────────────────

/** Estado de una sesión */
export type SessionStatus = "active" | "expired" | "revoked";

/** Sesión almacenada */
export interface Session {
  sessionId: string;
  apiKeyEncrypted: string;
  apiKeyHash: string;
  companyName: string | null;
  userName: string | null;
  role: string | null;
  deviceCount: number;
  createdAt: string;
  lastAccess: string;
  expiresAt: string;
  status: SessionStatus;
}

/** Resultado de cifrado */
export interface EncryptedData {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Respuesta genérica de la API */
export interface ApiResponse<T = unknown> {
  ok?: boolean;
  success?: boolean;
  data?: T;
  error?: string;
  empresa?: string;
  usuario?: string;
  rol?: string;
  message?: string;
  endpoint?: string;
  total?: number;
  total_lecturas?: number;
  dispositivos?: T;
  historial?: T;
  lecturas?: T;
  rango?: { fecha_desde: string; fecha_hasta: string };
}

/** Dispositivo de la API (formato real) */
export interface Device {
  codigo_dispositivo: string;
  nombre_dispositivo: string;
  campo: string | null;
  temperatura_actual: number | null;
  humedad_actual: number | null;
  horas_frio_acumuladas: number;
  porciones_frio_acumuladas: number;
  latitud: number | null;
  longitud: number | null;
  fecha_ultima_conexion: string | null;
}

/** Entrada de historial (formato real) */
export interface HistoryEntry {
  codigo_dispositivo: string;
  temperatura: number;
  humedad: number;
  fecha: string;
}

/** Datos de clima */
export interface WeatherData {
  temperatura?: number;
  humedad?: number;
  viento?: number;
  presion?: number;
  pronostico?: string;
  ubicacion?: string;
  fecha?: string;
}

/** Datos de bins */
export interface BinsData {
  total: number;
  por_variedad?: Array<{ variedad: string; cantidad: number; kilos: number }>;
  fecha?: string;
}

/** Datos de cosecha */
export interface HarvestData {
  variedad?: string;
  temporada?: string;
  total_kilos: number;
  total_bins: number;
  kilos_hoy?: number;
  bins_hoy?: number;
  rendimiento_promedio?: number;
  porcentaje_avance?: number;
  ultima_actualizacion?: string;
}

/** Datos de exportaciones */
export interface ExportsData {
  total_kilos: number;
  destinos?: Array<{ destino: string; kilos: number }>;
  fecha_inicio?: string;
  fecha_fin?: string;
}

/** Datos de despachos */
export interface Dispatch {
  id: number | string;
  destino: string;
  kilos: number;
  estado: string;
  fecha: string;
  variedad?: string;
}

/** Resultado de un tool */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Opciones del API Client */
export interface ApiRequestOptions {
  endpoint: string;
  params?: Record<string, string>;
  apiKey: string;
  timeoutMs?: number;
}

/** Entrada de caché */
export interface CacheEntry<T = unknown> {
  data: T;
  createdAt: number;
  ttl: number;
}

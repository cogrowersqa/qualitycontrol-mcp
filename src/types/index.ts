// ─────────────────────────────────────────────
// Tipos e interfaces del servidor MCP QualityControl
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
  total_lecturas_porciones_frio?: number;
  dispositivos?: T;
  historial?: T;
  lecturas?: T;
  lecturas_porciones_frio?: T;
  rango?: { fecha_desde: string; fecha_hasta: string };
}

/** Dispositivo de la API (formato real) */
export interface Device {
  codigo_dispositivo: string;
  nombre_dispositivo: string;
  empresa: string;
  campo: string | null;
  temperatura_actual: number | null;
  humedad_actual: number | null;
  horas_frio_acumuladas: number;
  fecha_horas_frio?: string | null;
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
  horas_frio: number;
  fecha: string;
}

/** Entrada de porciones de frío por hora */
export interface PorcionesFrioEntry {
  codigo_dispositivo: string;
  porciones_frio: number;
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

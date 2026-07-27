import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { maskApiKey } from "../crypto/encryption.js";
import type { ApiResponse, ApiRequestOptions } from "../types/index.js";

/**
 * Cliente HTTP para comunicarse con la API REST de AgroClimate.
 * Todas las llamadas pasan por aquí para centralizar:
 * - Headers de autenticación
 * - Timeout
 * - Manejo de errores
 * - Logging (sin datos sensibles)
 */
class ApiClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor() {
    this.baseUrl = config.API_BASE_URL.replace(/\/$/, ""); // Remover trailing slash
    this.timeoutMs = config.API_TIMEOUT_MS;
  }

  /**
   * Realiza un GET a la API con autenticación Bearer.
   */
  async get<T = unknown>(options: ApiRequestOptions): Promise<ApiResponse<T>> {
    const { endpoint, params, apiKey, timeoutMs } = options;

    // Construir URL con parámetros
    const url = new URL(`${this.baseUrl}/${endpoint.replace(/^\//, "")}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.timeoutMs
    );

    try {
      logger.debug(`API Request: GET ${endpoint}`, {
        params: params ?? {},
        apiKey: maskApiKey(apiKey),
      });

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Sin detalle");
        logger.warn(`API Error: ${response.status} en ${endpoint}`, {
          status: response.status,
          body: errorText.substring(0, 200),
        });

        if (response.status === 401 || response.status === 403) {
          return {
            success: false,
            error: "API Key inválida o sin permisos. Verifica tu API Key.",
          };
        }

        return {
          success: false,
          error: `Error de la API (${response.status}): ${errorText.substring(0, 100)}`,
        };
      }

      const data = (await response.json()) as ApiResponse<T>;

      logger.debug(`API Response: ${response.status} en ${endpoint}`, {
        ok: data.ok,
      });

      // Normalizar: la API usa "ok" en vez de "success"
      if (data.ok !== undefined && data.success === undefined) {
        data.success = data.ok;
      }

      return data;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === "AbortError") {
        logger.error(`API Timeout: ${endpoint} (${timeoutMs ?? this.timeoutMs}ms)`);
        return {
          success: false,
          error: "La API no respondió a tiempo. Intenta de nuevo.",
        };
      }

      const message = error instanceof Error ? error.message : "Error desconocido";
      logger.error(`API Exception: ${endpoint}`, { error: message });

      return {
        success: false,
        error: `Error de conexión con la API: ${message}`,
      };
    }
  }

  /**
   * Valida una API Key haciendo una llamada al endpoint de dispositivos.
   * Si la respuesta es exitosa, la key es válida.
   */
  async validateApiKey(apiKey: string): Promise<ApiResponse> {
    return this.get({
      endpoint: "api_clientes_dispositivos.php",
      apiKey,
    });
  }

  /**
   * Verifica la conectividad con la API (healthcheck).
   */
  async healthcheck(): Promise<boolean> {
    try {
      const url = new URL(this.baseUrl);
      const response = await fetch(url.toString(), {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok || response.status === 405 || response.status === 404;
    } catch {
      return false;
    }
  }
}

export const apiClient = new ApiClient();

import { sessionStore } from "./store.js";
import { hashApiKey } from "../crypto/encryption.js";
import { logger } from "../logger/index.js";
import type { Session } from "../types/index.js";
import { getRequestApiKey } from "../tools/request-context.js";

/**
 * Manager de sesiones — lógica de alto nivel.
 */
export class SessionManager {
  /** Última conexión válida para reconexión silenciosa tras disconnect */
  private lastApiKey: string | null = null;
  private lastCompanyName: string | null = null;
  private lastDeviceCount: number = 0;

  /**
   * Crea o recupera una sesión para una API Key.
   * Si ya existe una sesión activa con la misma key, la reutiliza.
   */
  connectCompany(
    apiKey: string,
    companyName: string | null,
    userName: string | null,
    role: string | null,
    deviceCount: number
  ): Session {
    // Guardar para reconexión silenciosa posterior
    this.lastApiKey = apiKey;
    this.lastCompanyName = companyName;
    this.lastDeviceCount = deviceCount;

    // Verificar si ya existe sesión activa para esta key
    const keyHash = hashApiKey(apiKey);
    const existing = sessionStore.findByApiKeyHash(keyHash);

    if (existing) {
      sessionStore.touch(existing.sessionId);
      logger.info(`Sesión reutilizada: ${existing.sessionId} (empresa: ${existing.companyName})`);
      return existing;
    }

    // Crear nueva sesión
    return sessionStore.create(apiKey, companyName, userName, role, deviceCount);
  }

  /**
   * Reconecta silenciosamente con la última empresa usada (si existe).
   * Usado por los tools de datos tras un disconnect sin cambio de empresa.
   */
  reconnectLast(): Session | null {
    if (!this.lastApiKey) return null;
    logger.info(`Reconexión silenciosa: empresa "${this.lastCompanyName}"`);
    return this.connectCompany(this.lastApiKey, this.lastCompanyName, null, null, this.lastDeviceCount);
  }

  /**
   * Limpia también la última conexión guardada.
   * Usar cuando se quiere forzar un cambio de empresa real.
   */
  clearLastConnection(): void {
    this.lastApiKey = null;
    this.lastCompanyName = null;
    this.lastDeviceCount = 0;
  }

  /**
   * Obtiene la sesión activa actual.
   * En MCP stdio, normalmente hay una sola sesión por proceso.
   */
  getActiveSession(): Session | null {
    return sessionStore.getActiveSession();
  }

  /**
   * Obtiene la sesión correspondiente a la request actual (por API key del token OAuth).
   * Es la forma correcta de obtener la sesión en un servidor multi-usuario.
   * Busca por hash de la API key inyectada por runWithApiKey() en server.ts.
   * Fallback: primera sesión activa (compatible con flujo de un solo usuario).
   */
  getSession(): Session | null {
    const apiKey = getRequestApiKey();
    if (apiKey) {
      const hash = hashApiKey(apiKey);
      const byKey = sessionStore.findByApiKeyHash(hash);
      if (byKey) return byKey;
    }
    return sessionStore.getActiveSession();
  }

  /**
   * Verifica si hay sesión activa para la request actual.
   */
  hasSession(): boolean {
    return this.getSession() !== null;
  }

  /**
   * Desconecta solo la sesión de la request actual (por API key del token).
   * No afecta a otros usuarios conectados simultáneamente.
   */
  disconnectCurrent(): boolean {
    const apiKey = getRequestApiKey();
    if (!apiKey) return false;
    const hash = hashApiKey(apiKey);
    const session = sessionStore.findByApiKeyHash(hash);
    if (!session) return false;
    return sessionStore.revoke(session.sessionId);
  }

  /**
   * Obtiene la API key de la request actual (desde AsyncLocalStorage).
   */
  getApiKeyForCurrentRequest(): string | null {
    return getRequestApiKey();
  }

  /**
   * Obtiene una sesión por ID y renueva su acceso.
   */
  getAndTouch(sessionId: string): Session | null {
    const session = sessionStore.get(sessionId);
    if (session) {
      sessionStore.touch(sessionId);
    }
    return session;
  }

  /**
   * Obtiene la API Key descifrada de la sesión activa.
   */
  getApiKey(sessionId?: string): string | null {
    const id = sessionId ?? sessionStore.getActiveSession()?.sessionId;
    if (!id) return null;
    return sessionStore.getApiKey(id);
  }

  /**
   * Desconecta la sesión.
   */
  disconnect(sessionId?: string): boolean {
    const id = sessionId ?? sessionStore.getActiveSession()?.sessionId;
    if (!id) return false;
    return sessionStore.revoke(id);
  }

  /**
   * Desconecta TODAS las sesiones activas.
   * Garantiza que no queda ningún estado residual de empresa anterior.
   * Usado en logout completo.
   */
  disconnectAll(): number {
    let count = 0;
    const allActive = sessionStore.getAllActiveSessions();
    for (const session of allActive) {
      sessionStore.revoke(session.sessionId);
      count++;
    }
    if (count > 0) {
      logger.info(`Logout completo: ${count} sesión(es) revocadas`);
    }
    return count;
  }

  /**
   * Verifica si hay una sesión activa.
   */
  hasActiveSession(): boolean {
    return sessionStore.getActiveSession() !== null;
  }

  /**
   * Cambia de empresa: revoca TODAS las sesiones activas.
   * El usuario deberá proporcionar nueva API Key.
   */
  switchCompany(): void {
    this.disconnectAll();
    logger.info("Cambio de empresa: todas las sesiones revocadas");
  }

  /**
   * Estadísticas de sesiones para healthcheck.
   */
  getStats() {
    return sessionStore.stats();
  }
}

// Singleton
export const sessionManager = new SessionManager();

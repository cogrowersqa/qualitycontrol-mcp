import { sessionStore } from "./store.js";
import { hashApiKey } from "../crypto/encryption.js";
import { logger } from "../logger/index.js";
import type { Session } from "../types/index.js";

/**
 * Manager de sesiones — lógica de alto nivel.
 */
export class SessionManager {
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
   * Obtiene la sesión activa actual.
   * En MCP stdio, normalmente hay una sola sesión por proceso.
   */
  getActiveSession(): Session | null {
    return sessionStore.getActiveSession();
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

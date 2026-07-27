import { randomUUID } from "node:crypto";
import type { Session } from "../types/index.js";
import { encrypt, decrypt, hashApiKey } from "../crypto/encryption.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

/**
 * Almacén de sesiones en memoria.
 * Las sesiones se mantienen mientras el proceso MCP esté activo.
 */
class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Crea una nueva sesión con la API Key cifrada.
   */
  create(
    apiKey: string,
    companyName: string | null,
    userName: string | null,
    role: string | null,
    deviceCount: number
  ): Session {
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + config.SESSION_TTL_HOURS * 60 * 60 * 1000
    );

    const session: Session = {
      sessionId,
      apiKeyEncrypted: encrypt(apiKey),
      apiKeyHash: hashApiKey(apiKey),
      companyName,
      userName,
      role,
      deviceCount,
      createdAt: now.toISOString(),
      lastAccess: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "active",
    };

    this.sessions.set(sessionId, session);
    logger.info(`Sesión creada: ${sessionId} (empresa: ${companyName ?? "desconocida"})`);

    return session;
  }

  /**
   * Obtiene una sesión por ID.
   * Retorna null si no existe o está expirada/revocada.
   */
  get(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    if (session.status === "revoked") {
      return null;
    }

    // Verificar expiración
    if (new Date(session.expiresAt) < new Date()) {
      session.status = "expired";
      return null;
    }

    return session;
  }

  /**
   * Busca una sesión activa por hash de API Key.
   * Útil para reconectar sin pedir la key de nuevo.
   */
  findByApiKeyHash(apiKeyHash: string): Session | null {
    for (const session of this.sessions.values()) {
      if (session.apiKeyHash === apiKeyHash && session.status === "active") {
        if (new Date(session.expiresAt) >= new Date()) {
          return session;
        }
      }
    }
    return null;
  }

  /**
   * Obtiene la primera sesión activa (para flujos single-session).
   */
  getActiveSession(): Session | null {
    for (const session of this.sessions.values()) {
      if (session.status === "active" && new Date(session.expiresAt) >= new Date()) {
        return session;
      }
    }
    return null;
  }

  /**
   * Renueva el acceso de una sesión (sliding expiration).
   */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === "active") {
      const now = new Date();
      session.lastAccess = now.toISOString();
      session.expiresAt = new Date(
        now.getTime() + config.SESSION_TTL_HOURS * 60 * 60 * 1000
      ).toISOString();
    }
  }

  /**
   * Revoca una sesión (cierre de sesión).
   * Elimina la API Key cifrada por seguridad.
   */
  revoke(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.status = "revoked";
    session.apiKeyEncrypted = ""; // Borrar la key cifrada
    logger.info(`Sesión revocada: ${sessionId}`);
    return true;
  }

  /**
   * Descifra y retorna la API Key de una sesión.
   */
  getApiKey(sessionId: string): string | null {
    const session = this.get(sessionId);
    if (!session || !session.apiKeyEncrypted) {
      return null;
    }
    return decrypt(session.apiKeyEncrypted);
  }

  /**
   * Retorna estadísticas de sesiones.
   */
  stats(): { total: number; active: number; expired: number; revoked: number } {
    let active = 0;
    let expired = 0;
    let revoked = 0;

    for (const session of this.sessions.values()) {
      switch (session.status) {
        case "active":
          if (new Date(session.expiresAt) >= new Date()) {
            active++;
          } else {
            expired++;
          }
          break;
        case "expired":
          expired++;
          break;
        case "revoked":
          revoked++;
          break;
      }
    }

    return { total: this.sessions.size, active, expired, revoked };
  }

  /**
   * Limpia sesiones expiradas o revocadas que tienen más de 48 horas.
   */
  cleanup(): number {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    let removed = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (
        (session.status === "expired" || session.status === "revoked") &&
        new Date(session.lastAccess) < cutoff
      ) {
        this.sessions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info(`Cleanup: ${removed} sesiones eliminadas`);
    }

    return removed;
  }

  /**
   * Inicia el intervalo de limpieza automática.
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      config.SESSION_CLEANUP_INTERVAL_MIN * 60 * 1000
    );
    // No bloquear el cierre del proceso
    this.cleanupInterval.unref();
  }

  /**
   * Detiene la limpieza automática.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton
export const sessionStore = new SessionStore();

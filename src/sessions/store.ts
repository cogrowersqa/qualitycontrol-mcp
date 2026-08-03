import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Session } from "../types/index.js";
import { encrypt, decrypt, hashApiKey } from "../crypto/encryption.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly storeFile: string;

  constructor() {
    this.storeFile = resolve(config.MCP_SESSION_STORE_FILE);
    this.loadFromFile();
    this.startCleanup();
  }

  create(apiKey: string, companyName: string | null, userName: string | null, role: string | null, deviceCount: number): Session {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const session: Session = {
      sessionId,
      apiKeyEncrypted: encrypt(apiKey),
      apiKeyHash: hashApiKey(apiKey),
      companyName, userName, role, deviceCount,
      createdAt: now, lastAccess: now,
      expiresAt: null,
      status: "active",
    };
    this.sessions.set(sessionId, session);
    logger.info(`Sesion creada: ${sessionId} (empresa: ${companyName ?? "desconocida"})`);
    this.saveToFile();
    return session;
  }

  get(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "revoked") return null;
    return session;
  }

  findByApiKeyHash(apiKeyHash: string): Session | null {
    for (const session of this.sessions.values()) {
      if (session.apiKeyHash === apiKeyHash && session.status === "active") return session;
    }
    return null;
  }

  getActiveSession(): Session | null {
    for (const session of this.sessions.values()) {
      if (session.status === "active") return session;
    }
    return null;
  }

  getAllActiveSessions(): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.status === "active");
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === "active") {
      session.lastAccess = new Date().toISOString();
    }
  }

  revoke(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = "revoked";
    session.apiKeyEncrypted = "";
    logger.info(`Sesion revocada: ${sessionId}`);
    this.saveToFile();
    return true;
  }

  getApiKey(sessionId: string): string | null {
    const session = this.get(sessionId);
    if (!session || !session.apiKeyEncrypted) return null;
    try { return decrypt(session.apiKeyEncrypted); } catch { return null; }
  }

  stats(): { total: number; active: number; expired: number; revoked: number } {
    let active = 0, expired = 0, revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "active") active++;
      else if (session.status === "expired") expired++;
      else if (session.status === "revoked") revoked++;
    }
    return { total: this.sessions.size, active, expired, revoked };
  }

  cleanup(): number {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    let removed = 0;
    for (const [id, session] of this.sessions.entries()) {
      if ((session.status === "revoked" || session.status === "expired") && new Date(session.lastAccess) < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) { logger.info(`Cleanup: ${removed} sesion(es) antiguas eliminadas`); this.saveToFile(); }
    return removed;
  }

  saveToFile(): void {
    try {
      const dir = dirname(this.storeFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const activeSessions = Array.from(this.sessions.values()).filter((s) => s.status === "active");
      writeFileSync(this.storeFile, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), sessions: activeSessions }, null, 2), "utf8");
    } catch (err) {
      logger.error("SessionStore: error guardando en disco", { error: String(err) });
    }
  }

  private loadFromFile(): void {
    try {
      if (!existsSync(this.storeFile)) { logger.debug("SessionStore: no existe archivo, comenzando vacio"); return; }
      const raw = readFileSync(this.storeFile, "utf8");
      const payload = JSON.parse(raw) as { version: number; sessions: Session[] };
      if (payload.version !== 1 || !Array.isArray(payload.sessions)) { logger.warn("SessionStore: formato no reconocido, ignorando"); return; }
      let loaded = 0;
      for (const session of payload.sessions) {
        if (session.sessionId && session.status === "active" && session.apiKeyEncrypted) {
          session.expiresAt = null;
          this.sessions.set(session.sessionId, session);
          loaded++;
        }
      }
      if (loaded > 0) logger.info(`SessionStore: ${loaded} sesion(es) restaurada(s) desde disco`);
    } catch (err) {
      logger.warn("SessionStore: error cargando desde disco, comenzando vacio", { error: String(err) });
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => this.cleanup(), config.SESSION_CLEANUP_INTERVAL_MIN * 60 * 1000);
    this.cleanupInterval.unref();
  }

  destroy(): void {
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null; }
  }
}

export const sessionStore = new SessionStore();
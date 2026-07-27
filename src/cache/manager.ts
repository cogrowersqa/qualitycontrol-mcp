import type { CacheEntry } from "../types/index.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

/**
 * Cache in-memory con TTL configurable.
 * Evita llamadas repetidas a la API para datos que no cambian frecuentemente.
 */
class CacheManager {
  private store: Map<string, CacheEntry> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Obtiene un valor del caché.
   * Retorna null si no existe o está expirado.
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.createdAt > entry.ttl * 1000) {
      this.store.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Almacena un valor en caché con TTL opcional.
   */
  set<T>(key: string, data: T, ttlSeconds?: number): void {
    // Respetar límite máximo de entradas
    if (this.store.size >= config.CACHE_MAX_ENTRIES) {
      this.evictOldest();
    }

    this.store.set(key, {
      data,
      createdAt: Date.now(),
      ttl: ttlSeconds ?? config.CACHE_TTL_SECONDS,
    });
  }

  /**
   * Genera una key de caché basada en el endpoint y la sesión.
   */
  buildKey(sessionId: string, endpoint: string, params?: Record<string, string>): string {
    const paramStr = params
      ? Object.entries(params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("&")
      : "";
    return `${sessionId}:${endpoint}:${paramStr}`;
  }

  /**
   * Invalida todas las entradas de caché de una sesión.
   */
  invalidateSession(sessionId: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Invalida todo el caché.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Elimina la entrada más antigua.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.store.delete(oldestKey);
    }
  }

  /**
   * Limpia entradas expiradas.
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now - entry.createdAt > entry.ttl * 1000) {
        this.store.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`Cache cleanup: ${removed} entradas eliminadas`);
    }
  }

  private startCleanup(): void {
    // Limpiar cada 5 minutos
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Estadísticas del caché.
   */
  stats(): { entries: number; maxEntries: number } {
    return {
      entries: this.store.size,
      maxEntries: config.CACHE_MAX_ENTRIES,
    };
  }
}

export const cacheManager = new CacheManager();

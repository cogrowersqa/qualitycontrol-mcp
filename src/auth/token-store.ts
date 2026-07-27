/**
 * Token Store — módulo compartido entre server.ts y los tools.
 *
 * Gestiona la relación OAuth token ↔ sesión MCP.
 * Permite revocar tokens, forzar re-autenticación y garantizar
 * aislamiento completo entre sesiones de empresas diferentes.
 */

import { logger } from "../logger/index.js";

/** Mapea sessionId MCP → token OAuth asociado */
const sessionTokenMap = new Map<string, string>();

/** Mapea token OAuth → sessionId MCP (inverso para lookup rápido) */
const tokenSessionMap = new Map<string, string>();

/** Tokens revocados (pendientes de ser rechazados en la próxima request) */
const revokedTokens = new Set<string>();

/** Flag global: forzar re-autenticación en la próxima request */
let forceReAuthFlag = false;

/**
 * Asocia un token OAuth con una sesión MCP (bidireccional).
 * Se llama al crear una nueva sesión MCP con auto-connect.
 */
export function associateToken(sessionId: string, token: string): void {
  sessionTokenMap.set(sessionId, token);
  tokenSessionMap.set(token, sessionId);
  logger.debug(`Token asociado a sesión ${sessionId}`);
}

/**
 * Obtiene el sessionId asociado a un token OAuth.
 */
export function getSessionForToken(token: string): string | undefined {
  return tokenSessionMap.get(token);
}

/**
 * Obtiene el token asociado a un sessionId.
 */
export function getTokenForSession(sessionId: string): string | undefined {
  return sessionTokenMap.get(sessionId);
}

/**
 * Revoca el token asociado a una sesión MCP.
 * La próxima request con ese token recibirá 401, forzando re-auth.
 */
export function revokeSessionToken(sessionId: string): boolean {
  const token = sessionTokenMap.get(sessionId);
  if (token) {
    revokedTokens.add(token);
    sessionTokenMap.delete(sessionId);
    tokenSessionMap.delete(token);
    logger.info(`Token revocado para sesión ${sessionId}`);
    return true;
  }
  return false;
}

/**
 * Revoca TODOS los tokens activos.
 * Usado en logout completo para garantizar que no quede nada residual.
 */
export function revokeAllTokens(): void {
  for (const [sessionId, token] of sessionTokenMap.entries()) {
    revokedTokens.add(token);
    logger.info(`Token revocado (revokeAll) para sesión ${sessionId}`);
  }
  sessionTokenMap.clear();
  tokenSessionMap.clear();
  forceReAuthFlag = true;
}

/**
 * Verifica si un token fue revocado.
 */
export function isTokenRevoked(token: string): boolean {
  return revokedTokens.has(token);
}

/**
 * Limpia un token del set de revocados (después de que el cliente re-autentica).
 */
export function clearRevoked(token: string): void {
  revokedTokens.delete(token);
}

/**
 * Solicita re-autenticación en la próxima request MCP.
 * Usado por disconnect_company y connect_company (sin API key).
 */
export function requestReAuth(): void {
  forceReAuthFlag = true;
  logger.debug("Re-autenticación solicitada (flag activado)");
}

/**
 * Verifica y consume el flag de re-auth.
 * Retorna true UNA vez si se solicitó re-auth.
 */
export function shouldForceReAuth(): boolean {
  if (forceReAuthFlag) {
    forceReAuthFlag = false;
    return true;
  }
  return false;
}

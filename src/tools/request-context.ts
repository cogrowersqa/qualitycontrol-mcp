import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Almacenamiento aislado por request usando AsyncLocalStorage.
 * Cada request tiene su propio contexto — no hay mezcla entre usuarios concurrentes.
 */
const storage = new AsyncLocalStorage<string>();

/**
 * Ejecuta fn() dentro de un contexto donde getRequestApiKey() devuelve apiKey.
 * Usar en server.ts: await runWithApiKey(tokenData.apiKey, () => transport.handleRequest(...))
 */
export function runWithApiKey<T>(apiKey: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(apiKey, fn);
}

/**
 * Devuelve la API key del contexto de la request actual.
 * Solo tiene valor dentro de runWithApiKey(). Retorna null fuera de ese contexto.
 */
export function getRequestApiKey(): string | null {
  return storage.getStore() ?? null;
}
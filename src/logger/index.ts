import { createLogger, format, transports } from "winston";
import { config } from "../config/index.js";
import { maskApiKey } from "../crypto/encryption.js";

/**
 * Sanitiza mensajes de log para evitar filtrar API Keys.
 */
const sanitizeFormat = format((info) => {
  if (typeof info.message === "string") {
    // Detectar patrones de API Key y reemplazar
    info.message = info.message.replace(
      /(?:Bearer\s+|apikey=|X-API-KEY:\s*)([\w\-\.]{20,})/gi,
      (match, key) => match.replace(key, maskApiKey(key))
    );
  }
  return info;
});

export const logger = createLogger({
  level: config.LOG_LEVEL,
  format: format.combine(
    sanitizeFormat(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "qualitycontrol-mcp" },
  transports: [
    new transports.File({
      filename: `${config.LOG_DIR}/error.log`,
      level: "error",
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    new transports.File({
      filename: `${config.LOG_DIR}/combined.log`,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

// En desarrollo, loguear también a consola (stderr para no interferir con stdio MCP)
if (config.NODE_ENV === "development") {
  logger.add(
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
      stderrLevels: ["error", "warn", "info", "debug"],
    })
  );
}

/**
 * Log de auditoría para tool calls.
 * Nunca incluye datos sensibles.
 */
export function auditLog(
  toolName: string,
  sessionId: string | null,
  success: boolean,
  durationMs: number
): void {
  logger.info("tool_call", {
    tool: toolName,
    sessionId: sessionId ?? "none",
    success,
    durationMs,
    timestamp: new Date().toISOString(),
  });
}

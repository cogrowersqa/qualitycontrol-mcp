import { z } from "zod";
import { config as loadDotenv } from "dotenv";

// Cargar .env si existe
loadDotenv();

const envSchema = z.object({
  // API
  API_BASE_URL: z.string().url(),
  API_TIMEOUT_MS: z.coerce.number().default(30000),
  API_VALIDATE_ENDPOINT: z.string().default("api_toda_info.php"),
  API_DEVICES_ENDPOINT: z.string().default("api_toda_info.php"),
  API_HISTORY_ENDPOINT: z.string().default("api_toda_info.php"),
  API_WEATHER_ENDPOINT: z.string().default("api_toda_info.php"),

  // Cifrado
  ENCRYPTION_KEY: z.string().min(64).max(64),

  // Sesiones
  SESSION_TTL_HOURS: z.coerce.number().default(24),
  SESSION_CLEANUP_INTERVAL_MIN: z.coerce.number().default(60),

  // Cache
  CACHE_TTL_SECONDS: z.coerce.number().default(300),
  CACHE_MAX_ENTRIES: z.coerce.number().default(1000),

  // Logs
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  LOG_DIR: z.string().default("./logs"),

  // Server
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  MCP_PORT: z.coerce.number().default(3100),
  MCP_HOST: z.string().default("0.0.0.0"),
  MCP_BASE_URL: z.string().default("https://qa.cogrowers.cl/mcp/qualitycontrol"),
  // Persistencia en disco
  MCP_SESSION_STORE_FILE: z.string().default("./data/sessions.json"),
  MCP_TOKEN_STORE_FILE: z.string().default("./data/tokens.json"),
  // Zona horaria para calcular fechas por defecto (ej: "America/Santiago")
  TZ_OFFSET_HOURS: z.coerce.number().default(-4),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues.map(
      (i) => `  - ${i.path.join(".")}: ${i.message}`
    );
    throw new Error(
      `Configuración inválida. Variables faltantes o incorrectas:\n${missing.join("\n")}`
    );
  }

  return Object.freeze(result.data);
}

export const config = loadConfig();
export type Config = z.infer<typeof envSchema>;

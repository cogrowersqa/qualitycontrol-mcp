#!/usr/bin/env node

/**
 * AgroClimate MCP Server — HTTP/SSE Transport
 *
 * Versión para deploy en servidor con PM2.
 * Expone el MCP via Streamable HTTP en un puerto configurable.
 * Incluye OAuth 2.1 para compatibilidad con Claude.ai web.
 *
 * Endpoints:
 *   POST /mcp   — JSON-RPC messages (MCP protocol)
 *   GET  /mcp   — SSE stream (server → client notifications)
 *   DELETE /mcp — Close session
 *   GET  /health — Health check para PM2/balanceador
 *   GET  /.well-known/oauth-authorization-server — OAuth metadata
 *   GET  /authorize — OAuth authorization endpoint
 *   POST /token — OAuth token endpoint
 *   POST /register — OAuth dynamic client registration
 */

import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { tools, executeTool } from "./tools/index.js";
import { logger } from "./logger/index.js";
import { apiClient } from "./api/client.js";
import { sessionManager } from "./sessions/manager.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "3100", 10);
const HOST = process.env.MCP_HOST || "0.0.0.0";
const BASE_URL = process.env.MCP_BASE_URL || "https://qa.cogrowers.cl/mcp/agroclimate";

// ─── Crear servidor MCP ────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agroclimate-mcp",
    version: "1.0.0",
  });

  // Registrar todas las herramientas
  for (const tool of tools) {
    const zodShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, propDef] of Object.entries(tool.inputSchema.properties)) {
      const prop = propDef as { type: string; description?: string; enum?: string[] };
      let zodField: z.ZodTypeAny;

      if (prop.enum) {
        zodField = z.enum(prop.enum as [string, ...string[]]);
      } else if (prop.type === "number") {
        zodField = z.number();
      } else {
        zodField = z.string();
      }

      if (prop.description) {
        zodField = zodField.describe(prop.description);
      }

      if (!tool.inputSchema.required.includes(key)) {
        zodField = zodField.optional();
      }

      zodShape[key] = zodField;
    }

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (params) => {
        const result = await executeTool(tool.name, params as Record<string, unknown>);
        return result;
      }
    );
  }

  return server;
}

// ─── Express App ───────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Map de sesiones activas: sessionId → transport
const transports = new Map<string, StreamableHTTPServerTransport>();

// ─── OAuth 2.1 (requerido por Claude.ai web) ───────────────────────────────────

// Almacenamiento temporal de códigos de autorización y tokens
interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  expiresAt: number;
  apiKey?: string;
  companyName?: string | null;
  deviceCount?: number;
}
interface TokenData {
  clientId: string;
  expiresAt: number;
  apiKey?: string;
  companyName?: string | null;
  deviceCount?: number;
}
const authCodes = new Map<string, AuthCodeData>();
const accessTokens = new Map<string, TokenData>();
const registeredClients = new Map<string, { clientId: string; clientSecret: string; redirectUris: string[] }>();

// OAuth Server Metadata (RFC 8414)
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported: ["mcp"],
  });
});

// Protected Resource Metadata (RFC 9728) — required by MCP spec
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
});

// Dynamic Client Registration (RFC 7591)
app.post("/register", (req, res) => {
  const clientId = `client_${randomUUID()}`;
  const clientSecret = `secret_${randomUUID()}`;
  const redirectUris = req.body.redirect_uris || [];

  registeredClients.set(clientId, { clientId, clientSecret, redirectUris });
  logger.info(`OAuth: Cliente registrado: ${clientId}`);

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// Escapar HTML para prevenir XSS
function escapeHtml(str: string): string {
  return (str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Authorization Endpoint — GET muestra formulario para ingresar API Key
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  // Mostrar formulario de autenticación
  res.type("html").send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgroClimate — Conectar empresa</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 40px; max-width: 420px; width: 100%; }
    h1 { font-size: 1.5rem; color: #1a5d1a; margin-bottom: 8px; }
    p { color: #666; font-size: 0.9rem; margin-bottom: 24px; line-height: 1.4; }
    label { display: block; font-weight: 600; color: #333; margin-bottom: 6px; font-size: 0.9rem; }
    input[type=password] { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem; margin-bottom: 20px; }
    input[type=password]:focus { outline: none; border-color: #1a5d1a; box-shadow: 0 0 0 3px rgba(26,93,26,0.1); }
    button { width: 100%; padding: 12px; background: #1a5d1a; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #145214; }
    .error { background: #fef2f2; color: #991b1b; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 0.85rem; }
    .info { font-size: 0.8rem; color: #999; margin-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🌿 AgroClimate</h1>
    <p>Ingresa tu API Key para conectar tu empresa.<br>La puedes obtener desde el Portal Web en <strong>API para Clientes</strong>.</p>
    <form method="POST" action="${escapeHtml(BASE_URL)}/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}" />
      <input type="hidden" name="state" value="${escapeHtml(state)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}" />
      <input type="hidden" name="response_type" value="code" />
      <label for="api_key">API Key</label>
      <input type="password" id="api_key" name="api_key" placeholder="Pega tu API Key aquí" required />
      <button type="submit">Conectar empresa</button>
    </form>
    <p class="info">Tu API Key se almacena encriptada en el servidor y nunca se comparte con terceros.</p>
  </div>
</body>
</html>`);
});

// Authorization Endpoint — POST procesa el formulario
app.post("/authorize", async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, response_type, api_key } = req.body;

  if (response_type !== "code" || !api_key) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  // Validar API Key contra la API de AgroClimate
  try {
    const validation = await apiClient.validateApiKey(api_key.trim());

    if (!validation.success) {
      logger.warn(`OAuth: API Key inválida desde ${client_id}`);
      res.type("html").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Error</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f0f4f0}.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);padding:40px;max-width:420px;text-align:center}h1{color:#991b1b;margin-bottom:12px}p{color:#666;margin-bottom:20px}a{color:#1a5d1a;font-weight:600}</style>
</head><body><div class="card"><h1>API Key inválida</h1><p>La API Key ingresada no es válida o no tiene permisos. Verifica que la copiaste correctamente.</p><a href="javascript:history.back()">← Volver a intentar</a></div></body></html>`);
      return;
    }

    // API Key válida — extraer info de empresa
    const devices = (validation.dispositivos as unknown[]) ?? (validation.data as unknown[]) ?? [];
    const companyName = (validation.empresa as string) ?? null;
    const deviceCount = (validation.total as number) ?? devices.length;

    // Generar código de autorización con API Key incluida
    const code = randomUUID();
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      expiresAt: Date.now() + 5 * 60 * 1000,
      apiKey: api_key.trim(),
      companyName,
      deviceCount,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    logger.info(`OAuth: Empresa "${companyName}" autorizada (${deviceCount} dispositivos)`);
    res.redirect(302, redirectUrl.toString());
  } catch (error) {
    logger.error("OAuth: Error validando API Key", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "server_error" });
  }
});

// Token Endpoint
app.post("/token", (req, res) => {
  const { grant_type, code, client_id } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const authCode = authCodes.get(code);
  if (!authCode || authCode.expiresAt < Date.now()) {
    authCodes.delete(code);
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  // Eliminar código usado (single-use)
  authCodes.delete(code);

  // Generar access token (incluye API Key si fue proporcionada en authorize)
  const token = `mcp_${randomUUID()}`;
  accessTokens.set(token, {
    clientId: client_id || authCode.clientId,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 horas
    apiKey: authCode.apiKey,
    companyName: authCode.companyName,
    deviceCount: authCode.deviceCount,
  });

  logger.info(`OAuth: Token emitido para ${client_id || authCode.clientId}`);

  res.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 86400,
    scope: "mcp",
  });
});

// ─── MCP Endpoint ──────────────────────────────────────────────────────────────

// Middleware: verificar Bearer token en /mcp
function validateBearerToken(req: express.Request, res: express.Response): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const resourceMetadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource`;
    res.status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
      .json({ error: "unauthorized", error_description: "Bearer token required" });
    return false;
  }

  const token = authHeader.slice(7);
  const tokenData = accessTokens.get(token);
  if (!tokenData || tokenData.expiresAt < Date.now()) {
    accessTokens.delete(token);
    const resourceMetadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource`;
    res.status(401)
      .set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`)
      .json({ error: "invalid_token", error_description: "Token expired or invalid" });
    return false;
  }

  return true;
}

app.all("/mcp", async (req, res) => {
  try {
    // Verificar autenticación
    if (!validateBearerToken(req, res)) return;

    // Verificar si es una sesión existente
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Sesión existente: reutilizar transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Para GET/DELETE sin sesión válida, rechazar
    if (req.method === "GET" || req.method === "DELETE") {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Nueva sesión (POST con initialize): crear transport + servidor MCP
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createMcpServer();
    await server.connect(transport);

    // handleRequest procesa el initialize y GENERA el sessionId
    await transport.handleRequest(req, res, req.body);

    // Guardar DESPUÉS de handleRequest (ahora sí tiene sessionId)
    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
      logger.info(`Nueva sesión MCP: ${transport.sessionId}`);
    }

    // Auto-conectar empresa si el token tiene API Key (del formulario OAuth)
    const bearerToken = req.headers.authorization?.slice(7);
    if (bearerToken) {
      const tokenData = accessTokens.get(bearerToken);
      if (tokenData?.apiKey && !sessionManager.hasActiveSession()) {
        try {
          sessionManager.connectCompany(
            tokenData.apiKey,
            tokenData.companyName ?? null,
            null, // userName
            null, // role
            tokenData.deviceCount ?? 0
          );
          logger.info(`Auto-conectada empresa "${tokenData.companyName}" via OAuth`);
        } catch (err) {
          logger.warn("Error auto-conectando empresa", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        logger.info(`Sesión MCP cerrada: ${sid}`);
      }
    };
  } catch (error) {
    logger.error("Error en /mcp", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "agroclimate-mcp",
    version: "1.0.0",
    transport: "streamable-http",
    activeSessions: transports.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Iniciar servidor HTTP ─────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  logger.info(`AgroClimate MCP Server v1.0.0 (HTTP) escuchando en http://${HOST}:${PORT}`);
  logger.info(`MCP endpoint: POST http://${HOST}:${PORT}/mcp`);
  logger.info(`Health check: GET http://${HOST}:${PORT}/health`);
  logger.info(`Tools registrados: ${tools.length}`);
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`Recibido ${signal}, cerrando servidor...`);

  // Cerrar todas las sesiones activas
  for (const [sid, transport] of transports) {
    try {
      await transport.close();
      logger.debug(`Sesión ${sid} cerrada`);
    } catch {
      // ignore
    }
  }
  transports.clear();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
  logger.error("Excepción no capturada", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Promesa rechazada no manejada", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

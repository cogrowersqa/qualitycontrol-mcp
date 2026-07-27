#!/usr/bin/env node

/**
 * AgroClimate MCP Server
 *
 * Servidor Model Context Protocol que conecta ChatGPT/Claude con la API REST de AgroClimate.
 * Transporte: stdio (estándar MCP)
 *
 * Flujo:
 * 1. El LLM invoca tools via MCP protocol
 * 2. El servidor gestiona sesiones y cifrado de API Keys
 * 3. Las llamadas pasan a la API REST con Bearer token
 * 4. Los resultados se formatean para consumo del LLM
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { tools, executeTool } from "./tools/index.js";
import { logger } from "./logger/index.js";

// ─── Crear servidor MCP ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "agroclimate-mcp",
  version: "1.0.0",
});

// ─── Registrar todas las herramientas ──────────────────────────────────────────

for (const tool of tools) {
  // Construir el schema Zod dinámicamente a partir del inputSchema
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

    // Si no está en required, hacerlo opcional
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

// ─── Iniciar servidor ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("Iniciando AgroClimate MCP Server v1.0.0");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Servidor MCP conectado via stdio");
  logger.info(`Tools registrados: ${tools.length}`);

  // Manejo de cierre graceful
  process.on("SIGINT", () => {
    logger.info("Recibido SIGINT, cerrando servidor...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.info("Recibido SIGTERM, cerrando servidor...");
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Excepción no capturada", { error: error.message, stack: error.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Promesa rechazada no manejada", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((error) => {
  console.error("Error fatal al iniciar el servidor MCP:", error);
  process.exit(1);
});

/**
 * Test interactivo del MCP QualityControl.
 * Uso: npx tsx test/interactive.ts
 *
 * 1. Pega tu API Key
 * 2. Se conecta
 * 3. Escribe comandos: dispositivos, historial, clima, desconectar, salir
 */

import * as readline from "node:readline";
import { connectCompanyTool } from "../src/tools/connect_company.js";
import { disconnectCompanyTool } from "../src/tools/disconnect_company.js";
import { getDevicesTool } from "../src/tools/get_devices.js";
import { getSensorHistoryTool } from "../src/tools/get_sensor_history.js";
import { companyInfoTool } from "../src/tools/company_info.js";
import { healthcheckTool } from "../src/tools/healthcheck.js";
import { sessionManager } from "../src/sessions/manager.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function printResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  console.log("\n" + "─".repeat(50));
  console.log(result.content[0].text);
  console.log("─".repeat(50) + "\n");
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   QualityControl MCP — Test Interactivo         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Paso 1: Pedir API Key
  const apiKey = await ask("🔑 Pega tu API Key: ");

  if (!apiKey.trim()) {
    console.log("❌ No se proporcionó API Key. Saliendo.");
    rl.close();
    return;
  }

  // Paso 2: Conectar
  console.log("\n⏳ Conectando...");
  const connectResult = await connectCompanyTool.handler({ api_key: apiKey.trim() });
  printResult(connectResult);

  if (!sessionManager.hasActiveSession()) {
    console.log("❌ No se pudo conectar. Verifica tu API Key.");
    rl.close();
    return;
  }

  // Paso 3: Loop interactivo
  console.log("Comandos disponibles:");
  console.log("  dispositivos      → Lista tus dispositivos y sensores");
  console.log("  historial         → Historial de temperatura/humedad de un sensor");
  console.log("  info              → Info de empresa conectada");
  console.log("  health            → Estado del servidor");
  console.log("  desconectar       → Cerrar sesión");
  console.log("  salir             → Salir\n");

  while (true) {
    const input = await ask("📝 > ");
    const cmd = input.trim().toLowerCase();

    if (!cmd) continue;

    if (cmd === "salir" || cmd === "exit" || cmd === "quit") {
      console.log("👋 Adiós!");
      break;
    }

    try {
      switch (cmd) {
        case "dispositivos":
        case "devices": {
          const r = await getDevicesTool.handler({} as never);
          printResult(r);
          break;
        }
        case "historial":
        case "history": {
          console.log("  (Usa los códigos de dispositivo que viste en 'dispositivos')");
          const dispositivo = await ask("   Código dispositivo: ");
          const desde = await ask("   Fecha desde (YYYY-MM-DD o YYYY-MM-DD HH:mm, vacío = últimas 24h): ");
          const hasta = await ask("   Fecha hasta (YYYY-MM-DD o YYYY-MM-DD HH:mm, vacío = ahora): ");
          const histParams: Record<string, string> = { dispositivo: dispositivo.trim() };
          if (desde.trim()) histParams.fecha_desde = desde.trim();
          if (hasta.trim()) histParams.fecha_hasta = hasta.trim();
          const r = await getSensorHistoryTool.handler(histParams as any);
          printResult(r);
          break;
        }
        case "info": {
          const r = await companyInfoTool.handler({} as never);
          printResult(r);
          break;
        }
        case "health":
        case "healthcheck": {
          const r = await healthcheckTool.handler({} as never);
          printResult(r);
          break;
        }
        case "desconectar":
        case "disconnect": {
          const r = await disconnectCompanyTool.handler({} as never);
          printResult(r);
          console.log("Sesión cerrada. Usa 'salir' para terminar.");
          break;
        }
        default:
          console.log(`  ❓ Comando no reconocido: "${cmd}". Intenta: dispositivos, historial, info, health, desconectar, salir`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ Error: ${msg}`);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});

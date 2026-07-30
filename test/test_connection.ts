/**
 * Script de prueba para el servidor MCP QualityControl.
 * Simula las llamadas que haría ChatGPT/Claude al servidor.
 *
 * Uso:
 *   npx tsx test/test_connection.ts
 *
 * Requiere las variables de entorno configuradas.
 */

import { config } from "../src/config/index.js";
import { apiClient } from "../src/api/client.js";
import { sessionManager } from "../src/sessions/manager.js";
import { encrypt, decrypt, maskApiKey } from "../src/crypto/encryption.js";
import { connectCompanyTool } from "../src/tools/connect_company.js";
import { getDevicesTool } from "../src/tools/get_devices.js";
import { disconnectCompanyTool } from "../src/tools/disconnect_company.js";
import { healthcheckTool } from "../src/tools/healthcheck.js";

const TEST_API_KEY = process.argv[2] || "";

async function separator(title: string) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60) + "\n");
}

async function main() {
  console.log("🚀 QualityControl MCP Server — Test de Conexión\n");
  console.log(`API Base URL: ${config.API_BASE_URL}`);
  console.log(`Encryption Key: ${config.ENCRYPTION_KEY.substring(0, 8)}...`);
  console.log(`Session TTL: ${config.SESSION_TTL_HOURS}h`);

  // ─── Test 1: Healthcheck ───────────────────────────────────────
  await separator("TEST 1: Healthcheck");
  const healthResult = await healthcheckTool.handler({} as never);
  console.log(healthResult.content[0].text);

  // ─── Test 2: Sin sesión (debe pedir API Key) ──────────────────
  await separator("TEST 2: Sin API Key → Debe pedir la key");
  const noKeyResult = await connectCompanyTool.handler({});
  console.log(noKeyResult.content[0].text);

  if (!TEST_API_KEY) {
    console.log("\n⚠️  Para continuar los tests, pasa tu API Key como argumento:");
    console.log("   npx tsx test/test_connection.ts TU_API_KEY\n");
    return;
  }

  // ─── Test 3: Cifrado de API Key ───────────────────────────────
  await separator("TEST 3: Cifrado/Descifrado de API Key");
  const encrypted = encrypt(TEST_API_KEY);
  const decrypted = decrypt(encrypted);
  console.log(`Original (masked): ${maskApiKey(TEST_API_KEY)}`);
  console.log(`Cifrada: ${encrypted.substring(0, 40)}...`);
  console.log(`Descifrada OK: ${decrypted === TEST_API_KEY ? "✅ SÍ" : "❌ NO"}`);

  // ─── Test 4: Validar API Key contra la API real ────────────────
  await separator("TEST 4: Validar API Key contra la API");
  const validationResult = await apiClient.validateApiKey(TEST_API_KEY);
  console.log(`Respuesta OK: ${validationResult.success ? "✅" : "❌"}`);
  console.log(`Total dispositivos: ${validationResult.total ?? "N/A"}`);
  if (validationResult.error) {
    console.log(`Error: ${validationResult.error}`);
  }

  // ─── Test 5: Connect Company (flujo completo) ──────────────────
  await separator("TEST 5: connect_company con API Key válida");
  const connectResult = await connectCompanyTool.handler({ api_key: TEST_API_KEY });
  console.log(connectResult.content[0].text);
  console.log(`\nSesión activa: ${sessionManager.hasActiveSession() ? "✅" : "❌"}`);

  // ─── Test 6: Obtener dispositivos ──────────────────────────────
  await separator("TEST 6: get_devices (con sesión activa)");
  const devicesResult = await getDevicesTool.handler({} as never);
  console.log(devicesResult.content[0].text);

  // ─── Test 7: Intentar conectar de nuevo (ya conectado) ─────────
  await separator("TEST 7: connect_company (ya conectado → debe informar)");
  const reConnectResult = await connectCompanyTool.handler({ api_key: TEST_API_KEY });
  console.log(reConnectResult.content[0].text);

  // ─── Test 8: Desconectar ──────────────────────────────────────
  await separator("TEST 8: disconnect_company");
  const disconnectResult = await disconnectCompanyTool.handler({} as never);
  console.log(disconnectResult.content[0].text);
  console.log(`\nSesión activa: ${sessionManager.hasActiveSession() ? "✅" : "❌ (correctamente desconectada)"}`);

  // ─── Test 9: Sin sesión post-desconexión ───────────────────────
  await separator("TEST 9: get_devices sin sesión (debe fallar)");
  const noSessionResult = await getDevicesTool.handler({} as never);
  console.log(noSessionResult.content[0].text);
  console.log(`isError: ${noSessionResult.isError ? "✅ (correcto)" : "❌"}`);

  await separator("✅ TODOS LOS TESTS COMPLETADOS");
}

main().catch((err) => {
  console.error("❌ Error fatal:", err.message);
  process.exit(1);
});

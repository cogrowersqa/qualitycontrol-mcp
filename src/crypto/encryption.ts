import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "../config/index.js";
import type { EncryptedData } from "../types/index.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Cifra una API Key usando AES-256-GCM.
 * Genera un IV único por cada operación.
 */
export function encrypt(plaintext: string): string {
  const key = Buffer.from(config.ENCRYPTION_KEY, "hex");
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  const encrypted: EncryptedData = {
    iv: iv.toString("hex"),
    authTag,
    ciphertext,
  };

  // Formato almacenado: iv:authTag:ciphertext
  return `${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`;
}

/**
 * Descifra una API Key cifrada con AES-256-GCM.
 */
export function decrypt(encryptedString: string): string {
  const [ivHex, authTagHex, ciphertext] = encryptedString.split(":");

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error("Formato de datos cifrados inválido");
  }

  const key = Buffer.from(config.ENCRYPTION_KEY, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");

  return plaintext;
}

/**
 * Genera un hash SHA-256 de la API Key para búsqueda rápida.
 * No se usa para descifrar, solo para identificar la sesión.
 */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Enmascara una API Key para logs seguros.
 * Ejemplo: "ak_7f8a9b2c..." → "ak_***REDACTED***"
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) {
    return "***REDACTED***";
  }
  const prefix = apiKey.substring(0, 4);
  return `${prefix}***REDACTED***`;
}

# QualityControl MCP Server — Arquitectura Empresarial

## Resumen Ejecutivo

Servidor MCP (Model Context Protocol) que actúa como capa intermedia entre ChatGPT y la API REST de QualityControl. Permite a los usuarios interactuar con la información de su empresa mediante lenguaje natural, sin acceso directo a bases de datos.

---

## 1. Stack Tecnológico

| Componente | Tecnología |
|---|---|
| Lenguaje | TypeScript 5.x |
| Runtime | Node.js 20+ LTS |
| SDK | @modelcontextprotocol/sdk (oficial) |
| Transporte | stdio (estándar MCP) |
| HTTP Client | node-fetch / undici |
| Cifrado | Node.js crypto (AES-256-GCM) |
| Sesiones | In-memory + archivo JSON cifrado |
| Logs | Winston (sin datos sensibles) |
| Caché | In-memory con TTL |

---

## 2. Arquitectura General

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USUARIO FINAL                                   │
│                    (ChatGPT / Claude Desktop)                            │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │ Lenguaje Natural
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        MODELO LLM (GPT/Claude)                          │
│                   Interpreta intención del usuario                       │
│                   Selecciona Tool MCP apropiado                          │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │ Tool Call (MCP Protocol)
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SERVIDOR MCP AGROCLIMATE                           │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  Tools   │  │ Sessions │  │  Cache   │  │  Crypto  │              │
│  │ Registry │  │ Manager  │  │ Manager  │  │  Module  │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │              │              │                     │
│       ▼              ▼              ▼              ▼                     │
│  ┌──────────────────────────────────────────────────────┐              │
│  │              API CLIENT (HTTP Layer)                   │              │
│  │         Headers: Authorization: Bearer {KEY}          │              │
│  └──────────────────────────┬───────────────────────────┘              │
└─────────────────────────────┼───────────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        API REST AGROCLIMATE                              │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐           │
│  │  Dispositivos  │  │   Historial    │  │     Clima      │           │
│  └────────────────┘  └────────────────┘  └────────────────┘           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐           │
│  │    Cosecha     │  │     Bins       │  │  Exportaciones │           │
│  └────────────────┘  └────────────────┘  └────────────────┘           │
│                                                                          │
│              ┌─────────────────────────┐                                │
│              │  SQL Server (interno)   │                                │
│              │  NUNCA expuesto al MCP  │                                │
│              └─────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Flujo Completo de Conexión

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ Usuario  │         │   LLM    │         │   MCP    │         │   API    │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │  "Hola"            │                     │                     │
     │────────────────────>│                     │                     │
     │                     │  connect_company()  │                     │
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │  "No hay sesión,    │                     │
     │                     │   pide API Key"     │                     │
     │                     │<────────────────────│                     │
     │                     │                     │                     │
     │  "Pega tu API Key" │                     │                     │
     │<────────────────────│                     │                     │
     │                     │                     │                     │
     │  "ak_xxxxxxxxxxxx" │                     │                     │
     │────────────────────>│                     │                     │
     │                     │  connect_company    │                     │
     │                     │  (api_key=ak_xxx)   │                     │
     │                     │────────────────────>│                     │
     │                     │                     │  GET /dispositivos  │
     │                     │                     │  Bearer ak_xxx      │
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │  200 OK + JSON      │
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │                     │  Crear Sesión       │
     │                     │                     │  Cifrar API Key     │
     │                     │                     │                     │
     │                     │  "Conectado OK"     │                     │
     │                     │<────────────────────│                     │
     │                     │                     │                     │
     │  "Empresa conectada│                     │                     │
     │   correctamente"   │                     │                     │
     │<────────────────────│                     │                     │
     │                     │                     │                     │
```

---

## 4. Flujo de Consulta (Post-Conexión)

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ Usuario  │         │   LLM    │         │   MCP    │         │   API    │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │  "¿Cuántos bins    │                     │                     │
     │   llevo hoy?"      │                     │                     │
     │────────────────────>│                     │                     │
     │                     │                     │                     │
     │                     │  get_bins_today     │                     │
     │                     │  (session_id=xxx)   │                     │
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │                     │  Buscar sesión      │
     │                     │                     │  Descifrar API Key  │
     │                     │                     │                     │
     │                     │                     │  GET /bins?fecha=hoy│
     │                     │                     │  Bearer ak_xxx      │
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │  200 OK             │
     │                     │                     │  { bins: [...] }    │
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │  JSON resumido      │                     │
     │                     │<────────────────────│                     │
     │                     │                     │                     │
     │  "Hoy llevas 142   │                     │                     │
     │   bins de cereza"  │                     │                     │
     │<────────────────────│                     │                     │
```

---

## 5. Flujo de Renovación de Sesión

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│ Usuario  │         │   LLM    │         │   MCP    │
└────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │
     │  "¿Cuántos bins?"  │                     │
     │────────────────────>│                     │
     │                     │  get_bins_today     │
     │                     │────────────────────>│
     │                     │                     │
     │                     │                     │  Sesión encontrada
     │                     │                     │  Último acceso > 30min
     │                     │                     │  pero < 24h
     │                     │                     │
     │                     │                     │  Renovar sesión
     │                     │                     │  Actualizar último acceso
     │                     │                     │  Continuar normalmente
     │                     │                     │
     │                     │  Respuesta normal   │
     │                     │<────────────────────│
     │                     │                     │
```

---

## 6. Flujo de Cierre de Sesión

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│ Usuario  │         │   LLM    │         │   MCP    │
└────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │
     │  "Desconectar"     │                     │
     │────────────────────>│                     │
     │                     │ disconnect_company  │
     │                     │────────────────────>│
     │                     │                     │
     │                     │                     │  Buscar sesión
     │                     │                     │  Eliminar API Key
     │                     │                     │  Marcar inactiva
     │                     │                     │  Limpiar caché
     │                     │                     │
     │                     │  "Desconectado"     │
     │                     │<────────────────────│
     │                     │                     │
     │  "Empresa           │                     │
     │   desconectada"    │                     │
     │<────────────────────│                     │
```

---

## 7. Administración de Sesiones

### Estructura de Sesión

```
┌─────────────────────────────────────────────────────┐
│                    SESSION                            │
├─────────────────────────────────────────────────────┤
│  session_id        │  UUID v4                        │
│  api_key_encrypted │  AES-256-GCM (cifrada)         │
│  api_key_hash      │  SHA-256 (para búsqueda)       │
│  company_name      │  string | null                  │
│  user_name         │  string | null                  │
│  role              │  string | null                  │
│  device_count      │  number                         │
│  created_at        │  ISO 8601                       │
│  last_access       │  ISO 8601                       │
│  expires_at        │  ISO 8601                       │
│  status            │  active | expired | revoked     │
└─────────────────────────────────────────────────────┘
```

### Ciclo de Vida

| Evento | Acción |
|---|---|
| connect_company exitoso | Crear sesión, cifrar key, estado = active |
| Cualquier tool call | Actualizar last_access, renovar si necesario |
| 24h sin actividad | Estado = expired |
| disconnect_company | Estado = revoked, borrar key cifrada |
| Cleanup automático | Eliminar sesiones expired > 48h |

---

## 8. Cifrado de API Key

### Algoritmo: AES-256-GCM

```
┌─────────────────────────────────────────────┐
│           CIFRADO DE API KEY                 │
├─────────────────────────────────────────────┤
│                                              │
│  API Key (plaintext)                         │
│       │                                      │
│       ▼                                      │
│  ┌──────────────────────┐                   │
│  │  AES-256-GCM Encrypt │                   │
│  │  Key: ENCRYPTION_KEY │                   │
│  │  IV: random 16 bytes │                   │
│  └──────────┬───────────┘                   │
│             │                                │
│             ▼                                │
│  ┌──────────────────────┐                   │
│  │  iv:authTag:cipher   │  (almacenado)     │
│  └──────────────────────┘                   │
│                                              │
│  + SHA-256 hash (para búsqueda rápida)      │
│                                              │
└─────────────────────────────────────────────┘
```

### Protecciones

- La ENCRYPTION_KEY se almacena SOLO en variable de entorno
- Nunca se loguea la API Key (ni cifrada ni en texto plano)
- En logs aparece como `ak_***REDACTED***`
- IV único por cada cifrado (previene ataques de repetición)
- AuthTag garantiza integridad

---

## 9. Detección de Sesión Inexistente

```
┌─────────────────────────────────────────────────────┐
│           DETECCIÓN DE SESIÓN                        │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Tool recibe llamada                                 │
│       │                                              │
│       ▼                                              │
│  ¿Se proporcionó session_id?                         │
│       │                                              │
│  ┌────┴────┐                                        │
│  │NO       │SI                                      │
│  │         ▼                                        │
│  │    ¿Existe en store?                             │
│  │         │                                        │
│  │    ┌────┴────┐                                   │
│  │    │NO       │SI                                 │
│  │    │         ▼                                   │
│  │    │    ¿Está activa?                            │
│  │    │         │                                   │
│  │    │    ┌────┴────┐                              │
│  │    │    │NO       │SI                            │
│  │    │    │         ▼                              │
│  │    │    │    ¿Expirada?                          │
│  │    │    │         │                              │
│  │    │    │    ┌────┴────┐                         │
│  │    │    │    │SI       │NO                       │
│  │    │    │    │         ▼                         │
│  │    │    │    │    CONTINUAR                      │
│  │    │    │    │    (renovar last_access)          │
│  │    │    │    │                                   │
│  ▼    ▼    ▼    ▼                                   │
│  RESPONDER: "Necesito tu API Key para conectar"     │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 10. Diseño de Tools MCP

### 10.1 connect_company

| Campo | Valor |
|---|---|
| **Nombre** | `connect_company` |
| **Descripción** | Conecta una empresa al MCP validando la API Key contra la API REST |
| **Entrada** | `{ api_key?: string }` |
| **Salida** | Mensaje de éxito con info de empresa o solicitud de API Key |
| **HTTP** | `GET {BASE_URL}/api_clientes_dispositivos.php` |
| **Headers** | `Authorization: Bearer {api_key}` |
| **Respuesta API** | `{ success: true, data: [...], empresa: "...", usuario: "..." }` |
| **Resumen** | "Empresa {nombre} conectada. {N} dispositivos encontrados." |

### 10.2 disconnect_company

| Campo | Valor |
|---|---|
| **Nombre** | `disconnect_company` |
| **Descripción** | Desconecta la empresa actual y elimina la sesión |
| **Entrada** | `{ session_id: string }` |
| **Salida** | Confirmación de desconexión |
| **HTTP** | Ninguna (operación local) |
| **Resumen** | "Empresa desconectada correctamente." |

### 10.3 get_devices

| Campo | Valor |
|---|---|
| **Nombre** | `get_devices` |
| **Descripción** | Obtiene la lista de dispositivos/sensores de la empresa |
| **Entrada** | `{ session_id: string }` |
| **Salida** | Lista de dispositivos con estado |
| **HTTP** | `GET {BASE_URL}/api_clientes_dispositivos.php` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: [{ id, nombre, tipo, estado, ... }] }` |
| **Resumen** | "Tienes {N} dispositivos: {lista con estado}." |

### 10.4 get_sensor_history

| Campo | Valor |
|---|---|
| **Nombre** | `get_sensor_history` |
| **Descripción** | Obtiene historial de lecturas de un sensor |
| **Entrada** | `{ session_id: string, device_id?: string, fecha_inicio?: string, fecha_fin?: string }` |
| **Salida** | Historial de lecturas |
| **HTTP** | `GET {BASE_URL}/api_clientes_historial.php?device_id={id}&desde={inicio}&hasta={fin}` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: [{ fecha, valor, unidad, ... }] }` |
| **Resumen** | "Historial del sensor {nombre}: {resumen de lecturas}." |

### 10.5 get_weather

| Campo | Valor |
|---|---|
| **Nombre** | `get_weather` |
| **Descripción** | Obtiene información climática actual y pronóstico |
| **Entrada** | `{ session_id: string, ubicacion?: string }` |
| **Salida** | Datos meteorológicos |
| **HTTP** | `GET {BASE_URL}/api_clientes_clima.php` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: { temp, humedad, viento, pronostico } }` |
| **Resumen** | "Clima actual: {temp}°C, humedad {h}%, viento {v} km/h." |

### 10.6 get_bins_today

| Campo | Valor |
|---|---|
| **Nombre** | `get_bins_today` |
| **Descripción** | Obtiene el conteo de bins del día actual |
| **Entrada** | `{ session_id: string, variedad?: string }` |
| **Salida** | Conteo y detalle de bins |
| **HTTP** | `GET {BASE_URL}/api_clientes_bins.php?fecha=hoy` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: { total, por_variedad: [...] } }` |
| **Resumen** | "Hoy llevas {total} bins. Detalle: {por variedad}." |

### 10.7 get_harvest

| Campo | Valor |
|---|---|
| **Nombre** | `get_harvest` |
| **Descripción** | Obtiene información de cosecha |
| **Entrada** | `{ session_id: string, variedad?: string, fecha?: string }` |
| **Salida** | Datos de cosecha |
| **HTTP** | `GET {BASE_URL}/api_clientes_cosecha.php?variedad={v}&fecha={f}` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: { kilos, bins, variedades: [...] } }` |
| **Resumen** | "Cosecha: {kilos} kg en {bins} bins. Variedades: {lista}." |

### 10.8 get_exports

| Campo | Valor |
|---|---|
| **Nombre** | `get_exports` |
| **Descripción** | Obtiene información de exportaciones |
| **Entrada** | `{ session_id: string, fecha_inicio?: string, fecha_fin?: string }` |
| **Salida** | Datos de exportación |
| **HTTP** | `GET {BASE_URL}/api_clientes_exportaciones.php?desde={inicio}&hasta={fin}` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: { total_kilos, destinos: [...] } }` |
| **Resumen** | "Exportaciones: {total} kg a {N} destinos." |

### 10.9 get_dispatches

| Campo | Valor |
|---|---|
| **Nombre** | `get_dispatches` |
| **Descripción** | Obtiene despachos pendientes o realizados |
| **Entrada** | `{ session_id: string, estado?: "pendiente" \| "completado" \| "todos" }` |
| **Salida** | Lista de despachos |
| **HTTP** | `GET {BASE_URL}/api_clientes_despachos.php?estado={estado}` |
| **Headers** | `Authorization: Bearer {api_key_descifrada}` |
| **Respuesta API** | `{ success: true, data: [{ id, destino, kilos, estado, fecha }] }` |
| **Resumen** | "Tienes {N} despachos pendientes por {total} kg." |

### 10.10 company_info

| Campo | Valor |
|---|---|
| **Nombre** | `company_info` |
| **Descripción** | Muestra información de la empresa conectada |
| **Entrada** | `{ session_id: string }` |
| **Salida** | Datos de la sesión actual |
| **HTTP** | Ninguna (datos de sesión local) |
| **Resumen** | "Empresa: {nombre}. Usuario: {user}. Rol: {rol}. Dispositivos: {N}." |

### 10.11 healthcheck

| Campo | Valor |
|---|---|
| **Nombre** | `healthcheck` |
| **Descripción** | Verifica el estado del servidor MCP y la conectividad con la API |
| **Entrada** | `{}` |
| **Salida** | Estado del servidor |
| **HTTP** | `GET {BASE_URL}/api_clientes_dispositivos.php` (con key de test si existe) |
| **Resumen** | "MCP activo. API: {status}. Sesiones activas: {N}." |

---

## 11. Ejemplo Detallado: "¿Cómo va mi cosecha de Santina?"

```
PASO 1: Usuario escribe en ChatGPT
─────────────────────────────────────
"¿Cómo va mi cosecha de Santina?"

PASO 2: LLM interpreta la intención
─────────────────────────────────────
- Intención: consultar cosecha
- Variedad: Santina
- Selecciona tool: get_harvest
- Parámetros: { session_id: "current", variedad: "Santina" }

PASO 3: MCP recibe la llamada
─────────────────────────────────────
Tool: get_harvest
Input: { session_id: "abc-123-def", variedad: "Santina" }

PASO 4: Validación de sesión
─────────────────────────────────────
- Buscar sesión "abc-123-def" en SessionStore
- Estado: active ✓
- Último acceso: hace 5 minutos ✓
- Actualizar last_access = now()

PASO 5: Descifrar API Key
─────────────────────────────────────
- Obtener api_key_encrypted de la sesión
- Descifrar con AES-256-GCM
- Resultado: "ak_7f8a9b2c3d4e5f6g..."

PASO 6: Llamada HTTP a la API
─────────────────────────────────────
GET https://api.agroclimate.cl/api_clientes_cosecha.php?variedad=Santina
Headers:
  Authorization: Bearer ak_7f8a9b2c3d4e5f6g...
  Content-Type: application/json
  X-MCP-Request-ID: req_uuid_456

PASO 7: Respuesta de la API
─────────────────────────────────────
HTTP 200 OK
{
  "success": true,
  "data": {
    "variedad": "Santina",
    "temporada": "2025-2026",
    "total_kilos": 45230,
    "total_bins": 142,
    "kilos_hoy": 3200,
    "bins_hoy": 10,
    "rendimiento_promedio": 318.5,
    "porcentaje_avance": 67.3,
    "ultima_actualizacion": "2026-07-26T14:30:00Z"
  }
}

PASO 8: MCP construye respuesta
─────────────────────────────────────
{
  "content": [
    {
      "type": "text",
      "text": "Datos de cosecha de Santina (temporada 2025-2026):\n
              - Total acumulado: 45,230 kg en 142 bins\n
              - Hoy: 3,200 kg en 10 bins\n
              - Rendimiento promedio: 318.5 kg/bin\n
              - Avance de temporada: 67.3%\n
              - Última actualización: 26/07/2026 14:30"
    }
  ]
}

PASO 9: LLM genera respuesta natural
─────────────────────────────────────
"Tu cosecha de Santina va muy bien. Llevas 45,230 kilos en 142 bins
esta temporada, con un avance del 67.3%. Hoy sumaste 10 bins más
(3,200 kg). El rendimiento promedio es de 318.5 kg por bin."
```

---

## 12. Escalabilidad — Agregar Nuevos Tools

Para agregar un nuevo endpoint (ej: packing), solo se necesita:

1. Crear archivo `src/tools/get_packing.ts`
2. Seguir la interfaz `ToolDefinition`
3. Registrar en `src/tools/index.ts`

**No se modifica:**
- El servidor principal
- El manejo de sesiones
- El cliente HTTP
- El cifrado
- Los logs

```typescript
// src/tools/get_packing.ts — Ejemplo de nuevo tool
export const getPackingTool: ToolDefinition = {
  name: "get_packing",
  description: "Obtiene información de packing",
  inputSchema: { ... },
  handler: async (params, session) => {
    return apiClient.get("/api_clientes_packing.php", params, session.apiKey);
  }
};
```

---

## 13. Variables de Entorno

```env
# API
API_BASE_URL=https://api.agroclimate.cl
API_TIMEOUT_MS=30000

# Cifrado
ENCRYPTION_KEY=<64-char-hex-key>

# Sesiones
SESSION_TTL_HOURS=24
SESSION_CLEANUP_INTERVAL_MIN=60

# Cache
CACHE_TTL_SECONDS=300
CACHE_MAX_ENTRIES=1000

# Logs
LOG_LEVEL=info
LOG_DIR=./logs

# Server
NODE_ENV=production
```

---

## 14. Seguridad

| Control | Implementación |
|---|---|
| API Key cifrada en reposo | AES-256-GCM |
| API Key nunca en logs | Sanitización automática |
| Sesiones con expiración | TTL de 24 horas |
| Transporte seguro | HTTPS hacia la API |
| Sin acceso a DB | Arquitectura por diseño |
| Sin validación de permisos | Delegado 100% a la API |
| Rate limiting | Configurable por sesión |
| Auditoría | Log de cada tool call (sin datos sensibles) |

---

## 15. Estructura de Carpetas Final

```
AgroClimate/
├── src/
│   ├── api/
│   │   └── client.ts              # HTTP client para la API REST
│   ├── cache/
│   │   └── manager.ts             # Cache in-memory con TTL
│   ├── config/
│   │   └── index.ts               # Configuración centralizada
│   ├── crypto/
│   │   └── encryption.ts          # AES-256-GCM cifrado/descifrado
│   ├── logger/
│   │   └── index.ts               # Winston logger con sanitización
│   ├── sessions/
│   │   ├── store.ts               # Almacenamiento de sesiones
│   │   └── manager.ts             # Lógica de sesiones
│   ├── tools/
│   │   ├── index.ts               # Registro de tools
│   │   ├── connect_company.ts     # Tool: conectar empresa
│   │   ├── disconnect_company.ts  # Tool: desconectar
│   │   ├── get_devices.ts         # Tool: dispositivos
│   │   ├── get_sensor_history.ts  # Tool: historial
│   │   ├── get_weather.ts         # Tool: clima
│   │   ├── get_bins_today.ts      # Tool: bins del día
│   │   ├── get_harvest.ts         # Tool: cosecha
│   │   ├── get_exports.ts         # Tool: exportaciones
│   │   ├── get_dispatches.ts      # Tool: despachos
│   │   ├── company_info.ts        # Tool: info empresa
│   │   └── healthcheck.ts         # Tool: estado del servidor
│   ├── types/
│   │   └── index.ts               # Interfaces y tipos
│   └── index.ts                   # Entry point del servidor MCP
├── .env.example                    # Template de variables de entorno
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

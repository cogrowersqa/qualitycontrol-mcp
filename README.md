# QualityControl MCP Server

Servidor MCP (Model Context Protocol) que conecta ChatGPT/Claude con la API REST de QualityControl, permitiendo a los usuarios consultar información de su empresa mediante lenguaje natural.

## Requisitos

- Node.js 20+ LTS
- npm 10+

## Instalación

```bash
# Instalar dependencias
npm install

# Copiar variables de entorno
cp .env.example .env

# Generar ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Editar .env con la URL de la API y la ENCRYPTION_KEY generada
```

## Compilar

```bash
npm run build
```

## Ejecutar (desarrollo)

```bash
npm run dev
```

## Configuración en ChatGPT / Claude Desktop

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "qualitycontrol": {
      "command": "node",
      "args": ["C:/Repositorio/MCP/QualityControl/dist/index.js"],
      "env": {
        "API_BASE_URL": "https://developers.cogrowers.cl/heladas",
        "ENCRYPTION_KEY": "<tu-key-64-hex>",
        "LOG_LEVEL": "info",
        "LOG_DIR": "./logs",
        "NODE_ENV": "production",
        "SESSION_TTL_HOURS": "24",
        "SESSION_CLEANUP_INTERVAL_MIN": "60",
        "CACHE_TTL_SECONDS": "300",
        "CACHE_MAX_ENTRIES": "1000",
        "API_TIMEOUT_MS": "30000",
        "API_VALIDATE_ENDPOINT": "api_toda_info.php",
        "API_DEVICES_ENDPOINT": "api_toda_info.php",
        "API_HISTORY_ENDPOINT": "api_toda_info.php",
        "API_WEATHER_ENDPOINT": "api_toda_info.php"
      }
    }
  }
}
```

### ChatGPT (Custom GPT con Actions)

Para ChatGPT, se requiere un wrapper HTTP. Consulta la documentación de OpenAI para configurar un GPT Action que apunte al servidor MCP.

## Herramientas Disponibles

| Tool | Descripción |
|------|-------------|
| `connect_company` | Conecta una empresa validando la API Key |
| `disconnect_company` | Desconecta la empresa y cierra sesión |
| `get_devices` | Lista dispositivos/sensores |
| `get_sensor_history` | Historial de lecturas |
| `get_weather` | Información climática |
| `get_bins_today` | Bins recolectados hoy |
| `get_harvest` | Información de cosecha |
| `get_exports` | Datos de exportación |
| `get_dispatches` | Despachos pendientes/completados |
| `company_info` | Info de empresa conectada |
| `healthcheck` | Estado del servidor |

## Agregar Nuevos Tools

1. Crear `src/tools/nuevo_tool.ts` siguiendo la estructura existente
2. Importar y agregar al array en `src/tools/index.ts`
3. Compilar: `npm run build`

No se requiere modificar el servidor principal ni ningún otro módulo.

## Arquitectura

Consultar [ARCHITECTURE.md](./ARCHITECTURE.md) para el documento completo de arquitectura.

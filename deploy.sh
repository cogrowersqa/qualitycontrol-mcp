#!/bin/bash
# ─── Deploy QualityControl MCP Server ──────────────────────────────
# Ejecutar en el servidor como root o con permisos adecuados
#
# Uso:
#   chmod +x deploy.sh
#   ./deploy.sh

set -e

APP_DIR="/opt/bitnami/apache2/htdocs/mcp/qualitycontrol"
APP_NAME="qualitycontrol-mcp"

echo "═══════════════════════════════════════════════════"
echo "  Deploying QualityControl MCP Server"
echo "═══════════════════════════════════════════════════"

# 1. Crear directorio si no existe
if [ ! -d "$APP_DIR" ]; then
  echo "📁 Creando directorio $APP_DIR..."
  mkdir -p "$APP_DIR"
fi

# 2. Copiar archivos (asume que ya los subiste con scp/rsync)
echo "📦 Verificando archivos..."
cd "$APP_DIR"

if [ ! -f "package.json" ]; then
  echo "❌ Error: No se encontró package.json en $APP_DIR"
  echo "   Primero sube los archivos con:"
  echo "   scp -r ./* mnavarrete@instance-qa:~/qualitycontrol-mcp/"
  exit 1
fi

# 3. Instalar dependencias de producción
echo "📥 Instalando dependencias..."
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# 4. Crear directorio de logs
mkdir -p logs

# 5. Verificar .env
if [ ! -f ".env" ]; then
  if [ -f ".env.production" ]; then
    cp .env.production .env
    echo "⚠️  Archivo .env creado desde .env.production"
    echo "   IMPORTANTE: Edita .env y cambia ENCRYPTION_KEY"
    echo "   Genera una nueva con: openssl rand -hex 32"
  else
    echo "❌ Error: No se encontró .env ni .env.production"
    exit 1
  fi
fi

# 6. Verificar que dist/ existe
if [ ! -d "dist" ]; then
  echo "❌ Error: No se encontró dist/ (código compilado)"
  echo "   Compila antes de subir: npm run build"
  exit 1
fi

# 7. Detener app anterior si existe
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  echo "🔄 Deteniendo instancia anterior..."
  pm2 delete "$APP_NAME"
fi

# 8. Iniciar con PM2
echo "🚀 Iniciando con PM2..."
pm2 start ecosystem.config.cjs

# 9. Guardar config PM2
pm2 save

# 10. Verificar que inició correctamente
sleep 2
if pm2 describe "$APP_NAME" | grep -q "online"; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  ✅ QualityControl MCP Server desplegado!"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  URL:    http://localhost:3100/mcp"
  echo "  Health: http://localhost:3100/health"
  echo ""
  echo "  Comandos útiles:"
  echo "    pm2 logs $APP_NAME    — Ver logs"
  echo "    pm2 restart $APP_NAME — Reiniciar"
  echo "    pm2 stop $APP_NAME    — Detener"
  echo ""
  pm2 list
else
  echo "❌ Error al iniciar. Revisa los logs:"
  echo "   pm2 logs $APP_NAME --lines 50"
  exit 1
fi

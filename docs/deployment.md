# VM Setup

Guia base para dejar `twilio-call` desplegado en una VM Ubuntu con `Nginx + Certbot + systemd`.

## 1. DNS y puertos

- Crea un subdominio como `calls.tudominio.com`
- Apunta ese subdominio a la IP publica de la VM
- Abre `80/tcp` y `443/tcp`

## 2. Paquetes base

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx git curl docker.io docker-compose-plugin
```

Instala Node.js 22.x con tu metodo preferido. Ejemplo con NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 3. Directorios de despliegue

```bash
sudo mkdir -p /srv/azure-realtime-voice-apps/current
sudo chown -R "$USER":"$USER" /srv/azure-realtime-voice-apps
```

Este instructivo asume que GitHub Actions copiara el proyecto dentro de:

```bash
/srv/azure-realtime-voice-apps/current
```

Usa ese mismo valor en el secret `DEPLOY_PATH`.

## 4. Configuracion de entorno

La configuracion de runtime queda fuera del repo y la carga `systemd` desde:

```bash
/etc/twilio-call.env
```

Puedes crearlo manualmente para la primera puesta en marcha:

```bash
sudo tee /etc/twilio-call.env >/dev/null <<'EOF'
TWILIO_CALL_HOST=127.0.0.1
TWILIO_CALL_PORT=8090
PUBLIC_BASE_URL=https://calls.tudominio.com
TWILIO_CALL_TRIGGER_TOKEN=<token largo>
AZURE_OPENAI_ENDPOINT=<endpoint>
AZURE_OPENAI_API_KEY=<api-key>
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-realtime-mini
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<token>
TWILIO_FROM_NUMBER=<numero>
TWILIO_TO_NUMBER=<numero-opcional>
REDIS_URL=redis://127.0.0.1:6379
BULLMQ_QUEUE_NAME=outbound-calls
MAX_CONCURRENT_CALLS=1
EOF
sudo chmod 600 /etc/twilio-call.env
```

Luego GitHub Actions lo actualizara con los secrets del repo.

## 5. Nginx

Edita `infra/nginx/twilio-call.conf` y reemplaza `calls.example.com` por tu dominio.

```bash
sudo cp /srv/azure-realtime-voice-apps/current/infra/nginx/twilio-call.conf \
  /etc/nginx/sites-available/twilio-call.conf
sudo ln -s /etc/nginx/sites-available/twilio-call.conf /etc/nginx/sites-enabled/twilio-call.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 6. HTTPS con Certbot

```bash
sudo certbot --nginx -d calls.tudominio.com
```

Verifica renovacion:

```bash
sudo certbot renew --dry-run
```

## 7. systemd

Edita `infra/systemd/twilio-call.service` si necesitas otro usuario o ruta.

```bash
sudo cp /srv/azure-realtime-voice-apps/current/infra/systemd/twilio-call.service \
  /etc/systemd/system/twilio-call.service
sudo systemctl daemon-reload
sudo systemctl enable --now twilio-call.service
```

Logs:

```bash
sudo journalctl -u twilio-call.service -f
```

## 8. Validaciones

Inicia Redis antes del servicio Node.js:

```bash
cd /srv/azure-realtime-voice-apps/current
sudo docker compose -f infra/redis-compose.yml up -d
```

```bash
curl http://127.0.0.1:8090/health
curl https://calls.tudominio.com/health
```

Prueba endpoint protegido:

```bash
curl -X POST https://calls.tudominio.com/twilio/call \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"to":"+56911111111","name":"Prueba","context":"Chequeo de deploy"}'
```

## 9. Secrets para GitHub Actions

Configura estos secrets en GitHub:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PORT`
- `DEPLOY_PATH`
  Valor recomendado: `/srv/azure-realtime-voice-apps/current`
- `PUBLIC_BASE_URL`
- `TWILIO_CALL_TRIGGER_TOKEN`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_API_VERSION`
- `TWILIO_CALL_VOICE`
- `TWILIO_CALL_SYSTEM_PROMPT`
- `TWILIO_CALL_VAD_THRESHOLD`
- `TWILIO_CALL_VAD_PREFIX_PADDING_MS`
- `TWILIO_CALL_VAD_SILENCE_DURATION_MS`
- `TWILIO_CALL_BARGE_IN_DEBOUNCE_MS`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `TWILIO_TO_NUMBER`
- `TWILIO_VOICE_WEBHOOK_PATH`
- `TWILIO_STATUS_WEBHOOK_PATH`
- `TWILIO_STREAM_PATH`
- `REDIS_URL`
- `BULLMQ_QUEUE_NAME`
- `MAX_CONCURRENT_CALLS`
- `MAX_CALL_ATTEMPTS`
- `CALL_RETRY_BASE_MS`

Los ultimos campos opcionales pueden omitirse si quieres mantener los defaults del codigo, pero si los declaras en GitHub quedaran centralizados ahi.

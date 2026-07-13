# IA Agent Call Center

MVP de llamadas salientes automatizadas con Twilio, Azure OpenAI Realtime y Redis/BullMQ.

## Estructura

```text
src/
  call-service/       API HTTP, worker BullMQ, bridge Twilio y agente Realtime
  shared/             Audio, variables de entorno y sesion Azure reutilizables
infra/
  nginx/              Proxy HTTPS y WebSocket
  systemd/            Servicio de produccion
  redis-compose.yml   Redis persistente para BullMQ
docs/
  deployment.md       Guia de instalacion en VM
.github/workflows/    Despliegue continuo a VM
```

## Arquitectura

- **Twilio:** crea llamadas salientes, entrega callbacks y Media Streams.
- **Azure OpenAI Realtime:** agente de voz en tiempo real.
- **Redis + BullMQ:** cola durable por contacto, reintentos y concurrencia controlada.
- **Node.js:** API de campanas, worker BullMQ y bridge de audio.
- **JSON atomico:** trazabilidad de campanas, contactos, intentos, eventos y texto basico del asistente.

## Requisitos

- Node.js 22+
- Redis 7+
- Cuenta Twilio con Media Streams
- Azure OpenAI Realtime
- URL publica HTTPS para Twilio

## Inicio local

```bash
npm install
docker compose -f infra/redis-compose.yml up -d
cp .env.example .env
npm start
```

Completa las credenciales de Azure y Twilio en `.env`. Nunca subas ese archivo al repositorio.

## Variables principales

| Variable | Descripcion |
| --- | --- |
| `PUBLIC_BASE_URL` | URL HTTPS publica del servicio. |
| `REDIS_URL` | Redis para BullMQ; por defecto `redis://127.0.0.1:6379`. |
| `MAX_CONCURRENT_CALLS` | Llamadas activas maximas; parte en `1`. |
| `CALL_STATUS_POLL_INTERVAL_MS` | Intervalo de respaldo para consultar el estado en Twilio; por defecto `5000`. |
| `CALL_STATUS_TIMEOUT_MS` | Limite para liberar un cupo sin estado terminal; por defecto `300000`. |
| `AZURE_OPENAI_*` | Endpoint, clave y deployment Azure Realtime. |
| `TWILIO_*` | Credenciales, numero origen, rutas y token de API. |

## Flujo de campana

1. Crea una campana: `POST /api/campaigns`.
2. Importa contactos CSV mediante `POST /api/campaigns/:campaignId/contacts/csv` con columnas `nombre,telefono`. La importacion solo persiste los contactos; todavia no los entrega al worker.
3. Inicia con `POST /api/campaigns/:campaignId/start`. En este momento se crean o reconstruyen los jobs BullMQ pendientes.
4. Pausa o reanuda con `/pause` y `/resume`.
5. Elimina una campana y libera sus jobs con `DELETE /api/campaigns/:campaignId`.
6. Consulta la trazabilidad en `GET /api/campaigns/:campaignId`.

Los endpoints administrativos usan `Authorization: Bearer <TWILIO_CALL_TRIGGER_TOKEN>` cuando el token esta configurado.

El worker reconcilia los intentos con la API de Twilio cuando se pierde un callback y recupera campanas `running` despues de reiniciar el servicio. Asi, una llamada atascada no bloquea indefinidamente el unico cupo de concurrencia.

## Despliegue

La configuracion para Nginx, systemd y Redis esta en `infra/`; CI/CD esta en `.github/workflows/`. Sigue `docs/deployment.md` para una VM Ubuntu.

## Verificacion

```bash
npm run check
npm test
curl http://127.0.0.1:8090/health
```

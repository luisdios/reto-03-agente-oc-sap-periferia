# Agente conversacional de órdenes SAP

Aplicación en español para revisar solicitudes de compra, validar los controles RC1–RC10, preparar una orden trazable y guardarla en un adaptador SAP simulado. Los fixtures se conservan sin cambios; el sistema escribe solo en `out/`.

## Probar en Replit

Abre la vista previa del artefacto **Agente de órdenes SAP** en el workspace. La API se publica en el mismo preview bajo `/api`. El endpoint de salud es `/api/healthz`.

Este workspace todavía no tiene una URL pública publicada. Para compartir una URL externa hay que publicar el artefacto desde Replit.

## Ejecutar localmente

Requisitos: Node.js 20+ y pnpm.

```bash
pnpm install
pnpm dev
```

La interfaz queda en `http://localhost:22663`; la API, en `http://localhost:8080/api`. `pnpm dev` inicia ambos procesos y cierra los dos al detenerlo.

La clave se lee únicamente desde el entorno del backend. En Replit, configura `GEMINI_API_KEY` en Secrets. En una terminal local, expórtala antes de iniciar:

```bash
export GEMINI_API_KEY="tu-clave"
pnpm dev
```

Consulta `.env.example` para ver las variables opcionales. No se recomienda guardar la clave en un `.env` compartido ni en el frontend.

## Comandos útiles

```bash
pnpm run typecheck
pnpm run test:oc
pnpm run demo
```

También puedes ejecutar la demo sin el servidor:

```bash
bun run demo.ts
```

La demo no llama a Gemini. **Al iniciar elimina el directorio `out/` y lo vuelve a crear** para que los números secuenciales y resultados sean reproducibles. No la ejecutes si necesitas conservar datos generados anteriormente en `out/`.

## Variables

| Variable | Valor predeterminado | Uso |
|---|---|---|
| `GEMINI_API_KEY` | Sin valor predeterminado | Clave secreta necesaria para conversar con Gemini. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Modelo con soporte oficial de function calling. |
| `AGENT_MAX_ITERATIONS` | `25` | Máximo de ciclos de herramientas por turno. |
| `AGENT_MAX_SESSION_TOKENS` | `40000` | Límite aproximado de tokens acumulados por sesión. |
| `AGENT_MAX_PROCESS_TOKENS_PER_DAY` | `200000` | Límite agregado del proceso por día UTC. |
| `API_SERVER_PORT` | `8080` | Puerto local de la API. |
| `WEB_PORT` | `22663` | Puerto local de la interfaz. |

La clave no se envía al navegador ni se incluye en los logs. `/api/healthz` informa si existe configuración, sin revelar su contenido.

## Qué incluye

- Panel de casos, chat con historial, órdenes guardadas y registro de control.
- Validación determinista con Zod y herramientas separadas del servidor HTTP.
- Confirmación en el servidor para excepciones; una respuesta del modelo no puede sustituirla.
- Proveedor y maestros consultados desde `fixtures/reto-03/`, en modo de solo lectura.
- SAP simulado, idempotencia por solicitud, evidencia en texto con SHA-256, trazabilidad JSON, `control.csv` y `log.jsonl`.
- Sesiones mantenidas en memoria; se reinician al reiniciar el servidor.

## API

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/healthz` | Estado del servidor y del proveedor configurado. |
| `GET` | `/api/cases` | Lista los seis casos y su estado de revisión. |
| `GET` | `/api/dashboard` | Métricas y actividad reciente. |
| `GET` | `/api/control` | Registro de control. |
| `GET` | `/api/sap/orders` | Órdenes guardadas en el SAP simulado. |
| `GET` | `/api/sessions/:id` | Historial en memoria de una sesión. |
| `POST` | `/api/chat` | Envía `{ "sessionId": "...", "message": "..." }`. |

## Límites del prototipo

No se conecta a SAP real. La evidencia P0 se genera en `aprobacion.txt`; la conversión a PDF P1, la lectura de archivos binarios `.xlsx`/PDF, la autenticación y la persistencia de sesiones no están incluidas. Revisa `SOLUCION.md` para la cobertura y los pasos necesarios antes de producción.

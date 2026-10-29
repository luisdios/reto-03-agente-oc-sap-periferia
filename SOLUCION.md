# Solución · Reto técnico 03

## 1. Problema en una frase

La analista de compras invierte tiempo digitando órdenes y revisando controles manualmente; el agente automatiza la lectura y preparación, pero mantiene los bloqueos y las decisiones de excepción bajo control humano.

## 2. Arquitectura

```text
React + Vite
    │ /api/*
    ▼
Express ── ciclo Gemini 3.6 Flash / function calling
    │                     │
    │                     ├── agent/prompt.md
    │                     └── artifacts/api-server/src/knowledge/
    ├── herramientas Zod ── fixtures/reto-03/ (solo lectura)
    └── SapAdapter ──────── out/sap/ordenes.jsonl
                            out/<caso>/aprobacion.txt
                            out/<caso>/trazabilidad.json
                            out/control.csv y out/log.jsonl
```

El frontend usa los clientes y esquemas generados desde `lib/api-spec/openapi.yaml`. La lógica del proceso y las herramientas viven en el artefacto de API para conservar el límite entre UI, servidor, herramientas y adaptadores del monorepo. El prompt y el conocimiento permanecen en archivos Markdown separados.

## 3. Ciclo del agente

El servidor mantiene el historial y el estado de confirmación en memoria. Gemini recibe el prompt, el historial y las cinco declaraciones de herramientas. Cada llamada se valida con Zod, se ejecuta sobre los fixtures y vuelve al modelo como resultado de herramienta. El servidor además verifica el caso seleccionado, vuelve a calcular validaciones y payloads canónicos y no confía en importes ni autorizaciones propuestos por el modelo.

El límite de iteraciones por turno es 25. Los límites de tokens son configurables: 40.000 por sesión y 200.000 por proceso en un día UTC. Se registra el uso informado por Gemini en `out/log.jsonl`. Si un caso está bloqueado no se construye ni se crea. Si tiene excepciones, se prepara evidencia y payload, queda pendiente y solo se crea tras una confirmación explícita del siguiente mensaje. Un caso limpio, como `sol-001`, se crea automáticamente. El adaptador verifica el guardado antes de responder con un número.

## 4. Modelo y costo estimado

Se eligió `gemini-3.6-flash`, modelo estable con function calling y enfoque en ciclos agénticos. Se usa el SDK oficial `@google/genai`; la clave se obtiene solo de `GEMINI_API_KEY` en el backend. La elección evita depender de `gemini-2.5-flash`, que Google retiró en octubre de 2026.

Estimación de presupuesto por caso completo: **aprox. USD 0,02** suponiendo 10.000 tokens de entrada y 2.000 de salida entre todas las rondas de herramientas. La tarifa estándar publicada por Google para Gemini 3.6 Flash es USD 0,75 por millón de tokens de entrada y USD 3,75 por millón de salida hasta el 31 de diciembre de 2026; con ese supuesto el cálculo directo es USD 0,015. La tarifa puede cambiar desde enero de 2027, el nivel gratuito aplica condiciones distintas y el consumo real depende del número de rondas. Los conteos observados se guardan para recalcular el costo real.

Fuentes oficiales consultadas el 29 de octubre de 2026: [modelo Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash) y [precios de Gemini API](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.6-flash).

## 5. Matriz de controles

| Regla | Tratamiento |
|---|---|
| RC1 · Proveedor | Busca por NIT normalizado o nombre normalizado si no hay NIT; bloquea inexistente o inactivo. |
| RC2 · Aprobación | Bloquea si falta, no contiene «Aprobado» o el remitente no está autorizado para el centro. |
| RC3 · Tope | Bloquea si el total excede el tope del aprobador autorizado. |
| RC4 · Centro/subárea | Bloquea centro inexistente o subárea no asignada. |
| RC5 · Cotización | Pide confirmación si falta, la moneda difiere o el total excede 2 % de diferencia. |
| RC6 · IVA | Deriva el indicador del proveedor y solicita confirmación si falta; bloquea un código desconocido. |
| RC7 · Pago | Deriva del maestro si falta y lo informa; bloquea un código desconocido. |
| RC8 · Retroactividad | Si la factura precede la solicitud, marca `retroactiva` y exige confirmación. |
| RC9 · Aprobación previa | Exige confirmación cuando la aprobación antecede la solicitud. |
| RC10 · Total | Bloquea si cantidad × precio unitario difiere del total por más de una unidad monetaria. |

La parte más delicada fue separar bloqueos de confirmaciones y hacer que esa diferencia sobreviva a todos los caminos de creación. La herramienta `oc_crear` repite el control en el servidor, incluso si Gemini intenta llamarla directamente.

## 6. Diseño del adaptador SAP real

Primero confirmaría versión, alcance de red y API habilitada con el equipo SAP. Si se trata de S/4HANA con servicio habilitado, evaluaría `API_PURCHASEORDER_PROCESS_SRV` mediante OData como primera opción; un SAP on-premise sin acceso directo requeriría SAP Integration Suite o un gateway administrado. No habilitaría RFC ni expondría el sistema directamente sin aprobación de arquitectura y seguridad.

El payload se mapearía a cabecera de orden (sociedad, organización de compras, proveedor, moneda, condiciones de pago) y partidas (descripción, cantidad, unidad, precio, indicador fiscal y asignación contable). Antes de crear en producción faltan datos que el esquema simplificado no incluye —por ejemplo, tipo de orden, planta, cuenta contable y clasificación de imputación— y deben obtenerse de fuentes autorizadas, no inferirse.

La autenticación viviría en un gestor de secretos del entorno de integración y usaría OAuth 2.0 o el mecanismo aprobado para ese landscape, con permisos mínimos, rotación y auditoría. La clave nunca viajaría al frontend, prompt ni logs.

`solicitud_id` sería una clave de correlación idempotente. Antes de reintentar una petición de resultado incierto, se consultaría SAP por esa referencia. Se almacenarían por separado la solicitud, la respuesta y los mensajes de retorno; un error parcial se marcaría como pendiente de reconciliación, sin reportar éxito. Si SAP no está disponible, se entrega un archivo de carga o una orden lista para revisar y digitar, junto con evidencia y trazabilidad.

## 7. Lectura del proceso

En este conjunto de prueba solo una de seis solicitudes tiene una factura fechada antes de la solicitud. Es suficiente para mostrar que el desvío se puede detectar, no para estimar una tasa real del proceso. El caso retroactivo debe medirse por solicitud y por área durante un periodo suficiente, distinguiendo «factura previa», «cotización omitida» y «aprobación fuera de secuencia». La dirección debería fijar una política explícita de excepciones, pedir que la orden se emita antes de recibir la factura y revisar mensualmente el porcentaje, valor y motivo de cada excepción. En este prototipo la factura retroactiva no se rechaza automáticamente: queda marcada, registrada y requiere confirmación.

## 8. Decisiones y trade-offs

1. **Archivos JSONL/CSV en vez de base de datos.** Se conserva el alcance del reto y se inspeccionan fácilmente los resultados. Se descartó añadir una base de datos porque la persistencia no es objetivo y aumentaría el despliegue.
2. **Reglas de negocio deterministas en el servidor.** El modelo selecciona herramientas y conversa, pero no valida importes ni cambia datos. Se descartó pedirle a Gemini que decida si una orden cumple porque el resultado no sería reproducible ni suficiente para auditoría.
3. **Evidencia TXT P0.** Se escribe el contenido completo de aprobación y su SHA-256. La generación PDF P1 se dejó fuera del alcance para no convertir el texto en un archivo cuya fidelidad no se valida.
4. **Adaptador SAP simulado.** Se persiste y verifica una orden localmente con idempotencia. Se descartó cualquier escritura real en SAP porque la viabilidad y autorización de esa conexión no están confirmadas.

## 9. Supuestos

- Los adjuntos binarios ya están normalizados a JSON/TXT, tal como indican los fixtures; no se interpreta un Excel o PDF arbitrario.
- Las fechas de solicitud están en ISO `AAAA-MM-DD`; las fechas de correo conservan su zona horaria.
- El NIT se compara por los primeros nueve dígitos cuando incluye dígito de verificación.
- `1000` es la sociedad y organización de compras del escenario de demostración.
- Una confirmación autoriza las excepciones del caso actual, no modifica la solicitud original.
- Las sesiones son temporales y no hay autenticación porque el PRD no la requiere.

## 10. Cobertura

| Historia o requisito | Estado | Pendiente para producción |
|---|---|---|
| HU-1 · Leer paquete | Hecho | Conectar extracción real de adjuntos y almacenamiento seguro. |
| HU-2 · Reglas RC1–RC10 | Hecho | Sincronizar maestros desde fuentes SAP autorizadas. |
| HU-3 · Payload y trazabilidad | Hecho | Completar campos reales requeridos por el landscape SAP. |
| HU-4 · Evidencia | Parcial: TXT P0 + SHA-256 | Crear PDF P1 y validar accesibilidad del adjunto en SAP. |
| HU-5 · SAP simulado | Hecho | Implementar, probar y autorizar el adaptador SAP real. |
| HU-6 · Errores | Hecho para errores de herramienta/modelo y JSON de entrada | Probar formatos, límites, logs y reconciliación de errores parciales. |
| Chat, confirmaciones y log | Hecho | Autenticación, persistencia y retención de sesiones. |
| Demo sin modelo | Hecho | No aplica. |
| Módulo reutilizable bonus | No hecho | Empaquetar prompt, conocimiento y herramientas como módulo independiente. |
| URL pública | Parcial | Publicar el artefacto; por ahora se prueba desde la vista previa de Replit. |

## 11. Uso de IA

Replit Agent se utilizó para implementar la interfaz, el backend, las herramientas, las pruebas y la documentación. Gemini 3.6 Flash es el modelo de ejecución de la aplicación y decide cuándo llamar herramientas, no los valores que se guardan. Se descartó que el modelo calcule o corrija montos, elija aprobadores o confirme una orden: esas decisiones provienen de validaciones deterministas y de la confirmación directa de la analista.

## 12. Riesgos y mitigaciones

- **SAP exige datos o reglas adicionales:** completar el contrato con el equipo SAP y bloquear campos desconocidos antes de habilitar escritura.
- **Adjuntos malformados o formatos nuevos:** validar estructura, conservar el archivo original y devolver errores sin fabricar valores.
- **Reintentos o errores de red con estado incierto:** usar `solicitud_id` como correlación y consultar el sistema antes de reintentar.
- **Acceso público o abuso de la clave:** configurar autenticación y cuotas antes de publicar; el prototipo aplica límites por turno, sesión y proceso, pero no reemplaza controles de identidad.
- **Persistencia local no duradera:** `out/` puede desaparecer al reiniciar o cambiar el entorno; trasladar órdenes, logs y evidencias a almacenamiento duradero y definir retención.
- **Uso de datos en un proveedor de IA:** revisar términos y clasificación antes de enviar solicitudes reales; los fixtures de este reto son ficticios.

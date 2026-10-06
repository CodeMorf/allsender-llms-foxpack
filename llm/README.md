# Código aislado del LLM de FoxPack

**Snapshot del 2026-10-07** del código que hace funcionar al asistente de FoxPack dentro de AllSender.

Está **aislado a propósito**: la aplicación completa tiene cambios fuera del SaaS (plataforma, canales,
paneles) y aquí solo se copia **lo que pertenece al LLM y sus funciones**. Nada de este código se ejecuta
solo: necesita el resto de `wapi-api` (modelos, canales, base de datos).

> **Sin secretos**: no hay claves, tokens, contraseñas ni datos personales (se verificó archivo por archivo).
> Las claves viven en `.env` del servidor y en `user_settings` del cliente.

---

## 1. Qué incluye

| Archivo | Rol | Puntos de entrada |
| --- | --- | --- |
| `services/branch-router.service.js` **(el cerebro)** | Arma el prompt, llama al modelo, interpreta el JSON de contrato y ejecuta la decisión: responder, transferir, consultar tracking, buscar productos. También los caminos deterministas de respaldo. | `processIncomingMessage()`, `handleAiMode()`, `handleDeterministicMode()`, `executeBranchTransfer()`, `sendReply()`, `enviarImagenesOfertas()` |
| `services/omnicall.service.js` **(capa del modelo)** | `chatCompletion()`: normaliza la base URL, crea el proveedor con el AI SDK, aplica modo JSON, temperatura, timeout y reintentos, y recorre la cadena de respaldo. Devuelve `{ success, json, text, provider, model, errors }`. | `chatCompletion()`, `createModel()`, `parseJsonSafely()` |
| `services/amazon-deals-live.service.js` **(manos: ofertas)** | Consulta Amazon **en vivo** (Prime + en oferta + ≤ US$199), descarga el HTML (directo; Firecrawl solo si bloquea), lo **parsea en local** (sin IA) y devuelve **máximo 3** productos con precio de antes y de ahora. No guarda nada. | `buscar()`, `searchUrl()`, `extraerConsulta()` |
| `services/foxpack-tracking.service.js` **(manos: tracking)** | Ejecutor determinista del courier: consulta el estado real de un paquete y redacta con datos verificados. | `handleTrackingQuestion()` y sus consultas |
| `services/knowledge-retrieval.service.js` **(corteza: RAG)** | Recupera el conocimiento del negocio: fragmenta los documentos, puntúa por relevancia, inyecta siempre los `policy` y respeta un presupuesto de 9.000 caracteres. | `obtenerConocimientoRelevante({ workspaceId, query })` |
| `services/handoff-ack.service.js` | Acuse cuando un caso pasa a una persona (con candado para no repetirlo en el mismo turno). | `maybeSendHandoffAck()` |
| `services/conversation-context.service.js` | Contexto de la conversación y aviso de ticket abierto. | `acknowledgeHumanCase()`, `isOpenHumanCase()` |
| `services/deepseek.service.js` | Cliente directo de DeepSeek (uso auxiliar). | `deepseekService` |
| `utils/response-style-policy.js` (reflejos) | Saneado y estilo: cortar cierres proactivos, detectar cortesías, conversaciones ya cerradas, preguntas pendientes. | `trimProactiveEnding()`, `classifyCourtesyAcknowledgement()`, `alreadyClosedConversation()`, `hasPendingRequiredQuestion()` |
| `utils/ai-utils.js` | Utilidades de IA compartidas (conteo de tokens, ayudas de llamada). | `callAIModel()` y helpers |
| `utils/ai-error-details.js` | Resume los errores del proveedor para los logs sin exponer la clave. | `safeAiError()` |
| `scripts/aviso-silencio.mjs` **(sistema inmune)** | Cron cada 5 min: si un caso lleva >10 min sin respuesta humana y el cliente espera, le avisa (máx. 2 veces, 30 min entre avisos). Soporta `--dry`. | ejecutable directo con `node` |

---

## 2. Cómo se conecta (flujo)

```
canal (WhatsApp / Instagram / Facebook / webchat)
   └─ BranchRouterService.processIncomingMessage()
        ├─ guardas: ticket abierto, IA silenciada, reactivación a las 2 h
        └─ handleAiMode()
             ├─ knowledge-retrieval → conocimiento del negocio
             ├─ omnicall.chatCompletion → DeepSeek (JSON)
             ├─ decisión:
             │    ├─ tracking_code  → foxpack-tracking (datos reales)
             │    ├─ producto       → amazon-deals-live (ofertas reales)
             │    ├─ needs_transfer → executeBranchTransfer (ticket + tarea)
             │    └─ responder      → saneado + guardias
             └─ sendReply / enviarImagenesOfertas
```

---

## 3. Qué NO está incluido (dependencias externas)

| Dependencia | Para qué se necesita |
| --- | --- |
| Modelos Mongoose de `wapi-api` | `Contact`, `Workspace`, `User`, `UserSetting`, `ChatAssignment`, `AssignmentEvent`, `Message`, `Department` |
| Paquete `@allsender/omnichannel-branches` | `Branch`, `BranchMembership`, `BranchAgent`, `BranchHandoff`, `BranchConversationState` |
| Servicio unificado de mensajería | `services/whatsapp/unified-whatsapp.service.js` (envío de texto, imagen, media) |
| Proveedores de canal | Baileys (WhatsApp), Zernio (Instagram/Facebook), webchat |
| `utils/automated-response.service.js` | `sendOmnichannelMessageHelper` |
| Colecciones de MongoDB | `omnichannel_branch_knowledge` (9 documentos), `omnichannel_branch_conversation_states`, `chat_assignments`, `messages`, `user_settings` |
| Librerías npm | `ai` (Vercel AI SDK v5) + proveedores, `zod`, `mongoose`, `dotenv` |
| Variables de entorno | `MONGO_URI`, `FIRECRAWL_API_KEY` (solo si Amazon bloquea la descarga directa) |
| Llave del cliente | `user_settings.api_key` (DeepSeek) — **nunca en el código** |

---

## 4. Cómo montarlo de nuevo (si hiciera falta)

1. Copiar estos archivos respetando las rutas dentro de `wapi-api` (`services/`, `utils/`, `scripts/`).
2. Instalar dependencias: `npm i ai @ai-sdk/deepseek zod mongoose dotenv`.
3. Definir en `.env`: `MONGO_URI` y (opcional) `FIRECRAWL_API_KEY`.
4. Verificar que la fila de `user_settings` del dueño del workspace tenga `api_key` (la llave de DeepSeek).
5. Ajustar `AMAZON_LIVE_WORKSPACE` en `branch-router.service.js` al `_id` del workspace que se quiera
   habilitar para la búsqueda de ofertas (hoy solo FoxPack).
6. Arrancar el proceso (PM2) y comprobar en el log los marcadores:
   `[BranchRouter] Prompt:` → `[AI SDK HTTP] status: 200` → `[BranchRouter AI Mode] Response via Omnicall`.

---

## 5. Endurecimiento incluido en esta versión (Codex, 2026-10-06 18:51Z)

Estos cambios ya están aplicados en producción y verificados en vivo (fecha correcta, ofertas antes/ahora y
tarifa China 780 siguen funcionando):

1. **El workspace debe estar activo y tener dueño.** Si `Workspace.findById()` no devuelve un workspace
   activo con `user_id`, se lanza un error explícito. Se eliminó el respaldo que buscaba la llave en
   `contactDoc.created_by` (era la vía por la que un contacto de agente podía quedarse sin llave).
2. **La guardia de tarifas (780/245) solo aplica al workspace de FoxPack** (`corregirTarifas(texto,
   workspaceId)`), para no reescribir precios de otros clientes. Se exporta como `correctFoxpackRates`
   (permite probarla aislada).
3. **Detección de productos con límites de palabra** (`\b`), para que "producto" no dispare por coincidir
   dentro de otra palabra.
4. **Telemetría por workspace**: `chatCompletion` acepta `workspaceId` y se registra en
   `[AI SDK] Generated Request Body`, `[AI SDK HTTP]`, `[AI SDK] Response` y en `AiPromptLog`
   (`workspace_id`, `provider`, `model`, `status`, `http_status`, `elapsed_ms`, `finish_reason`).
5. **Errores del proveedor con detalle**: cuando la llamada falla se registra
   `[BranchRouter AI Mode] Provider failure detail { workspace_id, user_id, errors }` y el aviso
   `Tenant provider failed` ya incluye el JSON con el motivo. Además se quitó la frase engañosa
   "trying direct DeepSeek fallback" (ese respaldo no existía).
6. **Más filtrado de la consulta de Amazon**: se descartan `enviame`, `link/enlace`, `primero/segundo/tercero`,
   `aun`, `sigue`… antes de buscar.

## 6. Trampas conocidas (documentadas para no repetirlas)

1. **`jsonMode` + herramientas nativas de DeepSeek no son compatibles.** Intentar `tools` con modo JSON
   rompe la llamada y todas las conversaciones caen al respaldo fijo.
2. **Sin `api_key` la cola de proveedores queda vacía** y el router cae al respaldo
   (`[BranchRouter AI Mode] Tenant provider failed`) — el síntoma es que el cliente recibe textos fijos.
3. **`Tenant provider failed` se escribe en `wapi-api-error.log`**, no en `out.log`, y ese archivo no tiene
   marcas de tiempo: para medir fallos nuevos hay que comparar el contador entre dos mediciones.
4. En la búsqueda de ofertas, la insignia **Prime ya no viene en el marcado** de Amazon: el Prime se deduce
   del **filtro de la URL** (`p_n_is_prime_eligible:1`).
5. El precio debe leerse **del contenedor `a-price`**; leer el primer número suelto de la tarjeta produjo un
   TV de 50" a US$7. Además se descartan descuentos >85 % y precios <US$3.
6. `String.replace(viejo, nuevo)`: si el reemplazo contiene `$'` (por ejemplo el texto `US$'`), JavaScript
   inserta "el resto del archivo" y destruye el fichero. Usar `replace(viejo, () => nuevo)`.

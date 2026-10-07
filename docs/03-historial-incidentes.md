# Historial de incidentes reales y sus arreglos (LLM de FoxPack)

Registro de lo que falló, por qué, y cómo quedó. Sirve para no repetirlo.

| # | Fecha | Fallo observado | Causa raíz | Arreglo |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-06 | El asistente contestaba **textos fijos** durante días | El proceso dejó de resolver la llave del tenant y caía al respaldo (`Tenant provider failed`) | Reinicio del proceso + vigilante cada 30 min |
| 2 | 2026-10-06 | Conversaciones **aparcadas** por una frase inocente | El "blindaje de coherencia" se activaba con la frase `tu caso` | Disparador acotado; solo transfiere si el caso lo pide |
| 3 | 2026-10-06 | **Silencio eterno** tras transferir | La IA quedaba muda y nadie reactivaba | Reactivación automática a las 2 h + aviso a los 10 min (cron) |
| 4 | 2026-10-06 | La IA **prometía fotos** y no llegaban | `last_offers` no se persistía (Mongoose descartaba el campo) y la prioridad estaba mal | Guardado directo en la base + la foto de lo mostrado tiene prioridad |
| 5 | 2026-10-06 | **Precios absurdos** (un TV de 50" a US$7) | El parser leía el primer número suelto de la tarjeta | Precio desde el contenedor `a-price` + se descartan descuentos >85 % o precios <US$3 |
| 6 | 2026-10-07 | El asistente **inventaba la fecha** ("30 de septiembre") | El prompt no llevaba la fecha | Bloque `FECHA DE HOY` con la fecha real de RD |
| 7 | 2026-10-07 | **Búsquedas basura** (`day`, `saber`, `estoy esperando`) que gastaban créditos | Se buscaba con cualquier palabra | Lista de palabras vacías + palabras cortas de producto (tv, pc, usb…) |
| 8 | 2026-10-06 | El intento de **herramientas nativas** rompió todo el flujo | DeepSeek no acepta `tools` + modo JSON a la vez | Revertido; el modo autónomo va por **campo del contrato**, con prueba aislada |
| 9 | 2026-10-07 | El chat mostraba **palabras cortadas** (`cada` → `c / ada`) | `break-all` en las burbujas y en el textarea | `overflow-wrap: break-word` + `pre-wrap` (conserva saltos de línea) |
| 10 | 2026-10-07 | **Audio con 0:00 / 0:00** | `NEXT_PUBLIC_STORAGE_URL` vacío → ruta relativa → 404 | El audio usa el mismo resolutor que las imágenes (`getResolvedImageUrl`) + reproductor propio |
| 11 | 2026-10-07 | Los mensajes de **Facebook e Instagram no llegaban** a AllSender (Zernio sí los mostraba) | `handleMessageReceived` usaba `preserveActivity` y `receivedAt`, que solo existen en otra función: `ReferenceError` que mataba el job antes de guardar | Declarar la marca de tiempo del mensaje + id de reacción desde el UUID del evento + las cuentas de Zernio ajenas se ignoran en vez de fallar |
| 12 | 2026-10-07 | **"Resolver" no cerraba el caso** en chats sociales: el cliente escribía y la IA no volvía | El panel manda el id de la **cuenta de Zernio** y los casos se crean con el id de la **conexión local**: el resolver no encontraba la asignación y dejaba `chatbot_paused=true` | Mapa de equivalencias (página de Facebook / perfil de Instagram) y búsqueda con `{ $in: [...] }` |
| 13 | 2026-10-07 | Un chat resuelto seguía **"muerto"** y la pantalla no se enteraba de la reapertura | El acuse de cortesía descartaba el turno y la reapertura no emitía evento al panel | Reabrir al escribir + no tragarse el acuse si venía resuelto + avisos `whatsapp:status` y `chat:status-changed` |
| 14 | 2026-10-07 | **Webchat** se quedaba sin IA para siempre | Su guarda propia cortaba antes del embudo común, sin reapertura ni reactivación | Webchat igualado: reabre, reactiva a las 2 h y pasa la marca de reapertura al embudo |
| 15 | 2026-10-07 | El contrato JSON **aceptaba cualquier objeto** y el reintento corría en todos los clientes | Validación de una línea (`typeof v === 'object'`) dentro del router compartido | Validación por campos y tipos + reintento acotado a `AMAZON_LIVE_WORKSPACE` |

## Trampas conocidas

1. **`Tenant provider failed` se escribe en `error.log`, no en `out.log`**, y ese archivo no tiene marcas de tiempo. Para medir fallos nuevos hay que **comparar el contador** entre dos mediciones, no contar líneas sueltas.
2. La frase **"En esa zona tenemos varios puntos: 1) … 2) …"** es del **modo IA sano**, no del respaldo. Un vigilante que la cuente como fallo da falsos positivos (se manda decenas de veces al día).
3. En `String.replace`, si el reemplazo contiene `$'` (por ejemplo el texto `US$'`), JavaScript inserta "el resto del archivo" y destruye el fichero. Usar siempre `replace(viejo, () => nuevo)`.
4. Un `next build` que falla en el **type-check** borra/omite `.next/BUILD_ID`: no reiniciar el front hasta que el build termine bien.
5. **Hora del servidor y de la base**: el servidor está en **AST (UTC-4)** y la consola de Mongo muestra **UTC**. Un mensaje de las 19:34 en el panel es 23:34 UTC. Mezclar las dos horas hace que un arreglo parezca anterior o posterior a lo que realmente es.
6. **`deleteMany` con un filtro que no encaja no avisa**: el resolver de chats devolvía `200 success` sin haber cerrado nada. Al tocar filtros de asignaciones, comprobar siempre **cuántas filas cambiaron**.
7. **Refactor que copia un bloque a otra función**: al mover el alta de contacto social, quedaron referencias a variables que solo existían en la función original. Un `node --check` pasa (es sintaxis válida); el fallo solo se ve en ejecución. Revisar los nombres de parámetros al copiar bloques.

## Cómo comprobar que el asistente está sano (rutina)

1. `pm2 describe wapi-api` → `online` y `curl http://127.0.0.1:5100/` → `200`.
2. `Tenant provider failed` en `error.log`: **comparar el contador** con la medición anterior.
3. Cola de Zernio (`bull:zernio-webhook`): contar `failed` y mirar que no crezca con motivos nuevos.
4. Prueba de humo por canal contra `routeIncomingConversation` con un contacto sintético y los envíos
   interceptados (tarifas, ofertas, tracking, fotos).
5. `node --test --test-force-exit test/production-repair.test.js test/branch-router-contrato.test.js`.

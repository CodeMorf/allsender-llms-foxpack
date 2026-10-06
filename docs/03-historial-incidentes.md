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

## Trampas conocidas

1. **`Tenant provider failed` se escribe en `error.log`, no en `out.log`**, y ese archivo no tiene marcas de tiempo. Para medir fallos nuevos hay que **comparar el contador** entre dos mediciones, no contar líneas sueltas.
2. La frase **"En esa zona tenemos varios puntos: 1) … 2) …"** es del **modo IA sano**, no del respaldo. Un vigilante que la cuente como fallo da falsos positivos (se manda decenas de veces al día).
3. En `String.replace`, si el reemplazo contiene `$'` (por ejemplo el texto `US$'`), JavaScript inserta "el resto del archivo" y destruye el fichero. Usar siempre `replace(viejo, () => nuevo)`.
4. Un `next build` que falla en el **type-check** borra/omite `.next/BUILD_ID`: no reiniciar el front hasta que el build termine bien.

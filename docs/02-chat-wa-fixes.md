# Chat de AllSender (`platform.allsender.tech/wa_chat`) — arreglos hechos y lo que falta

Documento de traspaso para que **Codex** termine lo que quede.
Fecha: 2026-10-07 · Servidor: `root@86.48.20.221` (S2) · App: `/www/wwwroot/wapi-frontend` (Next.js 16.3.5, PM2 `wapi-frontend`, puerto 3100)

---

## 1. Estado actual (verificado tras desplegar)

| Comprobación | Resultado |
| --- | --- |
| `BUILD_ID` desplegado | `mCdjBRBGvp1iTsYXP5VHD` |
| `pm2 wapi-frontend` | online |
| `https://platform.allsender.tech/wa_chat` | HTTP **200** |
| Player de audio en el bundle | sí (`Reproducir audio` en `.next/static/chunks/1vptqg6qf0jaq.js`) |
| Barra de ortografía en el bundle | sí (`Posibles errores` en el mismo chunk) |
| Diccionario local servido | sí (`public/dictionaries/es.aff`, `es.dic`) |

**Pendiente de verificación humana (no hay navegador en el servidor):** probar en **Android e iPhone** el audio, el cursor, el autocorrector y mensajes largos.

---

## 2. Lo que se hizo, punto por punto

### 2.1 Audio de WhatsApp (0:00 / 0:00) — CAUSA RAÍZ ENCONTRADA

El reproductor viejo usaba el `<audio controls>` nativo y, además, **la URL estaba mal resuelta**:

```ts
// ANTES (mal): concatenación a mano
message.fileUrl.startsWith("http") ? message.fileUrl : `${ImageBaseUrl}${message.fileUrl}`
```

`ImageBaseUrl = process.env.NEXT_PUBLIC_STORAGE_URL` y **esa variable está VACÍA** en `.env.production`
(solo hay `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`).
Resultado: `uploads/whatsapp/xxx.ogg` (ruta **relativa**) → el navegador pedía
`https://platform.allsender.tech/wa_chat/uploads/...` → **404 HTML** → el player no cargaba metadatos →
`0:00 / 0:00`.

Las **imágenes sí se veían** porque usan el resolutor del proyecto
(`getResolvedImageUrl` en `src/utils/image.ts`), que hace `ImageBaseUrl || API_BASE_URL` y normaliza la
barra final.

**Arreglo aplicado:** audio, video y documento usan el MISMO resolutor que las imágenes:

```ts
// src/components/chat/messages/AudioMessage.tsx
import { getResolvedImageUrl } from "@/src/utils/image";
const src = message.fileUrl ? getResolvedImageUrl(message.fileUrl) : null;
```

Mismo cambio en `VideoMessage.tsx` y `DocumentMessage.tsx` (`: undefined` para el `src`, por tipos).

**Además** se reescribió el reproductor (`AudioMessage.tsx`, 186 líneas) al estilo WhatsApp compacto:
- play/pausa con icono, barra de progreso **clicable** (seek), tiempo actual / total (`m:ss`).
- **duración real**: primero `loadedmetadata`; si el contenedor no la declara (audios de WhatsApp en
  `.ogg` suelen dar `Infinity`), se fuerza un salto al final para que el navegador la calcule y se vuelve
  al inicio (`currentTime = 1e101` + `durationchange`).
- estados de carga (spinner) y de error ("No se pudo cargar" en vez de 0:00).
- responsive: `max-w-[260px] sm:max-w-[320px]`, mismo lenguaje visual de la burbuja (sin rediseñar nada).

### 2.2 Palabras cortadas en la burbuja (`cada` → `c / ada`)

Causa: **`break-all`** (`word-break: break-all`) en `src/components/chat/messages/TextMessage.tsx`.

Arreglo: `whitespace-pre-wrap wrap-break-word` → `white-space: pre-wrap` (conserva los **saltos de línea
intencionales**) + `overflow-wrap: break-word` (parte solo palabras imposibles, nunca por la mitad).
Verificado en el CSS compilado: `wrap-break-word{overflow-wrap:break-word}`.
Se aplicó lo mismo en `CommentMessage.tsx`, `StoryReplyMessage.tsx` y `TemplateMessage.tsx`.
El `break-all` que queda es solo en enlaces de URL y en el botón de plantilla (correcto, son tokens largos).

### 2.3 Textarea: mismas reglas

`ChatArea.tsx` tenía `whitespace-break-spaces break-all` en el `<Textarea>` → cambiado a
`whitespace-pre-wrap wrap-break-word` (ya no corta palabras en la vista).

### 2.4 Que el mensaje enviado sea idéntico al escrito

- El envío usa `currentMessageText` (capturado antes de limpiar el campo): **sin transformar**.
- **Arreglo**: al fallar un envío, antes se hacía `setMessageText(currentMessageText)` y **se borraba lo
  que el agente hubiera escrito mientras se enviaba**. Ahora:
  `setMessageText((prev) => (prev && prev.trim().length > 0 ? prev : currentMessageText))`.
- Al aplicar una sugerencia de ortografía solo se sustituye si el texto en esa posición **sigue siendo el
  mismo** (`prev.slice(inicio, fin) === palabra`), así es imposible perder, duplicar o mover caracteres.

### 2.5 Enter / Shift+Enter / móvil

`ChatArea.tsx`:
```ts
const esDispositivoTactil = window.matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const estaComponiendo = (e.nativeEvent as { isComposing?: boolean }).isComposing === true || e.keyCode === 229;
if (e.key === "Enter" && !e.shiftKey && !esDispositivoTactil && !estaComponiendo) { e.preventDefault(); handleSend(); }
```
- Escritorio: Enter envía · Shift+Enter salto de línea.
- Móvil: Enter **siempre** hace salto de línea (nada de envíos accidentales; se envía con el botón).
- Nunca envía mientras el teclado compone (autocorrector, emoji, tildes) → evita el clásico "cada" partido.

### 2.6 Corrección ortográfica local (SIN IA, sin tokens)

- Dependencias añadidas: `nspell@^2.1.5` y `dictionary-es@^4.0.0` (ya en `package.json`).
- Diccionario copiado a `public/dictionaries/es.aff` (167 KB) y `es.dic` (706 KB) → carga diferida por HTTP,
  cacheable. Se descarga **solo** cuando el agente empieza a escribir.
- `src/lib/ortografia.ts`: `obtenerCorrector()` (singleton) y `analizarOrtografia(texto, corrector)`.
  Ignora URLs, correos, `@menciones`, `#hashtags`, números, MAYÚSCULAS/siglas y una lista de palabras del
  negocio (foxpack, casillero, prealerta, tracking, waba, miami, flete, libra…). Prioriza la sugerencia que
  solo cambia tildes (comparando la forma sin diacríticos) → *cancion → canción*, *codigo → código*.
  Máximo 6 problemas, 3 sugerencias cada uno.
- `src/components/chat/SpellCheckBar.tsx`: barra discreta encima del compositor con hasta 3 chips
  `palabra → sugerencia` (clic corrige y devuelve el foco al campo con el cursor al final de la palabra),
  contador de restantes y botón "Ocultar". Debounce de 700 ms (no molesta mientras se escribe).
- `src/types/nspell.d.ts`: declaración local (el paquete no trae tipos). **Ojo**: exporta la interfaz
  `NSpell` con nombre y la función como `export default`. Hay que importar `import type { NSpell } from "nspell";`
  — si se importa el default como tipo, TypeScript falla (`TS2749`).

### 2.7 Lo que NO se tocó

Diseño general, WhatsApp/otras conexiones, envío de imágenes, archivos, stickers, plantillas ni el envío
de audio grabado (`AudioRecorder.tsx`). Ningún detalle técnico se muestra en la UI.

---

## 3. Cómo compilar y desplegar (reglas de este servidor)

```bash
cd /www/wwwroot/wapi-frontend
# 1) compilar (memoria limitada; NO borrar .next/cache, acelera los rebuilds)
NODE_OPTIONS=--max-old-space-size=3072 npx next build
# 2) comprobar que el build salió bien y TIENE BUILD_ID
cat .next/BUILD_ID
ps -eo pid,cmd | grep '[n]ext build'   # no debe quedar ningún proceso
# 3) reiniciar y verificar
pm2 restart wapi-frontend
curl -s -o /dev/null -w "%{http_code}\n" -L https://platform.allsender.tech/wa_chat   # debe dar 200
```

⚠️ **Aviso importante**: si `next build` falla en el **type-check**, borra/omite `.next/BUILD_ID` y el
`.next` queda incompleto → un `pm2 restart` posterior puede **no arrancar**. Pasó en esta sesión (falló por
tipos). Si vuelve a pasar: corregir los errores TS, recompilar y **no reiniciar** hasta que exista
`BUILD_ID`.

---

## 4. Pendientes / recomendaciones para terminar

1. **Verificación en dispositivo real** (lo único que no se pudo hacer desde el servidor): Android e iPhone,
   audio de un mensaje entrante (duración correcta, play/pausa, seek), mensaje largo sin cortar palabras,
   cursor estable con autocorrector, y envío con Enter/Shift+Enter frente a móvil.
2. **`NEXT_PUBLIC_STORAGE_URL` está vacío** en `.env.production`. Hoy funciona porque el resolutor cae a
   `API_BASE_URL` → ruta del propio sitio. Recomendado: definirla en `.env.production` con la base real de
   medios y recompilar (es variable de build: no basta reiniciar).
3. **Ruido en el log del frontend**: `Messages get API error: SyntaxError: Unexpected token '<' ... is not
   valid JSON` en `src/app/api/whatsapp/messages/route.ts:24`. El proxy recibe HTML (sesión expirada o error
   del API) en vez de JSON. Conviene manejar ese caso (comprobar `content-type` antes de `JSON.parse` y
   devolver un error claro).
4. **Rendimiento/afinado del corrector**: si con textos largos se nota, limitar el análisis a los últimos
   ~400 caracteres o analizar solo la frase en curso. La lista `PERMITIDAS` de `src/lib/ortografia.ts` es
   ampliable (marcas, ciudades, jerga del negocio).
5. Los `<audio controls>` que quedan en `src/components/whatsapp-calling/CallLogDetailModal.tsx` (grabaciones
   de llamadas) siguen con el reproductor nativo: si se quiere el mismo estilo, reutilizar el componente nuevo.

---

## 5. Archivos tocados (para revisar el diff)

| Archivo | Cambio |
| --- | --- |
| `src/components/chat/messages/AudioMessage.tsx` | reescrito: player compacto + URL con `getResolvedImageUrl` |
| `src/components/chat/messages/TextMessage.tsx` | `break-all` → `whitespace-pre-wrap wrap-break-word` |
| `src/components/chat/messages/CommentMessage.tsx`, `StoryReplyMessage.tsx`, `TemplateMessage.tsx` | mismo cambio de wrapping |
| `src/components/chat/messages/VideoMessage.tsx`, `DocumentMessage.tsx` | URL con `getResolvedImageUrl` (+ `undefined`) |
| `src/components/chat/ChatArea.tsx` | textarea (wrapping), Enter/Shift+Enter móvil, no pisar el texto al fallar, id del campo, handler de sugerencias, `<SpellCheckBar />` |
| `src/components/chat/SpellCheckBar.tsx` | **nuevo**: barra de sugerencias |
| `src/lib/ortografia.ts` | **nuevo**: analizador local con nspell + diccionario español |
| `src/types/nspell.d.ts` | **nuevo**: tipos de nspell |
| `public/dictionaries/es.aff`, `es.dic` | **nuevos**: diccionario servido al navegador |
| `package.json` | `+ nspell`, `+ dictionary-es` |

**Respaldos** de los archivos originales: `/www/wwwroot/wapi-frontend/backups/*.pre-texto-*`,
`*.pre-player-*` (copia previa a cada bloque de cambios).

---

## 6. Consulta sobre el audio: resumen de la investigación

1. Se localizó el componente real: `MessageItem.tsx` enruta `messageType === "audio"` →
   `AudioMessage.tsx` (confirmado; no era otro componente).
2. Los 18 audios de FoxPack en Mongo tienen `file_url = "uploads/whatsapp/<conexion>_<ts>_file.ogg"`
   (**relativo**). Igual que imágenes y videos.
3. `NEXT_PUBLIC_STORAGE_URL` **vacío** → `ImageBaseUrl` undefined → la concatenación manual dejaba una
   ruta relativa → petición a `/wa_chat/uploads/...` → **404** (la URL absoluta tampoco está pública:
   `https://api.allsender.tech/uploads/...` responde 302 a `/login`, requiere sesión).
4. Las imágenes se ven porque `getResolvedImageUrl` (usado por `src/shared/Image`) cae a `API_BASE_URL` y
   normaliza la barra.
5. Conclusión: el "0:00 / 0:00" era una **URL mal resuelta**, no (solo) un problema de diseño del player.
   Por eso el redesign por sí solo no cambiaba nada: había que arreglar la resolución del archivo.

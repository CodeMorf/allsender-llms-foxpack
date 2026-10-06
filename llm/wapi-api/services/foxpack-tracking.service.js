// FoxPack · consulta de tracking para el modo IA del router de sucursales.
//
// UNICO router de tracking (un solo punto de entrada: fetchTracking). Prueba las fuentes en orden y
// se queda con la primera que reconoce el codigo; el prefijo no decide por si solo:
//   1. API JSON de envios locales  -> /api/v2/local_shipment/track/<CODIGO>        (codigos UP...)
//   2. API internacional           -> /api/v2/international_shipment/track/<CODIGO> (hoy responde 405:
//      se intenta igual para que funcione cuando FoxPack lo habilite)
//   3. API de courier              -> /api/v2/courier_shipment/track/<CODIGO>      (parcel_courier)
//   4. Paginas publicas de FoxPack  -> /package/international/tracking y /package/trackingdetail
//      (la de detalle mapea el codigo del suplidor con el tracking interno)
//   5. Fuente externa, solo si FoxPack no encuentra nada y hay FOXPACK_EXTERNAL_TRACK_URL en el .env
//
// Todas las fuentes se normalizan a la misma forma (kind, tracking_code, status, history, sla...) y la
// busqueda NO consume tokens: el LLM solo entra a redactar la respuesta. Nunca se exponen datos
// administrativos (precios, impuestos, ids o nombres de empleados, suplidor, alertas internas).
//
// Aislamiento: solo opera para el workspace de FoxPack.// Aislamiento: solo opera para el workspace de FoxPack.

import omnicallService from './omnicall.service.js';

export const FOXPACK_WORKSPACE_ID = '6ab82a6847ab241dfafe4bc0';
const BASE_URL = 'https://courier.foxpack.us';
const API_PATH = '/api/v2/local_shipment/track';
const DETAIL_PATH = '/package/trackingdetail';

const CONFIG = {
  noMovementHours: 72,
  escalateStatuses: [
    'devuelto', 'retornado', 'extraviado', 'perdido', 'retenido',
    'danado', 'dañado', 'averiado', 'cancelado', 'reclamacion', 'reclamación'
  ],
  timeZone: 'America/Santo_Domingo',
  holidays: []
};

// Sucursales de FoxPack: el API de courier identifica la sucursal con pos_id. La tabla se resuelve
// AQUI, en el backend: nunca viaja al LLM. Si el id no esta en el mapa no se inventa el nombre.
const SUCURSALES_POS = {
  23: 'Bella Vista', 24: 'Ensanche Luperón', 38: 'Bonao', 41: 'Santiago 27 Feb',
  47: 'San Pedro de Macorís', 48: 'Castillo (Solo Delivery)', 50: 'Higüey', 53: 'Monte Plata',
  55: 'San Francisco (Solo Delivery)', 59: 'La Romana', 60: 'Nagua', 61: 'Fantino',
  67: 'Verón / Bávaro', 71: 'El Claret (Solo Delivery)', 73: 'La Vega', 78: 'Yamasá',
  84: 'Moca (Solo Delivery)', 87: 'Santiago Bella Terra', 88: 'Santiago Gurabo',
  89: 'San Isidro Hotel Golden', 91: 'Villa Mella / Santa Cruz', 92: 'Las Palmas de Herrera',
  94: 'Los Mina (Solo Delivery)', 96: 'Las Terrenas', 101: 'Cotuí / La Mata',
  103: 'Los Girasoles', 106: 'Bávaro El Ejecutivo', 111: 'Villa Aura'
};

// El id de sucursal puede llegar con cualquiera de estos nombres segun la fuente.
const CAMPOS_SUCURSAL = ['pos_id', 'station_id', 'branch_id', 'office_id', 'point_id', 'pos', 'sucursal_id'];

const resolverSucursal = (data) => {
  if (!data || typeof data !== 'object') return null;
  for (const campo of CAMPOS_SUCURSAL) {
    const valor = Number(data[campo]);
    if (Number.isInteger(valor) && SUCURSALES_POS[valor]) {
      return { branch_id: valor, branch_name: SUCURSALES_POS[valor], branch_field: campo };
    }
  }
  // El id puede venir y no estar en el mapa: se conserva el id sin nombre.
  for (const campo of CAMPOS_SUCURSAL) {
    const valor = Number(data[campo]);
    if (Number.isInteger(valor) && valor > 0) return { branch_id: valor, branch_name: null, branch_field: campo };
  }
  return null;
};

const MS_HOUR = 3600 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;

export const isFoxpackWorkspace = (workspaceId) => String(workspaceId || '') === FOXPACK_WORKSPACE_ID;

const CODE_RX = /^[A-Za-z0-9][A-Za-z0-9-]{4,49}$/;

const parseDate = (value) => {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  if (m[1] === '0000' || m[2] === '00' || m[3] === '00') return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-04:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatRD = (date) => (date
  ? new Intl.DateTimeFormat('es-DO', { timeZone: CONFIG.timeZone, dateStyle: 'long', timeStyle: 'short' }).format(date)
  : null);

const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timeZone }).format(date);

const isBusinessDay = (date) => {
  const key = dayKey(date);
  const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !CONFIG.holidays.includes(key);
};

const businessHoursBetween = (from, to) => {
  if (!from || !to || to <= from) return 0;
  let hours = 0;
  const cursor = new Date(from.getTime());
  while (cursor < to) {
    const step = new Date(Math.min(cursor.getTime() + MS_HOUR, to.getTime()));
    if (isBusinessDay(cursor)) hours += (step.getTime() - cursor.getTime()) / MS_HOUR;
    cursor.setTime(step.getTime());
  }
  return Math.round(hours * 10) / 10;
};

const lastMovementOf = (history = []) => {
  const rows = (history || [])
    .map((h) => ({ status: h.status_name || null, date: parseDate(h.created_at) }))
    .filter((h) => h.status && h.date);
  rows.sort((a, b) => b.date - a.date);
  return rows[0] || null;
};

export const computeSla = (track, now = new Date()) => {
  const received = parseDate(track?.created_at);
  const estimate = parseDate(track?.date_estimate);
  const finish = parseDate(track?.date_finish);
  const last = lastMovementOf(track?.history);
  const status = String(track?.status_name || '').trim();
  const delivered = Number(track?.finish) === 1 || /entregad/i.test(status);

  const hoursWithoutMovement = delivered || !last ? null : (now.getTime() - last.date.getTime()) / MS_HOUR;
  const estimateExpired = !delivered && estimate ? now.getTime() > estimate.getTime() : false;
  const statusRequiresHuman = !delivered && CONFIG.escalateStatuses.some((s) => status.toLowerCase().includes(s));
  const noMovement = !delivered && hoursWithoutMovement !== null && hoursWithoutMovement > CONFIG.noMovementHours;
  const businessHours = delivered ? null : businessHoursBetween(received, now);

  let reason = null;
  if (!delivered) {
    if (statusRequiresHuman) reason = 'status_requires_human';
    else if (estimateExpired) reason = 'estimated_date_expired';
    else if (noMovement) reason = 'no_movement_' + CONFIG.noMovementHours + 'h';
  }

  return {
    delivered,
    status,
    estimated_delivery: estimate ? formatRD(estimate) : null,
    received_at: formatRD(received),
    delivered_at: delivered ? formatRD(finish) : null,
    last_movement: last ? { status: last.status, date: formatRD(last.date) } : null,
    hours_without_movement: hoursWithoutMovement === null ? null : Math.round(hoursWithoutMovement * 10) / 10,
    business_hours_since_received: businessHours,
    estimated_date_expired: estimateExpired,
    requires_human: Boolean(reason),
    reason
  };
};

// ---------------------------------------------------------------- fuente 1: API JSON

const fetchFromApi = async (code, { timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}${API_PATH}/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } catch {
    return { ok: false, reason: 'upstream_unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return { ok: false, reason: 'not_recognized' };
  if (!response.ok) return { ok: false, reason: 'not_recognized', http_status: response.status };

  let data;
  try { data = await response.json(); } catch { return { ok: false, reason: 'invalid_upstream_payload' }; }
  if (!data?.tracking_code) return { ok: false, reason: 'not_recognized' };

  const sla = computeSla(data);
  return {
    ok: true,
    result: {
      found: true,
      source: 'api',
      tracking_code: data.tracking_code,
      status: data.status_name || null,
      delivered: sla.delivered,
      receiver_name: data.receiver_name_complete ? String(data.receiver_name_complete).trim() : null,
      packages: data.total_package ?? null,
      weight: data.total_weight ?? null,
      history: (data.history || []).map((h) => ({ status: h.status_name || null, date: formatRD(parseDate(h.created_at)) })).filter((h) => h.status),
      sla
    }
  };
};

// ------------------------------------------------- fuente 2: pagina de detalle (fallback)

let session = { cookies: null, token: null, expires: 0 };

const openSession = async (fetchImpl) => {
  if (session.token && Date.now() < session.expires) return session;
  const res = await fetchImpl(`${BASE_URL}/`, { headers: { Accept: 'text/html' } });
  const html = await res.text();
  const token = (html.match(/name="_token" value="([^"]+)"/) || [])[1] || null;
  const cookieHeader = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie().map((c) => String(c).split(';')[0]).join('; ')
    : (res.headers.get('set-cookie') || '').split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  session = { cookies: cookieHeader || null, token, expires: Date.now() + SESSION_TTL_MS };
  return session;
};

const decodeEntities = (value) => String(value || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é')
  .replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const fieldOf = (html, label) => {
  const rx = new RegExp(label + '[\\s\\S]{0,240}?<div class="details">\\s*([\\s\\S]{0,120}?)</div>', 'i');
  const m = html.match(rx);
  return m ? decodeEntities(m[1]) : null;
};

const historyOf = (html) => {
  const tail = html.split(/Historial/i)[1] || '';
  const rows = [...tail.matchAll(/<tr>[\s\S]{0,80}?<td>([\s\S]{0,90}?)<\/td>[\s\S]{0,80}?<td>([\s\S]{0,90}?)<\/td>[\s\S]{0,80}?<td>([\s\S]{0,40}?)<\/td>/g)];
  return rows
    .map(([, status, comment, date]) => ({
      status: decodeEntities(status.replace(/<[^>]+>/g, '')),
      comment: decodeEntities(comment.replace(/<[^>]+>/g, '')) || null,
      date: decodeEntities(date.replace(/<[^>]+>/g, ''))
    }))
    .filter((r) => r.status && !/^estado$/i.test(r.status) && /\d{4}-\d{2}-\d{2}/.test(r.date));
};

// Solo campos visibles para el cliente: se descartan factura, suplidor, empleados y datos administrativos; el codigo FP del cliente si se conserva.
const parseDetailPage = (html, code) => {
  const internalTracking = (html.match(/<b class="pull-right">\s*(UP\w+)\s*<\/b>/) || [])[1] || null;
  const history = historyOf(html);
  const status = history.length ? history[0].status : null;
  const entry = fieldOf(html, 'Fecha de entrada');
  const description = fieldOf(html, 'Descripci');
  const weight = fieldOf(html, 'Peso');
  const tokens = tokensDeHtml(html);
  const fpCode = valorDespuesDe(tokens, 'Ciente') || valorDespuesDe(tokens, 'Cliente');
  const volumetricWeight = valorDespuesDe(tokens, 'Peso volumetrico');

  if (!internalTracking && !history.length) {
    return { found: false, reason: 'tracking_not_found' };
  }

  return {
    found: true,
    source: 'detail_page',
    tracking_code: internalTracking || code,
    supplier_tracking: code,
    status,
    delivered: false,
    description,
    weight,
    fp_code: fpCode || null,
    volumetric_weight: volumetricWeight || null,
    received_at: entry,
    history: history.map((h) => ({ status: h.status, date: h.date, comment: h.comment })).reverse(),
    // Es un registro de recepcion en almacen, no un envio en transito: no se aplica el reloj de
    // incumplimiento (el paquete puede esperar consolidacion). El LLM puede escalar si el cliente insiste.
    sla: {
      delivered: false,
      status,
      estimated_delivery: null,
      received_at: entry,
      delivered_at: null,
      last_movement: history.length ? { status: history[0].status, date: history[0].date } : null,
      hours_without_movement: null,
      business_hours_since_received: null,
      estimated_date_expired: false,
      requires_human: false,
      reason: null
    }
  };
};

const fetchFromDetailPage = async (code, { timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) => {
  let current;
  try {
    current = await openSession(fetchImpl);
  } catch {
    return { found: false, reason: 'detail_unreachable' };
  }
  if (!current?.token) return { found: false, reason: 'detail_session_unavailable' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(
      `${BASE_URL}${DETAIL_PATH}?_token=${encodeURIComponent(current.token)}&tracking_number=${encodeURIComponent(code)}`,
      { headers: { Accept: 'text/html', ...(current.cookies ? { Cookie: current.cookies } : {}) }, redirect: 'manual', signal: controller.signal }
    );
  } catch {
    return { found: false, reason: 'detail_unreachable' };
  } finally {
    clearTimeout(timer);
  }

  // 3xx = la sesion caduco (redirige a login/landing): se invalida para reabrirla en la proxima.
  if (res.status >= 300 && res.status < 400) {
    session = { cookies: null, token: null, expires: 0 };
    return { found: false, reason: 'tracking_not_found' };
  }
  if (!res.ok) return { found: false, reason: 'detail_upstream_error', http_status: res.status };

  const html = await res.text();
  return parseDetailPage(html, code);
};

// --------------------------------------------------------- fuente: API de courier (parcel_courier)

// El API de courier devuelve 86 campos, casi todos administrativos (precios, impuestos, ids de
// usuario, suplidor). Solo se conservan los que el cliente puede ver. El estado llega como
// status_id (numerico): el nombre se completa con la pagina publica, nunca se inventa.
const STATUS_NEUTRO = (status = null) => ({
  delivered: /entregad/i.test(String(status || '')),
  status,
  estimated_delivery: null,
  received_at: null,
  delivered_at: null,
  last_movement: null,
  hours_without_movement: null,
  business_hours_since_received: null,
  estimated_date_expired: false,
  requires_human: false,
  reason: null
});

const historyLimpio = (rows) => (Array.isArray(rows) ? rows : [])
  .map((h) => ({ status: h?.status_name || h?.status || null, date: formatRD(parseDate(h?.created_at || h?.date)) }))
  .filter((h) => h.status);

const fetchFromCourierApi = async (code, { timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}/api/v2/courier_shipment/track/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } catch {
    return { ok: false, reason: 'upstream_unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return { ok: false, reason: 'not_recognized', http_status: response.status };

  let data;
  try { data = await response.json(); } catch { return { ok: false, reason: 'invalid_upstream_payload' }; }
  if (!data?.tracking_id) return { ok: false, reason: 'not_recognized' };

  // El API tambien responde por el tracking interno: solo sirve si es el envio consultado.
  const pedido = String(code).toUpperCase();
  const coincide = [data.old_tracking, data.tracking_id].some((v) => String(v || '').toUpperCase() === pedido);
  if (!coincide) return { ok: false, reason: 'not_recognized' };

  const ubicacion = String(data.container_location || '').trim();
  const sucursal = resolverSucursal(data);
  return {
    ok: true,
    result: {
      found: true,
      source: 'courier_api',
      kind: 'courier',
      tracking_code: data.tracking_id,
      branch_id: sucursal?.branch_id ?? null,
      branch_name: sucursal?.branch_name ?? null,
      supplier_tracking: String(data.old_tracking || '').toUpperCase() === pedido ? data.old_tracking : code,
      status: null,
      status_id: data.status_id ?? null,
      delivered: false,
      description: data.description ? String(data.description).trim() : null,
      weight: data.pound ?? null,
      location: ubicacion && ubicacion !== 'Z/E' ? ubicacion : null,
      updated_at: data.updated_at || null,
      history: historyLimpio(data.history),
      sla: STATUS_NEUTRO()
    }
  };
};

// ------------------------------------------------------ fuente: API internacional (envios UPI...)

const fetchFromInternationalApi = async (code, { timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}/api/v2/international_shipment/track/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } catch {
    return { ok: false, reason: 'upstream_unreachable' };
  } finally {
    clearTimeout(timer);
  }
  // El 2026-09-28 este endpoint responde 405 (solo acepta otro metodo o no esta publicado): se
  // trata como "no disponible" y el router sigue con la pagina publica internacional.
  if (response.status === 405) return { ok: false, reason: 'international_api_not_available' };
  if (!response.ok) return { ok: false, reason: 'not_recognized', http_status: response.status };

  let data;
  try { data = await response.json(); } catch { return { ok: false, reason: 'invalid_upstream_payload' }; }
  const tracking = data?.tracking_code || data?.tracking || data?.tracking_number || null;
  if (!tracking) return { ok: false, reason: 'not_recognized' };

  const estado = data.status_name || data.status || null;
  const sucursal = resolverSucursal(data);
  return {
    ok: true,
    result: {
      found: true,
      source: 'international_api',
      kind: 'international',
      tracking_code: String(tracking).toUpperCase(),
      branch_id: sucursal?.branch_id ?? null,
      branch_name: sucursal?.branch_name ?? null,
      supplier_tracking: String(tracking).toUpperCase() === String(code).toUpperCase() ? null : code,
      status: estado,
      status_id: data.status_id ?? null,
      delivered: /entregad/i.test(String(estado || '')),
      origin: data.origin || data.origen || null,
      destination: data.destination || data.destino || null,
      sender: data.transmitter_name_complete || data.sender_name || null,
      receiver: data.receiver_name_complete || data.receiver_name || null,
      updated_at: data.updated_at || data.created_at || null,
      history: historyLimpio(data.history),
      sla: STATUS_NEUTRO(estado)
    }
  };
};

// ------------------------------------------- fuente: pagina publica de tracking internacional

// Envuelve el HTML en una lista de etiquetas/valores: cada tag pasa a separador, asi se puede
// leer "Origen | DO - Yamasa | Destino | US - New York" sin depender de clases ni ids.
const tokensDeHtml = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, '|')
  .replace(/&nbsp;/g, ' ')
  .split('|')
  .map((t) => decodeEntities(t).replace(/\s+/g, ' ').trim())
  .filter((t) => t.length > 0);

const valorDespuesDe = (tokens, etiqueta) => {
  const buscada = String(etiqueta).toLowerCase();
  const i = tokens.findIndex((t) => t.toLowerCase() === buscada);
  if (i < 0) return null;
  for (let j = i + 1; j < Math.min(i + 3, tokens.length); j += 1) {
    if (!/^[:|-]$/.test(tokens[j])) return tokens[j];
  }
  return null;
};

const parseInternationalPage = (html, code) => {
  const tokens = tokensDeHtml(html);
  const history = historyOf(html);
  const origen = valorDespuesDe(tokens, 'Origen');
  const destino = valorDespuesDe(tokens, 'Destino');
  const actualizado = valorDespuesDe(tokens, 'Última actualización') || valorDespuesDe(tokens, 'Ultima actualización');
  const presente = tokens.some((t) => t.toUpperCase() === String(code).toUpperCase());

  if (!presente && !origen && !destino && !history.length) return { found: false, reason: 'tracking_not_found' };

  const estado = history.length ? history[0].status : null;
  return {
    found: true,
    source: 'international_page',
    kind: 'international',
    tracking_code: String(code).toUpperCase(),
    supplier_tracking: null,
    status: estado,
    status_id: null,
    delivered: /entregad/i.test(String(estado || '')),
    origin: origen && origen !== 'Tracking' ? origen : null,
    destination: destino && !/^historial$/i.test(destino) ? destino : null,
    updated_at: actualizado && /^\d{4}-\d{2}-\d{2}/.test(actualizado) ? actualizado : null,
    history: history.map((h) => ({ status: h.status, date: h.date, comment: h.comment })).reverse(),
    sla: STATUS_NEUTRO(estado)
  };
};

const fetchFromInternationalPage = async (code, { timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${BASE_URL}/package/international/tracking?tracking_number=${encodeURIComponent(code)}`, {
      headers: { Accept: 'text/html' },
      signal: controller.signal
    });
  } catch {
    return { found: false, reason: 'international_page_unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { found: false, reason: 'international_page_error', http_status: res.status };
  return parseInternationalPage(await res.text(), code);
};

// ------------------------------- completar el estado con la pagina publica (sin inventar nada)

// Los API JSON de courier e internacional no traen el nombre del estado (solo status_id). La pagina
// publica si lo trae, junto con el historial. Solo se rellena lo que falte.
const enriquecerConPagina = async (result, code, options) => {
  if (result?.status && result?.history?.length) return result;
  const pagina = await fetchFromDetailPage(code, options);
  if (!pagina?.found) return result;
  return {
    ...result,
    status: result.status || pagina.status || null,
    status_id: result.status_id ?? null,
    history: result.history?.length ? result.history : (pagina.history || []),
    description: result.description || pagina.description || null,
    weight: result.weight || pagina.weight || null,
    fp_code: pagina.fp_code || result.fp_code || null,
    received_at: pagina.received_at || result.received_at || null,
    delivered: Boolean(result.delivered || pagina.delivered || /entregad/i.test(String(result.status || pagina.status || ''))),
    sla: { ...(result.sla || STATUS_NEUTRO(result.status || pagina.status)), status: result.status || pagina.status || null },
    page_enriched: true
  };
};

// La sucursal solo la publica el API de courier (pos_id). Si el envio salio por el API local, se
// consulta ese campo una vez para no dejar el cliente sin el dato.
const enriquecerSucursal = async (result, code, options) => {
  if (!result || result.branch_name) return result;
  const courier = await fetchFromCourierApi(code, options);
  if (!courier.ok) return result;
  return {
    ...result,
    branch_id: courier.result.branch_id ?? null,
    branch_name: courier.result.branch_name ?? null,
    fp_code: result.fp_code || courier.result.fp_code || null
  };
};

// --------------------------------------------- ultimo recurso: fuente externa (opcional)

// Solo se usa si FoxPack no encuentra nada Y existe FOXPACK_EXTERNAL_TRACK_URL en el .env
// (plantilla con {code}). Sin configurar, el router termina en "no encontrado": no se inventan datos.
const fetchFromExternal = async (code, { timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) => {
  const plantilla = process.env.FOXPACK_EXTERNAL_TRACK_URL;
  if (!plantilla || !plantilla.includes('{code}')) return { ok: false, reason: 'external_not_configured' };
  const url = plantilla.replace('{code}', encodeURIComponent(code));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch {
    return { ok: false, reason: 'external_unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { ok: false, reason: 'external_not_found' };
  let data;
  try { data = await res.json(); } catch { return { ok: false, reason: 'external_invalid_payload' }; }
  const estado = data?.status_name || data?.status || data?.estado || null;
  if (!estado && !data?.history) return { ok: false, reason: 'external_not_found' };
  return {
    ok: true,
    result: {
      found: true,
      source: 'external',
      kind: 'unknown',
      tracking_code: String(data.tracking_code || data.tracking || code).toUpperCase(),
      supplier_tracking: code,
      status: estado,
      status_id: null,
      delivered: /entregad/i.test(String(estado || '')),
      weight: data.weight || data.peso || null,
      updated_at: data.updated_at || null,
      history: historyLimpio(data.history),
      sla: STATUS_NEUTRO(estado)
    }
  };
};

// ------------------------------------------------------------------- cache corto por codigo

const CACHE_TTL_MS = 90 * 1000;
const cache = new Map();
const cacheGet = (code) => {
  const hit = cache.get(code);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(code); return null; }
  return hit.result;
};
const cacheSet = (code, result) => {
  cache.set(code, { result, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
};

// ---------------------------------------------------------------------- entrada principal

export const fetchTracking = async (code, options = {}) => {
  const clean = String(code || '').trim().toUpperCase();
  if (!CODE_RX.test(clean)) return { found: false, reason: 'invalid_tracking_code' };

  const enCache = cacheGet(clean);
  if (enCache) return { ...enCache, cached: true };

  // 1) Implementacion existente: API JSON de envios locales (codigos internos UP...).
  const local = await fetchFromApi(clean, options);
  if (local.ok) return cacheSet(clean, await enriquecerSucursal(local.result, clean, options));

  // 2) API internacional (hoy responde 405; queda listo para cuando FoxPack lo habilite).
  const internacional = await fetchFromInternationalApi(clean, options);
  if (internacional.ok) return cacheSet(clean, await enriquecerConPagina(internacional.result, clean, options));

  // 3) API de courier (parcel courier).
  const courier = await fetchFromCourierApi(clean, options);
  if (courier.ok) return cacheSet(clean, await enriquecerConPagina(courier.result, clean, options));

  // 4) Paginas publicas de FoxPack: internacional y, despues, la de detalle (mapea el codigo del
  //    suplidor con el tracking interno y trae el historial de recepcion).
  const paginaInternacional = await fetchFromInternationalPage(clean, options);
  if (paginaInternacional.found) return cacheSet(clean, paginaInternacional);

  const detalle = await fetchFromDetailPage(clean, options);
  if (detalle.found) return cacheSet(clean, detalle);

  // 5) Ultimo recurso: fuente externa, solo si esta configurada.
  const externo = await fetchFromExternal(clean, options);
  if (externo.ok) return cacheSet(clean, externo.result);

  if (detalle.reason && detalle.reason !== 'tracking_not_found') return detalle;
  return { found: false, reason: 'tracking_not_found' };
};

// ------------------------------------------------------------------------- redaccion

// ------------------------------------------------------------------ estados especiales

// El courier publica nombres de estado que el cliente no puede interpretar por si solo. La
// interpretacion oficial esta en la politica de estados especiales de FoxPack (documento interno,
// tambien cargado en la base de conocimiento). Aqui se traduce a la accion concreta que el LLM debe
// transmitir, para que no invente el significado: el 2026-09-27 el estado "Casillero Desconocido" se
// respondio como si el paquete estuviera en preparacion normal.
const ESTADOS_ESPECIALES = [
  {
    rx: /desconocid|no identificad|sin casillero|no asociad|no vinculad/i,
    significado: 'El paquete llego al almacen de Miami sin quedar asociado a la cuenta del cliente: entro sin su codigo FP o numero de casillero.',
    accion: 'Tiene que entrar a su cuenta de FoxPack y crear una PRE-ALERTA con el numero de tracking de ese paquete; la pre-alerta declara el valor y evita el pago por cambio de categoria. Como el paquete ya esta recibido en el almacen, esa pre-alerta se convierte en POST-ALERTA y asi el paquete queda identificado y asociado a su cuenta. De ahora en adelante debe incluir su codigo FP (numero de casillero) al comprar, para que el paquete llegue ya asociado.',
    noDecir: 'NO digas que el paquete va en camino, que esta en preparacion normal ni que ya quedo asociado a su cuenta: falta identificarlo.'
  }
];

const interpretarEstado = (status) => {
  const texto = String(status || '');
  if (!texto) return null;
  return ESTADOS_ESPECIALES.find((e) => e.rx.test(texto)) || null;
};

const bloqueDeEstado = (status) => {
  const interp = interpretarEstado(status);
  if (!interp) return [];
  return [
    '- SIGNIFICADO DE ESE ESTADO (explicaselo al cliente con tus palabras): ' + interp.significado,
    '- ACCION QUE DEBE HACER EL CLIENTE (es obligatorio decirlo en tu respuesta): ' + interp.accion,
    '- ' + interp.noDecir
  ];
};

// Una sola linea con la sucursal ya resuelta; la tabla de pos_id no se manda al LLM.
const lineaSucursal = (t) => (t?.branch_name
  ? [`- Sucursal asignada al paquete: ${t.branch_name} (es la sucursal que lo atiende; NO es el origen y no digas que el paquete sale de ahi).`]
  : []);

const buildDataBlock = (t) => {
  if (!t?.found) {
    const motivo = {
      tracking_not_found: 'No existe ningun envio registrado con ese numero (se consultaron todas las fuentes de FoxPack).',
      invalid_tracking_code: 'El numero de tracking no tiene un formato valido.',
      upstream_unreachable: 'El sistema de envios no respondio: no hay datos disponibles ahora mismo.',
      detail_unreachable: 'El sistema de envios no respondio: no hay datos disponibles ahora mismo.',
      upstream_error: 'El sistema de envios devolvio un error: no hay datos disponibles.',
      detail_upstream_error: 'El sistema de envios devolvio un error: no hay datos disponibles.',
      detail_session_unavailable: 'La consulta de ese tipo de codigo no esta disponible en este momento.',
      international_api_not_available: 'La consulta internacional no esta disponible en este momento.',
      international_page_unreachable: 'El sistema de envios no respondio: no hay datos disponibles ahora mismo.',
      international_page_error: 'El sistema de envios devolvio un error: no hay datos disponibles.',
      external_not_configured: 'No existe ningun envio registrado con ese numero.'
    }[t?.reason] || 'No se pudo consultar el envio.';
    return `CONSULTA DE TRACKING: sin resultado. Motivo verificado: ${t?.reason || 'desconocido'}. ${motivo}`;
  }

  if (t.kind === 'international') {
    return [
      'DATOS VERIFICADOS DEL ENVIO INTERNACIONAL (unica fuente valida; no agregues nada que no este aqui):',
      `- Tracking: ${t.tracking_code}`,
      `- Estado actual: ${t.status || 'sin estado'}`,
      ...bloqueDeEstado(t.status),
      ...lineaSucursal(t),
      `- Origen: ${t.origin || 'no informado'}`,
      `- Destino: ${t.destination || 'no informado'}`,
      ...(t.sender ? [`- Envia: ${t.sender}`] : []),
      ...(t.receiver ? [`- Recibe: ${t.receiver}`] : []),
      `- Ultima actualizacion del registro (no es un movimiento del paquete): ${t.updated_at || 'no informada'}`,
      `- Historial: ${t.history?.length ? t.history.map((h) => h.status + ' (' + h.date + ')').join(' | ') : 'vacio'}`,
      '- Si el historial esta vacio, di solamente que aun no hay movimientos registrados; no inventes movimientos, fechas ni recomendaciones que no esten en estos datos.',
      '- Prohibido nombrar tiendas, suplidores o plataformas de compra.',
      `- Tiene que pasar a una persona: ${t.sla?.requires_human ? 'SI (' + t.sla.reason + ')' : 'no'}`
    ].join('\n');
  }

  if (t.kind === 'courier') {
    return [
      'DATOS VERIFICADOS DEL ENVIO (unica fuente valida; no agregues nada que no este aqui):',
      `- Tracking: ${t.tracking_code}`,
      ...(t.supplier_tracking && t.supplier_tracking !== t.tracking_code
        ? [`- El numero que dio el cliente (${t.supplier_tracking}) es el tracking del suplidor; el tracking interno de FoxPack es ${t.tracking_code}.`]
        : []),
      `- Estado actual: ${t.status || 'sin estado'}${t.delivered ? ' (entregado)' : ''}`,
      ...bloqueDeEstado(t.status),
      ...lineaSucursal(t),
      ...(t.fp_code ? [`- Codigo de cliente (FP) del paquete: ${t.fp_code}`] : []),
      `- Peso: ${t.weight || 'no informado'}`,
      ...(t.description ? [`- Descripcion: ${t.description}`] : []),
      ...(t.location ? [`- Ubicacion: ${t.location}`] : []),
      `- Ultima actualizacion: ${t.updated_at || 'no informada'}`,
      `- Historial: ${t.history?.length ? t.history.map((h) => h.status + ' (' + h.date + ')').join(' | ') : 'vacio'}`,
      '- Prohibido nombrar tiendas, suplidores o plataformas de compra, y prohibido mencionar precios, impuestos, empleados o costos internos.',
      `- Tiene que pasar a una persona: ${t.sla?.requires_human ? 'SI (' + t.sla.reason + ')' : 'no'}`
    ].join('\n');
  }

  if (t.source === 'detail_page') {
    return [
      'DATOS VERIFICADOS DEL PAQUETE (unica fuente valida; no agregues nada que no este aqui):',
      `- El numero que dio el cliente (${t.supplier_tracking}) es el tracking del SUPLIDOR donde hizo la compra.`,
      `- Tracking interno de FoxPack asignado: ${t.tracking_code}`,
      ...(t.fp_code ? [`- Codigo de cliente (FP) del paquete: ${t.fp_code}`] : []),
      `- Descripcion: ${t.description || 'no informada'}`,
      `- Peso: ${t.weight || 'no informado'}${t.volumetric_weight ? ' (volumetrico ' + t.volumetric_weight + ')' : ''}`,
      `- Fecha de entrada en el almacen: ${t.received_at || 'no informada'}`,
      `- Estado actual en el almacen: ${t.status || 'sin estado'}`,
      ...bloqueDeEstado(t.status),
      `- Historial de recepcion: ${t.history.map((h) => h.status + ' (' + h.date + ')').join(' | ') || 'vacio'}`,
      '- Esto es el registro de RECEPCION EN ALMACEN (antes del envio a Republica Dominicana); no es todavia el trayecto final.',
      '- Prohibido nombrar tiendas, suplidores o plataformas de compra.',
      '- Tiene que pasar a una persona: no'
    ].join('\n');
  }

  const s = t.sla;
  return [
    'DATOS VERIFICADOS DEL ENVIO (unica fuente valida; no agregues nada que no este aqui):',
    `- Tracking: ${t.tracking_code}`,
    `- Estado actual: ${t.status || 'sin estado'}${s.delivered ? ' (entregado)' : ''}`,
    ...bloqueDeEstado(t.status),
    ...lineaSucursal(t),
    ...(t.receiver_name ? [`- Recibe: ${t.receiver_name}`] : []),
    `- Recibido en almacen: ${s.received_at || 'sin fecha'}`,
    `- Ultimo movimiento: ${s.last_movement ? s.last_movement.status + ' el ' + s.last_movement.date : 'sin movimientos registrados'}`,
    `- Entrega estimada: ${s.estimated_delivery || 'no informada'}`,
    `- Historial: ${t.history.length ? t.history.map((h) => h.status + ' (' + h.date + ')').join(' | ') : 'vacio'}`,
    `- Fecha estimada vencida: ${s.estimated_date_expired ? 'si' : 'no'}`,
    `- Horas sin movimiento: ${s.hours_without_movement ?? 'no aplica'}`,
    '- Prohibido mencionar precios, impuestos, empleados o costos internos.',
    `- Tiene que pasar a una persona: ${s.requires_human ? 'SI (' + s.reason + ')' : 'no'}`
  ].join('\n');
};

const COMPOSE_PROMPT = `Eres el asistente de FoxPack Courier (courier de paqueteria en Republica Dominicana).
Recibes los DATOS VERIFICADOS de un paquete y debes redactar la respuesta al cliente.

REGLAS OBLIGATORIAS
- Habla como una persona: cercano, breve y natural. Nunca suenes a bot ni a menu.

EXTENSION (OBLIGATORIA)
- BREVE Y DIRECTO: maximo 3 lineas cortas, unas 40 palabras, en un solo parrafo.
- Das el dato y cierras. No repitas el numero que dio el cliente si ya das el tracking interno, no listes el historial y no expliques de donde salieron los datos.
- Estado normal: estado + tracking interno + cierre breve.
- Estado de los desconocidos: estado + tracking interno + que cree la pre-alerta con ese tracking y agregue su codigo FP. Nada mas.
- Usa UNICAMENTE los datos verificados que se te entregan. Prohibido inventar estado, ubicacion, fecha ni prometer plazos.
- El termino del negocio es "tracking" (numero de tracking). No lo confundas con el "casillero" del cliente.
- Cuando el cliente dio el tracking del suplidor (de la tienda donde compro), explicale con naturalidad que con ese numero localizaste su paquete en nuestro almacen y dale el tracking interno de FoxPack con el que viaja a Republica Dominicana.
- No muestres JSON, identificadores internos, nombres de personal ni informacion tecnica o administrativa.
- Si los datos traen "SIGNIFICADO DE ESE ESTADO" y "ACCION QUE DEBE HACER EL CLIENTE", esa es la parte central de tu respuesta: explica con tus palabras que significa el estado y dile que tiene que hacer. Esos estados son de paquete sin identificar: prohibido decir que el paquete va en camino o que esta en preparacion normal.

TONO Y POSTURA (importante)
- Tono siempre positivo, cordial y profesional.
- Se diplomatico: nunca des la razon a un reclamo contra la empresa, ni admitas incumplimiento, culpa o responsabilidad.
- Defiende el interes de la empresa: presenta los hechos con transparencia pero sin conceder compensaciones, reembolsos ni culpas. Si el cliente pide algo de eso, indica que una persona del equipo lo revisara.
- Si el paquete esta en regla: informa con tranquilidad y da seguimiento (donde esta y el ultimo movimiento).
- Si la fecha estimada ya vencio, o lleva mas de 72 horas sin movimiento, o el estado pide atencion: acompanalo con empatia, explica brevemente sin culpar a nadie y avisa que su caso pasa a un representante para revisarlo contigo (needs_transfer: true).

CONTINUIDAD
- Mantiene el hilo de la conversacion (saluda/retoma por su nombre si lo tienes).
- Si aun no sabes en que ciudad o sucursal esta el cliente, aprovecha para preguntarlo de forma natural: el caso se atiende por sucursal.

PROHIBIDO en reply_text: las frases "tu caso", "asignado", "asignada", "caso registrado", "te transfiero", "he transferido" y pedir la sucursal como pregunta principal. Cierra, si hace falta, con una pregunta breve por la ciudad.
OBLIGATORIO en reply_text: mencionar el estado real y, si existe, el numero de tracking, todo dentro de 3 lineas cortas. Cuando el estado sea de los desconocidos (paquete no asociado), la respuesta TIENE que decir la palabra "pre-alerta" y explicar que debe crearla con el numero de tracking.

RESPONDE SOLO CON ESTE JSON:
{"reply_text": string, "needs_transfer": boolean, "reason": string | null}`;

// Frases que hacen que el router reescriba la respuesta mas adelante (bloque "claimsAssignment").
// Si la redaccion las usa, el cliente recibe la pregunta de sucursal en vez de sus datos.
const FRASES_QUE_DISPARAN_REESCRITURA = /asignad[oa]|caso ha sido|tu caso|registrando tu caso|caso est[aá] registrado|te transfiero|he transferido|agente especializado/i;

const validaRespuesta = (texto, tracking) => {
  if (!texto || texto.trim().length < 15) return false;
  if (FRASES_QUE_DISPARAN_REESCRITURA.test(texto)) return false;
  if (/para asignar (tu|su) caso a la sucursal/i.test(texto)) return false;
  if (tracking?.found && tracking.tracking_code && !texto.includes(tracking.tracking_code)) return false;
  if (tracking?.found && tracking.status && !texto.toLowerCase().includes(String(tracking.status).toLowerCase().split(' ')[0])) return false;
  // Un paquete sin identificar no se resuelve informando el estado: hay que decirle que cree la pre-alerta.
  if (tracking?.found && interpretarEstado(tracking.status) && !/pre-?\s?alerta/i.test(texto)) return false;
  // Envio internacional sin historial: no se inventan tramites (pre-alertas, declaraciones) que no esten en los datos.
  if (tracking?.found && tracking.kind === 'international' && !tracking.history?.length && /pre-?\s?alerta|declaraci|tramite|trámite/i.test(texto)) return false;
  // El cliente pidio respuestas breves: si el modelo se extiende se reintenta y, si no, sale el respaldo corto.
  if (texto.trim().length > 430) return false;
  return true;
};

const textoDeRespaldo = (tracking, customerName) => {
  const nombre = customerName ? ' ' + String(customerName).trim().split(/\s+/)[0] : '';
  if (!tracking?.found) {
    return 'Hola' + nombre + ', no encuentro ese número en nuestro sistema. ¿Podrías revisarlo y confirmármelo?';
  }
  if (tracking.kind === 'international') {
    return 'Hola' + nombre + ', tu envío ' + tracking.tracking_code + ' aparece como ' + (tracking.status || 'sin estado')
      + (tracking.origin && tracking.destination ? ', con origen ' + tracking.origin + ' y destino ' + tracking.destination : '')
      + (tracking.branch_name ? ', con la sucursal ' + tracking.branch_name + ' asignada' : '')
      + '. ¿Te ayudo con algo más?';
  }
  if (tracking.kind === 'courier') {
    return 'Hola' + nombre + ', tu envío ' + tracking.tracking_code + ' aparece como ' + (tracking.status || 'sin estado')
      + (tracking.weight ? ' y pesa ' + tracking.weight + ' lb' : '')
      + (tracking.branch_name ? ', con la sucursal ' + tracking.branch_name + ' asignada' : '') + '. ¿Te ayudo con algo más?';
  }
  if (tracking.source === 'detail_page') {
    if (interpretarEstado(tracking.status)) {
      return 'Hola' + nombre + ', localicé tu paquete: su tracking interno es ' + tracking.tracking_code + '. Entró al almacén sin tu código FP ni tu casillero, por eso figura como ' + (tracking.status || 'sin casillero') + '. Entra a tu cuenta de FoxPack y crea una pre-alerta con ese tracking: como ya está recibido, pasa a post-alerta y queda asociado. Incluye tu código FP al comprar.';
    }
    return 'Hola' + nombre + ', localicé tu paquete en nuestro almacén: su tracking interno es ' + tracking.tracking_code + ' y su estado es ' + (tracking.status || 'en almacén') + '. ¿En qué ciudad estás para darte seguimiento por tu sucursal?';
  }
  return 'Hola' + nombre + ', tu envío ' + tracking.tracking_code + ' aparece como ' + (tracking.status || 'sin estado') + '.' + (tracking.sla?.estimated_delivery ? ' La entrega estimada es ' + tracking.sla.estimated_delivery + '.' : '') + ' ¿Te ayudo con algo más?';
};

export const composeTrackingReply = async ({ tracking, userSetting, ownerUserId, history = [], customerName = null, channel = 'whatsapp' }) => {
  // Los datos verificados van DENTRO del system prompt (no como ultimo mensaje del historial): si van
  // al final del historial, el patron anterior de la conversacion pesa mas y el modelo repite la
  // pregunta en vez de informar el estado real (fallo detectado en produccion el 2026-09-27).
  const contexto = [
    customerName ? `Cliente: ${customerName}` : null,
    `Canal: ${channel}`,
    buildDataBlock(tracking),
    '',
    'IMPORTANTE: tu mensaje anterior pidio datos al cliente SIN haber consultado el envio. Ya tienes los datos verificados de arriba: informaselos ahora. No repitas la frase anterior ni vuelvas a pedir la sucursal, salvo un cierre breve si aun no la tienes.'
  ].filter(Boolean).join('\n');

  // Solo el ultimo mensaje del cliente: si se le pasa todo el historial, el patron anterior de la
  // conversacion pesa mas que los datos y el modelo repite la pregunta (fallo visto en produccion).
  const ultimo = [...history].reverse().find((m) => !m.from_me);
  const mensajes = [{ role: 'user', content: String(ultimo?.content || '¿Cómo va mi paquete?').slice(0, 500) }];

  const llamar = async (extra) => {
    const result = await omnicallService.chatCompletion({
      systemPrompt: COMPOSE_PROMPT + '\n\n' + contexto + (extra || ''),
      messages: mensajes,
      jsonMode: true,
      temperature: 0.3,
      preferredProvider: userSetting?.ai_model?.provider || null,
      preferredModel: userSetting?.ai_model?.model_id || null,
      preferredBaseUrl: userSetting?.ai_model?.api_endpoint || null,
      customApiKey: userSetting?.api_key || null,
      userId: ownerUserId,
      fallbackChain: userSetting?.api_key ? [{
        provider: userSetting?.ai_model?.provider || 'deepseek',
        model: userSetting?.ai_model?.model_id || 'deepseek-chat',
        apiKey: userSetting.api_key,
        baseUrl: userSetting?.ai_model?.api_endpoint || null
      }] : []
    });
    const parsed = result?.json || omnicallService.parseJsonSafely(result?.text) || null;
    return { texto: parsed?.reply_text ? String(parsed.reply_text) : null, needsTransfer: Boolean(parsed?.needs_transfer), reason: parsed?.reason || null };
  };

  let respuesta = await llamar('');
  if (!validaRespuesta(respuesta.texto, tracking)) {
    respuesta = await llamar('\n\nATENCION: tu respuesta anterior no sirvio. Tiene que ser BREVE (maximo 3 lineas, unas 40 palabras) e informar el estado y el numero de tracking que aparecen arriba, sin agregar recomendaciones ni tramites que no esten en los datos, y NO puedes usar las frases "tu caso", "asignado", "te transfiero" ni pedir la sucursal como pregunta principal.');
  }
  // Ultimo recurso: si el modelo no logra informar, el ejecutor garantiza el dato al cliente.
  const replyText = validaRespuesta(respuesta.texto, tracking) ? respuesta.texto : textoDeRespaldo(tracking, customerName);

  return {
    replyText,
    needsTransfer: respuesta.needsTransfer || Boolean(tracking?.sla?.requires_human),
    reason: respuesta.reason || tracking?.sla?.reason || null
  };
};

export const handleTrackingQuestion = async ({ trackingCode, workspaceId, userSetting, ownerUserId, history, customerName, channel }) => {
  if (!isFoxpackWorkspace(workspaceId)) return null;
  const tracking = await fetchTracking(trackingCode);
  const composed = await composeTrackingReply({ tracking, userSetting, ownerUserId, history, customerName, channel });
  return {
    tracking,
    replyText: composed?.replyText || null,
    needsTransfer: Boolean(composed?.needsTransfer) || Boolean(tracking?.sla?.requires_human),
    reason: composed?.reason || tracking?.sla?.reason || null
  };
};

export default {
  handleTrackingQuestion, fetchTracking, fetchFromApi, fetchFromDetailPage, parseDetailPage,
  computeSla, composeTrackingReply, isFoxpackWorkspace, FOXPACK_WORKSPACE_ID
};

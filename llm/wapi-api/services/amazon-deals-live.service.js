/**
 * Consulta EN VIVO de ofertas de Amazon para FoxPack.
 *
 * Portado del importador `foxpack-amazon-importer` (parse-search.mjs, normalize.mjs, http.mjs,
 * firecrawl.mjs). Regla del negocio: NO se guarda nada y NO se usa extraccion con IA: se descarga el
 * HTML, se parsea con este codigo y se descarta.
 *
 * Filtros fijos: solo Prime + solo en oferta + precio final <= US$199.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const USD_COOKIE = 'i18n-prefs=USD; lc-main=en_US';
const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';

const MAX_PRICE_USD = 199;
const MIN_DISCOUNT_PCT = 5;
// El filtro p_n_is_prime_eligible:1 viaja en la URL y lo aplica Amazon en su servidor: la insignia
// Prime ya no viene en el marcado de las tarjetas, asi que se confia en el filtro.
const PRIME_FILTER_APPLIED = true;
const PRIME_REFINEMENT = 'p_n_is_prime_eligible:1';
const DEALS_REFINEMENT = 'p_n_deal_type:23566065011';

const BLOCK_MARKERS = [
  'cs_503_search',
  'api-services-support@amazon.com',
  'Sorry! Something went wrong',
  'Sorry, we just need to make sure',
  'Enter the characters you see below',
  'Robot Check',
  'To discuss automated access to Amazon data',
  'bm-verify'
];

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&hellip;': '.', '&mdash;': '-', '&ndash;': '-' };

const decodeEntities = (text = '') => String(text)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] || ENTITIES[m.toLowerCase()] || m);

const cleanText = (html = '') => decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const visibleHtml = (html = '') => String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\u00a0/g, ' ').trim();
  const m = text.match(/(?:\$|USD)?\s*([\d][\d.,]*)/i);
  if (!m) return null;
  let num = m[1].replace(/\s/g, '');
  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) num = num.replace(/\./g, '').replace(',', '.');
    else num = num.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = num.length - lastComma - 1;
    num = decimals === 3 && num.length > 4 ? num.replace(/,/g, '') : num.replace(',', '.');
  }
  const value = Number.parseFloat(num);
  return Number.isFinite(value) ? value : null;
}

const upgradeImage = (url) => (url ? url.replace(/\._[A-Z0-9_,]+_\.(jpg|jpeg|png|webp)$/i, '._AC_UL640_QL65_.$1') : null);

function searchUrl({ keyword, page = 1 }) {
  const params = new URLSearchParams();
  params.set('k', keyword);
  params.set('rh', [PRIME_REFINEMENT, DEALS_REFINEMENT].join(','));
  if (page > 1) params.set('page', String(page));
  return 'https://www.amazon.com/s?' + params.toString();
}

/** Clasifica la respuesta: Amazon responde 200 con una pagina de error de ~2,8 KB al bloquear. */
function classify({ status, html }) {
  const body = html || '';
  if (status === 429 || status === 503) return 'blocked';
  if (status === 404) return 'notfound';
  if (status >= 400) return 'http_error';
  if (body.length < 5000) {
    if (BLOCK_MARKERS.some((m) => body.includes(m))) return 'blocked';
    return 'empty';
  }
  if (BLOCK_MARKERS.some((m) => body.includes(m))) return 'blocked';
  if (/Enter the characters you see below/i.test(body)) return 'captcha';
  return 'ok';
}

async function fetchDirect(url, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        Cookie: USD_COOKIE
      }
    });
    const html = await res.text();
    return { provider: 'direct', status: res.status, html, bytes: html.length, ms: Date.now() - started, cost: 0, kind: classify({ status: res.status, html }) };
  } catch (err) {
    return { provider: 'direct', status: 0, html: '', bytes: 0, ms: Date.now() - started, cost: 0, kind: 'network_error', error: err && err.name === 'TimeoutError' ? 'timeout' : String((err && err.message) || err) };
  }
}

/** Firecrawl: solo se usa como DESCARGADOR de HTML (rawHtml). Nunca extraccion con IA. */
async function fetchFirecrawl(url, timeoutMs) {
  const key = process.env.FIRECRAWL_API_KEY;
  const started = Date.now();
  if (!key) return { provider: 'firecrawl', status: 0, html: '', bytes: 0, ms: 0, cost: 0, kind: 'disabled', error: 'sin_clave' };
  try {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const res = await fetch(FIRECRAWL_ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(Math.max(timeoutMs, 45000)),
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false, proxy: 'auto', timeout: 45000 })
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* no json */ }
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      const html = (json && json.data && (json.data.rawHtml || json.data.html)) || '';
      const credits = Number((json && json.data && json.data.metadata && json.data.metadata.creditsUsed) || 0) || 0;
      return { provider: 'firecrawl', status: res.status, html, bytes: html.length, ms: Date.now() - started, cost: credits, kind: !res.ok || !(json && json.success) ? 'http_error' : classify({ status: 200, html }), error: json && json.error ? String(json.error).slice(0, 200) : null };
    }
    return { provider: 'firecrawl', status: 429, html: '', bytes: 0, ms: Date.now() - started, cost: 0, kind: 'blocked', error: 'rate_limit' };
  } catch (err) {
    return { provider: 'firecrawl', status: 0, html: '', bytes: 0, ms: Date.now() - started, cost: 0, kind: 'network_error', error: String((err && err.message) || err) };
  }
}

const DEAL_BADGE_RE = /sx-deal-dynamic-text|savingPriceOverride|apex-savings-percentage/i;
const ASIN_DIV_RE = /data-asin="([A-Z0-9]{10})"[^>]{0,600}?data-component-type="s-search-result"/g;

function extractTitle(block) {
  const label = block.match(/<h2[^>]*aria-label="([^"]{10,600})"/);
  if (label) return cleanText(label[1]);
  const h2 = block.match(/<h2[^>]*>([\s\S]{0,800}?)<\/h2>/);
  if (h2) { const t = cleanText(h2[1]); if (t.length > 8) return t; }
  const alt = block.match(/<img[^>]*class="s-image"[^>]*alt="([^"]{10,600})"/);
  return alt ? cleanText(alt[1]).replace(/^Sponsored Ad\s*-\s*/i, '') : null;
}

function extractImage(block) {
  const imgTags = block.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    if (!/s-image/.test(tag)) continue;
    const src = tag.match(/\bsrc="([^"]+)"/) || tag.match(/\bdata-src="([^"]+)"/);
    if (src) return src[1];
  }
  const anyImg = block.match(/<img\b[^>]*\bsrc="(https:\/\/m\.media-amazon\.com[^"]+)"/i);
  return anyImg ? anyImg[1] : null;
}

/** Parseo local de una pagina /s de Amazon: sin servicios externos ni IA. */
function parseSearchPage(html) {
  const visible = visibleHtml(html);
  const marks = [...html.matchAll(ASIN_DIV_RE)];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const asin = marks[i][1];
    if (seen.has(asin)) continue;
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(html.length, start + 18000);
    const block = html.slice(start, end);
    const blockVisible = visible.slice(start, Math.min(visible.length, end));
    seen.add(asin);

    const sponsored = /aria-label="Sponsored Ad"|\/sspa\/click|>\s*Sponsored\s*</i.test(block);
    // Precio: se busca DENTRO del contenedor de precio (a-price). Antes se tomaba el primer numero
    // suelto del bloque y salian precios absurdos (un TV de 50" a US$7, 2026-10-06).
    const enPrecio = block.match(/a-price[^>]*>[\s\S]{0,400}?a-offscreen">\s*([^<]{1,24})\s*</);
    const offscreens = [...block.matchAll(/a-offscreen">\s*([^<]{1,24})\s*</g)].map((m) => m[1]);
    const priceRaw = (enPrecio && enPrecio[1]) || offscreens[0] || null;
    const basisCandidates = [...block.matchAll(/a-text-price[\s\S]{0,300}?a-offscreen">\s*([^<]{1,24})\s*</g)].map((m) => m[1]);
    const badgeText = block.match(/a-badge-text"[^>]*data-a-badge-color="sx-deal-dynamic-text"[^>]*>\s*([^<]{2,48}?)\s*</);
    const dealEndsAt = block.match(/dealBadge-countdown-timer"[^>]*data-target-time="([^"]{10,40})"/);
    const dealBadge = DEAL_BADGE_RE.test(block) || /\bEnds in\b/i.test(blockVisible);
    const savePct = block.match(/Save (\d{1,2})\s*%/) || block.match(/-(\d{1,2})\s*%/);
    const rating = block.match(/aria-label="([\d.]+) out of 5 stars"/);
    const reviews = block.match(/aria-label="([\d,]+) ratings?"/);

    out.push({
      asin,
      sponsored,
      title: extractTitle(block),
      image: extractImage(block),
      price: parseMoney(priceRaw),
      priceBasis: basisCandidates.length ? parseMoney(basisCandidates[basisCandidates.length - 1]) : null,
      dealBadge,
      dealLabel: badgeText ? cleanText(badgeText[1]) || null : null,
      dealEndsAt: dealEndsAt ? dealEndsAt[1] : null,
      savePct: savePct ? Number(savePct[1]) : null,
      rating: rating ? Number(rating[1]) : null,
      reviews: reviews ? Number(String(reviews[1]).replace(/,/g, '')) : null,
      prime: /a-icon-prime|aria-label="Amazon Prime"|prime-badge/i.test(block),
      unavailable: /Currently unavailable/i.test(blockVisible)
    });
  }
  return out;
}

function normalize(item) {
  const deal = item.price;
  const basis = item.priceBasis && deal && item.priceBasis > deal ? item.priceBasis : null;
  const pctFromPrices = basis ? Math.round((1 - deal / basis) * 100) : null;
  const pct = pctFromPrices !== null ? pctFromPrices : item.savePct;
  const dealEvidence = [];
  if (item.dealBadge) dealEvidence.push(item.dealLabel || 'oferta');
  if (pct !== null) dealEvidence.push(pct + '%');
  return {
    asin: item.asin,
    title: item.title,
    image: upgradeImage(item.image),
    url: 'https://www.amazon.com/dp/' + item.asin,
    price_deal_usd: deal,
    price_normal_usd: basis,
    discount_pct: pct,
    prime: Boolean(item.prime) || PRIME_FILTER_APPLIED,
    deal_active: dealEvidence.length > 0,
    deal_evidence: dealEvidence,
    deal_ends_at: item.dealEndsAt || null,
    rating: item.rating,
    reviews: item.reviews,
    unavailable: item.unavailable
  };
}

function qualifies(r, maxPriceUsd) {
  const reasons = [];
  if (!/^[A-Z0-9]{10}$/.test(String(r.asin || ''))) reasons.push('asin_invalido');
  if (!r.title || r.title.length < 12) reasons.push('sin_titulo');
  if (!r.image) reasons.push('sin_imagen');
  if (!(r.price_deal_usd > 0)) reasons.push('sin_precio');
  else if (r.price_deal_usd >= maxPriceUsd) reasons.push('precio_sobre_tope');
  if (!r.prime) reasons.push('no_prime');
  if (!r.deal_active) reasons.push('sin_oferta');
  else if (typeof r.discount_pct === 'number' && r.discount_pct < MIN_DISCOUNT_PCT) reasons.push('descuento_bajo');
  if (r.unavailable) reasons.push('no_disponible');
  // Saneado: un descuento de mas del 85% casi siempre es un precio mal leido.
  if (r.price_normal_usd && r.price_deal_usd && r.price_deal_usd < r.price_normal_usd * 0.15) reasons.push('precio_sospechoso');
  if (r.price_deal_usd && r.price_deal_usd < 3) reasons.push('precio_muy_bajo');
  return { ok: reasons.length === 0, reasons };
}

const shortTitle = (t) => {
  const s = String(t || '').split('|')[0].trim();
  return s.length > 70 ? s.slice(0, 67).trim() + '…' : s;
};

export const amazonDealsLive = {
  searchUrl,
  /** Palabras utiles del mensaje del cliente (sin articulos ni la palabra "oferta"). */
  extraerConsulta(texto) {
    const stop = new Set(['busco','buscar','quiero','quisiera','algo','algun','alguna','producto','productos','oferta','ofertas','descuento','descuentos','barato','baratos','promo','promocion','amazon','prime','tienen','tienes','hay','que','para','con','sin','los','las','del','una','uno','unos','unas','por','mas','menos','me','mi','tu','de','en','y','o','el','la','ver','puedes','podrias','muestrame','ensename','dame','recomienda','recomiendas','nuevo','nuevos','hola','buenas','buenos','buen','dias','tardes','noches','saludos','favor','gracias','mira','ver','foto','fotos','imagen','imagenes','foticos','mandas','manda','mandame','enviar','envias','envie','muestra','muestras','existe','existen','algo','otra','otro','day','days','today','tomorrow','please','hey','hola','buenas','buenos','buen','dias','dia','hoy','manana','ayer','saber','saberlo','informacion','info','listo','perfecto','entonces','tambien','ademas','estoy','estamos','esperando','espero','sigo','aqui','ahi','ya','muy','mucho','poco','nada','todo','todos','todas','gracias','favor','ok','si','no','mas','menos','good','morning','afternoon','evening','night','thanks','thank','you','sir','maam','madam','regards','nice','very']);

// Palabras cortas que SI son producto (no se descartan por tener 2 caracteres).
const PALABRAS_CORTAS = new Set(['tv','pc','hd','4k','5k','8k','usb','ssd','sd','led','gps','ram','cpu','vr','ar','3d','ps5','ps4','xbox','wifi']);
    return String(texto || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9ñ\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => (w.length >= 3 || PALABRAS_CORTAS.has(w)) && !stop.has(w))
      .filter((w) => !/^(enviame|link|links|enlace|enlaces|primera|primeras|primero|primeros|segunda|segundo|tercera|tercero|aun|sigue|siguen)$/.test(w))
      .slice(0, 6)
      .join(' ')
      .trim();
  },

  /**
   * Busca ofertas EN VIVO. No guarda nada: descarga, parsea y devuelve como maximo `max` productos.
   * @param {{ query: string, max?: number, maxPriceUsd?: number, timeoutMs?: number }} opts
   */
  async buscar({ query, max = 3, maxPriceUsd = MAX_PRICE_USD, timeoutMs = 9000 } = {}) {
    const started = Date.now();
    const keyword = String(query || '').trim();
    if (!keyword) return { ok: false, reason: 'sin_consulta', items: [], url: null, provider: null, ms: 0 };
    const url = searchUrl({ keyword });

    let page = await fetchDirect(url, timeoutMs);
    if (page.kind !== 'ok') {
      console.log('[AmazonLive] directo no sirvio (' + page.kind + '), se intenta Firecrawl');
      const fc = await fetchFirecrawl(url, 45000);
      if (fc.kind === 'ok' || (fc.html && fc.html.length > 20000)) page = fc;
      else page = page.kind === 'ok' ? page : fc;
    }

    if (!page.html || page.kind === 'disabled' || page.kind === 'network_error') {
      console.log('[AmazonLive] sin HTML. query="' + keyword + '" kind=' + page.kind + ' error=' + (page.error || '-'));
      return { ok: false, reason: page.kind, items: [], url, provider: page.provider, ms: Date.now() - started };
    }

    const parsed = parseSearchPage(page.html);
    const norm = parsed.map(normalize);
    const ok = norm.filter((r) => qualifies(r, maxPriceUsd).ok);
    const items = ok.slice(0, Math.max(1, Math.min(8, max)));

    console.log('[AmazonLive] query="' + keyword + '" provider=' + page.provider + ' html=' + page.html.length + ' parseados=' + parsed.length + ' validos=' + ok.length + ' devueltos=' + items.length + ' ms=' + (Date.now() - started) + ' creditos=' + page.cost);

    return {
      ok: items.length > 0,
      reason: items.length ? null : (parsed.length ? 'sin_candidatos_validos' : 'sin_resultados'),
      items: items.map((r) => ({
        asin: r.asin,
        title: shortTitle(r.title),
        price: r.price_deal_usd,
        price_normal: r.price_normal_usd,
        discount_pct: r.discount_pct,
        prime: r.prime,
        image: r.image,
        url: r.url,
        deal_ends_at: r.deal_ends_at
      })),
      url,
      provider: page.provider,
      ms: Date.now() - started,
      credits: page.cost || 0
    };
  }
};

export default amazonDealsLive;

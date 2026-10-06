import mongoose from 'mongoose';

// Recuperacion de conocimiento (RAG). Antes se inyectaban los 5 documentos completos (~80.700 chars,
// ~22.400 tokens) en CADA mensaje: era el 71% del costo. Ahora se buscan solo los fragmentos que el
// mensaje necesita. Todo el conocimiento sigue guardado: nada se pierde ni hay que reentrenar.

const COL = 'omnichannel_branch_knowledge';
const TTL_INDICE_MS = 5 * 60 * 1000;
const TTL_CONSULTA_MS = 10 * 60 * 1000;
const PRESUPUESTO_CHARS = 9000;
const MAX_POR_FRAGMENTO = 1200;

const SIN_VALOR = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'que', 'en', 'a', 'por', 'para', 'con', 'sin', 'mi', 'tu', 'su', 'es', 'esta', 'estan', 'son', 'como', 'cuando', 'donde', 'porque', 'se', 'lo', 'al', 'del', 'mas', 'pero', 'si', 'no', 'ya', 'me', 'te', 'le', 'nos', 'hay', 'muy', 'todo', 'toda', 'esto', 'eso', 'cuanto', 'cuantos', 'cuanta', 'tiene', 'tengo', 'puedo', 'quiero', 'necesito', 'hola', 'buenas', 'gracias', 'favor', 'seria', 'podria', 'puede', 'hacer', 'hago', 'soy', 'estoy', 'eres', 'tienes', 'sabes', 'dime', 'decir', 'ser', 'estar', 'tambien', 'solo', 'sólo', 'aqui', 'ahi', 'alli', 'bien', 'mal', 'muy']);

const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokensDe = (t) => normalizar(t).split(' ').filter((x) => x.length >= 3 && !SIN_VALOR.has(x));

const trocear = (contenido, objetivo = 1100) => {
  const texto = String(contenido || '').replace(/\r/g, '').trim();
  if (!texto) return [];
  const parrafos = texto.split(/\n{2,}/);
  const piezas = [];
  let actual = '';
  const cerrar = () => { if (actual.trim()) piezas.push(actual.trim()); actual = ''; };
  for (const p of parrafos) {
    if (p.length > objetivo * 1.6) {
      cerrar();
      const oraciones = p.split(/(?<=[.!?])\s+/);
      let bloque = '';
      for (const o of oraciones) {
        if ((bloque + ' ' + o).length > objetivo && bloque) { piezas.push(bloque.trim()); bloque = o; }
        else bloque += (bloque ? ' ' : '') + o;
      }
      if (bloque.trim()) piezas.push(bloque.trim());
      continue;
    }
    if ((actual + '\n\n' + p).length > objetivo && actual) { cerrar(); actual = p; }
    else actual += (actual ? '\n\n' : '') + p;
  }
  cerrar();
  return piezas.map((t) => (t.length > MAX_POR_FRAGMENTO ? t.slice(0, MAX_POR_FRAGMENTO) : t));
};

let indice = { at: 0, sello: '', fragmentos: [], idf: new Map() };
const cacheConsultas = new Map();

const cargarIndice = async (workspaceId) => {
  const db = mongoose.connection.db;
  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const docs = await db.collection(COL).find(
    { workspace_id: wsId, status: 'active' },
    { projection: { title: 1, content: 1, type: 1, scope: 1, branch_id: 1, matrix_id: 1, source_url: 1, updated_at: 1, created_at: 1 } }
  ).toArray();

  const sello = docs.map((d) => String(d.updated_at || d.created_at || '')).sort().pop() || '';
  if (indice.fragmentos.length && indice.sello === sello && Date.now() - indice.at < TTL_INDICE_MS) return indice;

  const fragmentos = [];
  for (const d of docs) {
    for (const [i, texto] of trocear(d.content).entries()) {
      fragmentos.push({
        docId: String(d._id),
        titulo: d.title,
        tipo: d.type,
        scope: d.scope,
        branchId: d.branch_id ? String(d.branch_id) : null,
        matrixId: d.matrix_id ? String(d.matrix_id) : null,
        parte: i + 1,
        texto
      });
    }
  }
  const df = new Map();
  for (const f of fragmentos) {
    for (const t of new Set(tokensDe(f.titulo + ' ' + f.texto))) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + fragmentos.length / (1 + n)));

  indice = { at: Date.now(), sello, fragmentos, idf };
  return indice;
};

const puntuar = (fragmento, consultaTokens, idf) => {
  if (!consultaTokens.length) return 0;
  const enTexto = new Set(tokensDe(fragmento.texto));
  const enTitulo = new Set(tokensDe(fragmento.titulo));
  let puntaje = 0;
  for (const t of new Set(consultaTokens)) {
    const peso = idf.get(t) || Math.log(1 + fragmento.texto.length / 400);
    if (enTitulo.has(t)) puntaje += peso * 2.5;
    else if (enTexto.has(t)) puntaje += peso;
  }
  // Frases de dos palabras seguidas dentro del fragmento: senal fuerte ("peso volumetrico").
  const textoNorm = normalizar(fragmento.texto);
  for (let i = 0; i < consultaTokens.length - 1; i += 1) {
    if (textoNorm.includes(consultaTokens[i] + ' ' + consultaTokens[i + 1])) puntaje += 3;
  }
  return puntaje;
};

// Devuelve el bloque de conocimiento que se le manda al modelo: la politica (corta, siempre) y los
// fragmentos con mejor puntaje hasta el presupuesto.
export const obtenerConocimientoRelevante = async ({ workspaceId, matrixId = null, branchId = null, query = '', presupuestoChars = PRESUPUESTO_CHARS } = {}) => {
  if (!workspaceId || !mongoose.connection.db) return '';
  const clave = normalizar(String(query || '').slice(0, 240));
  const cacheado = cacheConsultas.get(clave);
  if (cacheado && Date.now() - cacheado.at < TTL_CONSULTA_MS) return cacheado.texto;

  const { fragmentos, idf } = await cargarIndice(workspaceId);
  if (!fragmentos.length) return '';

  const consultaTokens = tokensDe(query);
  const alcance = (f) => (f.branchId && branchId && f.branchId === String(branchId)) || (!f.branchId && !f.matrixId);
  const candidatos = fragmentos.filter((f) => !f.branchId || f.branchId === String(branchId) || String(f.branchId) === String(branchId));

  const conPuntaje = candidatos
    .map((f) => ({ f, puntaje: puntuar(f, consultaTokens, idf) + (alcance(f) ? 0.3 : 0) }))
    .filter((x) => x.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje);

  const elegidos = [];
  let usado = 0;
  // La politica va siempre, pero ORDENADA por relevancia para este mensaje: si el presupuesto se
  // agota, los fragmentos que el mensaje necesita entran primero (antes entraban por orden de carga
  // y un documento nuevo quedaba fuera cuando el presupuesto ya estaba lleno).
  const puntajeDe = new Map(conPuntaje.map((x) => [x.f, x.puntaje]));
  const politicas = fragmentos
    .filter((x) => x.tipo === 'policy' && !x.branchId)
    .sort((a, b) => (puntajeDe.get(b) || 0) - (puntajeDe.get(a) || 0));
  for (const f of politicas) {
    if (usado + f.texto.length > presupuestoChars) continue;
    elegidos.push(f);
    usado += f.texto.length;
  }
  for (const { f } of conPuntaje) {
    if (elegidos.includes(f)) continue;
    if (usado + f.texto.length > presupuestoChars) continue;
    elegidos.push(f);
    usado += f.texto.length;
    if (elegidos.length >= 12) break;
  }
  if (!elegidos.length) return '';

  const bloque = [
    'BASE DE CONOCIMIENTO RELEVANTE PARA ESTE MENSAJE (no es la base completa; usa solo lo que aplique):'
  ];
  for (const f of elegidos) {
    bloque.push('### ' + f.titulo + ' [' + f.tipo + ']');
    bloque.push(f.texto);
  }
  bloque.push('Si el cliente pregunta algo que no aparece aqui, dilo con naturalidad, ofrece ayuda humana y no inventes datos.');
  const texto = bloque.join('\n');
  cacheConsultas.set(clave, { at: Date.now(), texto });
  if (cacheConsultas.size > 300) cacheConsultas.delete(cacheConsultas.keys().next().value);
  return texto;
};

export const limpiarIndice = () => { indice = { at: 0, sello: '', fragmentos: [], idf: new Map() }; cacheConsultas.clear(); };

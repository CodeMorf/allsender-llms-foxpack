const normalize = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

const ACKNOWLEDGEMENTS = new Set([
  'gracias', 'muchas gracias', 'mil gracias', 'graxias', 'grasias', 'grx',
  'ok', 'okay', 'okey', 'vale', 'de acuerdo', 'esta bien', 'entendido',
  'listo', 'perfecto', 'excelente', 'genial', 'de nada', 'thank you', 'thanks', 'thx'
]);

const PROMOTIONAL_QUESTION = /(?:te gustaria|quieres|deseas|prefieres)\s+(?:cotizar|hacer una cotizacion|que te comunique con un asesor|hablar con un asesor)|(?:te ayudo|puedo ayudarte|necesitas|quieres)\s+con\s+(?:algo\s+)?mas|en que (?:mas )?puedo ayudarte(?: hoy)?|que mas necesitas/i;
const GENERIC_FOLLOW_UP = /(?:si mas adelante necesitas|si necesitas algo mas|si deseas algo mas|aqui estamos para ayudarte|aqui estoy para ayudarte|cuando quieras,? aqui estamos|estoy aqui para ayudarte)/i;
const COURTESY_CLOSE = /(?:con gusto|de nada|gracias por escribir|que tengas buen dia|hasta luego|aqui estoy para ayudarte|aqui estamos para ayudarte)/i;
const BRIEF_FINAL_CLOSE = /(?:^|[.!]\s*)(?:con gusto|de acuerdo|de nada|perfecto|listo|vale|entendido|gracias|muchas gracias|hasta luego|que tengas buen dia)[.!]*$/i;

export function classifyCourtesyAcknowledgement(value) {
  const normalized = normalize(value)
    .replace(/[.,!?¡¿'’"`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = normalized.replace(/\s+/g, '');
  const courtesyOnly = /^(?:(?:muchasgracias|milgracias|gracias|graxias|grasias|grx|deacuerdo|estabien|entendido|listo|perfecto|excelente|genial|denada|okay|okey|ok|vale|thankyou|thanks|thx))+$/;
  return ACKNOWLEDGEMENTS.has(normalized) || courtesyOnly.test(compact) ? normalized : null;
}

export function hasPendingRequiredQuestion(value) {
  const text = String(value || '').trim();
  const questionStart = text.lastIndexOf('¿');
  const questionEnd = text.lastIndexOf('?');
  if (questionEnd < 0) return false;
  const previousBoundary = Math.max(text.lastIndexOf('.', questionEnd), text.lastIndexOf('!', questionEnd));
  const start = questionStart >= 0 && questionStart < questionEnd ? questionStart : previousBoundary + 1;
  const lastQuestion = text.slice(start, questionEnd + 1).replace(/[?¿\s.!]+$/g, '');
  if (!lastQuestion) return false;
  return !PROMOTIONAL_QUESTION.test(normalize(lastQuestion));
}

export function alreadyClosedConversation(value) {
  const text = normalize(value);
  return COURTESY_CLOSE.test(text) || BRIEF_FINAL_CLOSE.test(text) || GENERIC_FOLLOW_UP.test(text) || PROMOTIONAL_QUESTION.test(text);
}

export function trimProactiveEnding(value) {
  let text = String(value || '').trim();
  if (!text) return text;

  const genericBoilerplate = /^gracias por escribir\.[\s\S]*?(?:puedo ayudarte con informacion general|si necesitas una gestion especializada)[\s\S]*$/i;
  if (genericBoilerplate.test(normalize(text))) return text.slice(0, text.indexOf('.') + 1).trim();

  const futureOffer = text.search(/\s+(?:si m[aá]s adelante necesitas|si necesitas algo m[aá]s|si deseas algo m[aá]s|aqu[ií] estoy para ayudarte|aqu[ií] estamos para ayudarte|cuando quieras,? aqu[ií] estamos)\b/i);
  if (futureOffer >= 0) text = text.slice(0, futureOffer).trim();

  const questionOffer = text.search(/\s+¿(?:te gustar[ií]a cotizar|quieres cotizar|deseas cotizar|prefieres que te comunique con un asesor|te ayudo con algo m[aá]s|puedo ayudarte con algo m[aá]s|necesitas algo m[aá]s|en qu[eé] m[aá]s puedo ayudarte|qu[eé] m[aá]s necesitas)\b/i);
  if (questionOffer >= 0) text = text.slice(0, questionOffer).trim();

  return text;
}

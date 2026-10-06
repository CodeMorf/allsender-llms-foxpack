import mongoose from 'mongoose';
import { isOpenHumanCase } from './conversation-context.service.js';
import { customerContextPrompt } from './webchat-identity.service.js';
import ChatAssignment from '../models/chat-assignment.model.js';
import AssignmentEvent from '../models/assignment-event.model.js';
import User from '../models/user.model.js';
import Workspace from '../models/workspace.model.js';
import Message from '../models/message.model.js';
import deepseekService from './deepseek.service.js';
import { callAIModel } from '../utils/ai-utils.js';
import Department from '../models/department.model.js';
import Contact from '../models/contact.model.js';
import { Branch, BranchMembership, BranchAgent, BranchHandoff, BranchConversationState } from '@allsender/omnichannel-branches';
import { sendOmnichannelMessageHelper } from '../utils/automated-response.service.js';
import organizationCaseService from './organization-case.service.js';
import omnicallService from './omnicall.service.js';
import foxpackTrackingService from './foxpack-tracking.service.js';
import organizationKnowledgeService from './organization-knowledge.service.js';
import amazonDealsLive from './amazon-deals-live.service.js';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { alreadyClosedConversation, classifyCourtesyAcknowledgement, hasPendingRequiredQuestion, trimProactiveEnding } from '../utils/response-style-policy.js';

// Ofertas de Amazon EN VIVO: solo para el workspace de FoxPack.
const AMAZON_LIVE_WORKSPACE = '6ab82a6847ab241dfafe4bc0';

const toObjectId = (val) => (val && mongoose.Types.ObjectId.isValid(val) ? new mongoose.Types.ObjectId(val) : null);

const normalize = (text) => String(text || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

// Tarifas vigentes por libra (DOP). Fuente: documento de tarifas y respuestas de los agentes.
const TARIFAS_POR_LIBRA = { china: 780, miami: 245 };
// Guardia determinista de precios: el modelo cotizo China con la tarifa de Miami (RD$245) el 05-oct.
// Es un dato de dinero, asi que se corrige antes de enviar.
const corregirTarifas = (texto) => {
  let t = String(texto || "");
  if (!t || !/china/i.test(t) || !/libra/i.test(t)) return t;
  const traePrecioMiami = /(245|244[.,]99)/.test(t);
  const traeChinaBuena = /780/.test(t);
  if (traePrecioMiami && !traeChinaBuena) {
    console.log("[BranchRouter] Guardia de tarifas: se corrigio una cotizacion de China con el precio de Miami");
    t = t.replace(/244[.,]99/g, "780").replace(/245/g, "780");
  }
  return t;
};
const sanearRespuesta = (texto) => corregirTarifas(trimProactiveEnding(texto));

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function findNearestBranch(branches, location) {
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) return null;
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);

  let nearest = null;
  let minDistance = Infinity;

  for (const branch of branches) {
    const coords = branch.location?.coordinates;
    if (Array.isArray(coords) && coords.length === 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
      // GeoJSON is [longitude, latitude]
      const dist = calculateDistanceKm(lat, lon, coords[1], coords[0]);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = { branch, distanceKm: dist };
      }
    }
  }
  return nearest;
}

// Cuando ya se conoce la sucursal del paquete (por el pos_id), no tiene sentido cerrar pidiendo la
// ciudad o la zona: se quita esa pregunta del final en lugar de depender del modelo.
const quitarPreguntaDeCiudad = (texto, recordado) => {
  if (!recordado?.branch_name || !texto) return texto;
  let limpio = String(texto)
    .replace(/\s*¿[^?]*(ciudad|zona)[^?]*\?/gi, '')
    .replace(/\s*(cuéntame|cuentame|me confirmas|me confirmarías|indícame|indicame|dime|me dices|me dirías)[^.!?]*(ciudad|zona)[^.!?]*[.!?]?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return limpio.length >= 40 ? limpio : texto;
};

export class BranchRouterService {
  /**
   * Helper to send an outbound reply back to the user across channels.
   */
  static async sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId, workspaceId, text, connectionId, allowHumanCaseAck = false }) {
    if (!text) return;
    try {
      // A human takeover during an LLM request must also suppress the delayed reply.
      if (contactDoc?._id && !allowHumanCaseAck) {
        const fresh = await Contact.findOne({ _id: contactDoc._id, workspace_id: contactDoc.workspace_id }).select('chatbot_paused').lean();
        if (fresh?.chatbot_paused) return;
      }
      const isSocial = platform === 'facebook' || platform === 'instagram' || contactDoc?.metadata?.platform === 'facebook' || contactDoc?.metadata?.platform === 'instagram' || contactDoc?.metadata?.zernio_account_id;

      if (platform === 'webchat') {
        const { sendWebchatReply } = await import('./webchat-messaging.service.js');
        await sendWebchatReply({ contactDoc, text });
        return;
      }

      if ((platform === 'whatsapp' || !platform) && !isSocial) {
        const { default: unifiedWhatsAppService } = await import('./whatsapp/unified-whatsapp.service.js');
        const effectiveUserId = userId || contactDoc?.user_id;
        if (unifiedWhatsAppService && effectiveUserId) {
          await unifiedWhatsAppService.sendMessage(effectiveUserId, {
            recipientNumber: senderNumber,
            messageText: text,
            messageType: 'text',
            connectionId: connectionId || whatsappPhoneNumberId || undefined,
            whatsappPhoneNumberId: whatsappPhoneNumberId || undefined
          });
          return;
        }
      }

      if (contactDoc) {
        await sendOmnichannelMessageHelper({
          contactDoc,
          messageType: 'text',
          text
        });
      }
    } catch (err) {
      console.error('[BranchRouterService.sendReply] Error sending reply:', err.message);
    }
  }

  /** Envia hasta 3 fotos de las ofertas de Amazon consultadas en vivo. No guarda nada. */
  static async enviarImagenesOfertas({ contactDoc, platform, senderNumber, whatsappPhoneNumberId, userId, workspaceId, connectionId, ofertas = [] }) {
    if (!ofertas.length) return;
    try {
      const { default: unifiedWhatsAppService } = await import('./whatsapp/unified-whatsapp.service.js');
      const effectiveUserId = userId || contactDoc?.user_id;
      if (!effectiveUserId) return;
      let enviadas = 0;
      for (const p of ofertas) {
        if (!p.image) continue;
        const caption = p.title + ' - US$' + p.price;
        await unifiedWhatsAppService.sendMessage(effectiveUserId, {
          recipientNumber: senderNumber,
          messageText: caption,
          messageType: 'image',
          mediaUrl: p.image,
          connectionId: connectionId || whatsappPhoneNumberId || undefined,
          whatsappPhoneNumberId: whatsappPhoneNumberId || undefined
        });
        enviadas++;
        await new Promise((r) => setTimeout(r, 1200));
      }
      console.log('[BranchRouter] Fotos de ofertas enviadas: ' + enviadas);
    } catch (e) {
      console.warn('[BranchRouter] No se pudieron enviar las fotos de ofertas:', e.message);
    }
  }

  /**
   * Main Router Entry Point:
   * Called for every incoming message before generic automations.
   */
  static async processIncomingMessage({
    workspaceId,
    contactDoc,
    platform = 'whatsapp',
    senderNumber,
    receiverNumber,
    whatsappPhoneNumberId,
    incomingText = '',
    conversationId = null,
    location = null,
    actorId = null,
    connectionId = null
  }) {
    const wsId = toObjectId(workspaceId);
    if (!wsId || !contactDoc?._id) return { handled: false, reason: 'missing_context' };

    const contactId = toObjectId(contactDoc._id);
    const effectiveAccountId = String(connectionId || whatsappPhoneNumberId || receiverNumber || '');
    const conversationKey = [
      String(platform || 'unknown').toLowerCase(),
      effectiveAccountId || 'default',
      conversationId
        ? `conversation:${String(conversationId)}`
        : String(contactId || senderNumber || 'unknown')
    ].join(':');

    // 1. Check if conversation is ALREADY ASSIGNED to a chatbot, branch, or human agent
    const activeAssignment = await ChatAssignment.findOne({
      workspace_id: wsId,
      contact_id: contactId,
      conversation_key: conversationKey,
      status: 'assigned',
      is_solved: { $ne: true }
    }).lean();

    const freshContact = await Contact.findOne({ _id: contactId, workspace_id: wsId }).select('chatbot_paused').lean();
    if (freshContact?.chatbot_paused || isOpenHumanCase(activeAssignment)) {
      // Reactivacion automatica: el silencio no puede ser eterno. Si el contacto quedo silenciado sin
      // ticket, o el ticket nunca tuvo respuesta humana y ya pasaron las horas de margen, la IA retoma
      // la conversacion en vez de dejar al cliente esperando para siempre.
      const HORAS_PARA_REACTIVAR_IA = 2;
      const horasDeEspera = activeAssignment
        ? (Date.now() - new Date(activeAssignment.created_at || activeAssignment.opened_at || Date.now()).getTime()) / 3600000
        : Infinity;
      const sinRespuestaHumana = !activeAssignment || !activeAssignment.first_response_at;
      if (!activeAssignment || (sinRespuestaHumana && horasDeEspera >= HORAS_PARA_REACTIVAR_IA)) {
        await Contact.updateOne({ _id: contactId }, { $set: { chatbot_paused: false, updated_at: new Date() } });
        console.log('[BranchRouter] IA reactivada (el silencio no es eterno): ' + (activeAssignment ? ('ticket ' + activeAssignment.case_number + ' con ' + Math.round(horasDeEspera) + 'h sin respuesta humana') : 'contacto silenciado sin ticket abierto'));
      } else {
        return { handled: true, routed: false, reason: 'human_ticket_owner' };
      }
    }

    // Si ya está asignado a un CHATBOT, no quemar tokens de IA en el router de sucursales
    if (activeAssignment && activeAssignment.chatbot_id) {
      return { handled: false, reason: 'chatbot_assigned', chatbotId: activeAssignment.chatbot_id };
    }
    if (contactDoc?.assigned_chatbot) {
      return { handled: false, reason: 'contact_has_assigned_chatbot', chatbotId: contactDoc.assigned_chatbot };
    }

    const activeCase = activeAssignment?.branch_id ? activeAssignment : null;

    // 2. Fetch all active branches for this workspace
    const branches = await Branch.find({
      workspace_id: wsId,
      status: 'active',
      deleted_at: null
    }).sort({ sort_order: 1, is_default: -1, name: 1 }).lean();

    if (branches.length === 0) {
      return { handled: false, reason: 'no_branches' };
    }

    // 3. Find Matrix to check organization policies & company name
    const MatrixModel = mongoose.models.OrganizationMatrix || mongoose.model('OrganizationMatrix');
    const matrix = await MatrixModel.findOne({ workspace_id: wsId, is_default: true, deleted_at: null }).lean() ||
                   await MatrixModel.findOne({ workspace_id: wsId, deleted_at: null }).lean();
    const wsDoc = await Workspace.findById(wsId).lean();
    const companyName = matrix?.name || wsDoc?.name || 'nuestra empresa';
    const companyDescription = matrix?.description || '';
    const customInstructions = matrix?.router_instructions || matrix?.attention_policy || '';
    const customWelcome = matrix?.custom_welcome_message || '';

    // 4. Retrieve or initialize conversation state
    let state = await BranchConversationState.findOne({
      workspace_id: wsId,
      conversation_key: conversationKey
    });

    if (!state) {
      state = await BranchConversationState.create({
        workspace_id: wsId,
        conversation_key: conversationKey,
        branch_resolution_source: 'unknown',
        responder_type: 'NONE',
        metadata: {
          status: 'branch_selection_pending',
          menu_options: [],
          failed_attempts: 0,
          city_context: null
        },
        recent_messages: []
      });
    }

    await BranchConversationState.updateOne(
      { _id: state._id },
      {
        $set: {
          'metadata.contact_id': String(contactId),
          'metadata.platform': String(platform || 'unknown'),
          'metadata.account_id': effectiveAccountId || null
        }
      }
    );

    // Regla del Contrato Maestro: BOT DE FLUJO
    // Si flow_bot_active=true, el Flow Bot tiene prioridad.
    // No respondas en paralelo. Si ai_breakout_allowed=false, permanecer en silencio.
    try {
      const AutomationExecution = mongoose.models.AutomationExecution || mongoose.model('AutomationExecution');
      const waitingFlow = await AutomationExecution.findOne({
        contact_identifier: senderNumber,
        status: 'waiting',
        workspace_id: wsId
      }).sort({ updated_at: -1 }).lean();

      if (waitingFlow) {
        const allowBreakout = Boolean(matrix?.ai_breakout_allowed);
        if (!allowBreakout) {
          console.log(`[BranchRouter] Flow Bot activo para ${senderNumber} (execution ${waitingFlow._id}) y ai_breakout_allowed=false. Guardando silencio según contrato.`);
          return { handled: false, flowBotActive: true, reason: 'flow_bot_priority' };
        }
      }
    } catch (flowCheckErr) {
      console.warn('[BranchRouter] Error verificando flow activo:', flowCheckErr.message);
    }

    // 5. AI mode uses only the workspace owner's key. No platform key.
    let aiMode = matrix?.ai_router_enabled !== false;
    const keyOwnerId = wsDoc?.user_id || contactDoc.user_id;
    const userSetting = await mongoose.connection.db.collection('user_settings').findOne({ user_id: keyOwnerId });
    const hasCustomKey = Boolean(userSetting?.api_key) && !String(userSetting.api_key).startsWith('enc:');
    if (!hasCustomKey) {
      aiMode = false;
    }

    // Record customer's incoming message in recent history
    const inputContent = String(incomingText || '').trim();
    if (inputContent) {
      await BranchConversationState.updateOne(
        { _id: state._id },
        {
          $push: {
            recent_messages: {
              $each: [{ role: 'user', content: inputContent, at: new Date() }],
              $slice: -20
            }
          }
        }
      );
      state = await BranchConversationState.findById(state._id);
    }

    // Do not start another LLM turn for a courtesy acknowledgement after a resolved exchange.
    // Preserve genuine questions that still need an answer (for example, a missing city or branch).
    if (aiMode && inputContent) {
      const acknowledgement = classifyCourtesyAcknowledgement(inputContent);
      const priorAssistant = (state.recent_messages || []).slice().reverse()
        .find(message => message.role === 'assistant' && message.content);
      if (acknowledgement && priorAssistant && !hasPendingRequiredQuestion(priorAssistant.content)) {
        if (alreadyClosedConversation(priorAssistant.content)) {
          return { handled: true, routed: false, mode: 'courtesy_acknowledgement_suppressed' };
        }

        const isThanks = /gracias|thank|graxias|grasias|grx/.test(acknowledgement);
        const courtesyReply = isThanks ? 'Con gusto.' : 'De acuerdo.';
        try {
          await this.sendReply({
            contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId,
            userId: contactDoc.user_id, workspaceId: wsId, text: courtesyReply, connectionId: effectiveAccountId
          });
          await BranchConversationState.updateOne(
            { _id: state._id },
            { $push: { recent_messages: { $each: [{ role: 'assistant', content: courtesyReply, at: new Date() }], $slice: -20 } } }
          );
          return { handled: true, routed: false, mode: 'courtesy_acknowledgement' };
        } catch (courtesyErr) {
          console.warn('[BranchRouter] Courtesy response failed:', courtesyErr.message);
          return { handled: true, routed: false, mode: 'courtesy_acknowledgement_send_failed' };
        }
      }
    }

    // 6. Execute Routing based on Mode
    if (aiMode) {
      return await this.handleAiMode({
        wsId,
        contactDoc,
        platform,
        senderNumber,
        receiverNumber,
        whatsappPhoneNumberId,
        effectiveAccountId,
        conversationKey,
        state,
        branches,
        matrix,
        companyName,
        companyDescription,
        customInstructions,
        customWelcome,
        incomingText: inputContent,
        location,
        actorId,
        activeAssignment,
        activeCase
      });
    } else {
      return await this.handleDeterministicMode({
        wsId,
        contactDoc,
        platform,
        senderNumber,
        receiverNumber,
        whatsappPhoneNumberId,
        effectiveAccountId,
        conversationKey,
        state,
        branches,
        matrix,
        companyName,
        companyDescription,
        customInstructions,
        customWelcome,
        incomingText: inputContent,
        location,
        actorId
      });
    }
  }

  /**
   * MODO 1: IA CONVERSACIONAL AUTÓNOMA
   * Interpreta lenguaje natural, no pregunta lo que ya sabe, maneja GPS,
   * y no inventa sucursales.
   */
  static async handleAiMode({
    wsId,
    contactDoc,
    platform,
    senderNumber,
    receiverNumber,
    whatsappPhoneNumberId,
    effectiveAccountId,
    conversationKey,
    state,
    branches,
    matrix,
    companyName,
    companyDescription = '',
    customInstructions = '',
    customWelcome = '',
    incomingText,
    location,
    actorId,
    activeAssignment = null,
    activeCase = null
  }) {
    // 1. Check GPS location first if shared
    if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
      const bestMatch = findNearestBranch(branches, location);

      if (bestMatch?.branch) {
        const branch = bestMatch.branch;
        const reply = `Encontré nuestra sucursal de *${branch.name}* como la más cercana a tu ubicación. Te comunicaré con su equipo de inmediato.`;

        await this.sendReply({
          contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId,
          userId: contactDoc.user_id, workspaceId: wsId, text: reply, connectionId: effectiveAccountId
        });

        await this.executeBranchTransfer({
          wsId, contactDoc, platform, senderNumber, receiverNumber,
          whatsappPhoneNumberId, effectiveAccountId, conversationKey,
          state, branch, source: 'location', actorId
        });

        return { handled: true, routed: true, branch, mode: 'ai_location' };
      }
    }

    // 2. Prepare branches metadata for LLM grounding (Strict Grounding: NEVER invent branches)
    // El modo de entrega (Solo Delivery / sucursal fisica) y el prefijo de la marca son
    // informacion interna: el cliente solo debe oir el nombre del punto.
    const nombreParaCliente = (b) => String(b.name || '')
      .replace(/^\s*Fox\s*Pack\s*/i, '')
      .replace(/\s*[\(/]?\s*Solo\s*Delivery\s*\)?/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || b.name;

    // Se envia solo lo que el modelo necesita para ubicar la ciudad del cliente: id, nombre,
    // ciudad y zonas cortas. El codigo interno, la direccion completa y la descripcion de servicios
    // no aportan al enrutado y ocupaban ~11.000 caracteres en cada mensaje (recorte 2026-10-06).
    const branchesJson = branches.map((b, i) => ({
      id: String(b._id),
      numero_opcion: i + 1,
      nombre: nombreParaCliente(b),
      ciudad: b.address?.city || null,
      zonas: (b.aliases || [])
        .map((a) => String(a || '').trim())
        .filter((a) => a.length >= 3 && a.length <= 24 && !/^\d/.test(a) && !/#|calle|esquina|nivel|local/i.test(a))
        .slice(0, 6)
    }));
    // --- Reconocimiento de sucursal por nombre o alias. Los alias genericos (fox, foxpack,
    // delivery, domicilio...) los comparten casi todas, asi que se ignoran: hacian coincidir
    // cualquier mensaje con todas las sucursales.
    const ALIAS_GENERICOS = new Set(['fox', 'foxpack', 'fox pack', 'delivery', 'solo delivery', 'domicilio', 'general', 'global', 'no se', 'toda la ciudad', 'plata', 'monte', 'villa', 'san', 'santa', 'cruz', 'bella', 'mata', 'abajo', 'los', 'las', 'mina', 'terra', 'aura', 'hotel', 'golden', 'mall', 'plaza', 'calle', 'esquina', 'ejecutivo', 'oeste', 'este', 'norte', 'sur', 'centro', 'distrito', 'nacional']);
    const MIN_COINCIDENCIA = 4;
    const terminosDeSucursal = (branch) => [normalize(branch.name), ...(branch.aliases || []).map(normalize)]
      .filter((t) => t && t.length >= MIN_COINCIDENCIA && !ALIAS_GENERICOS.has(t));
    const coincidenciasSucursal = (value) => {
      const haystack = normalize(value);
      if (!haystack) return [];
      const puntajes = [];
      for (const branch of branches) {
        let mejor = 0;
        for (const t of terminosDeSucursal(branch)) {
          if (haystack.includes(t) && t.length > mejor) mejor = t.length;
        }
        // Si el cliente nombra la localidad propia de la sucursal ("la vega"), esa sucursal gana
        // sobre las que solo coinciden por un alias heredado ("la vega jima" de JIMA ABAJO).
        const localidad = normalize(nombreParaCliente(branch).replace(/\s*[\(/].*$/, ''));
        if (localidad && (haystack === localidad || haystack.startsWith(localidad + ' '))) mejor += 100;
        if (mejor) puntajes.push({ branch, puntaje: mejor });
      }
      if (!puntajes.length) return [];
      const maximo = Math.max(...puntajes.map((p) => p.puntaje));
      return puntajes.filter((p) => p.puntaje === maximo).map((p) => p.branch);
    };
    const branchNamedIn = (value) => {
      const encontradas = coincidenciasSucursal(value);
      if (encontradas.length === 1) return encontradas[0];
      if (encontradas.length > 1) {
        const primerNombre = normalize(nombreParaCliente(encontradas[0])).replace(/\s*\(.*?\)/g, '').trim();
        const todasMismaZona = encontradas.every((b) => {
          const n = normalize(nombreParaCliente(b)).replace(/\s*\(.*?\)/g, '').trim();
          return n === primerNombre || n.includes(primerNombre) || primerNombre.includes(n);
        });
        if (todasMismaZona) return encontradas[0];
      }
      return null;
    };
    // Una ciudad con varias sucursales (Santo Domingo, Santiago) se resuelve con lista numerada.
    const sucursalesDeLaCiudadDicha = (value) => {
      const haystack = normalize(value);
      if (!haystack || haystack.length < 6) return [];
      const equivalencias = { 'distrito nacional': 'santo domingo', capital: 'santo domingo' };
      const frase = equivalencias[haystack] || haystack;
      return branches.filter((branch) => terminosDeSucursal(branch)
        .some((t) => t === frase || t.startsWith(frase + ' ') || equivalencias[t] === frase));
    };
    // Solo se arma lista numerada cuando el texto coincide con VARIAS sucursales a la vez.
    const candidatasDeZona = (() => {
      const empatadas = coincidenciasSucursal(incomingText);
      if (empatadas.length < 2) return [];
      const unicas = [];
      for (const branch of [...empatadas, ...sucursalesDeLaCiudadDicha(incomingText)]) {
        const nombre = nombreParaCliente(branch).toLowerCase();
        const repetida = unicas.some((u) => String(u._id) === String(branch._id) || nombreParaCliente(u).toLowerCase() === nombre);
        if (!repetida) unicas.push(branch);
      }
      return unicas.slice(0, 8);
    })();

    // Fetch active departments for this workspace
    let departmentsJson = [];
    try {
      const depts = await Department.find({ workspace_id: wsId, status: 'active', deleted_at: null }).lean();
      departmentsJson = depts.map(d => ({
        id: String(d._id),
        nombre: d.name,
        descripcion: d.description || undefined
      }));
    } catch (dErr) {
      console.warn('[BranchRouter] Error fetching departments:', dErr.message);
    }

    // Format recent conversation history
    const storedMessages = state.recent_messages || [];
    const lastStoredMessage = storedMessages[storedMessages.length - 1];
    const historyMessages = (lastStoredMessage?.role === 'user' &&
      String(lastStoredMessage.content || '').trim() === String(incomingText || '').trim())
      ? storedMessages.slice(0, -1)
      : storedMessages;
    const conversationMessages = historyMessages
      .filter(message => ['user', 'assistant'].includes(message.role) && message.content)
      .map(message => ({ role: message.role, content: String(message.content) }));
    conversationMessages.push({ role: 'user', content: String(incomingText || '') });

    const agentName = matrix?.agent_name || 'Asistente Virtual';
    const businessName = companyName || 'nuestra empresa';
    const agentBehavior = customInstructions || matrix?.attention_policy || matrix?.description || 'Atención personalizada, amable, ágil y profesional';

    // Cargar Base de Conocimiento Organizacional (Tarifas, Documentos, Preguntas Frecuentes)
    let knowledgeContext = '';
    try {
      // Solo los fragmentos que este mensaje necesita (antes iban los 5 documentos completos,
      // ~22.400 tokens por mensaje). Si el buscador falla, se cae al metodo anterior.
      const { obtenerConocimientoRelevante } = await import('./knowledge-retrieval.service.js');
      const consultaConocimiento = [incomingText, ...(state?.recent_messages || []).slice(-2).map((m) => m.content)]
        .filter(Boolean).join(' ');
      knowledgeContext = await obtenerConocimientoRelevante({
        workspaceId: wsId,
        matrixId: matrix?._id,
        branchId: activeAssignment?.branch_id || null,
        query: consultaConocimiento
      });
    } catch (kErr) {
      console.warn('[BranchRouter] Error en el buscador de conocimiento:', kErr.message);
    }
    if (!knowledgeContext || knowledgeContext.length < 200) {
      try {
        knowledgeContext = await organizationKnowledgeService.getKnowledgeContext({
          workspaceId: wsId,
          matrixId: matrix?._id,
          branchId: activeAssignment?.branch_id || null
        });
      } catch (kErr2) {
        console.warn('[BranchRouter] Error loading knowledge context:', kErr2.message);
      }
    }

    const assignedBranchDoc = activeAssignment?.branch_id
      ? branches.find(b => String(b._id) === String(activeAssignment.branch_id))
      : null;

    // CONTRATO DEL AGENTE AUTÓNOMO CON MEMORIA Y BASE DE CONOCIMIENTO
    // ---- Ofertas de Amazon EN VIVO (solo FoxPack) ----
    // No se guarda nada: se consulta Amazon en el momento, se parsea en local y el HTML se descarta.
    let bloqueOfertasAmazon = '';
    let ofertasAmazon = null;
    const textoDelCliente = String(incomingText || '');
    if (String(wsId) === AMAZON_LIVE_WORKSPACE) {
      const pideFoto = /foto|fotos|imagen|imagenes|foticos|verlo|verla|muestrame|muestramelo|me lo muestras|se ve/i.test(textoDelCliente);
      // Se entiende la intencion real: pide ofertas O pide un producto para comprar. Se excluyen las
      // preguntas sobre su envio, que no son busquedas de producto (2026-10-06).
      const mencionaProducto = /amazon|oferta|descuento|barato|barata|promo|deal|producto|prime/i.test(textoDelCliente);
      const quiereAlgo = /busco|buscas|busca|buscamos|buscar|buscando|busque|quiero|quiere|queria|quisiera|necesito|necesita|comprar|compra|compro|comprarlo|recomiend|algo para|algo como|donde compro|conseguir|regalar|tiene algo|tienen algo|hay algo|tienes algo|venden|vende|vendes|manejan|maneja|ofrecen|ofrece|encontre|encuentro|algun|alguna|me interesa|me gustaria|gustaria|ese mismo|el primero|el segundo|el tercero/i.test(textoDelCliente);
      const esSobreSuEnvio = /paquete|tracking|rastreo|casillero|envio|enviar|guia|sucursal|retirar|flete|prealerta|libra|libras|tarifa|tarifas|cuesta|cuanto cuesta|cotiz|aduan|impuesto/i.test(textoDelCliente);
      const pideOfertas = (mencionaProducto || quiereAlgo) && !esSobreSuEnvio;
      const ofertasPrevias = Array.isArray(state?.metadata?.last_offers) ? state.metadata.last_offers : [];
      // Palabras que no describen producto: si la consulta solo trae estas, NO es una busqueda nueva.
      const PALABRAS_VACIAS = /^(interesa|compro|comprar|comprarlo|quiero|necesito|busco|busca|buscar|algo|producto|productos|oferta|ofertas|amazon|prime|catalogo|precio|ver|muestra|muestrame|tiene|tienen|hay|primero|segundo|tercero|este|esta|ese|esa|mismo|misma|foto|fotos|imagen|imagenes|enviame|envia|enviar|mandame|manda|mostrar|mostrarme|mostrarmela|mostrarlas|muestras|muestrala|muestralas|ensename|ayudame|ayudarme|puedes|podrias|puede|puedo|quisiera|gustaria|saber|saberlo|conocer|informacion|info|mira|pasa|pasame|dame|ver|verlo|verla|por|favor|si|no|ok|listo|perfecto|gracias|aqui|ahi|entonces|tambien|ademas|dia|dias|hoy|manana|ayer|day|days|today|tomorrow|please|hey|hola|buenas|buenos|saludos|amigo|amiga|señor|senor|usted|fecha|cuando|cuanto|cuantos|donde|como|que|quien|cual|cuales|tienen|tiene|quisiera|necesito|busco|buscar|busca|gusta|interesa|preguntar|pregunta|duda|dudas|estoy|estamos|esperando|espero|esperaba|sigo|sigo|aqui|ahi|todavia|aun|ya|muy|mucho|poco|bueno|buena|malo|mala|grande|pequeno|usado|nueva|ultimo|ahora|luego|despues|antes|tarde|temprano|dale|excelente|buenisimo|interesado|interesada|ayuda|ayudar|pueden|queria|deberia|necesitaria|compraria|vi|visto|viste|mire|mirando|buscando|buscaba|pense|creo|parece|crees|sabes|sabe|conoces|conoce|recomiendas|recomienda|sugieres|sugiere|sugerencia|sugerencias|opciones|opcion|ideas|idea|nada|todo|todos|todas|algun|alguna|alguno|tengo|tuve|tenemos|puedo|podemos|debo|deberias|seria|sera|esta|este|estan|estaba|estuvo|hace|hacer|hago|dijo|dice|dime|decir|cuentame|cuentas|comentas|mencionas|hablas|hablar|escribir|escribe|escribeme|llamar|llamo|llamame)$/;
      const consultaCruda = amazonDealsLive.extraerConsulta(textoDelCliente);
      const hayProductoNuevo = Boolean(consultaCruda) && consultaCruda.split(' ').some((w) => !PALABRAS_VACIAS.test(w));
      // Solo la foto de lo que ya se mostro: no se busca de nuevo ni se gasta una llamada al modelo.
      // Si pide foto y no se le ha mostrado ningun producto, NO puede prometer una foto: se le pregunta cual quiere ver.
      if (pideFoto && !ofertasPrevias.length && !hayProductoNuevo) {
        bloqueOfertasAmazon = '\n\nFOTOS: el cliente pide una foto pero en esta conversacion AUN no le has mostrado ningun producto. NO prometas enviar una foto ni digas que la envias. Preguntale en UNA frase que producto quiere ver y buscalo.';
        console.log('[BranchRouter] Piden foto sin productos mostrados: se pregunta cual quiere ver');
      }
      // Si pide una foto y YA se le mostraron productos, se envian las fotos aunque nombre el producto
      // (ej.: "enviame la foto del fire tv"), que antes bloqueaba el envio (2026-10-06).
      if (pideFoto && ofertasPrevias.length) {
        await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: 'Claro, aqui te van las fotos:', connectionId: effectiveAccountId });
        await this.enviarImagenesOfertas({ contactDoc, platform, senderNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, connectionId: effectiveAccountId, ofertas: ofertasPrevias.slice(0, 3) });
        return { handled: true, routed: false, mode: 'ai_ofertas_fotos' };
      }
      // La busqueda por palabras queda APAGADA: ahora el modelo decide con la herramienta
      // buscar_ofertas_amazon (autonomia real, sin listas de palabras). Se deja el codigo como
      // respaldo por si hiciera falta volver atras.
      const BUSQUEDA_POR_PALABRAS = true; // respaldo mientras se despliega el modo autonomo (contrato)
      if (BUSQUEDA_POR_PALABRAS && pideOfertas) {
        const consultaOfertas = consultaCruda;
      const consultaUtil = hayProductoNuevo;
      if (consultaUtil) {
        try {
          ofertasAmazon = await amazonDealsLive.buscar({ query: consultaOfertas, max: 3 });
          if (ofertasAmazon.ok) {
            const lineas = ofertasAmazon.items.map((p) => '- ' + p.title + ' | ' + (p.price_normal ? 'antes US$' + p.price_normal + ', ahora US$' + p.price : 'ahora US$' + p.price) + ' | ' + (p.discount_pct !== null && p.discount_pct !== undefined ? '-' + p.discount_pct + '%' : 'activo') + ' | Prime' + (p.deal_ends_at ? ' | la oferta vence ' + p.deal_ends_at : '')).join('\n');
            bloqueOfertasAmazon = '\n\nOFERTAS DE AMAZON EN VIVO (consultadas ahora mismo; son las UNICAS que puedes mencionar):\n' + lineas +
              '\nReglas: muestra COMO MAXIMO 3 productos, una linea corta por producto con el PRECIO DE ANTES y el PRECIO DE AHORA (ej.: antes US$49.99, ahora US$29.99, -40%). No inventes precios ni productos: si no esta en esta lista, no existe. No menciones otras ofertas. NUNCA digas que FoxPack no busca productos por el cliente: SI los buscas, y acabas de hacerlo. Para mostrar productos NO pidas ciudad ni sucursal. Pide la ciudad (o pasa el caso a un asesor) SOLO cuando el cliente decida comprar. Si el cliente pide la foto, dile que se la envias ahora.';
            // Escritura directa (driver): el modelo de Mongoose descartaba 'metadata.last_offers' y por eso
            // la foto del turno siguiente nunca encontraba productos (2026-10-06).
            await mongoose.connection.db.collection('omnichannel_branch_conversation_states').updateOne(
              { _id: state._id },
              { $set: { 'metadata.last_offers': ofertasAmazon.items, updated_at: new Date() } }
            );
            console.log('[BranchRouter] Ofertas Amazon en vivo: ' + ofertasAmazon.items.length + ' productos para ' + consultaOfertas + ' (' + ofertasAmazon.ms + ' ms, ' + (ofertasAmazon.provider || '?') + ')');
          } else {
            console.log('[BranchRouter] Ofertas Amazon sin resultados: ' + ofertasAmazon.reason);
            bloqueOfertasAmazon = '\n\nBUSQUEDA DE PRODUCTOS: acabas de buscar en Amazon "' + consultaOfertas + '" y NO encontraste ofertas que encajen. Dile con naturalidad que ahora mismo no encontraste algo que encaje y ofrecele DOS salidas: que te diga otra palabra o categoria, o pasar su caso a un asesor de la sucursal. NUNCA digas que FoxPack no busca productos: si los busca, solo que en este caso no hubo coincidencia. No pidas la ciudad para esto.';
          }
        } catch (e) {
          console.warn('[BranchRouter] Ofertas Amazon fallo:', e.message);
        }
      } else {
        const previas = Array.isArray(state?.metadata?.last_offers) ? state.metadata.last_offers : [];
        const pideComprar = /compro|comprarlo|como lo compro|donde lo compro|me interesa|lo quiero|quiero ese|quiero esa|el primero|el segundo|el tercero/i.test(textoDelCliente);
        if (pideComprar && previas.length) {
          // Ya se le mostraron productos y quiere comprar: se le explica el flujo y AHORA se pide la ciudad.
          bloqueOfertasAmazon = '\n\nCOMPRA DE UN PRODUCTO YA MOSTRADO: explicale en 2 frases el flujo: (1) descargar la app de FoxPack y registrarse (https://courier.foxpack.us/registration o https://bit.ly/descargafoxpack) para tener su casillero FP; (2) una vez registrado, se le pasa con un asesor de su sucursal para cerrar la compra. Y AHORA SI preguntale en que ciudad o zona esta. No busques mas productos en este turno.';
          console.log('[BranchRouter] Ofertas Amazon: intencion de compra sobre lo ya mostrado');
        } else {
          bloqueOfertasAmazon = '\n\nBUSQUEDA DE PRODUCTOS: el cliente pregunta por ofertas o productos pero NO dijo cual. Responde en UNA frase que si tienes ofertas Prime y preguntale que producto o categoria le interesa (ej.: cocina, audifonos, bebe, hogar). No pidas ciudad ni sucursal, y no le mandes a registrarse para esto.';
          console.log('[BranchRouter] Ofertas Amazon: sin producto concreto, se le pregunta que busca');
        }
      }
      }
    }

    // Regla fija de FoxPack: el modelo llegaba a decir que no podia enviar imagenes y que no maneja
    // catalogo. Ambas cosas son falsas: las fotos se envian y los productos se buscan en vivo.
    if (String(wsId) === AMAZON_LIVE_WORKSPACE) {
      bloqueOfertasAmazon += '\n\nFOTOS Y CATALOGO: si el cliente pide la foto de un producto que ya le mostraste, responde que se la envias ahora (el sistema la envia automaticamente). NUNCA digas que no puedes enviar imagenes. Tampoco digas que no manejas catalogo, inventario o disponibilidad: si pregunta por un producto, buscalo y muestrale hasta 3 opciones con precio de antes y precio de ahora.';
    }

    // ---- Instruccion de productos (la busqueda la dispara el codigo por ahora; la herramienta nativa
    // no es compatible con el modo JSON de DeepSeek, se retira para no romper el flujo) ----
    if (String(wsId) === AMAZON_LIVE_WORKSPACE) {
      bloqueOfertasAmazon += '\n\nPRODUCTOS DE AMAZON: cuando el cliente pida un producto, una recomendacion, un regalo o pregunte por ofertas, ya se buscaron ofertas para el y estan arriba. Muestra COMO MAXIMO 3 productos, cada uno con su PRECIO DE ANTES y su PRECIO DE AHORA (ej.: antes US$49.99, ahora US$29.99, -40%). Nunca inventes precios ni productos: solo los de la lista. Para tarifas, envios, casillero o tramites NO hables de productos.';
    }

    // Fecha real de Republica Dominicana: sin esto el modelo inventaba la fecha y calculaba mal los
    // plazos estimados (2026-10-07).
    let bloqueFechaHoy = '';
    try {
      const fechaHoyTexto = new Intl.DateTimeFormat('es-DO', { timeZone: 'America/Santo_Domingo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
      bloqueFechaHoy = '\n\nFECHA DE HOY: ' + fechaHoyTexto + ' (hora de Republica Dominicana). Usala para cualquier calculo de dias, plazos o fechas estimadas; nunca digas otra fecha.';
    } catch (eFecha) { /* si falla el formateo, se sigue sin fecha */ }

    const systemPrompt = `Eres ${agentName}, representante virtual de ${businessName}.

[IDENTIDAD VERIFICADA DEL CLIENTE]
- Nombre registrado: ${contactDoc?.name || 'No disponible'}
- Teléfono registrado: ${contactDoc?.phone_number || senderNumber || 'No disponible'}
- Identificador de contacto: ${contactDoc?._id || 'No disponible'}
- Si el nombre registrado está disponible, úsalo de forma natural y NO vuelvas a pedirlo.

[RESUMEN PERSISTENTE DE LA CONVERSACIÓN]
- ${state.summary || 'Todavía no existe un resumen persistente; usa los mensajes recientes y actualízalo cuando obtengas un motivo o dato relevante.'}

Tu configuración y forma de comportarte provienen de:
${agentBehavior}



${(activeCase || activeAssignment) ? `
[MEMORIA DE TRABAJO ACTIVA - CASO / TICKET EN CURSO]
- Ya existe un caso abierto y registrado en el sistema para este cliente:
  * Número de Ticket: ${activeCase?.case_number || 'C-Registrado'}
  * Título del Caso: ${activeCase?.option_title || activeAssignment?.ticket_title || 'Atención en curso'}
  * Sucursal Asignada: ${assignedBranchDoc ? assignedBranchDoc.name : 'Sucursal asignada'}
  * Motivo / Resumen: ${activeCase?.summary || activeAssignment?.problem_summary || ''}
  * Prioridad: ${activeCase?.priority || activeAssignment?.priority || 'normal'}
  * Datos Previos Recolectados: ${JSON.stringify(activeCase?.collected_information || activeAssignment?.collected_information || [])}
- El cliente está haciendo una pregunta de seguimiento, consulta de tarifas, costos de envío por libra o aportando datos adicionales.
- NUNCA reinicies el saludo de bienvenida ni vuelvas a pedir su ciudad o sucursal.
- Responde de forma precisa, amable y directa a su pregunta utilizando la BASE DE CONOCIMIENTO Y TARIFAS OFICIALES.
- No vuelvas a generar una nueva transferencia ni un nuevo ticket ("needs_transfer": false).
- Si el cliente aporta más detalles de su paquete o situación, agrégalos en "collected_information".
` : ''}

Tu configuración y forma de comportarte provienen de:
${agentBehavior}

${customWelcome ? `SALUDO DE BIENVENIDA OBLIGATORIO:
El negocio ha configurado este mensaje oficial de bienvenida:
"${customWelcome}"
En el primer saludo o al iniciar la conversación con el cliente, DEBES utilizar obligatoriamente este mensaje como saludo principal.
` : ''}
${customInstructions ? `INSTRUCCIONES ESPECÍFICAS DE LA EMPRESA / PERSONA DEL NEGOCIO:
"${customInstructions}"
Debes seguir estas directrices de la empresa con máxima prioridad en todas tus respuestas.
` : ''}
Tu función principal es recibir al cliente, comprender qué necesita,
hacer solamente las preguntas necesarias, identificar la sucursal y
área correcta cuando corresponda, registrar el caso y facilitar la
continuación con el equipo adecuado.

IDENTIDAD
Preséntate siempre como el asistente virtual de ${businessName}. Nunca uses el nombre de una persona del equipo (por ejemplo "Yosabel") ni digas que alguien te acompaña.
Si el negocio configuró una forma específica de saludo o comportamiento, respétala.
No repitas tu presentación en cada mensaje.

IDIOMA
Detecta el idioma utilizado por el cliente.
Por defecto responde en el mismo idioma.
Si está configurado language_mode=auto_confirm, pregunta brevemente en el idioma detectado si desea continuar en ese idioma o utilizar otro.
No obligues al cliente a utilizar el idioma predeterminado de la sucursal.
El idioma predeterminado se utiliza únicamente cuando no puedas determinar el idioma del cliente.

CONVERSACIÓN
WhatsApp debe sentirse conversacional.
Responde de forma corta, amable y natural.
Preferiblemente utiliza una o dos frases.
Haz una sola pregunta principal por turno.
Nunca conviertas la conversación en un formulario.
No solicites información que ya se encuentre disponible en los datos del contacto o en la conversación.

REPETICIONES Y SUCURSAL PENDIENTE (obligatorio)
Nunca dejes sin responder el mensaje del cliente.
Si ya conoces el motivo pero el cliente todavía no te dice su ciudad o sucursal, NO repitas la misma pregunta con las mismas palabras: reformúlala con otras palabras y ofrece dos o tres ejemplos concretos de ciudades o sucursales donde atienden.
Si el cliente vuelve a contar el motivo sin darte la sucursal, acompáñalo para ubicarla (pregunta por el sector, la zona o el municipio) en lugar de repetir la pregunta igual.
Tras dos intentos sin lograr la sucursal, dilo con naturalidad y ofrece que una persona del equipo continúe la conversación (needs_transfer: true).

TRACKING DE ENVIOS (obligatorio)
El negocio llama "tracking" a cualquier numero de tracking de un paquete y "casillero" al locker del cliente en Miami: no los confundas.
El cliente puede dar dos tipos de codigo y AMBOS valen:
  · el tracking interno de FoxPack (empieza con UP y sigue con digitos, ej. UP5848100014793), o
  · el tracking que le dio la tienda o el suplidor donde compro (otro formato, ej. cnusup00010663581).
Si el cliente escribe algo que parece un numero de tracking, codigo de envio, guia o referencia de su compra (cualquier combinacion larga de letras y digitos), pasalo TAL CUAL en "tracking_code": el sistema lo busca en las dos fuentes del courier y te devuelve los datos reales. No lo descartes por su formato.
Si el cliente menciona, escribe o responde con un numero de tracking, devuélvelo en el campo "tracking_code" y NO inventes nada sobre el envio en "reply_text": el sistema consulta el estado real y te lo devuelve para que redactes la respuesta final.
Nunca afirmes el estado, la ubicacion ni la fecha de un envio sin los datos del sistema.
Habla siempre de fechas y plazos como ESTIMACIÓN, nunca como promesa: da rangos acompañados de "aproximadamente" (ej. "estaría llegando aproximadamente entre el 25 y el 28 de este mes"). Nunca garantices ni confirmes una fecha de entrega.
Si el cliente pregunta por su envio y no ha dado el numero, pideselo de forma natural mencionando el "numero de tracking".
Si el cliente sigue hablando del mismo envio (pregunta por la sucursal, por el estado o si ya llego) y el sistema ya te dio esos datos en esta conversacion, respondes con ellos: no vuelvas a pedir el numero ni la ciudad.

TONO Y POSTURA (obligatorio)
Mantén siempre un tono positivo, cordial y profesional.
Sé diplomático: nunca le des la razón a un reclamo contra la empresa, ni admitas incumplimiento, culpa o responsabilidad.
Defiende el interés de la empresa: cuenta los hechos con transparencia, sin conceder compensaciones, reembolsos ni descuentos. Si el cliente los pide, indica que una persona del equipo lo revisará.
Nunca hables mal del negocio, de sus sucursales ni de sus agentes.

OBJETIVO PRINCIPAL
Primero comprende qué necesita el cliente.
Después identifica solamente lo necesario:
1. intención (Taxonomía obligatoria de 11 intenciones);
2. sucursal;
3. departamento;
4. datos mínimos del caso (en collected_information);
5. agente adecuado.
No preguntes por departamento. Dedúcelo según la necesidad del cliente.
No preguntes por sucursal si ya está determinada.
No preguntes datos que ya existan en el sistema o hayan sido respondidos.

==================================================
DETECCIÓN DE INTENCIÓN (TAXONOMÍA MAESTRA DEL CONTRATO)
==================================================
Clasifica internamente la intención en "customer_intent":
- SALES (Venta, cotización, compra, contratación de productos o servicios)
- SUPPORT (Soporte técnico, ayuda operativa, problemas de funcionamiento)
- COMPLAINT (Reclamo formal, inconformidad grave, daño en paquete recibido)
- BILLING (Facturación, cobros duplicados, pagos, recibos, tarjetas)
- ORDER (Seguimiento, estatus o problemas con un pedido, paquete o envío)
- PRODUCT_INFORMATION (Consulta de características de productos o servicios)
- STOCK_CHECK (Consulta sobre disponibilidad de inventario o stock)
- HUMAN_REQUEST (Solicitud explícita de hablar con un humano o asesor)
- GENERAL_INFORMATION (Horarios, ubicaciones físicas, teléfonos, cobertura)
- GREETING (Saludo de cortesía simple sin consulta de fondo)
- UNKNOWN (No determinada)
No muestres esta clasificación técnica al cliente.

MATRIZ
Cuando operes como agente de Matriz, actúa como una recepción inteligente.
Tu objetivo es comprender la necesidad y determinar la sucursal, departamento o equipo apropiados.
Puedes conversar brevemente para conseguir la información faltante.
No pretendas ser una sucursal si todavía no se ha determinado una.

SUCURSAL
Cuando la conversación pertenece a una sucursal, utiliza sus datos, conocimiento, horario, ubicación, cobertura y reglas.
Nunca mezcles información de otra sucursal salvo que estés realizando una búsqueda de destino autorizada desde Matriz.

DEPARTAMENTOS
Los departamentos y sucursales son entidades diferentes.
La sucursal determina dónde se atenderá.
El departamento determina qué área debe atender.
Selecciona solamente departamentos configurados por el negocio.
Departamentos disponibles:
${JSON.stringify(departmentsJson, null, 2)}

SUCURSALES DISPONIBLES:
${JSON.stringify(branchesJson, null, 2)}

OPCIONES
Las opciones configuradas por el administrador son reglas semánticas.
No obligues al cliente a escribir números o seleccionar botones cuando puedas comprender directamente lo que solicita.

PREGUNTAS DE CONTEXTO
Utiliza las preguntas configuradas por el negocio solamente cuando la respuesta todavía sea necesaria.
Si el cliente ya proporcionó ese dato, considéralo respondido.

==================================================
REGLA MAESTRA DE RESOLUCIÓN DE SUCURSAL (ORDEN OBLIGATORIO)
==================================================
Para cualquier atención, ticket, reclamo o derivación humana, LA SUCURSAL ES UN REQUISITO PREVIO INDISPENSABLE.
Debes consultar obligatoriamente la lista de SUCURSALES DISPONIBLES de ${businessName}.

1. SI EL CLIENTE REPORTA UN PROBLEMA O CONSULTA (ej. paquete perdido, rastreo, compra) PERO AÚN NO HA INDICADO SU CIUDAD O SUCURSAL:
   - "resolved_branch_id": null
   - "needs_transfer": false
   - PROHIBIDO TERMINANTEMENTE decir que el caso ya fue registrado, o que lo estás transfiriendo, o que un agente se pondrá en contacto.
   - En "reply_text": DEBES agradecer el dato proporcionado (ej. código de rastreo o casillero) y PREGUNTAR DIRECTAMENTE por la sucursal o ciudad:
     Ejemplo: "Gracias por el código. Cuéntame en qué ciudad o zona estás y te atiendo con la sucursal que te corresponde."

2. SI EL CLIENTE RESPONDE CON SU CIUDAD O SUCURSAL:
   - Compara el texto del cliente contra las SUCURSALES DISPONIBLES.
   - Si el cliente no dice una localidad clara (ej. "Santo Evangelio"):
     * "resolved_branch_id": null
     * "needs_transfer": false
     * Explica amablemente que no tienes sucursal en esa localidad y pregunta en qué ciudad o zona está.
   - Si la localidad que dice tiene VARIAS sucursales (ej. "Santo Domingo", "Santiago"):
     * "resolved_branch_id": null
     * "needs_transfer": false
     * Muestrale una lista numerada corta (maximo 6 opciones) con el nombre de esos puntos y pidele que responda con el numero.
       Ejemplo: "En Santo Domingo tenemos varios puntos: 1) Bella Vista, 2) Villa Mella / Santa Cruz, 3) Los Mina. ¿Con cual te atiendo? Responde con el numero."
   - Si el cliente responde con un numero, es la opcion de tu lista anterior: devuelve el ID de esa sucursal en "resolved_branch_id".
   - Si ya preguntaste una vez y el cliente no aclara, deja de preguntar: "resolved_branch_id": null y "needs_transfer": true para que lo atienda una persona.
   - PROHIBIDO mencionarle al cliente el modo de entrega o el prefijo de la marca (por ejemplo "Solo Delivery" o "Fox Pack"): usa solo el nombre del punto como aparece en SUCURSALES DISPONIBLES.
   - Si SÍ coincide (ej. "La Vega", "Santo Domingo", "Santiago"):
     * "resolved_branch_id": "[ID exacto de la sucursal encontrada]"
     * "needs_transfer": true
     * En "reply_text": Confirma de forma clara y amable que el caso fue asignado a esa sucursal:
       "¡Listo! Ya le pasé tu conversación al equipo de [Nombre Sucursal] para que te atiendan por aquí con todo el contexto."

CASOS Y TICKETS (SOLO CON SUCURSAL RESUELTA)
ÚNICAMENTE cuando la sucursal esté resuelta ("resolved_branch_id" no nulo o cuando el negocio solo tenga 1 sucursal) y el caso requiera seguimiento humano, marca "needs_transfer": true.
El ticket y resumen deben explicar claramente al agente:
- qué quiere el cliente;
- qué ocurrió;
- datos relevantes obtenidos;
- idioma;
- sucursal;
- departamento;
- prioridad;
- qué acción espera el cliente.
Formato para "agent_summary":
"Cliente: ${contactDoc?.name || senderNumber}
Sucursal: [Nombre Sucursal]
Motivo: [Motivo puntual]
Necesita: [Acción esperada]
Prioridad: [low | normal | high | urgent]"
O compacto: "[${contactDoc?.name || senderNumber}] reporta que [problema]. Solicita [acción]."
No obligues al usuario a repetir su historia al agente.

HUMAN HANDOFF
Si el cliente pide una persona, asesor, agente humano o transferencia ("Quiero hablar con una persona", "me puede transferir", "comunicame con alguien"):
- Prioriza el handoff. No intentes convencerlo de seguir hablando contigo.
- Revisa el historial de mensajes: si el cliente YA mencionó su tema o inquietud en los mensajes anteriores (ej. impuestos, demora, cobro, registro, paquete), YA CONOCES EL MOTIVO: NO vuelvas a preguntar "¿Sobre qué necesitas ayuda?".
- Si ya se conoce el motivo o el cliente insiste, procede inmediatamente con la transferencia ("needs_transfer": true).
- Si aún no se conoce la sucursal o ciudad, pregunta únicamente: "Con gusto, te comunico con un asesor para atender tu consulta. ¿En qué ciudad o sucursal te encuentras para transferirte con el equipo correspondiente?"
- Si el cliente ya mencionó una sucursal o zona (ej. "Bella Vista", "Santiago", "La Vega"), transfiere de inmediato a esa sucursal ("needs_transfer": true).

INFORMACIÓN DE IMPUESTOS Y ADUANAS (FOXPACK / REPÚBLICA DOMINICANA)
Si el cliente pregunta por impuestos o aranceles aduanales:
- Envíos con valor declarado menor a US$200: Están EXENTOS de impuestos de importación (Decreto 402-05 de Despacho Expreso).
- Envíos con valor declarado mayor a US$200: Están sujetos al pago de aranceles e impuestos aduanales (DGA / ITBIS según la categoría de la mercancía).
- Explica esto de forma clara y amable si el cliente lo consulta, y ofrece transferirle con un asesor si necesita revisión específica de un paquete o liquidación.

VERACIDAD
Nunca inventes:
- sucursales;
- agentes;
- departamentos;
- precios;
- horarios;
- productos;
- inventario;
- políticas;
- estado de pedidos.
Utiliza solamente información del tenant actual.

ESTILO
Mensajes cortos (1 o 2 frases).
Cálido pero no exagerado.
Evita párrafos largos.
Evita lenguaje técnico y no expliques procesos internos.
Tu trabajo es hacer que obtener ayuda sea sencillo.

FORMATO DE RESPUESTA:
Responde SIEMPRE con un JSON válido con esta estructura exacta:
{
  "detected_language": "es",
  "customer_intent": "SALES" | "SUPPORT" | "COMPLAINT" | "BILLING" | "ORDER" | "PRODUCT_INFORMATION" | "STOCK_CHECK" | "HUMAN_REQUEST" | "GENERAL_INFORMATION" | "GREETING" | "UNKNOWN",
  "resolved_branch_id": string | null,
  "tracking_code": string | null,
  "resolved_department_id": string | null,
  "detected_city": string | null,
  "needs_transfer": boolean,
  "reply_text": string,
  "ticket_title": string | null,
  "agent_summary": string | null,
  "recommended_action": string | null,
  "collected_information": [
    { "label": string, "value": string }
  ],
  "priority": "low" | "medium" | "normal" | "high" | "urgent"
}`;

    try {
      // 3. Invocar Omnicall Service (Pooling resiliente: Gemini, DeepSeek, Groq, OpenAI con fallback)
      const wsDoc = await Workspace.findById(wsId).lean();
      const ownerUserId = wsDoc?.user_id || contactDoc.user_id || contactDoc.created_by;

      const UserSetting = mongoose.models.UserSetting || mongoose.model('UserSetting');
      let userSetting = await UserSetting.findOne({ user_id: ownerUserId }).populate('ai_model').lean();
      if (!userSetting?.ai_model && contactDoc.created_by) {
        userSetting = await UserSetting.findOne({ user_id: contactDoc.created_by }).populate('ai_model').lean();
      }

      if (!userSetting?.ai_model) {
        // La migracion dejo el modelo del cliente en la coleccion ai_models; el modelo Mongoose
        // AIModel apunta a aimodels. Mismo fallback que webchat-messaging.service.js.
        const rawSetting = await mongoose.connection.db.collection('user_settings').findOne({ user_id: ownerUserId });
        if (rawSetting?.ai_model) {
          const legacyModel = await mongoose.connection.db.collection('ai_models').findOne({ _id: rawSetting.ai_model });
          if (legacyModel) {
            userSetting = { ...(userSetting || {}), ai_model: legacyModel, api_key: (userSetting && userSetting.api_key) || rawSetting.api_key };
            console.log('[BranchRouter] Modelo resuelto desde ai_models: ' + (legacyModel.model_id || legacyModel.name));
          }
        }
      }

      if (platform === 'webchat' && !userSetting?.ai_model) {
        const { resolveWebchatAI } = await import('./webchat-messaging.service.js');
        const config = await resolveWebchatAI(ownerUserId);
        userSetting = { ...(userSetting || {}), ai_model: config.model, api_key: config.apiKey };
      }

      let aiResponse = null;

      // Zona con varios puntos: el modelo escribe la lista numerada y no transfiere.
      // Si en esta conversacion ya se consulto un paquete, sus datos (estado y sucursal) viajan en el
      // prompt para que el asistente responda el seguimiento sin volver a pedir la ciudad.
      // El sistema ya resuelve los alias y sectores en el backend: al modelo se le manda la
      // sucursal detectada (cuando es unica) en lugar de los alias de las 38 sucursales.
      const detectadas = coincidenciasSucursal(incomingText);
      const bloqueSucursalDetectada = detectadas.length === 1
        ? '\n\n=== SUCURSAL DETECTADA POR EL SISTEMA ===\n' +
          '- El cliente nombro: ' + nombreParaCliente(detectadas[0]) + ' (id ' + String(detectadas[0]._id) + ').\n' +
          '- Si es la sucursal que pidio, devuelve ese id en "resolved_branch_id".\n'
        : '';

      const paqueteRecordado = state?.metadata?.last_tracking;
      const bloquePaqueteRecordado = (paqueteRecordado && (paqueteRecordado.branch_name || paqueteRecordado.status))
        ? '\n\n=== PAQUETE YA CONSULTADO EN ESTA CONVERSACION ===\n' +
          '- tracking: ' + (paqueteRecordado.internal || paqueteRecordado.code || '') +
          (paqueteRecordado.status ? ' | estado: ' + paqueteRecordado.status : '') +
          (paqueteRecordado.branch_name ? ' | sucursal asignada: ' + paqueteRecordado.branch_name : '') + '\n' +
          '- Si el cliente pregunta por la sucursal, por el estado o si el paquete ya llego, responde con estos datos. Ya sabes la sucursal: NO cierres pidiendo la ciudad ni la zona.\n' +
          '- Si el cliente escribe un tracking nuevo, es otro envio: devuelvelo en "tracking_code".\n'
        : '';

      const responseStyleContract = '\n\n[ESTILO DE RESPUESTA OBLIGATORIO]\n' +
        '- Responde primero y directamente a lo que el cliente preguntó, usando datos verificados del negocio y su conocimiento.\n' +
        '- No agregues ofertas, ventas sugeridas, invitaciones a cotizar ni preguntas de seguimiento que el cliente no pidió.\n' +
        '- Haz solo preguntas necesarias para obtener un dato que falte; conserva las preguntas necesarias de ciudad, sucursal, destino, peso o seguimiento.\n' +
        '- Tras resolver la solicitud, usa como máximo un cierre breve. No repitas agradecimientos, despedidas ni ofertas en mensajes posteriores.\n' +
        '- Si el cliente solo dice gracias, ok o está bien después de una respuesta completa, responde con una sola cortesía breve si aún no se cerró el intercambio; después guarda silencio hasta una nueva pregunta o solicitud.\n' +
        '- Conserva el JSON requerido y nunca alteres tarifas, sucursales, departamentos o decisiones de transferencia.\n';
      const systemPromptFinal = systemPrompt + customerContextPrompt(contactDoc) + (candidatasDeZona.length > 1
        ? '\n\n=== ZONA CON VARIOS PUNTOS (OBLIGATORIO) ===\n' +
          'El cliente menciono una zona que tiene varios puntos. NO transfieras y NO elijas uno por tu cuenta.\n' +
          'En "reply_text" muestrale estos puntos en una lista numerada, en este orden, y pidele que responda con el numero:\n' +
          candidatasDeZona.map((b, i) => (i + 1) + ') ' + nombreParaCliente(b)).join('\n') + '\n' +
          'Devuelve "resolved_branch_id": null y "needs_transfer": false. No menciones "Solo Delivery".\n'
        : '') + bloquePaqueteRecordado + bloqueSucursalDetectada + (knowledgeContext ? '\n\n' + knowledgeContext : '') + responseStyleContract + bloqueOfertasAmazon + bloqueFechaHoy;

      console.log('[BranchRouter] Prompt: ' + systemPromptFinal.length + ' chars (~' + Math.round(systemPromptFinal.length / 3.6) + ' tokens)' +
        ' | conocimiento=' + knowledgeContext.length + ' | sucursales=' + JSON.stringify(branchesJson).length + ' | historial=' + JSON.stringify(conversationMessages).length);

      try {
          const omniResult = await omnicallService.chatCompletion({
            systemPrompt: systemPromptFinal,
            messages: conversationMessages,
          jsonMode: true,
          temperature: 0.2,
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

        if (omniResult.success && omniResult.json) {
          aiResponse = omniResult.json;
          console.log(`[BranchRouter AI Mode] Response via Omnicall (${omniResult.provider}/${omniResult.model}):`, aiResponse);
        } else if (omniResult.text) {
          aiResponse = omnicallService.parseJsonSafely(omniResult.text) || { reply_text: omniResult.text, needs_transfer: false };
        }
      } catch (omniErr) {
        console.warn('[BranchRouter AI Mode] Omnicall execution warning, trying direct DeepSeek fallback:', omniErr.message);
      }

      if (!aiResponse) {
        console.error('[BranchRouter AI Mode] Tenant provider failed; platform key is not used');
      }

      const rawIntent = aiResponse?.customer_intent || aiResponse?.intent || 'UNKNOWN';
      const detectedLang = aiResponse?.detected_language || 'es';
      const recommendedAction = aiResponse?.recommended_action || null;
      const collectedInfo = Array.isArray(aiResponse?.collected_information) ? aiResponse.collected_information : [];
      const resolvedBranchId = aiResponse?.resolved_branch_id;
      let resolvedDepartmentId = aiResponse?.resolved_department_id;
      let needsTransfer = Boolean(aiResponse?.needs_transfer && (resolvedBranchId || branches.length === 1));
      let trackingRequiereHumano = false;
        let replyText = aiResponse?.reply_text;
      const zonaConVarios = candidatasDeZona.length > 1;

      // FoxPack: si el LLM detecto un numero de tracking, se consulta el estado real y se redacta
      // la respuesta con esos datos verificados. Solo aplica al workspace de FoxPack.
      try {
        if (aiResponse?.tracking_code) {
          const tracked = await foxpackTrackingService.handleTrackingQuestion({
            trackingCode: aiResponse.tracking_code,
            workspaceId: wsId,
            userSetting,
            ownerUserId,
            history: conversationMessages,
            customerName: contactDoc?.name || null,
            channel: platform
          });
          if (tracked) {
            if (tracked.replyText) replyText = tracked.replyText;
            if (tracked.needsTransfer) needsTransfer = true;
            trackingRequiereHumano = Boolean(tracked.needsTransfer);
            console.log('[BranchRouter] Tracking FoxPack: estado=' + (tracked.tracking?.status || 'sin datos') + ' | requiere_persona=' + Boolean(tracked.tracking?.sla?.requires_human) + ' | motivo=' + (tracked.reason || '-'));
            // Se recuerda el paquete (estado y sucursal) para responder los seguimientos sin volver
            // a pedir la ciudad ni el numero.
            if (tracked.tracking?.found) {
              const memoriaPaquete = {
                code: String(aiResponse.tracking_code),
                internal: tracked.tracking.tracking_code || null,
                status: tracked.tracking.status || null,
                branch_name: tracked.tracking.branch_name || null,
                at: new Date().toISOString()
              };
              state.metadata = { ...(state.metadata || {}), last_tracking: memoriaPaquete };
              if (state?._id) {
                await BranchConversationState.updateOne(
                  { _id: state._id },
                  { $set: { 'metadata.last_tracking': memoriaPaquete } }
                );
              }
            }
          }
        }
      } catch (trackErr) {
        console.warn('[BranchRouter] Tracking lookup warning:', trackErr.message);
      }
      replyText = sanearRespuesta(replyText);
      // SI LA CONVERSACIÓN YA TIENE UN CASO / ASIGNACIÓN ABIERTA (SEGUIMIENTO ACTIVO)
      if (activeAssignment && activeAssignment.branch_id) {
        if (replyText) {
          await this.sendReply({
            contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId,
            userId: contactDoc.user_id, workspaceId: wsId, text: replyText, connectionId: effectiveAccountId
          });
        }

        // Actualizar caso activo con información nueva recolectada si existe
        if (activeCase && collectedInfo.length > 0) {
          try {
            const existingLabels = new Set((activeCase.collected_information || []).map(ci => ci.label));
            const newEntries = collectedInfo.filter(ci => !existingLabels.has(ci.label));
            if (newEntries.length > 0) {
              await ChatAssignment.findByIdAndUpdate(activeAssignment._id, {
                $push: { collected_information: { $each: newEntries } },
                $set: { updated_at: new Date() }
              });
              console.log(`[BranchRouter] Active case ${activeCase.case_number} updated with ${newEntries.length} new info items`);
            }
          } catch (caseUpErr) {
            console.warn('[BranchRouter] Error updating active case info:', caseUpErr.message);
          }
        }

        // Almacenar respuesta en el historial para memoria continua
        await BranchConversationState.updateOne(
          { _id: state._id },
          {
            $push: {
              recent_messages: {
                $each: [{ role: 'assistant', content: replyText || '', at: new Date() }],
                $slice: -20
              }
            }
          }
        );

        return { handled: true, routed: true, mode: 'ai_followup' };
      }

      // Inferencia semántica de departamento si la IA detectó la intención pero no colocó el ID
      if (!resolvedDepartmentId && rawIntent && departmentsJson.length > 0) {
        const intentUpper = String(rawIntent).toUpperCase();
        let matchedDept = null;
        if (['BILLING', 'FACTURACION', 'COBRO', 'PAGO'].includes(intentUpper)) {
          matchedDept = departmentsJson.find(d => /factur|cobro|pago|contab|admin/i.test(d.name));
        } else if (['ORDER', 'PEDIDO', 'ENVIO'].includes(intentUpper)) {
          matchedDept = departmentsJson.find(d => /pedido|envio|logist|despach|entrega/i.test(d.name));
        } else if (['SALES', 'VENTA', 'STOCK_CHECK', 'PRODUCT_INFORMATION'].includes(intentUpper)) {
          matchedDept = departmentsJson.find(d => /venta|comercial/i.test(d.name));
        } else if (['SUPPORT', 'SOPORTE', 'COMPLAINT', 'RECLAMO'].includes(intentUpper)) {
          matchedDept = departmentsJson.find(d => /soporte|reclamo|atencion|servicio/i.test(d.name));
        }
        if (matchedDept) {
          resolvedDepartmentId = matchedDept.id;
          console.log(`[BranchRouter AI Mode] Departamento '${matchedDept.name}' (${matchedDept.id}) inferido semánticamente de intención ${intentUpper}`);
        }
      }

      // Actualizar datos del contacto en tiempo real (Regla de Enriquecimiento CRM)
      if (detectedLang || aiResponse?.detected_city || (collectedInfo && collectedInfo.length > 0)) {
        try {
          const contactUpdates = {};
          if (detectedLang) {
            contactUpdates.preferred_language = detectedLang;
            contactUpdates['metadata.preferred_language'] = detectedLang;
          }
          if (aiResponse?.detected_city) {
            contactUpdates['metadata.city'] = aiResponse.detected_city;
          }
          if (collectedInfo && collectedInfo.length > 0) {
            contactUpdates['metadata.collected_information'] = collectedInfo;
          }
          await Contact.findByIdAndUpdate(contactDoc._id, { $set: contactUpdates });
        } catch (cUpdErr) {
          console.warn('[BranchRouter AI Mode] Error enriqueciendo datos de contacto:', cUpdErr.message);
        }
      }

      // (El reconocimiento por nombre y alias esta definido arriba, junto a las sucursales.)

      let matchedBranch = null;
      if (resolvedBranchId) {
        matchedBranch = branches.find(b => String(b._id) === String(resolvedBranchId));
      }
      if (!matchedBranch) matchedBranch = branchNamedIn(incomingText);
      if (!matchedBranch && branches.length === 1) matchedBranch = branches[0];

      // ELECCION POR NUMERO: si el cliente contesta "2", es la opcion 2 de la lista que se le envio.
      const ultimoSaliente = [...conversationMessages].reverse().find((m) => m.role === 'assistant');
      const sucursalGlobal = () => branches.find((b) => normalize(b.name) === 'area global') ||
        branches.find((b) => normalize(b.name).includes('area global')) || null;
      const opcionesDeLista = (texto) => {
        const salida = [];
        for (const linea of String(texto || '').split('\n')) {
          const m = linea.match(/^\s*(\d{1,2})\s*[).\-:]\s*(.+)$/);
          if (m) salida.push({ index: Number(m[1]), texto: m[2].trim() });
        }
        return salida;
      };
      if (!matchedBranch) {
        const numeroSolo = /^\s*(\d{1,2})\s*$/.exec(String(incomingText || ''));
        const previas = opcionesDeLista(ultimoSaliente?.content);
        const opcionesGuardadas = Array.isArray(state?.metadata?.menu_options) ? state.metadata.menu_options : [];
        if (numeroSolo && opcionesGuardadas.length) {
          const guardada = opcionesGuardadas.find((o) => Number(o.index) === Number(numeroSolo[1]));
          if (guardada) matchedBranch = branches.find((b) => String(b._id) === String(guardada.branch_id)) || null;
          if (matchedBranch) console.log('[BranchRouter] Opcion guardada ' + numeroSolo[1] + ' -> ' + matchedBranch.name);
        }
        if (!matchedBranch && numeroSolo && previas.length) {
          const elegida = previas.find((o) => o.index === Number(numeroSolo[1]));
          if (elegida) matchedBranch = branchNamedIn(elegida.texto);
          if (matchedBranch) console.log('[BranchRouter] Opcion ' + numeroSolo[1] + ' elegida -> ' + matchedBranch.name);
        }
      }

      // La zona tiene varios puntos: se garantiza la lista numerada, se guardan las opciones en el
      // mismo orden en que el cliente las vera y no se transfiere todavia.
      if (zonaConVarios && !matchedBranch) {
        const tieneLista = /\b1\s*[).]/.test(String(replyText || '')) && /\b2\s*[).]/.test(String(replyText || ''));
        const delTexto = [];
        for (const o of opcionesDeLista(replyText)) {
          const b = branchNamedIn(o.texto);
          if (b && !delTexto.some((x) => String(x.branch_id) === String(b._id))) {
            delTexto.push({ index: o.index, branch_id: String(b._id), name: nombreParaCliente(b) });
          }
        }
        const opciones = delTexto.length >= 2
          ? delTexto
          : candidatasDeZona.map((b, i) => ({ index: i + 1, branch_id: String(b._id), name: nombreParaCliente(b) }));
        if (!tieneLista) {
          replyText = 'En esa zona tenemos varios puntos:\n' +
            opciones.map((o, i) => (i + 1) + ') ' + o.name).join('\n') +
            '\n¿Con cuál te atiendo? Responde con el número.';
        }
        matchedBranch = null;
        needsTransfer = false;
        state.metadata = { ...(state.metadata || {}), menu_options: opciones };
        if (state?._id) {
          await BranchConversationState.updateOne(
            { _id: state._id },
            { $set: { 'metadata.menu_options': opciones } }
          );
        }
        console.log('[BranchRouter] Zona con varios puntos: lista de ' + opciones.length + ' opciones' +
          (delTexto.length >= 2 ? ' (tomada del texto del modelo)' : ' (armada por el sistema)'));
      }

      replyText = sanearRespuesta(replyText);
      const textoCliente = String(incomingText || '').trim();
      const cierreSimple = /^\s*(muchas\s+)?(gracias|ok|okey|okay|listo|perfecto|excelente|de acuerdo|vale|bien|entendido|genial|de nada|saludos|si|sí|👍|🙏)[\s,.!¡?]*$/i.test(textoCliente);
      const pidePersonaOProblema = /(hablar|comunicar|atienda|atiendan|pasame|pásame|necesito|quiero)\s+(con\s+)?(una?\s+)?(persona|asesor|agente|humano|alguien)|reclamo|reclamar|queja|perdid|perdi|no ha llegado|no llega|nunca lleg|da[nñ]ad|roto|extraviad|demora|retras|atrasad|molest|inconform|devoluc|reembols|cancel|urge|emergencia/i.test(textoCliente);
      const consultaInformativa = /sucursal|estado|d[oó]nde|donde|c[oó]mo va|cu[aá]ndo|llega|llego|tracking|paquete|env[ií]o|guia|guía/i.test(textoCliente);
      const sinTicket = !trackingRequiereHumano && (cierreSimple || (consultaInformativa && !pidePersonaOProblema));

      // Solo cuenta como "se atribuyo una asignacion" si el bot AFIRMA que ya transfirio o registro
      // el caso. Frases inocentes como "una cotizacion para tu caso" no deben disparar el blindaje
      // (incidente 2026-10-06: forzo transferencia, abrio ticket y silencio la IA).
      const claimsAssignment = /(caso|ticket|conversaci[oó]n)\s+(ha sido|fue|est[aá]|qued[oó]|ya (est[aá]|fue))\s+(asignad|registrad|transferid|cread|enviad)|ya\s+(te\s+)?(transfer[ií]|deriv[eé]|asign[eé]|registr[eé])|te\s+(transfiero|derivo|asigno)\s+(con|a)\b|le\s+pas[eé]\s+tu\s+conversaci|agente\s+especializado/i.test(replyText || '');
      if (!matchedBranch && claimsAssignment) matchedBranch = branchNamedIn(replyText);

      const recordado = state?.metadata?.last_tracking;
      const globalDelArea = sucursalGlobal();

      // Si el cliente pide una persona, asesor o reporta demora y no se indico otra sucursal,
      // la atencion le corresponde a la sucursal de su paquete ya consultado o al Area global.
      if (!matchedBranch && (pidePersonaOProblema || Boolean(aiResponse?.needs_transfer))) {
        if (recordado?.branch_name) {
          matchedBranch = branchNamedIn(recordado.branch_name) ||
            branches.find((b) => normalize(b.name).includes(normalize(recordado.branch_name))) || null;
        }
        if (!matchedBranch && globalDelArea) {
          matchedBranch = globalDelArea;
        }
      }

      let finalNeedsTransfer = Boolean(needsTransfer && matchedBranch);
      if (matchedBranch && (branchNamedIn(incomingText) || claimsAssignment || pidePersonaOProblema || Boolean(aiResponse?.needs_transfer))) {
        finalNeedsTransfer = true;
      }

      if (finalNeedsTransfer && matchedBranch) {
        // Asegurar que la respuesta al cliente sea una confirmacion clara de transferencia
        if (!claimsAssignment || !replyText) {
          replyText = `¡Listo! Ya le pasé tu conversación al equipo de ${nombreParaCliente(matchedBranch)} para que un asesor te atienda por aquí con todo el contexto.`;
        }
      } else if (!matchedBranch && branches.length > 1) {
        finalNeedsTransfer = false;
        const yaPreguntamosCiudad = /en que ciudad o zona estas/i.test(normalize(ultimoSaliente?.content || ''));
        if (pidePersonaOProblema && globalDelArea) {
          replyText = 'Ya le pasé tu caso a una persona de nuestro equipo para que te ayude directamente; te escribe por aquí en breve.';
          matchedBranch = globalDelArea;
          finalNeedsTransfer = true;
        } else if (claimsAssignment && !zonaConVarios && yaPreguntamosCiudad && globalDelArea) {
          replyText = 'Ya le pasé tu caso a una persona del equipo para que te ayude con esto; te escribe por aquí en breve.';
          matchedBranch = globalDelArea;
          finalNeedsTransfer = true;
        } else if (claimsAssignment && !zonaConVarios && !pidePersonaOProblema) {
          const esConsultaDeTracking = /(donde|d[oó]nde|cu[aá]ndo|c[oó]mo va|estado|sucursal|llega|llego|tracking|paquete|env[ií]o|guia|guía)/i.test(incomingText);
          if (recordado?.branch_name && esConsultaDeTracking) {
            replyText = 'Tu paquete va con la sucursal ' + recordado.branch_name
              + (recordado.status ? ' y su estado actual es ' + recordado.status : '') + '. ¿Te ayudo con algo más?';
          } else {
            const infoSnippet = (collectedInfo && collectedInfo.length > 0)
              ? `Gracias por los datos proporcionados (${collectedInfo.map(c => c.value).join(', ')}). `
              : '¡Con gusto! ';
            replyText = `${infoSnippet}¿En qué ciudad o sucursal te encuentras? Con eso te atiendo con el equipo correspondiente.`;
          }
        }
      }

      // Ya se conoce la sucursal del paquete del que habla: se quita el cierre pidiendo la ciudad.
      if (state?.metadata?.last_tracking?.branch_name && replyText && !pidePersonaOProblema) {
        replyText = quitarPreguntaDeCiudad(replyText, state.metadata.last_tracking);
      }

      if (finalNeedsTransfer && sinTicket) {
        if (claimsAssignment || Boolean(aiResponse?.needs_transfer) || Boolean(branchNamedIn(incomingText))) {
          console.log('[BranchRouter] Blindaje: Se mantiene transferencia activa (claimsAssignment/needs_transfer detectado)');
        } else {
          console.log('[BranchRouter] Sin ticket: ' + (cierreSimple ? 'el cliente solo cierra la conversacion' : 'consulta informativa ya respondida'));
          finalNeedsTransfer = false;
          matchedBranch = null;
        }
      }

      // Blindaje de coherencia: Si el bot redacto un mensaje confirmando la transferencia,
      // es obligatorio forzar la transferencia y crear el ticket correspondiente.
      const casoNecesitaRuta = Boolean(pidePersonaOProblema || trackingRequiereHumano || aiResponse?.needs_transfer);
      if (claimsAssignment && (!finalNeedsTransfer || !matchedBranch)) {
        // Si el bot no nombro sucursal y el caso no necesita persona, NO se fuerza la transferencia:
        // forzarla abria ticket y silenciaba la IA por una frase inocente (incidente 2026-10-06).
        const sucursalEnTexto = branchNamedIn(replyText) || branchNamedIn(incomingText);
        matchedBranch = matchedBranch || sucursalEnTexto || (casoNecesitaRuta ? sucursalGlobal() : null);
        if (matchedBranch) {
          finalNeedsTransfer = true;
          console.log('[BranchRouter] Blindaje de coherencia: claimsAssignment forzo transferencia a ' + matchedBranch.name);
        }
      }

      // Nunca repetir la misma respuesta dos veces: si se repite, pasa a una persona.
      if (!finalNeedsTransfer && replyText && ultimoSaliente?.content &&
          normalize(replyText) === normalize(ultimoSaliente.content)) {
        const globalDelArea = sucursalGlobal();
        if (globalDelArea) {
          replyText = 'Ya le pasé tu caso a una persona del equipo para que te ayude con esto; te escribe por aquí en breve.';
          matchedBranch = globalDelArea;
          finalNeedsTransfer = true;
          console.log('[BranchRouter] Respuesta repetida: el caso pasa al Area global');
        }
      }

      if (finalNeedsTransfer && matchedBranch) {
        // AI determinó transferencia: Enviar mensaje de confirmación corto y transferir
        if (replyText) {
          await this.sendReply({
            contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId,
            userId: contactDoc.user_id, workspaceId: wsId, text: replyText
          });
        }

        await this.executeBranchTransfer({
          wsId, contactDoc, platform, senderNumber, receiverNumber,
          whatsappPhoneNumberId, effectiveAccountId, conversationKey,
          state, branch: matchedBranch, source: 'ai', actorId,
          ticketTitle: aiResponse?.ticket_title || `Atención en Sucursal: ${matchedBranch.name}`,
          problemSummary: aiResponse?.agent_summary || incomingText || `Conversación transferida a ${matchedBranch.name} desde Router Central`,
          priority: aiResponse?.priority || 'normal',
          departmentId: resolvedDepartmentId || null,
          detectedLanguage: detectedLang,
          customerIntent: rawIntent,
          recommendedAction: recommendedAction,
          collectedInformation: collectedInfo,
          assistantReply: replyText
        });

        return { handled: true, routed: true, branch: matchedBranch, mode: 'ai' };
      }

      // Si la IA no ha transferido todavía (está comprendiendo o pidiendo dato faltante), envía respuesta conversacional corta
      if (replyText) {
        await this.sendReply({
          contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId,
          userId: contactDoc.user_id, workspaceId: wsId, text: replyText, connectionId: effectiveAccountId
        });

        // Ofertas de Amazon: si el cliente pidio la foto, se envian ahora (hasta 3).
        if (ofertasAmazon && ofertasAmazon.ok && /foto|imagen|verlo|foticos/i.test(textoDelCliente)) {
          await this.enviarImagenesOfertas({ contactDoc, platform, senderNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, connectionId: effectiveAccountId, ofertas: ofertasAmazon.items.slice(0, 3) });
        }

        // Almacenar respuesta en el historial
        await BranchConversationState.updateOne(
          { _id: state._id },
          {
            $set: {
              'metadata.status': 'branch_selection_pending',
              'metadata.city_context': aiResponse?.detected_city || state.metadata?.city_context || null,
              summary: aiResponse?.agent_summary || state.summary || null
            },
            $push: {
              recent_messages: {
                $each: [{ role: 'assistant', content: replyText, at: new Date() }],
                $slice: -20
              }
            }
          }
        );

        return { handled: true, routed: false, mode: 'ai' };
      }
    } catch (aiErr) {
      console.error('[BranchRouter AI Mode] AI call failed, falling back to deterministic:', aiErr.message);
    }

    // Fallback determinístico si falla la IA
    return await this.handleDeterministicMode({
      wsId, contactDoc, platform, senderNumber, receiverNumber,
      whatsappPhoneNumberId, effectiveAccountId, conversationKey,
      state, branches, matrix, companyName, incomingText, location, actorId
    });
  }

  /**
   * MODO 2: SIN IA (Determinístico Inteligente)
   * Flujo estructurado, no envía 15 sucursales juntas, "1" equivale a opción 1,
   * maneja submenús por ciudad y previene bucles.
   */
  static async handleDeterministicMode({
    wsId,
    contactDoc,
    platform,
    senderNumber,
    receiverNumber,
    whatsappPhoneNumberId,
    effectiveAccountId,
    conversationKey,
    state,
    branches,
    matrix,
    companyName,
    companyDescription = '',
    customInstructions = '',
    customWelcome = '',
    incomingText,
    location,
    actorId
  }) {
    const norm = normalize(incomingText);
    const meta = state.metadata || {};
    const menuOptions = meta.menu_options || [];
    let failedAttempts = meta.failed_attempts || 0;

    // 1. Check GPS location
    if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
      const bestMatch = findNearestBranch(branches, location);
      if (bestMatch?.branch) {
        const branch = bestMatch.branch;
        const msg = `Encontré nuestra sucursal de *${branch.name}* como la más cercana a tu ubicación. Te comunicaré con ella de inmediato.`;
        await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: msg, connectionId: effectiveAccountId });
        await this.executeBranchTransfer({ wsId, contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, effectiveAccountId, conversationKey, state, branch, source: 'location', actorId, assistantReply: msg });
        return { handled: true, routed: true, branch, mode: 'deterministic_location' };
      }
    }

    // 2. PRIORITY: Check if user sent a Numeric Option ("1", "2", "3", etc.)
    // If a menu was previously sent to this user, match immediately!
    const numericChoice = parseInt(norm, 10);
    if (!isNaN(numericChoice) && numericChoice > 0) {
      // Check against current menu_options stored in state
      if (menuOptions.length > 0) {
        const matchedOption = menuOptions.find(o => o.index === numericChoice);
        if (matchedOption) {
          const branch = branches.find(b => String(b._id) === String(matchedOption.branch_id));
          if (branch) {
            const preMsg = branch.pre_transfer_message || `Perfecto 👌 Te comunicaré con nuestra sucursal de *${branch.name}*. Un momento, por favor.`;
            await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: preMsg, connectionId: effectiveAccountId });
            await this.executeBranchTransfer({ wsId, contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, effectiveAccountId, conversationKey, state, branch, source: 'numeric', actorId, assistantReply: preMsg });
            return { handled: true, routed: true, branch, mode: 'deterministic' };
          }
        }
      }

      // If no menu_options in state, check 1-based index against all branches
      if (numericChoice <= branches.length) {
        const branch = branches[numericChoice - 1];
        if (branch) {
          const preMsg = branch.pre_transfer_message || `Perfecto 👌 Te comunicaré con nuestra sucursal de *${branch.name}*. Un momento, por favor.`;
          await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: preMsg, connectionId: effectiveAccountId });
          await this.executeBranchTransfer({ wsId, contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, effectiveAccountId, conversationKey, state, branch, source: 'numeric', actorId, assistantReply: preMsg });
          return { handled: true, routed: true, branch, mode: 'deterministic' };
        }
      }
    }

    // 3. PRIORITY: Check explicit branch name, code, or alias
    if (norm.length >= 2) {
      for (const branch of branches) {
        const bName = normalize(branch.name);
        const bCode = normalize(branch.code);
        const aliases = (branch.aliases || []).map(normalize);

        const isMatch = norm === bName || norm === bCode ||
                        norm.includes(bName) || (bCode && norm.includes(bCode)) ||
                        aliases.some(a => norm === a || (a.length >= 3 && norm.includes(a)));

        if (isMatch) {
          const preMsg = branch.pre_transfer_message || `Perfecto 👌 Te comunicaré con nuestra sucursal de *${branch.name}*. Un momento, por favor.`;
          await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: preMsg, connectionId: effectiveAccountId });
          await this.executeBranchTransfer({ wsId, contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, effectiveAccountId, conversationKey, state, branch, source: 'keyword', actorId, assistantReply: preMsg });
          return { handled: true, routed: true, branch, mode: 'deterministic' };
        }
      }
    }

    // 4. PRIORITY: Check city indicated
    if (norm.length >= 2) {
      // Group branches by city
      const cityMatches = branches.filter(b => {
        const city = normalize(b.address?.city || '');
        return city && (norm === city || norm.includes(city) || city.includes(norm));
      });

      if (cityMatches.length === 1) {
        // Single branch in this city -> Direct transfer!
        const branch = cityMatches[0];
        const preMsg = branch.pre_transfer_message || `Perfecto 👌 Te comunicaré con nuestra sucursal de *${branch.name}*. Un momento, por favor.`;
        await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: preMsg, connectionId: effectiveAccountId });
        await this.executeBranchTransfer({ wsId, contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, effectiveAccountId, conversationKey, state, branch, source: 'city', actorId, assistantReply: preMsg });
        return { handled: true, routed: true, branch, mode: 'deterministic' };
      }

      if (cityMatches.length > 1) {
        // Multiple branches in the same city: present sub-menu for this city ONLY!
        const cityName = cityMatches[0].address?.city || 'tu ciudad';
        const optionsList = cityMatches.map((b, i) => `${i + 1}️⃣ *${b.name}* (${b.address?.address_line || b.name})`).join('\n');
        const promptText = `En *${cityName}* contamos con las siguientes sucursales:\n\n${optionsList}\n\n👉 *Responde con el número (1 al ${cityMatches.length})* de tu preferencia:`;

        const newMenuOptions = cityMatches.map((b, i) => ({
          index: i + 1,
          branch_id: String(b._id),
          name: b.name,
          city: cityName
        }));

        await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: promptText, connectionId: effectiveAccountId });

        await BranchConversationState.updateOne(
          { _id: state._id },
          {
            $set: {
              'metadata.status': 'branch_selection_pending',
              'metadata.city_context': cityName,
              'metadata.menu_options': newMenuOptions,
              'metadata.failed_attempts': 0
            }
          }
        );

        return { handled: true, routed: false, mode: 'deterministic' };
      }
    }

    // 5. Initial greeting or unprompted message
    const isGreeting = /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|saludos|inicio|empezar|hi|hello)\b/i.test(incomingText.trim());
    const isFirstContact = (state.recent_messages || []).length <= 1 || isGreeting;
    if (isFirstContact) {
      let initialPrompt = customWelcome
        ? customWelcome
        : `¡Hola! 👋 Gracias por comunicarte con *${companyName}*.\n\n¿En qué ciudad deseas ser atendido?\n\nPuedes escribir el nombre de tu ciudad, seleccionar tu sucursal o compartir tu ubicación 📍`;

      if (customWelcome && !customWelcome.toLowerCase().includes('ciudad') && !customWelcome.toLowerCase().includes('sucursal')) {
        initialPrompt += `\n\n¿En qué ciudad deseas ser atendido?\nPuedes escribir tu ciudad, sucursal o compartir tu ubicación 📍`;
      }

      await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: initialPrompt, connectionId: effectiveAccountId });

      await BranchConversationState.updateOne(
        { _id: state._id },
        { $set: { 'metadata.status': 'branch_selection_pending', 'metadata.failed_attempts': 0 } }
      );
      return { handled: true, routed: false, mode: 'deterministic' };
    }

    // 6. Graceful Fallback (Prevent Infinite Loops)
    failedAttempts += 1;

    if (failedAttempts === 1) {
      const clarifyText = `Quiero asegurarme de comunicarte con el equipo correcto. ¿En qué ciudad o sector te encuentras? *(Ejemplo: Santo Domingo, Santiago, Puerto Plata...)*`;
      await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: clarifyText, connectionId: effectiveAccountId });

      await BranchConversationState.updateOne(
        { _id: state._id },
        { $set: { 'metadata.failed_attempts': failedAttempts } }
      );
      return { handled: true, routed: false, mode: 'deterministic' };
    }

    if (failedAttempts === 2) {
      // Show clean numbered menu of top active branches (up to 8)
      const visibleBranches = branches.slice(0, 8);
      const listText = visibleBranches.map((b, i) => `${i + 1}️⃣ *${b.name}* (📍 ${b.address?.city || b.name})`).join('\n');
      const menuPrompt = `Por favor, selecciona una de nuestras principales sucursales respondiendo con su número:\n\n${listText}\n\n*(O escribe tu ciudad o comparte tu ubicación)*`;

      const newMenuOptions = visibleBranches.map((b, i) => ({
        index: i + 1,
        branch_id: String(b._id),
        name: b.name,
        city: b.address?.city || b.name
      }));

      await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: menuPrompt, connectionId: effectiveAccountId });

      await BranchConversationState.updateOne(
        { _id: state._id },
        {
          $set: {
            'metadata.menu_options': newMenuOptions,
            'metadata.failed_attempts': failedAttempts
          }
        }
      );
      return { handled: true, routed: false, mode: 'deterministic' };
    }

    // 3 or more failed attempts -> Transfer to Central Reception (Default Branch) without loop
    const defaultBranch = branches.find(b => b.is_default) || branches[0];
    const fallbackText = `Te transferiré con nuestra *Recepción Central* para brindarte atención personalizada de inmediato.`;
    await this.sendReply({ contactDoc, platform, senderNumber, receiverNumber, whatsappPhoneNumberId, userId: contactDoc.user_id, workspaceId: wsId, text: fallbackText, connectionId: effectiveAccountId });

    await this.executeBranchTransfer({
      wsId, contactDoc, platform, senderNumber, receiverNumber,
      whatsappPhoneNumberId, effectiveAccountId, conversationKey,
      state, branch: defaultBranch, source: 'default', actorId, assistantReply: fallbackText
    });

    return { handled: true, routed: true, branch: defaultBranch, mode: 'deterministic_fallback' };
  }

  /**
   * Finalizes the transfer:
   * 1. Updates conversation state to 'transferred'
   * 2. Resolves and assigns branch agent / team
   * 3. Creates or updates ChatAssignment
   * 4. Opens OrganizationCase / Ticket
   * 5. Emits real-time socket event
   */
    /**
   * SELECCIÓN ENTRE VARIOS AGENTES SEGÚN LA PRIORIDAD DEL CONTRATO:
   * 1. Agente ya asignado al cliente, si corresponde.
   * 2. Agente especializado en ese departamento o tipo de caso.
   * 3. Agente disponible (activo, no eliminado).
   * 4. Agente con menor cantidad de conversaciones activas.
   * 5. Round-robin entre agentes disponibles.
   * 6. Cola de la sucursal si actualmente ninguno está disponible.
   */
  static async selectAgentAccordingToContract({ wsId, branchId, departmentId, contactDoc }) {
    try {
      // 1. Agente ya asignado al cliente si corresponde
      if (contactDoc?.assigned_to) {
        const prevAgent = await User.findOne({ _id: contactDoc.assigned_to, deleted_at: null, status: true }).lean();
        if (prevAgent) {
          const isMember = await BranchMembership.findOne({
            workspace_id: wsId,
            branch_id: branchId,
            user_id: prevAgent._id,
            role: 'agent',
            availability: { $nin: ['offline', 'away'] },
            status: 'active',
            deleted_at: null
          });
          if (isMember && !['offline', 'away'].includes(String(isMember.availability || '').toLowerCase())) {
            console.log(`[BranchRouter] Prioridad 1: Asignando a agente previo del cliente: ${prevAgent.name || prevAgent._id}`);
            return prevAgent._id;
          }
        }
      }

      // Buscar todos los miembros activos de la sucursal
      const branchMembers = await BranchMembership.find({
        workspace_id: wsId,
        branch_id: branchId,
        status: 'active',
        deleted_at: null
      }).select('user_id').lean();

      const memberUserIds = branchMembers.map(m => m.user_id).filter(Boolean);
      if (memberUserIds.length === 0) {
        console.log(`[BranchRouter] Prioridad 6: Sin agentes configurados en sucursal ${branchId}, pasa a cola.`);
        return null;
      }

      // Filtrar agentes activos y disponibles en el sistema
      const activeUsers = await User.find({
        _id: { $in: memberUserIds },
        deleted_at: null,
        status: true
      }).select('_id name email').lean();

      if (activeUsers.length === 0) {
        console.log(`[BranchRouter] Prioridad 6: Ningún agente disponible en sucursal ${branchId}, pasa a cola.`);
        return null;
      }

      const activeUserIds = activeUsers.map(u => u._id);

      // Reparto por prioridad de rol: primero los agentes de la sucursal (repartidos entre ellos por
      // menor carga y round-robin) y, solo si no hay ningun agente, entra el manager.
      const buscarMiembros = (filtro) => BranchMembership.find({
        workspace_id: wsId,
        branch_id: branchId,
        user_id: { $in: activeUserIds },
        status: 'active',
        deleted_at: null,
        ...filtro
      }).select('user_id role').lean();

      let availableBranchMembers = await buscarMiembros({ role: 'agent', availability: 'available' });
      if (availableBranchMembers.length === 0) availableBranchMembers = await buscarMiembros({ role: 'agent', availability: { $nin: ['offline', 'away'] } });
      if (availableBranchMembers.length === 0) availableBranchMembers = await buscarMiembros({ availability: 'available' });
      if (availableBranchMembers.length === 0) availableBranchMembers = await buscarMiembros({ availability: { $nin: ['offline', 'away'] } });

      const availableUserIds = availableBranchMembers.map(m => m.user_id).filter(Boolean);
      if (availableUserIds.length > 0) {
        console.log(`[BranchRouter] Prioridad 3: ${availableUserIds.length} agentes disponibles en sucursal ${branchId}`);
      } else {
        console.log(`[BranchRouter] Prioridad 6: Ningún agente con disponibilidad activa en sucursal ${branchId}, pasa a cola.`);
        return null;
      }

      // 2. Agente especializado en ese departamento o tipo de caso
      let candidateIds = availableUserIds;
      // candidateIds ya filtrado por disponibilidad
      if (departmentId) {
        try {
          const { default: OrganizationMembership } = await import('../models/organization-membership.model.js');
          const deptMembers = await OrganizationMembership.find({
            department_id: departmentId,
            user_id: { $in: activeUserIds },
            status: 'active',
            deleted_at: null
          }).select('user_id').lean();

          const deptUserIds = deptMembers.map(d => d.user_id).filter(Boolean);
          const availableSet = new Set(availableUserIds.map(id => String(id)));
          const availableDeptUserIds = deptUserIds.filter(id => availableSet.has(String(id)));
          if (availableDeptUserIds.length > 0) {
            candidateIds = availableDeptUserIds;
            console.log(`[BranchRouter] Prioridad 2: ${candidateIds.length} agentes especializados en departamento ${departmentId}`);
          } else {
            console.log(`[BranchRouter] Prioridad 6: Ningún agente disponible pertenece al departamento ${departmentId}, pasa a cola.`);
            return null;
          }
        } catch (orgErr) {
          console.error('[BranchRouter] Error lookup OrganizationMembership; se evita asignar fuera del departamento:', orgErr.message);
          return null;
        }
      }

      // 4. Agente con menor cantidad de conversaciones activas
      const chatLoads = await Promise.all(candidateIds.map(async (uid) => {
        const count = await ChatAssignment.countDocuments({
          workspace_id: wsId,
          agent_id: uid,
          status: 'assigned',
          is_solved: { $ne: true }
        });
        return { userId: uid, load: count };
      }));

      // Ordenar de menor a mayor carga de conversaciones
      chatLoads.sort((a, b) => a.load - b.load);

      // 5. Round-robin entre los agentes que empaten con menor carga
      const minLoad = chatLoads[0].load;
      const leastLoaded = chatLoads.filter(c => c.load === minLoad);
      const randomIndex = Math.floor(Math.random() * leastLoaded.length);
      const chosenAgentId = leastLoaded[randomIndex].userId;

      console.log(`[BranchRouter] Prioridad 4/5: Seleccionado agente ${chosenAgentId} con carga activa: ${minLoad}`);
      return chosenAgentId;
    } catch (selErr) {
      console.error('[BranchRouter] Error en selectAgentAccordingToContract:', selErr);
      return null;
    }
  }

  static async executeBranchTransfer({
    wsId,
    contactDoc,
    platform,
    senderNumber,
    receiverNumber,
    whatsappPhoneNumberId,
    effectiveAccountId,
    conversationKey,
    state,
    branch,
    source = 'unknown',
    actorId = null,
    ticketTitle = null,
    problemSummary = null,
    priority = 'normal',
    departmentId = null,
    detectedLanguage = null,
    customerIntent = null,
    recommendedAction = null,
    collectedInformation = [],
    assistantReply = null
  }) {
    const contactId = toObjectId(contactDoc._id);

    // Repeated handoffs reuse the human case instead of choosing another agent.
    const existingHumanCase = await ChatAssignment.findOne({ workspace_id: wsId, contact_id: contactId, conversation_key: conversationKey, status: 'assigned', is_solved: { $ne: true } }).sort({ created_at: -1 }).lean();
    if (isOpenHumanCase(existingHumanCase)) return existingHumanCase;
    const transferContact = await Contact.findOne({ _id: contactId, workspace_id: wsId }).select('chatbot_paused').lean();
    if (transferContact?.chatbot_paused) return existingHumanCase;

    // Reparto del caso: primero los agentes de la sucursal (por menor carga y round-robin) y el
    // manager solo como ultimo recurso, cuando no hay ningun agente disponible.
    const selectedAgentId = await this.selectAgentAccordingToContract({
      wsId,
      branchId: branch._id,
      departmentId,
      contactDoc
    });

    const mode = branch.assignment_mode || 'least_load';

    // Get workspace owner
    const ws = await Workspace.findById(wsId).select('user_id').lean();
    const ownerId = ws?.user_id || actorId;

    // Check if branch has autonomous AI agent
    let branchChatbotId = null;
    if (branch.response_policy === 'ai_first' || branch.response_policy === 'ai_only') {
      const bAgent = await BranchAgent.findOne({
        branch_id: branch._id,
        status: 'active',
        deleted_at: null
      }).lean();
      if (bAgent?.chatbot_id) {
        branchChatbotId = bAgent.chatbot_id;
      }
    }

    // Create or update ChatAssignment
    const assignment = await ChatAssignment.findOneAndUpdate(
      {
        workspace_id: wsId,
        contact_id: contactId,
        conversation_key: conversationKey,
        is_solved: { $ne: true }
      },
      {
        $set: {
          workspace_id: wsId,
          contact_id: contactId,
          branch_id: branch._id,
          department_id: departmentId || null,
          area_id: null,
          team_id: branch.team_id || null,
          conversation_key: conversationKey,
          platform: platform || null,
          account_id: effectiveAccountId,
          assignment_mode: mode,
          assignment_source: `branch_${source}`,
          sender_number: senderNumber || String(contactId),
          receiver_number: receiverNumber || effectiveAccountId || String(contactId),
          agent_id: selectedAgentId,
          chatbot_id: branchChatbotId,
          assigned_by: ownerId,
          whatsapp_phone_number_id: String(whatsappPhoneNumberId || effectiveAccountId || 'branch'),
          status: 'assigned',
          is_solved: false,
          updated_at: new Date()
        },
        $setOnInsert: { created_at: new Date() }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Open an Organization Case / Ticket for this branch & department
    let caseResult = null;
    let caseError = null;
    try {
      if (organizationCaseService && typeof organizationCaseService.openCase === 'function') {
        const finalTitle = ticketTitle || `Atención en Sucursal: ${branch.name}`;
        const finalSummary = problemSummary || `Conversación transferida a ${branch.name} desde Router Central`;
        const finalPriority = ['low', 'medium', 'normal', 'high', 'urgent'].includes(priority)
          ? (priority === 'medium' ? 'normal' : priority)
          : 'normal';

        caseResult = await organizationCaseService.openCase({
          workspaceId: wsId,
          actorId: ownerId,
          data: {
            conversation_key: conversationKey,
            contact_id: contactId,
            branch_id: branch._id,
            department_id: departmentId || null,
            agent_id: selectedAgentId,
            priority: finalPriority,
            option_title: finalTitle,
            summary: finalSummary,
            detected_language: detectedLanguage,
            customer_intent: customerIntent,
            recommended_action: recommendedAction,
            collected_information: collectedInformation
          }
        });

        // Create AgentTask for the assigned agent with compact format and recommended action
        if (selectedAgentId) {
          try {
            const AgentTask = mongoose.models.AgentTask || mongoose.model('AgentTask');
            const caseNum = caseResult?.case?.case_number || 'Nuevo';
            const actionText = recommendedAction ? `\n\nAcción sugerida: ${recommendedAction}` : '';
            const infoText = (collectedInformation && collectedInformation.length > 0)
              ? `\nDatos: ` + collectedInformation.map(ci => `${ci.label}: ${ci.value}`).join(' | ')
              : '';

            const taskTitle = `[Ticket ${caseNum}] ${finalTitle}`;
            await AgentTask.findOneAndUpdate(
              { title: taskTitle, agent_id: selectedAgentId, status: { $nin: ['completed', 'cancelled'] } },
              {
                $setOnInsert: {
                  title: taskTitle,
                  description: `Cliente: ${contactDoc?.name || contactDoc?.phone_number || senderNumber || 'Sin nombre'}\n${finalSummary}${actionText}${infoText}`,
                  status: 'pending',
                  task_priority: finalPriority,
                  agent_id: selectedAgentId,
                  assigned_by: ownerId
                }
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            console.log(`[BranchRouter] AgentTask created for agent ${selectedAgentId} on case ${caseNum}`);
          } catch (tErr) {
            console.error('[BranchRouter] AgentTask creation error:', tErr.message);
            caseError = tErr;
          }
        }
      }
    } catch (cErr) {
      console.error('[BranchRouter] openCase error:', cErr.message);
      caseError = cErr;
    }

    if (caseError) {
      try {
        await ChatAssignment.updateOne(
          { _id: assignment._id, workspace_id: wsId },
          { $set: { agent_id: null, case_status: 'waiting', updated_at: new Date() } }
        );
      } catch (assignmentError) {
        console.error('[BranchRouter] Failed to move broken transfer to queue:', assignmentError.message);
      }
    }

    // If no human is available, keep the conversation in an explicit branch
    // queue. Never claim a human assignment when the contract selector found
    // nobody eligible.
    if (!selectedAgentId || caseError) {
      try {
        await BranchHandoff.findOneAndUpdate(
          { workspace_id: wsId, branch_id: branch._id, conversation_key: conversationKey, status: 'waiting' },
          {
            $set: {
              reason: caseError ? 'ticket_creation_failed' : 'inbound_branch_message',
              priority: priority === 'urgent' ? 'urgent' : (priority === 'high' ? 'high' : 'normal'),
              summary: caseError
                ? `Transferencia pendiente: no se pudo completar el ticket de ${branch.name}`
                : `Cliente ${senderNumber || ''} enrutado a ${branch.name}`,
              status: 'waiting',
              updated_at: new Date()
            },
            $setOnInsert: {
              workspace_id: wsId,
              branch_id: branch._id,
              conversation_key: conversationKey,
              created_at: new Date()
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } catch (handoffErr) {
        console.error('[BranchRouter] BranchHandoff creation error:', handoffErr.message);
      }
    }

    // Silenciar la IA only after the assignment/ticket path has been attempted.
    // This prevents a failed transfer from looking like a successful human case.
    try {
      await Contact.findByIdAndUpdate(contactId, {
        $set: {
          assigned_to: caseError ? null : (selectedAgentId || null),
          assigned_branch_id: branch._id,
          chatbot_paused: true,
          assigned_chatbot: null,
          chat_status: 'open',
          updated_at: new Date(),
          // El router ya anuncio la transferencia al cliente en este mismo turno, asi que el acuse
          // de handoff queda marcado como enviado: un turno = un solo mensaje (2026-10-06).
          'metadata.handoff_ack_at': new Date(),
          'metadata.handoff_ack_case': String((assignment && assignment._id) || (existingHumanCase && existingHumanCase._id) || "")
        }
      });
      console.log(`[BranchRouter] Contact ${contactId} updated: assigned_to=${caseError ? 'queue' : selectedAgentId}, chatbot_paused=true (AI Silenciada)`);
    } catch (ctErr) {
      console.error('[BranchRouter] Contact update error:', ctErr.message);
    }

    // Update conversation state to 'transferred'
    await BranchConversationState.updateOne(
      { _id: state._id },
      {
        $set: {
          branch_id: branch._id,
          branch_resolution_source: source,
          branch_resolution_confidence: 1,
          responder_type: selectedAgentId && !caseError ? 'HUMAN' : 'WAITING_HUMAN',
          responder_id: selectedAgentId && !caseError ? String(selectedAgentId) : null,
          'metadata.status': selectedAgentId && !caseError ? 'transferred' : 'waiting_human',
          'metadata.transferred_at': new Date(),
          'metadata.transferred_branch_id': String(branch._id),
          'metadata.transferred_branch_name': branch.name,
          summary: problemSummary || state.summary || `Conversación transferida a ${branch.name} desde Router Central`
        },
        $push: {
          recent_messages: {
            $each: assistantReply ? [{ role: 'assistant', content: String(assistantReply), at: new Date() }] : [],
            $slice: -20
          }
        }
      }
    );

    // Emit real-time Socket event
    try {
      const io = global.io || null;
      if (io) {
        const assignmentPayload = {
          chat_id: String(contactId || senderNumber),
          contact_id: String(contactId),
          branch_id: String(branch._id),
          branch_name: branch.name,
          department_id: departmentId ? String(departmentId) : null,
          agent_id: selectedAgentId && !caseError ? String(selectedAgentId) : null,
          status: 'assigned',
          chatbot_paused: true,
          workspace_id: String(wsId)
        };
        io.to(`workspace:${wsId}`).emit('organization:assignment_updated', assignmentPayload);

        const chatAssignedPayload = {
          contact_id: String(contactId),
          chat_id: String(contactId),
          phone_number: contactDoc.phone_number || senderNumber,
          branch_id: String(branch._id),
          department_id: departmentId ? String(departmentId) : null,
          agent_id: selectedAgentId && !caseError ? String(selectedAgentId) : null,
          chatbot_paused: true,
          workspace_id: String(wsId)
        };
        io.to(`workspace:${wsId}`).emit('chat:assigned', chatAssignedPayload);

        if (selectedAgentId && !caseError) {
          io.to(`user:${selectedAgentId}`).emit('agent:escalation', {
            workspace_id: String(wsId),
            contact_id: String(contactId),
            user_id: ownerId,
            agent_id: String(selectedAgentId),
            message: `Nuevo caso transferido en ${branch.name}: ${ticketTitle || 'Atención requerida'}`,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (ioErr) {
      console.warn('[BranchRouter] io emit warning:', ioErr.message);
    }

    console.log(`[BranchRouter] Transfer finalized for ${conversationKey} to branch ${branch.name} (${branch._id}), agent=${caseError ? 'queue' : selectedAgentId}, ticket=${caseResult?.case?.case_number || 'pending'}`);
    return assignment;
  }
}

export default BranchRouterService;

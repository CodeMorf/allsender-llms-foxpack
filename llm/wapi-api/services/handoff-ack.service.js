import mongoose from 'mongoose';
import ChatAssignment from '../models/chat-assignment.model.js';
import Contact from '../models/contact.model.js';
import organizationSlaService from './organization-sla.service.js';

// Un unico acuse de recibo cuando la conversacion ya es de una persona y nadie ha contestado:
// fuera de horario avisa que la sucursal esta cerrada; en horario promete la atencion.
const ACK_TTL_MS = 6 * 60 * 60 * 1000;

const DAYS_ES = {
  monday: 'lunes',
  tuesday: 'martes',
  wednesday: 'miércoles',
  thursday: 'jueves',
  friday: 'viernes',
  saturday: 'sábado',
  sunday: 'domingo'
};

const firstName = (value) => String(value || '').trim().split(/\s+/)[0] || '';

// Para un dia suelto el espanol pide plural: "los sabados", "los domingos".
const DIAS_PLURAL = {
  lunes: 'lunes',
  martes: 'martes',
  miércoles: 'miércoles',
  jueves: 'jueves',
  viernes: 'viernes',
  sábado: 'sábados',
  domingo: 'domingos'
};

const humanTime = (value) => {
  const [hRaw, mRaw] = String(value || '').split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h)) return String(value || '');
  const suffix = h < 12 ? 'a.m.' : 'p.m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')} ${suffix}`;
};

// Agrupa dias consecutivos que comparten el mismo rango; los dias cerrados no se mencionan.
const formatHours = (hours) => {
  if (!hours) return '';
  const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const groups = [];
  order.forEach((key, index) => {
    const day = hours[key];
    const abierto = day && day.status === 'opened' && (day.hours || []).length;
    if (!abierto) return;
    const range = `${humanTime(day.hours[0].from)} a ${humanTime(day.hours[0].to)}`;
    const last = groups[groups.length - 1];
    if (last && last.range === range && last.endIndex === index - 1) {
      last.endIndex = index;
      last.days.push(DAYS_ES[key]);
      return;
    }
    groups.push({ range, days: [DAYS_ES[key]], endIndex: index });
  });
  if (!groups.length) return '';
  return groups
    .map((g) => {
      const dias = g.days.length === 1 ? `los ${DIAS_PLURAL[g.days[0]] || g.days[0]}` : `de ${g.days[0]} a ${g.days[g.days.length - 1]}`;
      return `${dias} de ${g.range}`;
    })
    .join(' y ');
};

const buildMessage = ({ isOpen, name, branchName, caseNumber, hoursText }) => {
  const hello = name ? `¡Hola ${name}!` : '¡Hola!';
  const ticket = caseNumber ? ` con el ticket ${caseNumber}` : '';
  if (isOpen) {
    return `${hello} Ya avisamos a un asesor de ${branchName}; te responde por este mismo chat en cuanto esté disponible. Tu caso ya quedó registrado${ticket}. Gracias por la paciencia.`;
  }
  const horario = hoursText ? ` (atendemos ${hoursText})` : '';
  return `${hello} Ahora mismo estamos fuera de horario${horario}. Tu caso ya quedó registrado${ticket} y no se va a perder: en cuanto abramos, un asesor te escribe por aquí para atenderte.`;
};

export const maybeSendHandoffAck = async ({
  contact,
  workspaceId,
  senderNumber,
  whatsappPhoneNumberId,
  userId,
  platform = 'whatsapp',
  now = new Date(),
  dryRun = false
}) => {
  if (!contact || contact.chatbot_paused !== true) return { sent: false, reason: 'ai_active' };

  const wsId = workspaceId && mongoose.Types.ObjectId.isValid(workspaceId)
    ? new mongoose.Types.ObjectId(workspaceId)
    : contact.workspace_id;

  const assignment = await ChatAssignment.findOne({
    workspace_id: wsId,
    contact_id: contact._id,
    status: 'assigned',
    is_solved: { $ne: true }
  }).sort({ created_at: -1 }).lean();

  if (!assignment) return { sent: false, reason: 'no_open_ticket' };
  if (assignment.first_response_at) return { sent: false, reason: 'agent_already_replied' };

  const metadata = contact.metadata || {};
  const previousAt = metadata.handoff_ack_at ? new Date(metadata.handoff_ack_at) : null;
  const sameCase = String(metadata.handoff_ack_case || '') === String(assignment._id);
  if (previousAt && sameCase && now.getTime() - previousAt.getTime() < ACK_TTL_MS) {
    return { sent: false, reason: 'already_acknowledged' };
  }

  const branch = assignment.branch_id
    ? await mongoose.connection.db.collection('omnichannel_branches').findOne({ _id: assignment.branch_id })
    : null;
  const hours = branch?.business_hours_mode === 'custom' && branch?.business_hours ? branch.business_hours : null;
  const timezone = branch?.timezone || 'America/Santo_Domingo';
  const isOpen = organizationSlaService.isOpenInBusinessHours({ hours, timezone, at: now });

  const text = buildMessage({
    isOpen,
    name: firstName(contact.name),
    branchName: branch?.name || 'nuestra sucursal',
    caseNumber: assignment.case_number || '',
    hoursText: formatHours(hours)
  });

  if (dryRun) return { sent: false, dryRun: true, state: isOpen ? 'open' : 'closed', text };

  const { default: branchRouterService } = await import('./branch-router.service.js');
  await branchRouterService.sendReply({
    contactDoc: contact,
    platform,
    senderNumber,
    whatsappPhoneNumberId: whatsappPhoneNumberId || undefined,
    userId: userId || contact.user_id,
    workspaceId: wsId,
    text,
    allowHumanCaseAck: true
  });

  await Contact.updateOne(
    { _id: contact._id },
    {
      $set: {
        'metadata.handoff_ack_at': now,
        'metadata.handoff_ack_case': String(assignment._id),
        'metadata.handoff_ack_state': isOpen ? 'open' : 'closed'
      }
    }
  );

  return { sent: true, state: isOpen ? 'open' : 'closed', text };
};

export default { maybeSendHandoffAck };

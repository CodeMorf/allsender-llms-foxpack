// Recordatorio de silencio: si un caso quedo con la IA silenciada y el cliente sigue esperando,
// se le avisa que su caso sigue en cola (maximo 2 avisos, separados 30 minutos). Por ahora solo FoxPack.
import 'dotenv/config';
import mongoose from 'mongoose';
import '../models/index.js';
import BranchRouterService from '../services/branch-router.service.js';

const DRY = process.argv.includes('--dry');
const WORKSPACES = { '6ab82a6847ab241dfafe4bc0': 'FoxPack' };
const MIN_ESPERA = 10;
const MIN_ENTRE_AVISOS = 30;
const MAX_AVISOS = 2;
const MAX_EDAD_HORAS = 24; // no se recuerda casos de hace dias: solo lo reciente

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
const ahora = Date.now();
let candidatos = 0, enviados = 0, errores = 0;

for (const [wsId, nombre] of Object.entries(WORKSPACES)) {
  const ws = new mongoose.Types.ObjectId(wsId);
  const tickets = await db.collection('chat_assignments').find({
    workspace_id: ws, status: 'assigned', is_solved: { $ne: true }, first_response_at: null
  }).toArray();

  for (const t of tickets) {
    const minutos = (ahora - new Date(t.created_at).getTime()) / 60000;
    if (minutos < MIN_ESPERA || minutos > MAX_EDAD_HORAS * 60) continue;

    const contact = await db.collection('contacts').findOne({ _id: t.contact_id });
    if (!contact || contact.chatbot_paused !== true) continue;

    const meta = contact.metadata || {};
    const avisos = Number(meta.silencio_avisos || 0);
    if (avisos >= MAX_AVISOS) continue;
    const ultimoAviso = meta.silencio_aviso_at ? new Date(meta.silencio_aviso_at).getTime() : 0;
    if (ultimoAviso && (ahora - ultimoAviso) / 60000 < MIN_ENTRE_AVISOS) continue;

    const ultimos = await db.collection('messages').find({ contact_id: t.contact_id }).sort({ created_at: -1 }).limit(1).toArray();
    const ultimo = ultimos[0];
    if (!ultimo || ultimo.direction !== 'inbound') continue;
    const esperando = Math.round((ahora - new Date(ultimo.created_at).getTime()) / 60000);
    if (esperando < MIN_ESPERA) continue;

    const branch = t.branch_id ? await db.collection('omnichannel_branches').findOne({ _id: t.branch_id }) : null;
    const sucursal = branch ? branch.name : 'nuestra sucursal';
    const texto = avisos === 0
      ? `Seguimos con tu caso: ya quedó registrado con el ticket ${t.case_number} para ${sucursal}. Un asesor te responde por aquí en cuanto esté disponible; si pasan unos minutos sin respuesta, escríbeme otra vez y lo escalo.`
      : `Tu caso ${t.case_number} sigue en cola con el equipo de ${sucursal}. Si necesitas algo más, escríbeme y te ayudo con lo que esté en mi mano mientras te atienden.`;

    candidatos++;
    console.log('[' + nombre + '] ticket ' + t.case_number + ' | ' + contact.name + ' | esperando ' + esperando + ' min | aviso ' + (avisos + 1) + '/' + MAX_AVISOS);
    console.log('   -> ' + texto.slice(0, 130));
    if (DRY) continue;

    try {
      await BranchRouterService.sendReply({
        contactDoc: contact,
        platform: t.platform || 'whatsapp',
        senderNumber: contact.phone_number,
        receiverNumber: null,
        whatsappPhoneNumberId: ultimo.whatsapp_phone_number_id || null,
        userId: contact.user_id,
        workspaceId: contact.workspace_id,
        text: texto,
        connectionId: ultimo.whatsapp_connection_id || null,
        allowHumanCaseAck: true
      });
      await db.collection('contacts').updateOne({ _id: contact._id }, { $set: {
        'metadata.silencio_avisos': avisos + 1,
        'metadata.silencio_aviso_at': new Date(),
        updated_at: new Date()
      }});
      enviados++;
    } catch (e) {
      errores++;
      console.error('   error enviando: ' + e.message);
    }
  }
}
console.log('candidatos: ' + candidatos + ' | enviados: ' + enviados + ' | errores: ' + errores + (DRY ? ' (dry-run)' : ''));
await mongoose.disconnect();
process.exit(0);

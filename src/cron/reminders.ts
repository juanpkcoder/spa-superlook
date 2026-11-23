import {
  ChatSesionRow,
  CitaConServicioRow,
  Env,
  formatCOP,
  NOMBRE_OFICIAL_NEGOCIO,
} from '../types';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../services/whatsapp';
import { buildClientCitaUrl } from '../services/security';
import { parseChatSession } from '../services/gemini-bot';

export interface RemindersExecutionSummary {
  checkedCount: number;
  sent24hCount: number;
  sent2hCount: number;
  sentMaintenanceNails25dCount: number;
  sentMaintenanceHair30dCount: number;
}

const UBICACION_ATENCION =
  'Transversal 86A #83A-30 · Spa Superlook (Atención exclusiva con reserva previa)';

/**
 * Determina la cadencia de mantenimiento según el servicio/categoría:
 * - Manicura / Pedicura / Uñas => 25 días
 * - Cabello / Capilar / Colorimetría / Keratina / Alisado / Corte => 30 días
 */
function detectMaintenanceCadence(
  categoria?: string | null,
  servicioNombre?: string | null
): { type: 'UNAS' | 'CABELLO'; days: number; label: string } | null {
  const haystack = `${categoria || ''} ${servicioNombre || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (
    haystack.includes('una') ||
    haystack.includes('manicur') ||
    haystack.includes('pedicur') ||
    haystack.includes('acrilic') ||
    haystack.includes('poligel') ||
    haystack.includes('soft gel') ||
    haystack.includes('press') ||
    haystack.includes('semipermanente') ||
    haystack.includes('nail')
  ) {
    return { type: 'UNAS', days: 25, label: 'manicura / pedicura' };
  }

  if (
    haystack.includes('cabello') ||
    haystack.includes('capilar') ||
    haystack.includes('color') ||
    haystack.includes('balayage') ||
    haystack.includes('babylight') ||
    haystack.includes('iluminacion') ||
    haystack.includes('rayito') ||
    haystack.includes('keratina') ||
    haystack.includes('cirugia') ||
    haystack.includes('laminado') ||
    haystack.includes('ampolleta') ||
    haystack.includes('alisado') ||
    haystack.includes('tinte') ||
    haystack.includes('tintura') ||
    haystack.includes('corte') ||
    haystack.includes('peinado') ||
    haystack.includes('cepillado') ||
    haystack.includes('mechas')
  ) {
    return { type: 'CABELLO', days: 30, label: 'cabello' };
  }

  return null;
}

/**
 * Ejecuta la tarea programada (Cron Trigger) para enviar:
 * 1. Recordatorios automáticos de 24 horas y 2 horas a citas próximas CONFIRMADA.
 * 2. Recordatorios automáticos de mantenimiento post-cita:
 *    - 25 días después para Manicura / Pedicura / Uñas
 *    - 30 días después para Cabello / Capilar / Colorimetría / Keratina
 *    Inyectando el contexto en `chat_sesiones` para que el Bot recuerde el servicio cuando la clienta confirme.
 */
export async function processScheduledReminders(
  env: Env
): Promise<RemindersExecutionSummary> {
  const now = new Date();
  const nowIso = now.toISOString();
  const in25HoursIso = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

  // ============================================================================
  // PARTE A: RECORDATORIOS PRE-CITA (24 HORAS Y 2 HORAS ANTES)
  // ============================================================================
  const { results } = await env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre, s.categoria AS servicio_categoria
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     WHERE c.estado = 'CONFIRMADA'
       AND c.fecha_hora_inicio > ?1
       AND c.fecha_hora_inicio <= ?2
       AND (c.recordatorio_24h = 0 OR c.recordatorio_2h = 0)`
  )
    .bind(nowIso, in25HoursIso)
    .all<CitaConServicioRow>();

  const citas = results || [];
  let sent24hCount = 0;
  let sent2hCount = 0;

  for (const cita of citas) {
    const startMs = new Date(cita.fecha_hora_inicio).getTime();
    const diffHours = (startMs - now.getTime()) / (1000 * 60 * 60);
    const servicioNombre = cita.servicio_nombre || `Servicio #${cita.servicio_id}`;
    const reembolso80Str = formatCOP(cita.monto_reembolso_80);
    const { url: linkGestionCita } = await buildClientCitaUrl(env, cita.id);

    // 1. Ventana de recordatorio de 2 horas (entre 0 y 2.5 horas antes de la cita)
    if (cita.recordatorio_2h === 0 && diffHours > 0 && diffHours <= 2.5) {
      const textoCliente2h =
        `⏰ *Recordatorio 2 Horas - ${NOMBRE_OFICIAL_NEGOCIO}*\n` +
        `Hola *${cita.cliente_nombre}*, tu cita bajo reserva de *${servicioNombre}* es hoy en aproximadamente 2 horas (${cita.fecha_hora_inicio}).\n` +
        `📍 *Ubicación:* ${UBICACION_ATENCION}\n` +
        `🔗 *Tu reserva:* ${linkGestionCita}\n` +
        `📌 *Política de cancelación:* En caso de cancelación se retiene el 20% por gastos administrativos y se reembolsa el 80% (${reembolso80Str}).`;

      await sendWhatsAppTemplate(
        env,
        cita.cliente_telefono,
        'recordatorio_cita_2h',
        [
          cita.cliente_nombre,
          servicioNombre,
          cita.fecha_hora_inicio,
          UBICACION_ATENCION,
          reembolso80Str,
        ],
        'es_CO',
        textoCliente2h
      );

      if (env.ADMIN_PHONE) {
        await sendWhatsAppText(
          env,
          env.ADMIN_PHONE,
          `🔔 *[${NOMBRE_OFICIAL_NEGOCIO} - Cita en 2h]*\nCliente: ${cita.cliente_nombre} (${cita.cliente_telefono})\nServicio: ${servicioNombre}\nInicio: ${cita.fecha_hora_inicio}\nID Cita: ${cita.id}`
        );
      }

      await env.DB.prepare('UPDATE citas SET recordatorio_2h = 1 WHERE id = ?1')
        .bind(cita.id)
        .run();

      sent2hCount++;
      continue;
    }

    // 2. Ventana de recordatorio de 24 horas (entre 2.5 y 25 horas antes de la cita)
    if (cita.recordatorio_24h === 0 && diffHours > 2.5 && diffHours <= 25) {
      const textoCliente24h =
        `📅 *Recordatorio 24 Horas - ${NOMBRE_OFICIAL_NEGOCIO}*\n` +
        `Hola *${cita.cliente_nombre}*, te recordamos tu cita confirmada de *${servicioNombre}* para mañana (${cita.fecha_hora_inicio}).\n` +
        `📍 *Ubicación:* ${UBICACION_ATENCION}\n` +
        `🔗 *Ver o cancelar tu reserva:* ${linkGestionCita}\n` +
        `📌 *Política obligatoria del 80%:* Si necesitas cancelar, se retiene el 20% por gastos administrativos y reserva de agenda, y tu reembolso del 80% equivale a ${reembolso80Str}.`;

      await sendWhatsAppTemplate(
        env,
        cita.cliente_telefono,
        'recordatorio_cita_24h',
        [
          cita.cliente_nombre,
          servicioNombre,
          cita.fecha_hora_inicio,
          UBICACION_ATENCION,
          reembolso80Str,
        ],
        'es_CO',
        textoCliente24h
      );

      if (env.ADMIN_PHONE) {
        await sendWhatsAppText(
          env,
          env.ADMIN_PHONE,
          `📅 *[${NOMBRE_OFICIAL_NEGOCIO} - Recordatorio 24h Enviado]*\nCliente: ${cita.cliente_nombre} (${cita.cliente_telefono})\nServicio: ${servicioNombre}\nInicio: ${cita.fecha_hora_inicio}\nID Cita: ${cita.id}`
        );
      }

      await env.DB.prepare('UPDATE citas SET recordatorio_24h = 1 WHERE id = ?1')
        .bind(cita.id)
        .run();

      sent24hCount++;
    }
  }

  // ============================================================================
  // PARTE B: RECORDATORIOS DE MANTENIMIENTO POST-CITA (25 DÍAS UÑAS / 30 DÍAS CABELLO)
  // ============================================================================
  const cutoff35DaysAgoIso = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff24DaysAgoIso = new Date(now.getTime() - 24 * 24 * 60 * 60 * 1000).toISOString();

  const { results: pastCitas } = await env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre, s.categoria AS servicio_categoria
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     WHERE c.estado = 'CONFIRMADA'
       AND c.fecha_hora_inicio >= ?1
       AND c.fecha_hora_inicio <= ?2
     ORDER BY c.fecha_hora_inicio DESC`
  )
    .bind(cutoff35DaysAgoIso, cutoff24DaysAgoIso)
    .all<CitaConServicioRow>();

  let sentMaintenanceNails25dCount = 0;
  let sentMaintenanceHair30dCount = 0;
  const webUrl = env.DASHBOARD_URL || 'https://spa-superlook.vercel.app';

  for (const pastCita of pastCitas || []) {
    const cleanPhone = (pastCita.cliente_telefono || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone === '0000000000') continue;

    const fullPhone =
      cleanPhone.length === 10 && cleanPhone.startsWith('3') ? `57${cleanPhone}` : cleanPhone;
    const cadence = detectMaintenanceCadence(
      pastCita.servicio_categoria,
      pastCita.servicio_nombre
    );
    if (!cadence) continue;

    const daysSinceCita =
      (now.getTime() - new Date(pastCita.fecha_hora_inicio).getTime()) / (1000 * 60 * 60 * 24);

    // Enviar exactamente al cumplir los 25 días (uñas) o 30 días (cabello), con ventana de 2 días de tolerancia
    if (daysSinceCita < cadence.days || daysSinceCita > cadence.days + 2) {
      continue;
    }

    // Verificar idempotencia en chat_sesiones.memory.mantenimientos_enviados
    const existingSession = await env.DB.prepare(
      'SELECT telefono, historial_json, updated_at FROM chat_sesiones WHERE telefono = ?1'
    )
      .bind(fullPhone)
      .first<ChatSesionRow>();

    const session = parseChatSession(existingSession?.historial_json);
    const alreadySent = session.memory.mantenimientos_enviados || [];
    if (alreadySent.includes(pastCita.id)) {
      continue;
    }

    const servicioNombre = pastCita.servicio_nombre || `Servicio #${pastCita.servicio_id}`;
    const emoji = cadence.type === 'UNAS' ? '💅✨' : '💇‍♀️✨';
    const fallbackMaintenanceText =
      `${emoji} *¡Hola ${pastCita.cliente_nombre}! Recordatorio de Mantenimiento · ${NOMBRE_OFICIAL_NEGOCIO}*\n\n` +
      `Ya pasaron *${cadence.days} días* desde tu cita de *${servicioNombre}* y es el momento ideal para realizar tu mantenimiento de ${cadence.label} 🌸.\n\n` +
      `¿Te gustaría confirmar tu mantenimiento? Solo respóndeme *"Sí"* junto con el día y hora que prefieres (o agenda directo en ${webUrl}) y te dejo tu turno listo al instante 💖.`;

    const sendRes = await sendWhatsAppTemplate(
      env,
      fullPhone,
      'recordatorio_mantenimiento',
      [
        pastCita.cliente_nombre,
        String(cadence.days),
        servicioNombre,
        webUrl,
      ],
      'es_CO',
      fallbackMaintenanceText
    );

    if (sendRes.ok) {
      // Guardar en memoria persistente y en el historial para que el Bot sepa exactamente qué mantenimiento está confirmando la clienta al responder "Sí"
      session.memory.cliente_nombre = pastCita.cliente_nombre;
      session.memory.servicio_id = pastCita.servicio_id;
      session.memory.servicio_nombre = servicioNombre;
      session.memory.notas = `Mantenimiento de ${cadence.days} días (${servicioNombre})`;
      session.memory.mantenimientos_enviados = [...alreadySent, pastCita.id];

      session.turns.push({
        role: 'model',
        text: fallbackMaintenanceText,
        sender: 'bot',
        timestamp: nowIso,
      });
      if (session.turns.length > 24) {
        session.turns = session.turns.slice(session.turns.length - 24);
      }

      await env.DB.prepare(
        `INSERT INTO chat_sesiones (telefono, historial_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(telefono) DO UPDATE SET
           historial_json = excluded.historial_json,
           updated_at = excluded.updated_at`
      )
        .bind(fullPhone, JSON.stringify(session), nowIso)
        .run();

      if (env.ADMIN_PHONE) {
        await sendWhatsAppText(
          env,
          env.ADMIN_PHONE,
          `🔄 *[${NOMBRE_OFICIAL_NEGOCIO} - Recordatorio de Mantenimiento ${cadence.days} días Enviado]*\n` +
            `• Cliente: ${pastCita.cliente_nombre} (+${fullPhone})\n` +
            `• Servicio: ${servicioNombre}\n` +
            `• Si confirma por chat, el Bot le agendará automáticamente.`
        );
      }

      if (cadence.type === 'UNAS') {
        sentMaintenanceNails25dCount++;
      } else {
        sentMaintenanceHair30dCount++;
      }
    }
  }

  return {
    checkedCount: citas.length,
    sent24hCount,
    sent2hCount,
    sentMaintenanceNails25dCount,
    sentMaintenanceHair30dCount,
  };
}


import {
  CitaConServicioRow,
  Env,
  formatCOP,
  NOMBRE_OFICIAL_NEGOCIO,
} from '../types';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../services/whatsapp';
import { buildClientCitaUrl } from '../services/security';

export interface RemindersExecutionSummary {
  checkedCount: number;
  sent24hCount: number;
  sent2hCount: number;
}

const UBICACION_ATENCION =
  'Transversal 86A #83A-30 · Spa Superlook (Atención exclusiva con reserva previa)';

/**
 * Ejecuta la tarea programada (Cron Trigger cada hora) para enviar recordatorios
 * automáticos de 24 horas y 2 horas a citas en estado CONFIRMADA.
 */
export async function processScheduledReminders(
  env: Env
): Promise<RemindersExecutionSummary> {
  const now = new Date();
  const nowIso = now.toISOString();
  const in25HoursIso = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre
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
        `📍 *Modalidad:* ${UBICACION_ATENCION}\n` +
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
          `🔔 *[${NOMBRE_OFICIAL_NEGOCIO} - Cita en 2h]*\nClienta: ${cita.cliente_nombre} (${cita.cliente_telefono})\nServicio: ${servicioNombre}\nInicio: ${cita.fecha_hora_inicio}\nID Cita: ${cita.id}`
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
        `📍 *Modalidad:* ${UBICACION_ATENCION}\n` +
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
          `📅 *[${NOMBRE_OFICIAL_NEGOCIO} - Recordatorio 24h Enviado]*\nClienta: ${cita.cliente_nombre} (${cita.cliente_telefono})\nServicio: ${servicioNombre}\nInicio: ${cita.fecha_hora_inicio}\nID Cita: ${cita.id}`
        );
      }

      await env.DB.prepare('UPDATE citas SET recordatorio_24h = 1 WHERE id = ?1')
        .bind(cita.id)
        .run();

      sent24hCount++;
    }
  }

  return {
    checkedCount: citas.length,
    sent24hCount,
    sent2hCount,
  };
}

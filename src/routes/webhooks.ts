import { Hono } from 'hono';
import {
  CitaConServicioRow,
  Env,
  formatCOP,
  NOMBRE_OFICIAL_NEGOCIO,
  TEXTO_LEGAL_RETENCION_20,
} from '../types';
import {
  verifyWompiWebhookSignature,
  WompiWebhookPayload,
} from '../services/wompi';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../services/whatsapp';
import { handleIncomingWhatsAppMessage } from '../services/gemini-bot';
import {
  buildClientCitaUrl,
  verifyMetaWebhookSignature,
} from '../services/security';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /webhooks/wompi
 * REQUISITO 3D:
 * 1. Valida obligatoriamente la firma criptográfica `x-event-checksum` usando SHA-256 con WOMPI_EVENTS_SECRET
 *    (rechaza con 401 si falla o no está configurada).
 * 2. Actualización idempotente en D1: si la cita ya se encuentra en estado `CONFIRMADA`,
 *    no reenvía alertas duplicadas a la clienta ni al ADMIN_PHONE.
 */
webhookRoutes.post('/wompi', async (c) => {
  let payload: WompiWebhookPayload;
  try {
    payload = await c.req.json<WompiWebhookPayload>();
  } catch {
    return c.json({ ok: false, error: 'Payload JSON inválido' }, 400);
  }

  const headerChecksum =
    c.req.header('x-event-checksum') || c.req.header('X-Event-Checksum');

  const isValidSignature = await verifyWompiWebhookSignature(
    payload,
    headerChecksum,
    c.env.WOMPI_EVENTS_SECRET
  );

  if (!isValidSignature) {
    return c.json(
      { ok: false, error: 'Firma x-event-checksum inválida o no autorizada' },
      401
    );
  }

  if (payload.event !== 'transaction.updated' || !payload.data?.transaction) {
    return c.json({ ok: true, ignored: true, event: payload.event });
  }

  const tx = payload.data.transaction;
  const reference = tx.reference;

  const cita = await c.env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     WHERE c.wompi_reference = ?1`
  )
    .bind(reference)
    .first<CitaConServicioRow>();

  if (!cita) {
    return c.json(
      { ok: false, error: `No se encontró cita con wompi_reference=${reference}` },
      404
    );
  }

  if (tx.status === 'APPROVED') {
    // IDEMPOTENCIA: Si la cita ya fue confirmada en un intento previo del webhook, no duplicar alertas
    if (cita.estado === 'CONFIRMADA') {
      return c.json({
        ok: true,
        idempotent: true,
        cita_id: cita.id,
        estado: 'CONFIRMADA',
        transaction_id: tx.id,
        message: 'Evento ya procesado previamente; no se reenvían notificaciones duplicadas.',
      });
    }

    const updateRes = await c.env.DB.prepare(
      `UPDATE citas
       SET estado = 'CONFIRMADA',
           wompi_transaction_id = ?1,
           metodo_pago = ?2
       WHERE id = ?3 AND estado != 'CONFIRMADA'`
    )
      .bind(tx.id, tx.payment_method_type || 'WOMPI', cita.id)
      .run();

    // Si otra petición concurrente ya actualizó la fila a CONFIRMADA, salir sin duplicar mensajes
    if (updateRes.meta.changes === 0) {
      return c.json({
        ok: true,
        idempotent: true,
        cita_id: cita.id,
        estado: 'CONFIRMADA',
        transaction_id: tx.id,
      });
    }

    const servicioNombre = cita.servicio_nombre || `Servicio #${cita.servicio_id}`;
    const totalStr = formatCOP(cita.monto_total);
    const reembolso80Str = formatCOP(cita.monto_reembolso_80);
    const { url: linkGestionCita } = await buildClientCitaUrl(c.env, cita.id);

    const clientConfirmationText =
      `✅ *¡Pago Aprobado y Reserva Confirmada en ${NOMBRE_OFICIAL_NEGOCIO}!*\n\n` +
      `Hola *${cita.cliente_nombre}*, hemos recibido tu pago en Wompi.\n` +
      `• *Servicio:* ${servicioNombre}\n` +
      `• *Inicio:* ${cita.fecha_hora_inicio}\n` +
      `• *Total pagado (100%):* ${totalStr}\n` +
      `• *Ref. Wompi:* ${reference} (Tx: ${tx.id})\n` +
      `• *Ver o gestionar tu cita:* ${linkGestionCita}\n\n` +
      `📌 ${TEXTO_LEGAL_RETENCION_20} (Monto de reembolso 80%: ${reembolso80Str}).`;

    await sendWhatsAppTemplate(
      c.env,
      cita.cliente_telefono,
      'cita_confirmada',
      [
        cita.cliente_nombre,
        servicioNombre,
        cita.fecha_hora_inicio,
        totalStr,
        reembolso80Str,
      ],
      'es_CO',
      clientConfirmationText
    );

    if (c.env.ADMIN_PHONE) {
      const adminAlertText =
        `💰 *[${NOMBRE_OFICIAL_NEGOCIO} - Nueva Reserva Confirmada y Pagada]*\n` +
        `• ID Cita: ${cita.id}\n` +
        `• Clienta: ${cita.cliente_nombre} (${cita.cliente_telefono})\n` +
        `• Servicio: ${servicioNombre}\n` +
        `• Fecha/Hora: ${cita.fecha_hora_inicio}\n` +
        `• Pagado (100%): ${totalStr}\n` +
        `• Reembolso 80% si cancela: ${reembolso80Str}\n` +
        `• Transacción Wompi: ${tx.id} (${tx.payment_method_type || 'WOMPI'})`;

      await sendWhatsAppText(c.env, c.env.ADMIN_PHONE, adminAlertText);
    }

    return c.json({
      ok: true,
      cita_id: cita.id,
      estado: 'CONFIRMADA',
      transaction_id: tx.id,
    });
  }

  if (['DECLINED', 'VOIDED', 'ERROR'].includes(tx.status)) {
    await c.env.DB.prepare(
      `UPDATE citas
       SET estado = 'CANCELADA',
           wompi_transaction_id = ?1,
           metodo_pago = ?2
       WHERE id = ?3 AND estado = 'PENDIENTE_PAGO'`
    )
      .bind(tx.id, tx.payment_method_type || 'WOMPI', cita.id)
      .run();

    return c.json({
      ok: true,
      cita_id: cita.id,
      estado: 'CANCELADA',
      transaction_status: tx.status,
    });
  }

  return c.json({ ok: true, status: tx.status });
});

/**
 * GET /webhooks/whatsapp
 * Validación oficial de Meta Cloud API (hub.challenge).
 */
webhookRoutes.get('/whatsapp', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  if (mode === 'subscribe' && token && token === c.env.WHATSAPP_VERIFY_TOKEN) {
    return c.text(challenge || '', 200);
  }

  return c.text('Forbidden: WHATSAPP_VERIFY_TOKEN no coincide', 403);
});

interface MetaWhatsAppWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: {
            body: string;
          };
        }>;
      };
    }>;
  }>;
}

/**
 * POST /webhooks/whatsapp
 * REQUISITO 3D:
 * 1. Valida la firma `X-Hub-Signature-256` si `META_APP_SECRET` está configurado.
 * 2. Responde 200 OK de inmediato para evitar reintentos de Meta, delegando el procesamiento
 *    del bot Gemini a `c.executionCtx.waitUntil(...)`.
 */
webhookRoutes.post('/whatsapp', async (c) => {
  const rawBody = await c.req.text();

  if (c.env.META_APP_SECRET && c.env.META_APP_SECRET.trim() !== '') {
    const signatureHeader =
      c.req.header('X-Hub-Signature-256') || c.req.header('x-hub-signature-256');
    const isValidMetaSig = await verifyMetaWebhookSignature(
      rawBody,
      signatureHeader,
      c.env.META_APP_SECRET.trim()
    );
    if (!isValidMetaSig) {
      return c.json(
        { ok: false, error: 'Firma X-Hub-Signature-256 inválida o no autorizada' },
        401
      );
    }
  }

  let body: MetaWhatsAppWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWhatsAppWebhookBody;
  } catch {
    return c.json({ ok: false, error: 'Payload JSON inválido' }, 400);
  }

  const entries = body.entry || [];
  const incomingTasks: Array<{ from: string; text: string }> = [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const messages = change.value?.messages || [];
      for (const msg of messages) {
        if (msg.type === 'text' && msg.text?.body && msg.from) {
          incomingTasks.push({ from: msg.from, text: msg.text.body });
        }
      }
    }
  }

  const processAllMessages = async () => {
    for (const task of incomingTasks) {
      try {
        await handleIncomingWhatsAppMessage(c.env, task.from, task.text);
      } catch (err) {
        console.error(`Error procesando mensaje WhatsApp de ${task.from}:`, err);
      }
    }
  };

  // Ejecutar en background con waitUntil para responder 200 OK rápido a Meta
  try {
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(processAllMessages());
    } else {
      await processAllMessages();
    }
  } catch {
    await processAllMessages();
  }

  return c.json({
    ok: true,
    queued: incomingTasks.length,
  });
});

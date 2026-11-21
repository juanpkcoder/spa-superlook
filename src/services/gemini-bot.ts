import {
  ChatSesionRow,
  CitaRow,
  Env,
  formatCOP,
  MODALIDAD_ATENCION_RESERVA,
  NOMBRE_OFICIAL_NEGOCIO,
  ServicioRow,
  TEXTO_LEGAL_RETENCION_20,
} from '../types';
import { createWompiPaymentLink } from './wompi';
import { sendWhatsAppText } from './whatsapp';
import { buildClientCitaUrl } from './security';

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

interface GeminiCandidatePart {
  text?: string;
  functionCall?: GeminiFunctionCall;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiCandidatePart[];
    };
  }>;
}

/**
 * Calcula los bloques horarios disponibles en una fecha dada (YYYY-MM-DD)
 * filtrando citas en estado CONFIRMADA o PENDIENTE_PAGO creadas hace menos de 20 minutos.
 * Spa Superlook trabaja ÚNICAMENTE bajo reserva previa; la disponibilidad depende de las citas
 * ya reservadas en D1 dentro de la franja operativa de agendamiento.
 */
export async function calcularBloquesDisponibles(
  db: D1Database,
  fechaYmd: string,
  duracionMinutos: number
): Promise<string[]> {
  const dayStart = `${fechaYmd}T00:00:00.000Z`;
  const dayEnd = `${fechaYmd}T23:59:59.999Z`;
  const cutoff20MinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  const { results: citasOcupadas } = await db
    .prepare(
      `SELECT fecha_hora_inicio, fecha_hora_fin, estado, created_at
       FROM citas
       WHERE fecha_hora_inicio <= ?1
         AND fecha_hora_fin >= ?2
         AND (
           estado = 'CONFIRMADA'
           OR (estado = 'PENDIENTE_PAGO' AND created_at > ?3)
         )`
    )
    .bind(dayEnd, dayStart, cutoff20MinAgo)
    .all<Pick<CitaRow, 'fecha_hora_inicio' | 'fecha_hora_fin' | 'estado' | 'created_at'>>();

  // Franja operativa para agendar reservas previas en Colombia (08:00 a 18:00 hora local -05:00)
  const openHour = 8;
  const closeHour = 18;
  const stepMinutes = 30;
  const bloquesDisponibles: string[] = [];

  for (let mins = openHour * 60; mins + duracionMinutos <= closeHour * 60; mins += stepMinutes) {
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const slotStartIso = new Date(`${fechaYmd}T${hh}:${mm}:00-05:00`).toISOString();
    const slotStartMs = new Date(slotStartIso).getTime();
    const slotEndMs = slotStartMs + duracionMinutos * 60 * 1000;

    const hayCruce = (citasOcupadas || []).some((cita) => {
      const cStart = new Date(cita.fecha_hora_inicio).getTime();
      const cEnd = new Date(cita.fecha_hora_fin).getTime();
      return slotStartMs < cEnd && cStart < slotEndMs;
    });

    if (!hayCruce) {
      bloquesDisponibles.push(`${hh}:${mm}`);
    }
  }

  return bloquesDisponibles;
}

/**
 * Ejecuta las herramientas (Function Calling) invocadas por Gemini.
 */
async function executeBotTool(
  env: Env,
  fromPhone: string,
  call: GeminiFunctionCall
): Promise<Record<string, unknown>> {
  if (call.name === 'listar_servicios') {
    const { results } = await env.DB.prepare(
      'SELECT id, categoria, nombre, descripcion, duracion_minutos, precio_cop FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
    ).all<ServicioRow>();

    return {
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      modalidad_atencion: MODALIDAD_ATENCION_RESERVA,
      servicios: (results || []).map((s) => ({
        id: s.id,
        categoria: s.categoria || 'General',
        nombre: s.nombre,
        descripcion: s.descripcion,
        duracion_minutos: s.duracion_minutos,
        precio_cop: s.precio_cop,
        precio_formateado: formatCOP(s.precio_cop),
        retencion_20_por_cancelacion: formatCOP(s.precio_cop - Math.round(s.precio_cop * 0.8)),
        reembolso_80_por_cancelacion: formatCOP(Math.round(s.precio_cop * 0.8)),
      })),
      politica_cancelacion: TEXTO_LEGAL_RETENCION_20,
    };
  }

  if (call.name === 'consultar_disponibilidad') {
    const fecha = String(call.args.fecha || new Date().toISOString().slice(0, 10));
    const servicioId = Number(call.args.servicio_id || 1);

    const servicio = await env.DB.prepare(
      'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE id = ?1 AND activo = 1'
    )
      .bind(servicioId)
      .first<ServicioRow>();

    const duracion = servicio?.duracion_minutos || 60;
    const horarios = await calcularBloquesDisponibles(env.DB, fecha, duracion);

    return {
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      modalidad_atencion: MODALIDAD_ATENCION_RESERVA,
      fecha,
      servicio: servicio?.nombre || 'Servicio general',
      duracion_minutos: duracion,
      horarios_disponibles: horarios,
    };
  }

  if (call.name === 'crear_reserva_con_pago') {
    const clienteNombre = String(call.args.cliente_nombre || 'Clienta WhatsApp').trim();
    const servicioId = Number(call.args.servicio_id || 1);
    const fechaHoraInicioRaw = String(call.args.fecha_hora_inicio || '').trim();

    const servicio = await env.DB.prepare(
      'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE id = ?1 AND activo = 1'
    )
      .bind(servicioId)
      .first<ServicioRow>();

    if (!servicio) {
      return { ok: false, error: 'El servicio solicitado no existe o no está activo en Spa Superlook.' };
    }

    const startDate = new Date(fechaHoraInicioRaw);
    if (Number.isNaN(startDate.getTime())) {
      return {
        ok: false,
        error: 'Formato de fecha_hora_inicio inválido. Usa ISO8601 con zona -05:00 (ej. 2026-11-22T10:00:00-05:00).',
      };
    }

    const fechaHoraInicioIso = startDate.toISOString();
    const fechaHoraFinIso = new Date(
      startDate.getTime() + servicio.duracion_minutos * 60 * 1000
    ).toISOString();
    const cutoff20MinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    // REQUISITO 3D: Verificar solapamiento de horarios justo antes de insertar en D1
    const conflicto = await env.DB.prepare(
      `SELECT id, estado FROM citas
       WHERE fecha_hora_inicio < ?1
         AND fecha_hora_fin > ?2
         AND (
           estado = 'CONFIRMADA'
           OR (estado = 'PENDIENTE_PAGO' AND created_at > ?3)
         )
       LIMIT 1`
    )
      .bind(fechaHoraFinIso, fechaHoraInicioIso, cutoff20MinAgo)
      .first<Pick<CitaRow, 'id' | 'estado'>>();

    if (conflicto) {
      return {
        ok: false,
        error:
          'El horario solicitado ya se encuentra reservado o en proceso de pago (bloqueo de 20 min). Por favor consulta disponibilidad y ofrece otro horario.',
      };
    }

    const citaId = crypto.randomUUID();
    const wompiReference = `SLK-${citaId.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const montoTotal = servicio.precio_cop;
    const montoReembolso80 = Math.round(montoTotal * 0.8);
    const montoRetencion20 = montoTotal - montoReembolso80;
    const createdAt = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO citas (
        id, cliente_nombre, cliente_telefono, servicio_id,
        fecha_hora_inicio, fecha_hora_fin, estado,
        monto_total, monto_reembolso_80, wompi_reference,
        recordatorio_24h, recordatorio_2h, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDIENTE_PAGO', ?7, ?8, ?9, 0, 0, ?10)`
    )
      .bind(
        citaId,
        clienteNombre,
        fromPhone,
        servicio.id,
        fechaHoraInicioIso,
        fechaHoraFinIso,
        montoTotal,
        montoReembolso80,
        wompiReference,
        createdAt
      )
      .run();

    // REQUISITO 3C: Enlace privado firmado con token HMAC exclusivo para esta cita
    const { url: linkGestionCita } = await buildClientCitaUrl(env, citaId);

    const paymentLink = await createWompiPaymentLink(env, {
      reference: wompiReference,
      amountCop: montoTotal,
      serviceName: servicio.nombre,
      customerName: clienteNombre,
      customerPhone: fromPhone,
      redirectUrl: linkGestionCita,
    });

    return {
      ok: true,
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      cita_id: citaId,
      servicio: servicio.nombre,
      fecha_hora_inicio: fechaHoraInicioIso,
      monto_total: formatCOP(montoTotal),
      monto_retencion_20: formatCOP(montoRetencion20),
      monto_reembolso_80: formatCOP(montoReembolso80),
      wompi_reference: wompiReference,
      payment_link: paymentLink.paymentUrl,
      link_gestion_cita: linkGestionCita,
      texto_legal: TEXTO_LEGAL_RETENCION_20,
    };
  }

  return { error: `Función desconocida: ${call.name}` };
}

/**
 * Procesa el mensaje entrante de WhatsApp utilizando Gemini con Function Calling
 * y persiste la sesión en la tabla `chat_sesiones` de D1.
 */
export async function handleIncomingWhatsAppMessage(
  env: Env,
  fromPhone: string,
  incomingText: string
): Promise<string> {
  // 1. Cargar historial de la sesión desde D1
  const existingSession = await env.DB.prepare(
    'SELECT telefono, historial_json, updated_at FROM chat_sesiones WHERE telefono = ?1'
  )
    .bind(fromPhone)
    .first<ChatSesionRow>();

  let history: ChatTurn[] = [];
  if (existingSession?.historial_json) {
    try {
      history = JSON.parse(existingSession.historial_json) as ChatTurn[];
    } catch {
      history = [];
    }
  }

  history.push({ role: 'user', text: incomingText });
  if (history.length > 12) {
    history = history.slice(history.length - 12);
  }

  let replyText = '';

  // 2. Si GEMINI_API_KEY está configurada, usar Gemini 2.5 Flash con Function Calling
  if (env.GEMINI_API_KEY) {
    try {
      const todayBogota = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const systemInstruction = `Eres la asistente virtual oficial de "${NOMBRE_OFICIAL_NEGOCIO}" en Colombia.
Fecha actual de referencia (Colombia UTC-5): ${todayBogota}.

DATOS Y REGLAS OBLIGATORIAS DEL NEGOCIO:
1. Nombre oficial: ${NOMBRE_OFICIAL_NEGOCIO}.
2. Modalidad de atención: Atendemos ÚNICAMENTE bajo reserva previa confirmada. NO trabajamos con horario fijo de atención al público sin cita; la disponibilidad depende exclusivamente de los espacios libres respecto a las citas ya reservadas en el sistema dentro de nuestra franja operativa de agendamiento. Si una clienta pregunta por el horario de atención o si puede ir sin cita, explícale amablemente que atendemos únicamente con reserva previa y ofrécele consultar los bloques disponibles para el día que desee.
3. Pago anticipado y bloqueo: Toda reserva requiere el pago anticipado del 100% mediante el link seguro de Wompi. Al crear la reserva en estado PENDIENTE_PAGO, el horario se bloquea por 20 minutos para que complete el pago.
4. Política obligatoria de cancelación (DEBES informarla siempre al cotizar o crear una reserva): En caso de cancelación, ${NOMBRE_OFICIAL_NEGOCIO} reembolsa el 80% del valor pagado y retiene el 20% por gastos administrativos y reserva de agenda (${TEXTO_LEGAL_RETENCION_20}).
5. Enlace seguro de la cita: Cuando ejecutes \`crear_reserva_con_pago\`, entrégale siempre a la clienta tanto el \`payment_link\` de Wompi como su enlace privado firmado \`link_gestion_cita\` para que pueda ver el estado o cancelar únicamente su reserva.
6. Responde siempre en español cálido, profesional, claro y conciso para WhatsApp.`;

      const toolsDeclaration = [
        {
          functionDeclarations: [
            {
              name: 'listar_servicios',
              description:
                'Devuelve el catálogo de servicios activos de Spa Superlook con categoría, precios en COP, duración y cálculo del 80% de reembolso.',
            },
            {
              name: 'consultar_disponibilidad',
              description:
                'Consulta los bloques horarios disponibles bajo reserva previa para una fecha (YYYY-MM-DD) y un servicio_id.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  fecha: { type: 'STRING', description: 'Fecha en formato YYYY-MM-DD' },
                  servicio_id: { type: 'INTEGER', description: 'ID numérico del servicio' },
                },
                required: ['fecha', 'servicio_id'],
              },
            },
            {
              name: 'crear_reserva_con_pago',
              description:
                'Verifica que no exista solapamiento, crea la cita en estado PENDIENTE_PAGO, genera el link de pago en Wompi y devuelve el link privado firmado de la cita.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  cliente_nombre: { type: 'STRING', description: 'Nombre completo de la clienta' },
                  servicio_id: { type: 'INTEGER', description: 'ID numérico del servicio elegido' },
                  fecha_hora_inicio: {
                    type: 'STRING',
                    description:
                      'Fecha y hora de inicio en formato ISO8601 con zona -05:00 (ej. 2026-11-22T10:00:00-05:00)',
                  },
                },
                required: ['cliente_nombre', 'servicio_id', 'fecha_hora_inicio'],
              },
            },
          ],
        },
      ];

      const contents: Array<Record<string, unknown>> = history.map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      }));

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

      const firstRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          tools: toolsDeclaration,
        }),
      });

      if (firstRes.ok) {
        const firstJson = (await firstRes.json()) as GeminiResponse;
        const firstParts = firstJson.candidates?.[0]?.content?.parts || [];
        const fnCallPart = firstParts.find((p) => p.functionCall);

        if (fnCallPart?.functionCall) {
          const toolResult = await executeBotTool(env, fromPhone, fnCallPart.functionCall);

          contents.push({
            role: 'model',
            parts: [{ functionCall: fnCallPart.functionCall }],
          });
          contents.push({
            role: 'function',
            parts: [
              {
                functionResponse: {
                  name: fnCallPart.functionCall.name,
                  response: toolResult,
                },
              },
            ],
          });

          const secondRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents,
              tools: toolsDeclaration,
            }),
          });

          if (secondRes.ok) {
            const secondJson = (await secondRes.json()) as GeminiResponse;
            replyText =
              secondJson.candidates?.[0]?.content?.parts
                ?.map((p) => p.text || '')
                .join('\n')
                .trim() || '';
          }
        } else {
          replyText = firstParts
            .map((p) => p.text || '')
            .join('\n')
            .trim();
        }
      }
    } catch (err) {
      console.error('Error en llamada a Gemini API:', err);
    }
  }

  // 3. Fallback local determinístico si GEMINI_API_KEY no está definida o falla la red
  if (!replyText) {
    const { results: servicios } = await env.DB.prepare(
      'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
    ).all<ServicioRow>();

    const listado = (servicios || [])
      .map(
        (s) =>
          `• *${s.id}. [${s.categoria || 'General'}] ${s.nombre}* (${s.duracion_minutos} min) — ${formatCOP(s.precio_cop)} (Reembolso 80% si cancelas: ${formatCOP(Math.round(s.precio_cop * 0.8))})`
      )
      .join('\n');

    replyText =
      `✨ *¡Hola! Bienvenida a ${NOMBRE_OFICIAL_NEGOCIO}* ✨\n\n` +
      `🗓️ *Modalidad de atención:* Atendemos *ÚNICAMENTE bajo reserva previa* (no manejamos atención sin cita previa; tu cupo se agenda según los bloques disponibles).\n\n` +
      `Estos son nuestros servicios activos:\n${listado}\n\n` +
      `📌 *${TEXTO_LEGAL_RETENCION_20}*\n\n` +
      `Indícanos tu nombre, qué servicio deseas y para qué fecha/hora para verificar disponibilidad y generarte tu link de pago en Wompi.`;
  }

  // 4. Guardar historial actualizado en D1 (`chat_sesiones`)
  history.push({ role: 'model', text: replyText });
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO chat_sesiones (telefono, historial_json, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(telefono) DO UPDATE SET
       historial_json = excluded.historial_json,
       updated_at = excluded.updated_at`
  )
    .bind(fromPhone, JSON.stringify(history), nowIso)
    .run();

  // 5. Enviar respuesta al cliente por WhatsApp Cloud API
  await sendWhatsAppText(env, fromPhone, replyText);

  return replyText;
}

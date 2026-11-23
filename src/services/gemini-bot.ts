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
import { createBoldPaymentLink } from './bold';
import { sendWhatsAppText } from './whatsapp';
import { buildClientCitaUrl } from './security';

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
  sender?: 'client' | 'bot' | 'admin';
  timestamp?: string;
}

export interface StoredChatSession {
  turns: ChatTurn[];
  human_takeover: boolean;
}

export function parseChatSession(rawJson: string | null | undefined): StoredChatSession {
  if (!rawJson) return { turns: [], human_takeover: false };
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      return { turns: parsed as ChatTurn[], human_takeover: false };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        turns: Array.isArray(parsed.turns) ? (parsed.turns as ChatTurn[]) : [],
        human_takeover: Boolean(parsed.human_takeover),
      };
    }
  } catch {
    // JSON corrupto: reiniciar sesión segura
  }
  return { turns: [], human_takeover: false };
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
 * ya reservadas en D1 / Supabase dentro de la franja operativa de agendamiento.
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
 * Envía una alerta estructurada al WhatsApp personal de Mamá (ADMIN_PHONE)
 * cuando una clienta solicita cotizar un diseño de uñas, colorimetría, cabello o servicio especial.
 */
export async function sendQuoteAlertToAdmin(
  env: Env,
  params: {
    origen: 'WhatsApp Bot' | 'Página Web';
    clienteNombre: string;
    clienteTelefono: string;
    categoria: string;
    descripcionDiseno: string;
    estimadoOrientativo?: string;
    fechaTentativa?: string;
  }
): Promise<{ ok: boolean }> {
  const cleanPhone = (params.clienteTelefono || '').replace(/\D/g, '');
  const fullPhone =
    cleanPhone.length === 10 && cleanPhone.startsWith('3') ? `57${cleanPhone}` : cleanPhone;
  const waDirectLink = fullPhone ? `https://wa.me/${fullPhone}` : 'No proporcionado';

  const adminMsg =
    `💅✨ *[${NOMBRE_OFICIAL_NEGOCIO} - Nueva Cotización de Diseño / Servicio]*\n` +
    `• *Origen:* ${params.origen}\n` +
    `• *Clienta:* ${params.clienteNombre}\n` +
    `• *WhatsApp:* ${fullPhone ? '+' + fullPhone : 'No indicado'}\n` +
    `• *Responder directo:* ${waDirectLink}\n` +
    `• *Categoría:* ${params.categoria}\n` +
    `• *Detalle / Diseño solicitado:* ${params.descripcionDiseno}\n` +
    (params.fechaTentativa ? `• *Fecha tentativa:* ${params.fechaTentativa}\n` : '') +
    (params.estimadoOrientativo ? `• *Referencia catálogo:* ${params.estimadoOrientativo}\n` : '') +
    `\n💡 Puedes responderle directo desde tu Panel Privado (${env.DASHBOARD_URL || 'https://spa-superlook.vercel.app'}/?admin=1) o tocando el enlace de WhatsApp.`;

  if (env.ADMIN_PHONE) {
    await sendWhatsAppText(env, env.ADMIN_PHONE, adminMsg);
  }
  return { ok: true };
}

/**
 * Ejecuta las herramientas (Function Calling) invocadas por Gemini tanto desde WhatsApp como desde la Web.
 */
async function executeBotTool(
  env: Env,
  fromPhone: string,
  origin: 'WhatsApp Bot' | 'Página Web',
  call: GeminiFunctionCall
): Promise<Record<string, unknown>> {
  if (call.name === 'listar_servicios') {
    const { results } = await env.DB.prepare(
      'SELECT id, categoria, nombre, descripcion, duracion_minutos, precio_cop FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
    ).all<ServicioRow>();

    return {
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      web_oficial: env.DASHBOARD_URL || 'https://spa-superlook.vercel.app',
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

  if (call.name === 'solicitar_cotizacion_personalizada') {
    const clienteNombre = String(call.args.cliente_nombre || 'Clienta interesada').trim();
    const telefonoArgs = String(call.args.cliente_telefono || fromPhone || '').replace(/\D/g, '');
    const categoria = String(call.args.categoria || 'Diseño Personalizado').trim();
    const descripcionDiseno = String(call.args.descripcion_diseno || '').trim();
    const fechaTentativa = call.args.fecha_tentativa ? String(call.args.fecha_tentativa).trim() : '';
    const estimadoOrientativo = call.args.estimado_orientativo
      ? String(call.args.estimado_orientativo).trim()
      : '';

    if (!descripcionDiseno) {
      return {
        ok: false,
        error: 'Pídele a la clienta los detalles del diseño de uñas o trabajo en el cabello (largo, tono, técnica o estilo) antes de enviar la cotización.',
      };
    }

    await sendQuoteAlertToAdmin(env, {
      origen: origin,
      clienteNombre,
      clienteTelefono: telefonoArgs,
      categoria,
      descripcionDiseno,
      estimadoOrientativo,
      fechaTentativa,
    });

    return {
      ok: true,
      especialista_notificada: true,
      mensaje_confirmacion:
        'Solicitud de cotización enviada con éxito a nuestra especialista de Spa Superlook. Ella revisará los detalles de tu diseño y te confirmará el valor exacto muy pronto.',
      web_citas: env.DASHBOARD_URL || 'https://spa-superlook.vercel.app',
    };
  }

  if (call.name === 'crear_reserva_con_pago') {
    const clienteNombre = String(call.args.cliente_nombre || 'Clienta Spa Superlook').trim();
    const clienteTelefono = String(call.args.cliente_telefono || fromPhone || '').replace(/\D/g, '');
    const servicioId = Number(call.args.servicio_id || 1);
    const fechaHoraInicioRaw = String(call.args.fecha_hora_inicio || '').trim();

    if (!clienteTelefono || clienteTelefono.length < 10) {
      return {
        ok: false,
        error: 'Necesito el número de WhatsApp de la clienta (10 dígitos en Colombia) para emitir su ticket oficial y enviarle el link de pago.',
      };
    }

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

    // REQUISITO 3D: Verificar solapamiento de horarios justo antes de insertar en D1/Supabase
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
        clienteTelefono,
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

    const useBold = Boolean(env.BOLD_IDENTITY_KEY);
    const paymentLink = useBold
      ? await createBoldPaymentLink(env, {
          reference: wompiReference,
          amountCop: montoTotal,
          serviceName: servicio.nombre,
          customerName: clienteNombre,
          customerPhone: clienteTelefono,
          redirectUrl: linkGestionCita,
        })
      : await createWompiPaymentLink(env, {
          reference: wompiReference,
          amountCop: montoTotal,
          serviceName: servicio.nombre,
          customerName: clienteNombre,
          customerPhone: clienteTelefono,
          redirectUrl: linkGestionCita,
        });

    const finalReference = paymentLink.reference || wompiReference;
    if (finalReference !== wompiReference || useBold) {
      await env.DB.prepare(
        `UPDATE citas SET wompi_reference = ?1, metodo_pago = ?2 WHERE id = ?3`
      )
        .bind(finalReference, useBold ? 'BOLD' : 'WOMPI', citaId)
        .run();
    }

    return {
      ok: true,
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      pasarela: useBold ? 'Bold' : 'Wompi',
      cita_id: citaId,
      servicio: servicio.nombre,
      fecha_hora_inicio: fechaHoraInicioIso,
      monto_total: formatCOP(montoTotal),
      monto_retencion_20: formatCOP(montoRetencion20),
      monto_reembolso_80: formatCOP(montoReembolso80),
      wompi_reference: finalReference,
      payment_link: paymentLink.paymentUrl,
      link_gestion_cita: linkGestionCita,
      texto_legal: TEXTO_LEGAL_RETENCION_20,
    };
  }

  return { error: `Función desconocida: ${call.name}` };
}

function buildSystemInstruction(env: Env, origin: 'WhatsApp Bot' | 'Página Web'): string {
  const todayBogota = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const webUrl = env.DASHBOARD_URL || 'https://spa-superlook.vercel.app';

  return `Eres **Superlook Concierge**, la anfitriona y asesora virtual oficial de **"${NOMBRE_OFICIAL_NEGOCIO}"** en Colombia ✨🌸.
Canal actual de conversación: ${origin}.
Fecha actual de referencia (Colombia UTC-5): ${todayBogota}.
Web oficial de citas (híbrida y sincronizada en tiempo real con este chat): ${webUrl}.

TU PERSONALIDAD Y ESTILO DE SALUDO:
- Eres cálida, cercana, elegante, empática y con el encanto acogedor de un spa boutique colombiano.
- Cuando te saluden por primera vez (ej. "Hola", "Buenas", "Info"), da una bienvenida memorable, amable y llena de energía positiva (ej: "¡Hola hermosa! ✨ Qué alegría saludarte, bienvenida a *Spa Superlook* 🌸💇‍♀️💅") y presenta de forma clara y ordenada cómo puedes consentirla hoy:
  1) Ver el catálogo de servicios y precios 💅
  2) Agendar tu cita directamente por aquí (y queda subida al instante en nuestra agenda oficial) o si prefieres desde nuestra web ${webUrl} 🗓️
  3) Cotizar un diseño personalizado de uñas, balayage, tintura, keratina o arreglo especial para el cabello 🎨✨
- Usa emojis con buen gusto (sin exagerar), frases claras y párrafos cortos fáciles de leer en celular.

REGLAS OBLIGATORIAS DEL NEGOCIO:
1. Nombre oficial: ${NOMBRE_OFICIAL_NEGOCIO}.
2. Modalidad híbrida y solo bajo reserva previa: Atendemos ÚNICAMENTE bajo reserva previa confirmada (no trabajamos sin cita). Todo lo que agendes por este chat se sincroniza al instante con nuestra plataforma web (${webUrl}) y viceversa.
3. Pago anticipado automático con Bold: Toda cita requiere el pago anticipado del 100% mediante el link seguro de pago en línea (Bold: Nequi, PSE, Bancolombia, Tarjetas y QR) que generas automáticamente con \`crear_reserva_con_pago\`. El bloqueo temporal dura 20 minutos mientras realiza el pago.
4. Política obligatoria de cancelación (DEBES informarla siempre al cotizar un servicio de catálogo o crear una reserva): En caso de cancelación, ${NOMBRE_OFICIAL_NEGOCIO} reembolsa el 80% del valor pagado y retiene el 20% por gastos administrativos y reserva de agenda (${TEXTO_LEGAL_RETENCION_20}).
5. COTIZACIONES PERSONALIZADAS DE UÑAS Y CABELLO:
   - Si una clienta quiere cotizar un diseño especial de uñas (acrílicas, press-on, semipermanente con diseño/pedrería, manicure ruso) o un trabajo para el cabello (balayage, iluminación, tintura, keratina, alisado, corte, peinado o maquillaje):
     a) Consulta primero \`listar_servicios\` para darle precios base de referencia si aplica.
     b) Pregúntale brevemente (si aún no lo dijo) los detalles clave para nuestra estilista: qué diseño o tono desea, largo/abundancia del cabello (o largo/técnica de uñas), su nombre y (si está en la web) su WhatsApp.
     c) Apenas tengas esos detalles (o si ya te los dio o envió una foto de referencia), llama INMEDIATAMENTE a \`solicitar_cotizacion_personalizada\` para avisar en tiempo real a nuestra especialista (dueña de Spa Superlook) por WhatsApp y darle una atención rápida y precisa!
6. Enlace seguro de la cita: Cuando ejecutes \`crear_reserva_con_pago\`, entrégale siempre tanto el \`payment_link\` automático de Bold como su enlace privado firmado \`link_gestion_cita\`.`;
}

function getToolsDeclaration() {
  return [
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
          name: 'solicitar_cotizacion_personalizada',
          description:
            'Envía una alerta inmediata por WhatsApp a la especialista/dueña de Spa Superlook cuando la clienta quiere cotizar un diseño personalizado de uñas, trabajo de colorimetría/balayage/cabello, keratina, maquillaje o servicio especial.',
          parameters: {
            type: 'OBJECT',
            properties: {
              cliente_nombre: { type: 'STRING', description: 'Nombre de la clienta' },
              cliente_telefono: {
                type: 'STRING',
                description: 'Número de WhatsApp de la clienta (10 dígitos o con 57)',
              },
              categoria: {
                type: 'STRING',
                description: 'Ej: Uñas & Nail Art, Cabello & Colorimetría, Alisados / Keratina, Maquillaje / Peinado, Facial / Spa',
              },
              descripcion_diseno: {
                type: 'STRING',
                description:
                  'Descripción detallada del diseño de uñas o procedimiento de cabello deseado (largo, tono, técnica, estado actual, etc.)',
              },
              estimado_orientativo: {
                type: 'STRING',
                description: 'Rango orientativo en COP basado en el catálogo si aplica (opcional)',
              },
              fecha_tentativa: {
                type: 'STRING',
                description: 'Fecha o jornada aproximada en que le gustaría agendar (opcional)',
              },
            },
            required: ['cliente_nombre', 'categoria', 'descripcion_diseno'],
          },
        },
        {
          name: 'crear_reserva_con_pago',
          description:
            'Verifica que no exista solapamiento, crea la cita en estado PENDIENTE_PAGO en la agenda híbrida, genera el link automático de pago en Bold y devuelve el link privado firmado de la cita.',
          parameters: {
            type: 'OBJECT',
            properties: {
              cliente_nombre: { type: 'STRING', description: 'Nombre completo de la clienta' },
              cliente_telefono: {
                type: 'STRING',
                description: 'WhatsApp de la clienta (requerido especialmente desde la web)',
              },
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
}

async function runGeminiConversation(
  env: Env,
  history: ChatTurn[],
  fromPhone: string,
  origin: 'WhatsApp Bot' | 'Página Web'
): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    return '';
  }

  try {
    const systemInstruction = buildSystemInstruction(env, origin);
    const toolsDeclaration = getToolsDeclaration();
    const contents: Array<Record<string, unknown>> = history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    }));

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

    // Soportar hasta 2 rondas de Function Calling (ej. listar_servicios -> consultar_disponibilidad o cotizar)
    for (let step = 0; step < 2; step++) {
      const res = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          tools: toolsDeclaration,
        }),
      });

      if (!res.ok) {
        console.error('Gemini API HTTP error:', res.status, await res.text());
        break;
      }

      const json = (await res.json()) as GeminiResponse;
      const parts = json.candidates?.[0]?.content?.parts || [];
      const fnCallPart = parts.find((p) => p.functionCall);

      if (fnCallPart?.functionCall) {
        const toolResult = await executeBotTool(env, fromPhone, origin, fnCallPart.functionCall);
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
        continue;
      }

      const textReply = parts
        .map((p) => p.text || '')
        .join('\n')
        .trim();
      if (textReply) {
        return textReply;
      }
      break;
    }
  } catch (err) {
    console.error('Error en llamada a Gemini API:', err);
  }

  return '';
}

async function buildFallbackGreeting(env: Env): Promise<string> {
  const { results: servicios } = await env.DB.prepare(
    'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
  ).all<ServicioRow>();

  const listado = (servicios || [])
    .map(
      (s) =>
        `• *${s.id}. [${s.categoria || 'General'}] ${s.nombre}* (${s.duracion_minutos} min) — ${formatCOP(s.precio_cop)}`
    )
    .join('\n');

  const webUrl = env.DASHBOARD_URL || 'https://spa-superlook.vercel.app';

  return (
    `✨ *¡Hola hermosa! Qué alegría saludarte, bienvenida a ${NOMBRE_OFICIAL_NEGOCIO}* 🌸💇‍♀️💅\n\n` +
    `Estamos listas para consentirte. Atendemos *ÚNICAMENTE bajo reserva previa* y puedes agendar aquí mismo por el chat o en nuestra web oficial (${webUrl}) — ¡todo queda sincronizado al instante!\n\n` +
    `📋 *Servicios destacados:*\n${listado}\n\n` +
    `🎨 ¿Quieres *cotizar un diseño de uñas o algo especial para tu cabello*? Cuéntame qué estilo tienes en mente (o envíame una foto de referencia) y le aviso de inmediato a nuestra especialista.\n\n` +
    `📌 *${TEXTO_LEGAL_RETENCION_20}*`
  );
}

/**
 * Procesa el mensaje entrante de WhatsApp utilizando Gemini con Function Calling
 * y persiste la sesión en la tabla `chat_sesiones` de D1 / Supabase.
 */
export async function handleIncomingWhatsAppMessage(
  env: Env,
  fromPhone: string,
  incomingText: string
): Promise<string> {
  const existingSession = await env.DB.prepare(
    'SELECT telefono, historial_json, updated_at FROM chat_sesiones WHERE telefono = ?1'
  )
    .bind(fromPhone)
    .first<ChatSesionRow>();

  const session = parseChatSession(existingSession?.historial_json);
  let history: ChatTurn[] = session.turns;
  const nowIso = new Date().toISOString();

  history.push({ role: 'user', text: incomingText, sender: 'client', timestamp: nowIso });
  if (history.length > 20) {
    history = history.slice(history.length - 20);
  }

  // Si Mamá activó control humano en este chat, guardar el mensaje para su bandeja y no responder con IA
  if (session.human_takeover) {
    await env.DB.prepare(
      `INSERT INTO chat_sesiones (telefono, historial_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(telefono) DO UPDATE SET
         historial_json = excluded.historial_json,
         updated_at = excluded.updated_at`
    )
      .bind(fromPhone, JSON.stringify({ turns: history, human_takeover: true }), nowIso)
      .run();

    return '[Modo atención humana activo: mensaje guardado en bandeja de Mamá]';
  }

  let replyText = await runGeminiConversation(env, history, fromPhone, 'WhatsApp Bot');
  if (!replyText) {
    replyText = await buildFallbackGreeting(env);
  }

  const replyIso = new Date().toISOString();
  history.push({ role: 'model', text: replyText, sender: 'bot', timestamp: replyIso });

  await env.DB.prepare(
    `INSERT INTO chat_sesiones (telefono, historial_json, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(telefono) DO UPDATE SET
       historial_json = excluded.historial_json,
       updated_at = excluded.updated_at`
  )
    .bind(fromPhone, JSON.stringify({ turns: history, human_takeover: false }), replyIso)
    .run();

  await sendWhatsAppText(env, fromPhone, replyText);

  return replyText;
}

/**
 * Procesa una conversación del Asistente IA directamente desde la Página Web (modo híbrido).
 * Comparte la misma inteligencia, catálogo, disponibilidad en vivo y alertas de cotización a Mamá.
 */
export async function handleWebChatMessage(
  env: Env,
  historyInput: ChatTurn[],
  userMessage: string,
  clientPhone = ''
): Promise<string> {
  const sanitizedHistory: ChatTurn[] = (Array.isArray(historyInput) ? historyInput : [])
    .slice(-10)
    .map((t) => ({
      role: t.role === 'model' ? 'model' : 'user',
      text: String(t.text || '').slice(0, 1200),
    }));

  sanitizedHistory.push({
    role: 'user',
    text: userMessage.slice(0, 1200),
  });

  let reply = await runGeminiConversation(env, sanitizedHistory, clientPhone, 'Página Web');
  if (!reply) {
    reply = await buildFallbackGreeting(env);
  }
  return reply;
}

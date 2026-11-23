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

export interface ChatMemory {
  cliente_nombre?: string;
  servicio_id?: number;
  servicio_nombre?: string;
  fecha_ymd?: string;
  hora_hhmm?: string;
  ultima_cita_id?: string;
  ultimo_payment_link?: string;
  ultimo_ticket_link?: string;
  notas?: string;
  mantenimientos_enviados?: string[];
}

export interface StoredChatSession {
  turns: ChatTurn[];
  human_takeover: boolean;
  memory: ChatMemory;
}

export function parseChatSession(rawJson: string | null | undefined): StoredChatSession {
  if (!rawJson) return { turns: [], human_takeover: false, memory: {} };
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      return { turns: parsed as ChatTurn[], human_takeover: false, memory: {} };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        turns: Array.isArray(parsed.turns) ? (parsed.turns as ChatTurn[]) : [],
        human_takeover: Boolean(parsed.human_takeover),
        memory:
          parsed.memory && typeof parsed.memory === 'object'
            ? (parsed.memory as ChatMemory)
            : {},
      };
    }
  } catch {
    // JSON corrupto: reiniciar sesión segura
  }
  return { turns: [], human_takeover: false, memory: {} };
}

interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

interface GeminiCandidatePart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: GeminiCandidatePart[];
    };
  }>;
}

/**
 * Construye el calendario exacto de los próximos 10 días en zona horaria Colombia (UTC-5)
 * para que Gemini jamás confunda qué día de la semana corresponde a "mañana", "lunes 23", etc.
 */
function buildColombiaCalendarContext(): string {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const nowBogotaMs = Date.now() - 5 * 60 * 60 * 1000;
  const nowDate = new Date(nowBogotaMs);
  const currentTimeStr = `${String(nowDate.getUTCHours()).padStart(2, '0')}:${String(nowDate.getUTCMinutes()).padStart(2, '0')}`;

  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(nowBogotaMs + i * 24 * 60 * 60 * 1000);
    const ymd = d.toISOString().slice(0, 10);
    const label = i === 0 ? 'HOY' : i === 1 ? 'MAÑANA' : `En ${i} días`;
    lines.push(
      `- ${label}: ${dias[d.getUTCDay()]} ${d.getUTCDate()} de ${meses[d.getUTCMonth()]} de ${d.getUTCFullYear()} (${ymd})`
    );
  }
  return `Hora actual en Colombia (UTC-5): ${currentTimeStr}\nCalendario oficial exacto:\n${lines.join('\n')}`;
}

/**
 * Calcula los bloques horarios disponibles en una fecha dada (YYYY-MM-DD)
 * filtrando citas en estado CONFIRMADA o PENDIENTE_PAGO creadas hace menos de 20 minutos.
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
 * cuando un cliente solicita cotizar un diseño de uñas, colorimetría, cabello o servicio especial.
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
    `• *Cliente:* ${params.clienteNombre}\n` +
    `• *WhatsApp:* ${fullPhone ? '+' + fullPhone : 'No indicado'}\n` +
    `• *Responder directo:* ${waDirectLink}\n` +
    `• *Categoría:* ${params.categoria}\n` +
    `• *Detalle / Diseño solicitado:* ${params.descripcionDiseno}\n` +
    (params.fechaTentativa ? `• *Fecha tentativa:* ${params.fechaTentativa}\n` : '') +
    (params.estimadoOrientativo ? `• *Referencia catálogo:* ${params.estimadoOrientativo}\n` : '') +
    `\n💡 Puedes responder directo desde tu Panel Privado (${env.DASHBOARD_URL || 'https://spa-superlook.vercel.app'}/?admin=1) o tocando el enlace de WhatsApp.`;

  if (env.ADMIN_PHONE) {
    await sendWhatsAppText(env, env.ADMIN_PHONE, adminMsg);
  }
  return { ok: true };
}

interface ToolExecutionContext {
  env: Env;
  fromPhone: string;
  origin: 'WhatsApp Bot' | 'Página Web';
  memory: ChatMemory;
  lastCreatedBooking?: {
    citaId: string;
    servicio: string;
    fechaHora: string;
    montoTotal: string;
    reembolso80: string;
    paymentLink: string;
    manageLink: string;
    pasarela: string;
  };
}

/**
 * Ejecuta las herramientas (Function Calling) invocadas por Gemini y actualiza la memoria estructurada.
 */
async function executeBotTool(
  ctx: ToolExecutionContext,
  call: GeminiFunctionCall
): Promise<Record<string, unknown>> {
  const { env, fromPhone, origin, memory } = ctx;

  if (call.name === 'guardar_memoria_reserva') {
    if (call.args.cliente_nombre) memory.cliente_nombre = String(call.args.cliente_nombre).trim();
    if (call.args.servicio_id) memory.servicio_id = Number(call.args.servicio_id);
    if (call.args.servicio_nombre) memory.servicio_nombre = String(call.args.servicio_nombre).trim();
    if (call.args.fecha_ymd) memory.fecha_ymd = String(call.args.fecha_ymd).trim();
    if (call.args.hora_hhmm) memory.hora_hhmm = String(call.args.hora_hhmm).trim();
    if (call.args.notas) memory.notas = String(call.args.notas).trim();
    return { ok: true, memory };
  }

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
    const fecha = String(call.args.fecha || memory.fecha_ymd || new Date().toISOString().slice(0, 10));
    const servicioId = Number(call.args.servicio_id || memory.servicio_id || 1);

    const servicio = await env.DB.prepare(
      'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE id = ?1 AND activo = 1'
    )
      .bind(servicioId)
      .first<ServicioRow>();

    memory.fecha_ymd = fecha;
    if (servicio) {
      memory.servicio_id = servicio.id;
      memory.servicio_nombre = servicio.nombre;
    }

    const duracion = servicio?.duracion_minutos || 60;
    const horarios = await calcularBloquesDisponibles(env.DB, fecha, duracion);

    return {
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      modalidad_atencion: MODALIDAD_ATENCION_RESERVA,
      fecha,
      servicio_id: servicio?.id || servicioId,
      servicio: servicio?.nombre || 'Servicio general',
      duracion_minutos: duracion,
      horarios_disponibles: horarios,
    };
  }

  if (call.name === 'solicitar_cotizacion_personalizada') {
    const clienteNombre = String(
      call.args.cliente_nombre || memory.cliente_nombre || 'Cliente interesado'
    ).trim();
    const telefonoArgs = String(call.args.cliente_telefono || fromPhone || '').replace(/\D/g, '');
    const categoria = String(call.args.categoria || 'Diseño Personalizado').trim();
    const descripcionDiseno = String(call.args.descripcion_diseno || '').trim();
    const fechaTentativa = call.args.fecha_tentativa
      ? String(call.args.fecha_tentativa).trim()
      : memory.fecha_ymd
        ? `${memory.fecha_ymd} ${memory.hora_hhmm || ''}`.trim()
        : '';
    const estimadoOrientativo = call.args.estimado_orientativo
      ? String(call.args.estimado_orientativo).trim()
      : '';

    if (clienteNombre && clienteNombre !== 'Cliente interesado') {
      memory.cliente_nombre = clienteNombre;
    }
    if (descripcionDiseno) {
      memory.notas = `${categoria}: ${descripcionDiseno}`.slice(0, 220);
    }

    if (!descripcionDiseno) {
      return {
        ok: false,
        error: 'Pide los detalles del diseño de uñas o trabajo de cabello antes de enviar la cotización.',
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
        'Solicitud de cotización enviada al WhatsApp de nuestra especialista de Spa Superlook. Te confirmará el precio exacto muy pronto.',
      web_citas: env.DASHBOARD_URL || 'https://spa-superlook.vercel.app',
    };
  }

  if (call.name === 'crear_reserva_con_pago') {
    const clienteNombre = String(
      call.args.cliente_nombre || memory.cliente_nombre || ''
    ).trim();
    const clienteTelefono = String(call.args.cliente_telefono || fromPhone || '').replace(/\D/g, '');
    const servicioId = Number(call.args.servicio_id || memory.servicio_id || 0);
    let fechaHoraInicioRaw = String(call.args.fecha_hora_inicio || '').trim();

    if (!fechaHoraInicioRaw && memory.fecha_ymd && memory.hora_hhmm) {
      fechaHoraInicioRaw = `${memory.fecha_ymd}T${memory.hora_hhmm}:00-05:00`;
    }

    if (!clienteNombre) {
      return { ok: false, error: 'Falta el nombre completo del cliente para emitir el ticket.' };
    }

    if (!clienteTelefono || clienteTelefono.length < 10) {
      return {
        ok: false,
        error: 'Falta el número de WhatsApp (10 dígitos en Colombia) para emitir el ticket y enviar el link de pago.',
      };
    }

    if (!servicioId) {
      return {
        ok: false,
        error: 'Debes elegir un servicio_id válido del catálogo activo para generar el link de pago automático.',
      };
    }

    const servicio = await env.DB.prepare(
      'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE id = ?1 AND activo = 1'
    )
      .bind(servicioId)
      .first<ServicioRow>();

    if (!servicio) {
      return { ok: false, error: 'El servicio_id solicitado no existe o no está activo en el catálogo.' };
    }

    // Asegurar zona horaria Colombia -05:00 si vino sin zona
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(fechaHoraInicioRaw)) {
      fechaHoraInicioRaw =
        fechaHoraInicioRaw.length === 16
          ? `${fechaHoraInicioRaw}:00-05:00`
          : `${fechaHoraInicioRaw}-05:00`;
    }

    const startDate = new Date(fechaHoraInicioRaw);
    if (Number.isNaN(startDate.getTime())) {
      return {
        ok: false,
        error: 'Formato de fecha_hora_inicio inválido. Usa YYYY-MM-DDTHH:mm:00-05:00 (ej. 2026-11-23T09:00:00-05:00).',
      };
    }

    // Actualizar memoria con los datos confirmados
    memory.cliente_nombre = clienteNombre;
    memory.servicio_id = servicio.id;
    memory.servicio_nombre = servicio.nombre;
    memory.fecha_ymd = fechaHoraInicioRaw.slice(0, 10);
    memory.hora_hhmm = fechaHoraInicioRaw.slice(11, 16);

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
      const alternativas = await calcularBloquesDisponibles(
        env.DB,
        memory.fecha_ymd,
        servicio.duracion_minutos
      );
      return {
        ok: false,
        error:
          'Ese horario acaba de ocuparse o está en proceso de pago (bloqueo de 20 min).',
        horarios_alternativos_ese_dia: alternativas,
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

    memory.ultima_cita_id = citaId;
    memory.ultimo_payment_link = paymentLink.paymentUrl;
    memory.ultimo_ticket_link = linkGestionCita;

    ctx.lastCreatedBooking = {
      citaId,
      servicio: servicio.nombre,
      fechaHora: `${memory.fecha_ymd} a las ${memory.hora_hhmm}`,
      montoTotal: formatCOP(montoTotal),
      reembolso80: formatCOP(montoReembolso80),
      paymentLink: paymentLink.paymentUrl,
      manageLink: linkGestionCita,
      pasarela: useBold ? 'Bold' : 'Wompi',
    };

    return {
      ok: true,
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      pasarela: useBold ? 'Bold' : 'Wompi',
      cita_id: citaId,
      servicio: servicio.nombre,
      fecha_hora_local: `${memory.fecha_ymd} ${memory.hora_hhmm} (Colombia)`,
      monto_total: formatCOP(montoTotal),
      monto_retencion_20: formatCOP(montoRetencion20),
      monto_reembolso_80: formatCOP(montoReembolso80),
      referencia_pago: finalReference,
      payment_link: paymentLink.paymentUrl,
      link_gestion_cita: linkGestionCita,
      texto_legal: TEXTO_LEGAL_RETENCION_20,
    };
  }

  return { error: `Función desconocida: ${call.name}` };
}

async function buildSystemInstruction(
  env: Env,
  origin: 'WhatsApp Bot' | 'Página Web',
  fromPhone: string,
  memory: ChatMemory
): Promise<string> {
  const webUrl = env.DASHBOARD_URL || 'https://spa-superlook.vercel.app';
  const calendarBlock = buildColombiaCalendarContext();

  // Inyectar el catálogo ACTIVO directamente en el prompt para evitar llamadas redundantes y errores de ID
  const { results: servicios } = await env.DB.prepare(
    'SELECT id, categoria, nombre, descripcion, duracion_minutos, precio_cop FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
  ).all<ServicioRow>();

  const catalogLines = (servicios || [])
    .map(
      (s) =>
        `  • ID=${s.id} | [${s.categoria || 'General'}] ${s.nombre} | ${s.duracion_minutos} min | ${formatCOP(s.precio_cop)} (Reembolso 80%: ${formatCOP(Math.round(s.precio_cop * 0.8))}) — ${s.descripcion}`
    )
    .join('\n');

  const memoryLines = [
    memory.cliente_nombre ? `- Nombre del cliente: ${memory.cliente_nombre}` : null,
    memory.servicio_id
      ? `- Servicio elegido: ID=${memory.servicio_id} (${memory.servicio_nombre || ''})`
      : null,
    memory.fecha_ymd ? `- Fecha solicitada: ${memory.fecha_ymd}` : null,
    memory.hora_hhmm ? `- Hora solicitada: ${memory.hora_hhmm}` : null,
    memory.notas ? `- Notas / Cotización: ${memory.notas}` : null,
    memory.ultimo_payment_link ? `- Último link de pago generado: ${memory.ultimo_payment_link}` : null,
  ].filter(Boolean);

  const phoneContext =
    origin === 'WhatsApp Bot' && fromPhone
      ? `TELÉFONO DEL CLIENTE YA CONOCIDO AUTOMÁTICAMENTE: +${fromPhone}. ¡PROHIBIDO pedirle su número de WhatsApp porque YA nos está escribiendo desde su WhatsApp!`
      : `CANAL WEB: Si el cliente aún no te dio su número de WhatsApp (10 dígitos en Colombia), pídeselo junto con su nombre al agendar o cotizar.`;

  return `Eres **Superlook Concierge**, la anfitriona y asesora virtual inteligente de **"${NOMBRE_OFICIAL_NEGOCIO}"** en Colombia ✨🌸.
Canal actual: ${origin}.
${phoneContext}

${calendarBlock}

CATÁLOGO ACTIVO REAL EN BASE DE DATOS (usa SIEMPRE estos IDs exactos para agendar):
${catalogLines || '  (Aún no hay servicios activos)'}

MEMORIA ACTUAL DE ESTA CONVERSACIÓN (NO vuelvas a pedir datos que YA están aquí o en el historial):
${memoryLines.length > 0 ? memoryLines.join('\n') : '- Aún no se han guardado datos de reserva.'}

PERSONALIDAD Y TONO:
- Cálida, elegante, servicial, directa y resolutiva.
- Usa un trato respetuoso y amable SIN asumir género ("¡Hola! ✨ Qué alegría saludarte...", "¡Perfecto, Wilman! ✨") a menos que el nombre o la conversación indique claramente género.
- En el PRIMER saludo únicamente, da una bienvenida encantadora presentando brevemente que puedes ayudarle a ver servicios, agendar aquí mismo (o en ${webUrl}) y cotizar diseños de uñas/cabello.
- En mensajes posteriores, **NUNCA repitas el saludo largo ni el menú inicial**: continúa la conversación con naturalidad, usando todo lo que ya te dijeron!

FLUJO INTELIGENTE DE RESERVA (SIGUE ESTO AL PIE DE LA LETRA):
1. Para crear una reserva con link automático de pago de **Bold** (crear_reserva_con_pago) solo necesitas 3 cosas en WhatsApp (o 4 en Web):
   - **Servicio del catálogo** (un servicio_id real del CATÁLOGO ACTIVO de arriba)
   - **Nombre del cliente**
   - **Fecha y hora exacta** (convertida con el CALENDARIO OFICIAL EXACTO a YYYY-MM-DDTHH:mm:00-05:00)
   - *(Solo si es Página Web: número de WhatsApp de 10 dígitos; en WhatsApp YA lo tienes en ${fromPhone}!)*
2. **NO HAGAS PREGUNTAS REPETIDAS NI INNECESARIAS**:
   - Apenas el cliente diga un dato (ej. su nombre, la fecha o la hora), recuérdalo usando la memoria y el historial. Si falta solo 1 dato (ej. solo falta la fecha o elegir el servicio), pregunta **únicamente por ese dato faltante** en 1 o 2 líneas!
   - Apenas tengas **Servicio del catálogo + Nombre + Fecha + Hora** (y teléfono), llama **DE INMEDIATO** a crear_reserva_con_pago en ese mismo turno (ella ya verifica solapamiento en la base de datos y te devuelve horarios alternativos si está ocupado, o el payment_link de **Bold** + link_gestion_cita si está libre!).
   - Cuando crear_reserva_con_pago devuelva ok: true, entrega SIEMPRE de forma súper clara:
     * Resumen del turno (Nombre, Servicio, Fecha/Hora, Valor 100%)
     * **Link de pago automático en Bold** (payment_link)
     * **Enlace privado de su ticket** (link_gestion_cita)
     * Recordatorio breve de bloqueo de 20 minutos y política obligatoria (80% reembolso / 20% retención).
3. **SERVICIOS PERSONALIZADOS QUE NO ESTÁN EN EL CATÁLOGO ACTUAL** (ej. uñas acrílicas con diseño, balayage, keratina, pedicura si aún no aparece en el catálogo de arriba):
   - Sé 100% honesta: dile claramente que ese diseño/servicio específico no tiene tarifa fija en el catálogo automático todavía y que se cotiza personalizado con nuestra especialista.
   - Si ya tienes su nombre y qué desea (y fecha/hora tentativa si la dio), llama **de una vez** a solicitar_cotizacion_personalizada para notificar a nuestra especialista al WhatsApp de Mamá, Y dile también qué servicios sí tenemos disponibles para agendar de inmediato con link de Bold por si quiere reservar alguno ya mismo.
4. **CONFIRMACIÓN DE MANTENIMIENTOS (25 DÍAS UÑAS / 30 DÍAS CABELLO)**:
   - Si el cliente responde "Sí", "Quiero agendar mi mantenimiento" o confirma después de un recordatorio de mantenimiento (25 días para manicura/pedicura o 30 días para cabello), revisa la MEMORIA ACTUAL (donde ya está su nombre y servicio) y pregúntale únicamente qué día y hora prefiere (si no lo dijo aún), o agenda de una vez con crear_reserva_con_pago para enviarle su link de pago de Bold. Si dice que no desea mantenimiento por ahora, agradécele amablemente y recuérdale que siempre estamos para atenderle cuando guste.
5. **Datos oficiales de Spa Superlook**:
   - Ubicación: Transversal 86A #83A-30 (atención ÚNICAMENTE bajo reserva previa).
   - Correo: juanpalook@gmail.com | Web: ${webUrl}
   - Política obligatoria de cancelación: Reembolso del 80% y retención del 20% por gastos administrativos y bloqueo de agenda.`;
}

function getToolsDeclaration() {
  return [
    {
      functionDeclarations: [
        {
          name: 'guardar_memoria_reserva',
          description:
            'Guarda en la memoria persistente de esta conversación cualquier dato parcial que el cliente acaba de dar (nombre, fecha, hora, servicio o notas) para recordarlo en turnos siguientes.',
          parameters: {
            type: 'OBJECT',
            properties: {
              cliente_nombre: { type: 'STRING', description: 'Nombre del cliente' },
              servicio_id: { type: 'INTEGER', description: 'ID del servicio del catálogo si ya eligió uno' },
              servicio_nombre: { type: 'STRING', description: 'Nombre del servicio' },
              fecha_ymd: { type: 'STRING', description: 'Fecha en formato YYYY-MM-DD' },
              hora_hhmm: { type: 'STRING', description: 'Hora en formato 24h HH:mm (ej. 09:00, 14:30)' },
              notas: { type: 'STRING', description: 'Notas o detalles de diseño' },
            },
          },
        },
        {
          name: 'consultar_disponibilidad',
          description:
            'Consulta los horarios libres en la agenda real para una fecha (YYYY-MM-DD) y un servicio_id del catálogo.',
          parameters: {
            type: 'OBJECT',
            properties: {
              fecha: { type: 'STRING', description: 'Fecha en formato YYYY-MM-DD' },
              servicio_id: { type: 'INTEGER', description: 'ID numérico del servicio del catálogo' },
            },
            required: ['fecha', 'servicio_id'],
          },
        },
        {
          name: 'crear_reserva_con_pago',
          description:
            'Verifica disponibilidad, crea la reserva oficial en la agenda híbrida (PENDIENTE_PAGO) y genera el Link de Pago automático de Bold + Ticket Privado. Llámala INMEDIATAMENTE apenas tengas cliente_nombre, servicio_id válido del catálogo y fecha_hora_inicio.',
          parameters: {
            type: 'OBJECT',
            properties: {
              cliente_nombre: { type: 'STRING', description: 'Nombre completo del cliente' },
              cliente_telefono: {
                type: 'STRING',
                description: 'WhatsApp del cliente (opcional en WhatsApp porque se toma automáticamente)',
              },
              servicio_id: { type: 'INTEGER', description: 'ID numérico exacto del servicio en el CATÁLOGO ACTIVO' },
              fecha_hora_inicio: {
                type: 'STRING',
                description:
                  'Fecha y hora exacta en formato ISO8601 con zona Colombia -05:00 (ej. 2026-11-23T09:00:00-05:00)',
              },
            },
            required: ['cliente_nombre', 'servicio_id', 'fecha_hora_inicio'],
          },
        },
        {
          name: 'solicitar_cotizacion_personalizada',
          description:
            'Envía alerta inmediata al WhatsApp de la especialista/dueña de Spa Superlook cuando el cliente quiere cotizar un diseño de uñas, balayage, tintura, keratina o servicio que aún no tiene tarifa fija en el catálogo.',
          parameters: {
            type: 'OBJECT',
            properties: {
              cliente_nombre: { type: 'STRING', description: 'Nombre del cliente' },
              cliente_telefono: { type: 'STRING', description: 'WhatsApp del cliente (automático en WhatsApp)' },
              categoria: { type: 'STRING', description: 'Categoría (ej. Uñas, Cabello, Pedicura, Colorimetría)' },
              descripcion_diseno: { type: 'STRING', description: 'Detalle del servicio o diseño solicitado' },
              estimado_orientativo: { type: 'STRING', description: 'Referencia de precio si aplica' },
              fecha_tentativa: { type: 'STRING', description: 'Fecha/hora deseada si la mencionó' },
            },
            required: ['cliente_nombre', 'categoria', 'descripcion_diseno'],
          },
        },
      ],
    },
  ];
}

const GEMINI_MODEL_FALLBACK_CHAIN = [
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];

async function callGeminiWithFallback(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<GeminiResponse | null> {
  for (const model of GEMINI_MODEL_FALLBACK_CHAIN) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        return (await res.json()) as GeminiResponse;
      }

      const errText = await res.text();
      console.error(`Gemini model ${model} HTTP ${res.status}:`, errText.slice(0, 220));
    } catch (err) {
      console.error(`Gemini model ${model} network/timeout error:`, err);
    }
  }
  return null;
}

async function runGeminiConversation(
  ctx: ToolExecutionContext,
  history: ChatTurn[]
): Promise<string> {
  const { env, fromPhone, origin, memory } = ctx;
  if (!env.GEMINI_API_KEY) {
    return '';
  }

  try {
    const systemInstruction = await buildSystemInstruction(env, origin, fromPhone, memory);
    const toolsDeclaration = getToolsDeclaration();
    const contents: Array<Record<string, unknown>> = history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    }));

    // Soportar hasta 5 rondas de Function Calling y múltiples llamadas paralelas por turno
    for (let step = 0; step < 5; step++) {
      const json = await callGeminiWithFallback(env.GEMINI_API_KEY, {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        tools: toolsDeclaration,
      });

      if (!json) {
        break;
      }

      const modelContent = json.candidates?.[0]?.content;
      const parts = modelContent?.parts || [];
      const fnCallParts = parts.filter((p) => p.functionCall);

      if (fnCallParts.length > 0 && modelContent) {
        // Preservar el content exacto devuelto por Gemini 3.x (incluye thoughtSignature obligatorio)
        contents.push({
          role: modelContent.role || 'model',
          parts: modelContent.parts || fnCallParts,
        });

        const functionResponseParts: Array<Record<string, unknown>> = [];
        for (const part of fnCallParts) {
          const fc = part.functionCall!;
          const toolResult = await executeBotTool(ctx, fc);
          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              ...(fc.id ? { id: fc.id } : {}),
              response: toolResult,
            },
          });
        }

        contents.push({
          role: 'user',
          parts: functionResponseParts,
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

  // Si se alcanzó a crear una reserva con link de Bold en este turno, JAMÁS perder el link ni enviar saludo
  if (ctx.lastCreatedBooking) {
    const b = ctx.lastCreatedBooking;
    return (
      `🎟️ *¡Listo! Tu reserva en ${NOMBRE_OFICIAL_NEGOCIO} quedó pre-agendada*\n\n` +
      `• *Servicio:* ${b.servicio}\n` +
      `• *Fecha/Hora:* ${b.fechaHora}\n` +
      `• *Valor (100%):* ${b.montoTotal}\n\n` +
      `💳 *Paga aquí en ${b.pasarela} (bloqueo de 20 min):*\n${b.paymentLink}\n\n` +
      `🔒 *Tu ticket privado:*\n${b.manageLink}\n\n` +
      `📌 *Política de cancelación:* Reembolso del 80% (${b.reembolso80}) y retención administrativa del 20%.`
    );
  }

  return '';
}

async function buildFallbackReply(env: Env, isFirstTurn: boolean, memory: ChatMemory): Promise<string> {
  const webUrl = env.DASHBOARD_URL || 'https://spa-superlook.vercel.app';

  // En turnos intermedios, NUNCA repetir el saludo de bienvenida inicial
  if (!isFirstTurn) {
    const known = memory.cliente_nombre ? `, ${memory.cliente_nombre}` : '';
    return (
      `¡Hola${known}! Tuve una pequeña demora procesando tu último mensaje 🙏.\n\n` +
      `Por favor confírmame el *servicio exacto del catálogo*, *fecha* y *hora* para generarte tu link de pago en Bold al instante, o si prefieres agenda directamente en 10 segundos desde nuestra web sincronizada: ${webUrl} ✨`
    );
  }

  const { results: servicios } = await env.DB.prepare(
    'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
  ).all<ServicioRow>();

  const listado = (servicios || [])
    .map(
      (s) =>
        `• *${s.id}. [${s.categoria || 'General'}] ${s.nombre}* (${s.duracion_minutos} min) — ${formatCOP(s.precio_cop)}`
    )
    .join('\n');

  return (
    `✨ *¡Hola! Qué alegría saludarte, bienvenido/a a ${NOMBRE_OFICIAL_NEGOCIO}* 🌸💇‍♀️💅\n\n` +
    `Atendemos *ÚNICAMENTE bajo reserva previa* en *Transversal 86A #83A-30*. Puedes agendar aquí mismo por WhatsApp o en nuestra web (${webUrl}) — ¡todo queda sincronizado al instante!\n\n` +
    `📋 *Servicios disponibles:*\n${listado}\n\n` +
    `🎨 ¿Quieres *cotizar un diseño personalizado de uñas o cabello*? Cuéntame qué estilo tienes en mente (o envíame una foto de referencia) y le aviso de inmediato a nuestra especialista.\n\n` +
    `📌 *${TEXTO_LEGAL_RETENCION_20}*`
  );
}

/**
 * Procesa el mensaje entrante de WhatsApp utilizando Gemini con Memoria Persistente + Function Calling
 * y guarda tanto el historial como la memoria estructurada en `chat_sesiones`.
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
  const memory: ChatMemory = { ...session.memory };
  const isFirstTurn = history.length === 0;
  const nowIso = new Date().toISOString();

  history.push({ role: 'user', text: incomingText, sender: 'client', timestamp: nowIso });
  if (history.length > 24) {
    history = history.slice(history.length - 24);
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
      .bind(fromPhone, JSON.stringify({ turns: history, human_takeover: true, memory }), nowIso)
      .run();

    return '[Modo atención humana activo: mensaje guardado en bandeja de Mamá]';
  }

  const ctx: ToolExecutionContext = {
    env,
    fromPhone,
    origin: 'WhatsApp Bot',
    memory,
  };

  let replyText = await runGeminiConversation(ctx, history);
  if (!replyText) {
    replyText = await buildFallbackReply(env, isFirstTurn, memory);
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
    .bind(fromPhone, JSON.stringify({ turns: history, human_takeover: false, memory }), replyIso)
    .run();

  await sendWhatsAppText(env, fromPhone, replyText);

  return replyText;
}

/**
 * Procesa una conversación del Asistente IA directamente desde la Página Web (modo híbrido).
 */
export async function handleWebChatMessage(
  env: Env,
  historyInput: ChatTurn[],
  userMessage: string,
  clientPhone = ''
): Promise<string> {
  const sanitizedHistory: ChatTurn[] = (Array.isArray(historyInput) ? historyInput : [])
    .slice(-16)
    .map((t) => ({
      role: t.role === 'model' ? 'model' : 'user',
      text: String(t.text || '').slice(0, 1200),
    }));

  const isFirstTurn = sanitizedHistory.length === 0;
  sanitizedHistory.push({
    role: 'user',
    text: userMessage.slice(0, 1200),
  });

  const ctx: ToolExecutionContext = {
    env,
    fromPhone: clientPhone,
    origin: 'Página Web',
    memory: {},
  };

  let reply = await runGeminiConversation(ctx, sanitizedHistory);
  if (!reply) {
    reply = await buildFallbackReply(env, isFirstTurn, ctx.memory);
  }
  return reply;
}

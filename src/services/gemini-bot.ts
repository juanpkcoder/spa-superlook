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
import { createQuoteAndNotifyAdmin } from './quotes';

export interface AttachedImageInput {
  base64?: string;
  mimeType?: string;
  mediaId?: string;
  contactName?: string;
}

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
  cotizacion_aprobada_code?: string;
  cotizacion_aprobada_cop?: number;
  cotizacion_aprobada_detalle?: string;
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
  attachedImage?: AttachedImageInput;
  quoteCreatedThisTurn?: boolean;
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
      call.args.cliente_nombre ||
        memory.cliente_nombre ||
        ctx.attachedImage?.contactName ||
        'Cliente interesado'
    ).trim();
    const telefonoArgs = String(call.args.cliente_telefono || fromPhone || '').replace(/\D/g, '');
    const categoria = String(call.args.categoria || 'Diseño Personalizado').trim();
    const descripcionDiseno = String(call.args.descripcion_diseno || '').trim();
    const analisisIa = call.args.analisis_ia ? String(call.args.analisis_ia).trim() : '';
    const estimadoCopRaw = Number(call.args.estimado_cop || 0);
    const estimadoCop =
      Number.isFinite(estimadoCopRaw) && estimadoCopRaw >= 5000
        ? Math.round(estimadoCopRaw)
        : undefined;
    const fechaTentativa = call.args.fecha_tentativa
      ? String(call.args.fecha_tentativa).trim()
      : memory.fecha_ymd
        ? `${memory.fecha_ymd} ${memory.hora_hhmm || ''}`.trim()
        : '';
    const estimadoOrientativo = call.args.estimado_orientativo
      ? String(call.args.estimado_orientativo).trim()
      : estimadoCop
        ? `Aprox. ${formatCOP(estimadoCop)}`
        : '';
    const servicioIdArg = Number(call.args.servicio_id || memory.servicio_id || 0);

    let servicioBase: ServicioRow | null = null;
    if (servicioIdArg > 0) {
      servicioBase = await env.DB.prepare(
        'SELECT id, categoria, nombre, duracion_minutos, precio_cop FROM servicios WHERE id = ?1 AND activo = 1'
      )
        .bind(servicioIdArg)
        .first<ServicioRow>();
    }

    if (clienteNombre && clienteNombre !== 'Cliente interesado') {
      memory.cliente_nombre = clienteNombre;
    }
    if (servicioBase) {
      memory.servicio_id = servicioBase.id;
      memory.servicio_nombre = servicioBase.nombre;
    }
    if (descripcionDiseno) {
      memory.notas = `${categoria}: ${descripcionDiseno}`.slice(0, 220);
    }

    if (!descripcionDiseno && !analisisIa) {
      return {
        ok: false,
        error: 'Describe el diseño de uñas o trabajo de cabello antes de enviar la cotización.',
      };
    }

    const quote = await createQuoteAndNotifyAdmin(env, {
      origen: origin,
      clienteNombre,
      clienteTelefono: telefonoArgs,
      categoria,
      servicioId: servicioBase?.id,
      servicioNombre: servicioBase?.nombre,
      descripcionDiseno: descripcionDiseno || analisisIa,
      analisisIa: analisisIa || undefined,
      estimadoCop: estimadoCop || servicioBase?.precio_cop,
      estimadoRango: estimadoOrientativo || undefined,
      fechaTentativa: fechaTentativa || undefined,
      mediaId: ctx.attachedImage?.mediaId,
    });

    ctx.quoteCreatedThisTurn = true;

    return {
      ok: true,
      codigo_cotizacion: quote.code,
      especialista_notificada: true,
      foto_reenviada_a_especialista: Boolean(ctx.attachedImage?.mediaId),
      estimado_sugerido: quote.estimado_cop ? formatCOP(quote.estimado_cop) : estimadoOrientativo,
      mensaje_confirmacion:
        `Cotización ${quote.code} enviada al WhatsApp personal de nuestra especialista de Spa Superlook para su aprobación final. Apenas confirme el valor exacto te llegará un mensaje aquí mismo.`,
      web_citas: env.DASHBOARD_URL || 'https://spa-superlook.vercel.app',
    };
  }

  if (call.name === 'crear_reserva_con_pago') {
    const clienteNombre = String(
      call.args.cliente_nombre || memory.cliente_nombre || ''
    ).trim();
    const clienteTelefono = String(call.args.cliente_telefono || fromPhone || '').replace(/\D/g, '');
    let servicioId = Number(call.args.servicio_id || memory.servicio_id || 0);
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

    // Si hay cotización aprobada por Mamá pero no se pasó servicio_id, tomar el primer servicio activo relacionado
    if (!servicioId && memory.cotizacion_aprobada_cop) {
      const fallbackSrv = await env.DB.prepare(
        'SELECT id FROM servicios WHERE activo = 1 ORDER BY id ASC LIMIT 1'
      ).first<{ id: number }>();
      if (fallbackSrv?.id) servicioId = fallbackSrv.id;
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

    // Si Mamá aprobó una cotización personalizada para esta clienta, usar ese monto oficial exacto
    const usarPrecioAprobado =
      Boolean(memory.cotizacion_aprobada_cop && memory.cotizacion_aprobada_cop >= 5000) &&
      (call.args.usar_precio_cotizacion_aprobada !== false);
    const montoTotal = usarPrecioAprobado
      ? Math.round(memory.cotizacion_aprobada_cop!)
      : servicio.precio_cop;
    const serviceDisplayName =
      usarPrecioAprobado && memory.cotizacion_aprobada_code
        ? `${servicio.nombre} (${memory.cotizacion_aprobada_code})`
        : servicio.nombre;

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
          serviceName: serviceDisplayName,
          customerName: clienteNombre,
          customerPhone: clienteTelefono,
          redirectUrl: linkGestionCita,
        })
      : await createWompiPaymentLink(env, {
          reference: wompiReference,
          amountCop: montoTotal,
          serviceName: serviceDisplayName,
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
    if (usarPrecioAprobado) {
      delete memory.cotizacion_aprobada_code;
      delete memory.cotizacion_aprobada_cop;
      delete memory.cotizacion_aprobada_detalle;
    }

    ctx.lastCreatedBooking = {
      citaId,
      servicio: serviceDisplayName,
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
      servicio: serviceDisplayName,
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
    memory.cotizacion_aprobada_cop
      ? `- ⭐ COTIZACIÓN APROBADA POR LA ESPECIALISTA (${memory.cotizacion_aprobada_code || 'OFICIAL'}): ${formatCOP(memory.cotizacion_aprobada_cop)} — ${memory.cotizacion_aprobada_detalle || ''}. ¡USA ESTE PRECIO EXACTO (usar_precio_cotizacion_aprobada: true) al crear la reserva con Bold!`
      : null,
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

TABLA DE PRECIOS VARIABLES Y REGLAS DE COTIZACIÓN DE LA ESPECIALISTA (MAMÁ):
- **Uñas & Manicure**:
  • Manicure Tradicional: $22.000 (precio fijo).
  • Manicure Semipermanente: $25.000 unicolor hasta $60.000 según diseño, nail art, efectos o retiro (tarifa promedio diseño: $45.000).
  • Uñas en Acrílico (Esculpidas): rango $60.000 a $90.000 según largo y decoración (base establecida: $65.000).
  • Uñas Soft Gel / Press-On: rango $75.000 a $100.000 según largo y diseño (base establecida: $75.000).
  • Extensiones en Gel / Poligel: rango $75.000 a $110.000 según largo y diseño (base establecida: $80.000).
- **Pedicure & Spa Pies**: Tradicional $28.000 (fijo) | Semipermanente $40.000 a $55.000 según diseño.
- **Tratamientos Capilares** (varían según largo y abundancia del cabello):
  • Keratina: base $160.000 (rango $160.000–$320.000).
  • Cirugía Capilar: base $140.000 (rango $140.000–$280.000).
  • Laminado Capilar: base $95.000 (rango $95.000–$180.000).
  • Ampolleta de Reestructuración Capilar: $45.000 (fijo).
- **Cabello, Corte & Color** (colorimetría varía según largo, base actual y tono deseado):
  • Corte de Cabello & Asesoría de Imagen: $35.000 (fijo).
  • Analogía de Color / Colorimetría: base $110.000 (rango $110.000–$220.000).
  • Mechas / Iluminaciones / Rayitos: base $160.000 (rango $160.000–$320.000).
  • Babylights (Baby Highlights): base $190.000 (rango $190.000–$360.000).
  • Balayage Profesional: base $220.000 (rango $220.000–$420.000).
- **Pestañas & Mirada** (precios fijos):
  • Pestañas en Tira: $25.000 | Punto a Punto: $40.000 | Pelo a Pelo (Efecto Natural): $85.000 | Volumen 3D: $115.000.

MEMORIA ACTUAL DE ESTA CONVERSACIÓN (NO vuelvas a pedir datos que YA están aquí o en el historial):
${memoryLines.length > 0 ? memoryLines.join('\n') : '- Aún no se han guardado datos de reserva.'}

PERSONALIDAD Y TONO:
- Cálida, elegante, servicial, directa y resolutiva.
- Usa un trato respetuoso y amable SIN asumir género ("¡Hola! ✨ Qué alegría saludarte...", "¡Perfecto, Camila! ✨") a menos que el nombre o la conversación indique claramente género.
- En el PRIMER saludo únicamente, da una bienvenida encantadora presentando brevemente que puedes ayudarle a ver servicios, agendar aquí mismo (o en ${webUrl}) y cotizar diseños de uñas o trabajos de cabello enviando una foto.
- En mensajes posteriores, **NUNCA repitas el saludo largo ni el menú inicial**: continúa la conversación con naturalidad, usando todo lo que ya te dijeron!

FLUJO INTELIGENTE DE RESERVA Y COTIZACIÓN CON FOTOS (SIGUE ESTO AL PIE DE LA LETRA):
1. **CUANDO LA CLIENTA ENVÍA UNA FOTO DE REFERENCIA (uñas, diseño, su cabello o inspiración de color)**:
   - Observa la imagen con muchísimo detalle (técnica de uñas, largo, decoración/pedrería/francés/3D, o largo/abundancia/tono actual y deseado del cabello).
   - Ubica el servicio base del CATÁLOGO ACTIVO (su \`servicio_id\`) y calcula un **precio estimado orientativo realista** (\`estimado_cop\` y \`estimado_orientativo\`) estrictamente dentro de la TABLA DE PRECIOS VARIABLES de arriba.
   - Llama **DE INMEDIATO EN ESTE MISMO TURNO** a \`solicitar_cotizacion_personalizada\` pasando \`servicio_id\`, \`categoria\`, \`descripcion_diseno\`, \`analisis_ia\`, \`estimado_cop\` y \`estimado_orientativo\`. Esta herramienta reenvía automáticamente la foto real y tu sugerencia de precio al WhatsApp personal de nuestra especialista para que ella apruebe o ajuste el valor exacto!
   - En tu respuesta a la clienta: elogia brevemente su idea, comparte el **rango/estimado orientativo** (dejando claro que es un estimado sujeto a confirmación), indícale su código de cotización (\`COT-XXX\`), y dile que **ya le enviamos su foto a nuestra especialista** para aprobar el precio exacto y que apenas lo confirme le llegará el mensaje aquí mismo para agendar su turno con link de Bold. Si todavía no dijo su nombre o fecha tentativa, pregúntaselos en 1 línea amable.
2. **CUANDO LA CLIENTA PIDE COTIZAR POR TEXTO UN SERVICIO DE PRECIO VARIABLE** (ej. balayage en cabello largo, keratina abundante, uñas acrílicas largas con diseño):
   - Dale el rango real de la tabla, invítala a enviarte **una foto por aquí mismo** (de su cabello o del diseño deseado) para que la especialista le confirme el valor exacto, O si ya dio suficiente detalle, llama a \`solicitar_cotizacion_personalizada\` para pedir aprobación a nuestra especialista al WhatsApp personal.
   - Si la clienta prefiere agendar de una vez con la tarifa base establecida o pidió un servicio de precio fijo, procede directo al paso 3!
3. **RESERVA DIRECTA CON LINK DE PAGO BOLD (\`crear_reserva_con_pago\`)**:
   - Solo necesitas 3 cosas en WhatsApp (o 4 en Web): **Servicio del catálogo (\`servicio_id\`) + Nombre + Fecha y Hora exacta** (\`YYYY-MM-DDTHH:mm:00-05:00\`).
   - Si en la MEMORIA ACTUAL ya existe una **⭐ COTIZACIÓN APROBADA POR LA ESPECIALISTA**, apenas la clienta confirme día y hora llama **DE INMEDIATO** a \`crear_reserva_con_pago\` con \`usar_precio_cotizacion_aprobada: true\` para emitir el Link de Pago de **Bold** por el **precio exacto aprobado por la especialista**!
   - **NO HAGAS PREGUNTAS REPETIDAS**: si falta solo 1 dato, pregunta únicamente por ese dato en 1 o 2 líneas.
   - Cuando \`crear_reserva_con_pago\` devuelva \`ok: true\`, entrega SIEMPRE de forma súper clara:
     * Resumen del turno (Nombre, Servicio, Fecha/Hora, Valor 100%)
     * **Link de pago automático en Bold** (\`payment_link\`)
     * **Enlace privado de su ticket** (\`link_gestion_cita\`)
     * Recordatorio breve de bloqueo de 20 minutos y política obligatoria (80% reembolso / 20% retención).
4. **CONFIRMACIÓN DE MANTENIMIENTOS (25 DÍAS UÑAS / 30 DÍAS CABELLO)**:
   - Si el cliente confirma tras un recordatorio de mantenimiento, usa la MEMORIA ACTUAL (nombre y servicio) y pregúntale solo día/hora si falta, o agenda de una vez con \`crear_reserva_con_pago\`.
5. **Datos oficiales de Spa Superlook**:
   - Ubicación: Transversal 86A #83A-30 (atención ÚNICAMENTE bajo reserva previa).
   - Instagram oficial: https://www.instagram.com/yc_peluqueriasuperlook/ (@yc_peluqueriasuperlook)
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
              usar_precio_cotizacion_aprobada: {
                type: 'BOOLEAN',
                description:
                  'Poner true si la clienta ya tiene una cotización aprobada por la especialista en MEMORIA ACTUAL para cobrar ese valor exacto en Bold.',
              },
            },
            required: ['cliente_nombre', 'servicio_id', 'fecha_hora_inicio'],
          },
        },
        {
          name: 'solicitar_cotizacion_personalizada',
          description:
            'Registra una cotización con código COT-XXX y envía alerta inmediata (incluyendo la foto real si la clienta mandó imagen) al WhatsApp personal de la especialista/dueña de Spa Superlook para que ella apruebe o ajuste el precio exacto.',
          parameters: {
            type: 'OBJECT',
            properties: {
              cliente_nombre: { type: 'STRING', description: 'Nombre del cliente' },
              cliente_telefono: { type: 'STRING', description: 'WhatsApp del cliente (automático en WhatsApp)' },
              servicio_id: {
                type: 'INTEGER',
                description: 'ID numérico del servicio base del catálogo más cercano (opcional pero recomendado)',
              },
              categoria: {
                type: 'STRING',
                description: 'Categoría (ej. Uñas & Manicure, Pedicure & Spa Pies, Tratamientos Capilares, Cabello, Corte & Color, Pestañas & Mirada)',
              },
              descripcion_diseno: { type: 'STRING', description: 'Detalle del servicio, largo, técnica o diseño solicitado' },
              analisis_ia: {
                type: 'STRING',
                description: 'Resumen breve de lo observado en la foto enviada por la clienta (si aplica)',
              },
              estimado_cop: {
                type: 'INTEGER',
                description: 'Valor numérico sugerido en pesos colombianos (ej. 85000) según la tabla de rangos de la especialista',
              },
              estimado_orientativo: { type: 'STRING', description: 'Rango orientativo legible (ej. "$75.000 - $90.000")' },
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
    const contents: Array<Record<string, unknown>> = history.map((turn, idx) => {
      const isLastUserTurn = idx === history.length - 1 && turn.role === 'user';
      if (isLastUserTurn && ctx.attachedImage?.base64) {
        return {
          role: turn.role,
          parts: [
            { text: turn.text },
            {
              inlineData: {
                mimeType: ctx.attachedImage.mimeType || 'image/jpeg',
                data: ctx.attachedImage.base64,
              },
            },
          ],
        };
      }
      return {
        role: turn.role,
        parts: [{ text: turn.text }],
      };
    });

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
  incomingText: string,
  attachedImage?: AttachedImageInput
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

  if (attachedImage?.contactName && !memory.cliente_nombre) {
    memory.cliente_nombre = attachedImage.contactName;
  }

  history.push({ role: 'user', text: incomingText, sender: 'client', timestamp: nowIso });
  if (history.length > 24) {
    history = history.slice(history.length - 24);
  }

  // Si Mamá activó control humano en este chat, guardar el mensaje para su bandeja y no responder con IA
  if (session.human_takeover) {
    if (attachedImage?.mediaId) {
      await createQuoteAndNotifyAdmin(env, {
        origen: 'WhatsApp Bot',
        clienteNombre: memory.cliente_nombre || attachedImage.contactName || 'Clienta WhatsApp',
        clienteTelefono: fromPhone,
        categoria: 'Foto de Referencia',
        descripcionDiseno: incomingText,
        mediaId: attachedImage.mediaId,
      }).catch(() => {});
    }
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
    attachedImage,
  };

  let replyText = await runGeminiConversation(ctx, history);

  // Garantía 100%: si la clienta envió una FOTO y Gemini no invocó solicitar_cotizacion_personalizada,
  // igual creamos el registro COT-XXX y reenviamos la foto real al WhatsApp personal de Mamá.
  if (attachedImage?.mediaId && !ctx.quoteCreatedThisTurn) {
    const fallbackQuote = await createQuoteAndNotifyAdmin(env, {
      origen: 'WhatsApp Bot',
      clienteNombre: memory.cliente_nombre || attachedImage.contactName || 'Clienta WhatsApp',
      clienteTelefono: fromPhone,
      categoria: 'Cotización con Foto',
      servicioId: memory.servicio_id,
      servicioNombre: memory.servicio_nombre,
      descripcionDiseno: incomingText,
      mediaId: attachedImage.mediaId,
    }).catch(() => null);

    if (!replyText && fallbackQuote) {
      replyText =
        `📸✨ ¡Qué lindo! Recibimos tu foto de referencia en *${NOMBRE_OFICIAL_NEGOCIO}* (código *${fallbackQuote.code}*).\n\n` +
        `Ya se la reenviamos directamente a nuestra especialista para que te confirme el valor exacto. Apenas lo apruebe te llegará el mensaje aquí mismo para agendar tu turno con link de pago en *Bold* 💖.`;
    }
  }

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

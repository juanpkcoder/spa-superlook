import {
  ChatSesionRow,
  Env,
  formatCOP,
  NOMBRE_OFICIAL_NEGOCIO,
  TEXTO_LEGAL_RETENCION_20,
} from '../types';
import {
  normalizeWhatsAppPhone,
  sendWhatsAppImageById,
  sendWhatsAppText,
} from './whatsapp';
import { parseChatSession } from './gemini-bot';

export const QUOTES_STORAGE_KEY = '__COTIZACIONES__';

export interface QuoteRecord {
  code: string;
  origen: 'WhatsApp Bot' | 'Página Web';
  cliente_nombre: string;
  cliente_telefono: string;
  categoria: string;
  servicio_id?: number;
  servicio_nombre?: string;
  descripcion_diseno: string;
  analisis_ia?: string;
  estimado_cop?: number;
  estimado_rango?: string;
  fecha_tentativa?: string;
  media_id?: string;
  estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA';
  precio_aprobado_cop?: number;
  nota_mama?: string;
  created_at: string;
  approved_at?: string;
}

interface QuotesStorePayload {
  seq: number;
  quotes: QuoteRecord[];
}

export interface ParsedAdminQuoteCommand {
  type: 'LIST' | 'APROBAR' | 'PRECIO' | 'RECHAZAR';
  code?: string;
  priceCop?: number;
  note?: string;
}

async function readQuotesStore(env: Env): Promise<QuotesStorePayload> {
  const row = await env.DB.prepare(
    'SELECT historial_json FROM chat_sesiones WHERE telefono = ?1'
  )
    .bind(QUOTES_STORAGE_KEY)
    .first<Pick<ChatSesionRow, 'historial_json'>>();

  if (!row?.historial_json) {
    return { seq: 100, quotes: [] };
  }
  try {
    const parsed = JSON.parse(row.historial_json) as Partial<QuotesStorePayload>;
    return {
      seq: typeof parsed.seq === 'number' && parsed.seq >= 100 ? parsed.seq : 100,
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
    };
  } catch {
    return { seq: 100, quotes: [] };
  }
}

async function saveQuotesStore(env: Env, store: QuotesStorePayload): Promise<void> {
  const trimmed: QuotesStorePayload = {
    seq: store.seq,
    quotes: store.quotes.slice(0, 80),
  };
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO chat_sesiones (telefono, historial_json, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(telefono) DO UPDATE SET
       historial_json = excluded.historial_json,
       updated_at = excluded.updated_at`
  )
    .bind(QUOTES_STORAGE_KEY, JSON.stringify(trimmed), nowIso)
    .run();
}

export async function listQuotes(env: Env): Promise<QuoteRecord[]> {
  const store = await readQuotesStore(env);
  return store.quotes;
}

/**
 * Parsea montos escritos de forma natural en Colombia por WhatsApp:
 * "85000", "85.000", "$85.000", "85,000", "85k", "85 mil", "160mil" -> número COP entero.
 */
export function parseColombianPrice(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/\$/g, '').replace(/\s+/g, '');

  const milMatch = cleaned.match(/^(\d+(?:[.,]\d+)?)(k|mil)$/);
  if (milMatch) {
    const num = Number(milMatch[1].replace(',', '.'));
    if (Number.isFinite(num) && num >= 5 && num <= 5000) {
      return Math.round(num * 1000);
    }
  }

  const digitsOnly = cleaned.replace(/[.,]/g, '');
  if (/^\d{4,7}$/.test(digitsOnly)) {
    const val = Number(digitsOnly);
    if (val >= 5000 && val <= 5000000) {
      return val;
    }
  }

  return null;
}

/**
 * Crea una cotización persistente con código corto (COT-101, COT-102...)
 * y envía la alerta (con foto real incluida si la clienta envió imagen) al WhatsApp personal de Mamá.
 */
export async function createQuoteAndNotifyAdmin(
  env: Env,
  input: {
    origen: 'WhatsApp Bot' | 'Página Web';
    clienteNombre: string;
    clienteTelefono: string;
    categoria: string;
    servicioId?: number;
    servicioNombre?: string;
    descripcionDiseno: string;
    analisisIa?: string;
    estimadoCop?: number;
    estimadoRango?: string;
    fechaTentativa?: string;
    mediaId?: string;
  }
): Promise<QuoteRecord> {
  const store = await readQuotesStore(env);
  const nextSeq = store.seq + 1;
  const code = `COT-${nextSeq}`;
  const fullPhone = normalizeWhatsAppPhone(input.clienteTelefono);
  const nowIso = new Date().toISOString();

  const quote: QuoteRecord = {
    code,
    origen: input.origen,
    cliente_nombre: (input.clienteNombre || 'Clienta').trim(),
    cliente_telefono: fullPhone,
    categoria: (input.categoria || 'Diseño Personalizado').trim(),
    servicio_id: input.servicioId && input.servicioId > 0 ? input.servicioId : undefined,
    servicio_nombre: input.servicioNombre?.trim() || undefined,
    descripcion_diseno: input.descripcionDiseno.trim(),
    analisis_ia: input.analisisIa?.trim() || undefined,
    estimado_cop:
      input.estimadoCop && Number.isFinite(input.estimadoCop) && input.estimadoCop >= 5000
        ? Math.round(input.estimadoCop)
        : undefined,
    estimado_rango: input.estimadoRango?.trim() || undefined,
    fecha_tentativa: input.fechaTentativa?.trim() || undefined,
    media_id: input.mediaId?.trim() || undefined,
    estado: 'PENDIENTE',
    created_at: nowIso,
  };

  store.seq = nextSeq;
  store.quotes.unshift(quote);
  await saveQuotesStore(env, store);

  if (env.ADMIN_PHONE) {
    const sugeridoTxt = quote.estimado_cop
      ? `${formatCOP(quote.estimado_cop)}${quote.estimado_rango ? ` (${quote.estimado_rango})` : ''}`
      : quote.estimado_rango || 'Pendiente de tu valoración';

    const headerEmoji = quote.media_id ? '📸💅' : '💅✨';
    const caption =
      `${headerEmoji} *[${NOMBRE_OFICIAL_NEGOCIO} · Cotización ${code}]*\n` +
      `• *Clienta:* ${quote.cliente_nombre}${fullPhone ? ` (+${fullPhone})` : ''}\n` +
      `• *Categoría:* ${quote.categoria}${quote.servicio_nombre ? ` · ${quote.servicio_nombre}` : ''}\n` +
      `• *Solicitud:* ${quote.descripcion_diseno}\n` +
      (quote.analisis_ia ? `• *Análisis visual IA:* ${quote.analisis_ia}\n` : '') +
      `• *Precio sugerido Bot:* ${sugeridoTxt}\n` +
      (quote.fecha_tentativa ? `• *Fecha tentativa:* ${quote.fecha_tentativa}\n` : '') +
      `\n👇 *Responde aquí para aprobar y avisar a la clienta:*\n` +
      (quote.estimado_cop
        ? `✅ *APROBAR ${code}*  (aprueba ${formatCOP(quote.estimado_cop)})\n`
        : '') +
      `💰 *PRECIO ${code} 85000*  (o escribe el valor que consideres + nota opcional)\n` +
      `❌ *RECHAZAR ${code} motivo*\n` +
      `📲 Panel: ${env.DASHBOARD_URL || 'https://spa-superlook.vercel.app'}/?admin=1`;

    if (quote.media_id) {
      await sendWhatsAppImageById(env, env.ADMIN_PHONE, quote.media_id, caption);
    } else {
      await sendWhatsAppText(env, env.ADMIN_PHONE, caption);
    }
  }

  return quote;
}

/**
 * Detecta comandos enviados por Mamá desde ADMIN_PHONE (573102319617) para aprobar,
 * ajustar precio, rechazar o listar cotizaciones pendientes.
 */
export function parseAdminQuoteCommand(rawText: string): ParsedAdminQuoteCommand | null {
  const text = (rawText || '').trim();
  if (!text) return null;

  // 1. Listar cotizaciones pendientes
  if (/^(cotizaciones|pendientes|ver\s+cotizaciones)$/i.test(text)) {
    return { type: 'LIST' };
  }

  // 2. APROBAR COT-101 [nota]  o  OK COT-101  o  SI COT-101
  const approveCodeMatch = text.match(
    /^(?:aprobar|aprobado|ok|si|sí|confirmar)\s+(cot-\d+)(?:\s+(.+))?$/i
  );
  if (approveCodeMatch) {
    const code = approveCodeMatch[1].toUpperCase();
    const rest = (approveCodeMatch[2] || '').trim();
    // Por si Mamá escribió "APROBAR COT-101 85000 nota"
    const restParts = rest.split(/\s+/);
    const maybePrice = restParts[0] ? parseColombianPrice(restParts[0]) : null;
    if (maybePrice) {
      return {
        type: 'PRECIO',
        code,
        priceCop: maybePrice,
        note: restParts.slice(1).join(' ').trim() || undefined,
      };
    }
    return {
      type: 'APROBAR',
      code,
      note: rest || undefined,
    };
  }

  // 3. PRECIO COT-101 85000 [nota]  o  COTIZAR COT-101 85000 [nota]  o  COT-101 85000 [nota]
  const priceCodeMatch = text.match(
    /^(?:(?:precio|cotizar|valor|poner)\s+)?(cot-\d+)\s+(\$?[\d.,]+(?:\s*(?:k|mil))?)(?:\s+(.+))?$/i
  );
  if (priceCodeMatch) {
    const priceCop = parseColombianPrice(priceCodeMatch[2]);
    if (priceCop) {
      return {
        type: 'PRECIO',
        code: priceCodeMatch[1].toUpperCase(),
        priceCop,
        note: (priceCodeMatch[3] || '').trim() || undefined,
      };
    }
  }

  // 4. RECHAZAR COT-101 [motivo]
  const rejectCodeMatch = text.match(
    /^(?:rechazar|cancelar|no)\s+(cot-\d+)(?:\s+(.+))?$/i
  );
  if (rejectCodeMatch) {
    return {
      type: 'RECHAZAR',
      code: rejectCodeMatch[1].toUpperCase(),
      note: (rejectCodeMatch[2] || '').trim() || undefined,
    };
  }

  // 5. Atajo rápido para Mamá (aplica a la última cotización PENDIENTE):
  //    "APROBAR" / "PRECIO 85000 [nota]" / "85000 [nota]" / "$85.000"
  if (/^(?:aprobar|aprobado)$/i.test(text)) {
    return { type: 'APROBAR' };
  }

  const quickPriceMatch = text.match(
    /^(?:(?:precio|valor|cotizar)\s+)?(\$?[\d.,]+(?:\s*(?:k|mil))?)(?:\s+(.+))?$/i
  );
  if (quickPriceMatch) {
    const priceCop = parseColombianPrice(quickPriceMatch[1]);
    if (priceCop) {
      return {
        type: 'PRECIO',
        priceCop,
        note: (quickPriceMatch[2] || '').trim() || undefined,
      };
    }
  }

  return null;
}

/**
 * Resuelve (aprueba con precio sugerido, fija precio personalizado o rechaza) una cotización,
 * sincroniza el precio oficial en la memoria de `chat_sesiones` de la clienta y le envía
 * notificación automática por WhatsApp desde +57 312 459 7896.
 */
export async function resolveQuoteAndNotifyClient(
  env: Env,
  params: {
    code?: string;
    action: 'APROBAR' | 'PRECIO' | 'RECHAZAR';
    customPriceCop?: number;
    notaMama?: string;
  }
): Promise<{ ok: boolean; quote?: QuoteRecord; error?: string }> {
  const store = await readQuotesStore(env);
  let quote: QuoteRecord | undefined;

  if (params.code) {
    quote = store.quotes.find(
      (q) => q.code.toUpperCase() === params.code!.toUpperCase()
    );
  } else {
    quote = store.quotes.find((q) => q.estado === 'PENDIENTE');
  }

  if (!quote) {
    return {
      ok: false,
      error: params.code
        ? `No encontré ninguna cotización con código ${params.code}.`
        : 'No hay cotizaciones pendientes por aprobar en este momento.',
    };
  }

  const nowIso = new Date().toISOString();

  if (params.action === 'RECHAZAR') {
    quote.estado = 'RECHAZADA';
    quote.nota_mama = params.notaMama?.trim() || 'Por el momento no podemos realizar ese diseño específico.';
    quote.approved_at = nowIso;
    await saveQuotesStore(env, store);

    if (quote.cliente_telefono) {
      const clientRejectMsg =
        `🌸 *Actualización de tu cotización ${quote.code} · ${NOMBRE_OFICIAL_NEGOCIO}*\n\n` +
        `Hola *${quote.cliente_nombre}*, nuestra especialista revisó tu solicitud y nos comenta:\n` +
        `_"${quote.nota_mama}"_\n\n` +
        `Si deseas, podemos ofrecerte otra opción linda de nuestro catálogo o ajustar el diseño. ¡Cuéntame qué te gustaría! ✨`;

      await sendWhatsAppText(env, quote.cliente_telefono, clientRejectMsg);
    }

    return { ok: true, quote };
  }

  const finalPriceCop =
    params.customPriceCop && params.customPriceCop >= 5000
      ? Math.round(params.customPriceCop)
      : quote.estimado_cop;

  if (!finalPriceCop || finalPriceCop < 5000) {
    return {
      ok: false,
      error: `La cotización ${quote.code} no tiene un monto base sugerido. Por favor indícame el valor exacto, ejemplo: PRECIO ${quote.code} 85000`,
    };
  }

  quote.estado = 'APROBADA';
  quote.precio_aprobado_cop = finalPriceCop;
  quote.nota_mama = params.notaMama?.trim() || undefined;
  quote.approved_at = nowIso;
  await saveQuotesStore(env, store);

  const reembolso80 = Math.round(finalPriceCop * 0.8);
  const retencion20 = finalPriceCop - reembolso80;

  const clientApprovedMsg =
    `✨ *¡Cotización Aprobada en ${NOMBRE_OFICIAL_NEGOCIO}!* 🌸\n\n` +
    `Hola *${quote.cliente_nombre}*, nuestra especialista ya revisó tu solicitud (*${quote.code}*) y confirmó tu precio oficial:\n\n` +
    `• *Servicio / Diseño:* ${quote.servicio_nombre || quote.categoria}\n` +
    `• *Detalle:* ${quote.descripcion_diseno}\n` +
    `• *Precio oficial aprobado:* *${formatCOP(finalPriceCop)}*\n` +
    (quote.nota_mama ? `• *Nota de la especialista:* ${quote.nota_mama}\n` : '') +
    `• *Política de cancelación:* ${TEXTO_LEGAL_RETENCION_20} (Reembolso 80%: ${formatCOP(reembolso80)} / Retención 20%: ${formatCOP(retencion20)}).\n\n` +
    (quote.fecha_tentativa
      ? `🗓️ Me habías comentado como fecha tentativa: *${quote.fecha_tentativa}*. ¿Confirmamos ese día y hora (o dime qué día y hora prefieres) para enviarte de inmediato tu link de pago en *Bold* por *${formatCOP(finalPriceCop)}*? 💖`
      : `🗓️ ¿Qué *día y hora* prefieres para reservar tu cita? Apenas me confirmes, te envío de inmediato tu link de pago en *Bold* por *${formatCOP(finalPriceCop)}* 💖.`);

  // Inyectar la cotización aprobada en la memoria persistente del chat de la clienta
  // para que cuando responda con día/hora, el Bot genere el link de Bold por el precio EXACTO aprobado por Mamá.
  if (quote.cliente_telefono) {
    const existingSession = await env.DB.prepare(
      'SELECT telefono, historial_json, updated_at FROM chat_sesiones WHERE telefono = ?1'
    )
      .bind(quote.cliente_telefono)
      .first<ChatSesionRow>();

    const session = parseChatSession(existingSession?.historial_json);
    session.memory.cliente_nombre = quote.cliente_nombre || session.memory.cliente_nombre;
    if (quote.servicio_id) {
      session.memory.servicio_id = quote.servicio_id;
    }
    if (quote.servicio_nombre) {
      session.memory.servicio_nombre = quote.servicio_nombre;
    }
    session.memory.cotizacion_aprobada_code = quote.code;
    session.memory.cotizacion_aprobada_cop = finalPriceCop;
    session.memory.cotizacion_aprobada_detalle = quote.descripcion_diseno.slice(0, 200);
    session.memory.notas = `Cotización ${quote.code} aprobada por Mamá en ${formatCOP(finalPriceCop)}: ${quote.descripcion_diseno.slice(0, 140)}`;
    session.turns.push({
      role: 'model',
      text: clientApprovedMsg,
      sender: 'admin',
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
      .bind(quote.cliente_telefono, JSON.stringify(session), nowIso)
      .run();

    await sendWhatsAppText(env, quote.cliente_telefono, clientApprovedMsg);
  }

  return { ok: true, quote };
}

/**
 * Procesa un mensaje entrante desde el WhatsApp personal de Mamá (ADMIN_PHONE).
 * Devuelve true si era un comando de gestión de cotizaciones (ya respondido),
 * o false si Mamá está escribiendo como usuaria normal para probar el bot.
 */
export async function handleAdminWhatsAppQuoteCommand(
  env: Env,
  fromPhone: string,
  incomingText: string
): Promise<boolean> {
  const adminClean = normalizeWhatsAppPhone(env.ADMIN_PHONE || '');
  const senderClean = normalizeWhatsAppPhone(fromPhone);
  if (!adminClean || senderClean !== adminClean) {
    return false;
  }

  const cmd = parseAdminQuoteCommand(incomingText);
  if (!cmd) {
    return false;
  }

  // Si usó el atajo rápido (solo un número o "APROBAR" sin código), solo interceptar si hay al menos una pendiente
  if (!cmd.code && cmd.type !== 'LIST') {
    const quotes = await listQuotes(env);
    const hasPending = quotes.some((q) => q.estado === 'PENDIENTE');
    if (!hasPending) {
      return false;
    }
  }

  if (cmd.type === 'LIST') {
    const quotes = await listQuotes(env);
    const pending = quotes.filter((q) => q.estado === 'PENDIENTE');
    if (pending.length === 0) {
      await sendWhatsAppText(
        env,
        adminClean,
        `✅ No tienes cotizaciones pendientes en *${NOMBRE_OFICIAL_NEGOCIO}* en este momento.`
      );
      return true;
    }

    const lines = pending.slice(0, 10).map((q) => {
      const sug = q.estimado_cop ? formatCOP(q.estimado_cop) : q.estimado_rango || 'Sin estimado';
      return `• *${q.code}* | ${q.cliente_nombre} | ${q.categoria} | Sug: ${sug}\n  _${q.descripcion_diseno.slice(0, 80)}_`;
    });

    await sendWhatsAppText(
      env,
      adminClean,
      `📋 *Cotizaciones Pendientes (${pending.length})*\n\n${lines.join('\n\n')}\n\n💡 Responde *APROBAR COT-XXX* o *PRECIO COT-XXX 85000* para confirmar.`
    );
    return true;
  }

  const result = await resolveQuoteAndNotifyClient(env, {
    code: cmd.code,
    action: cmd.type,
    customPriceCop: cmd.priceCop,
    notaMama: cmd.note,
  });

  if (!result.ok || !result.quote) {
    await sendWhatsAppText(env, adminClean, `⚠️ ${result.error || 'No se pudo procesar la cotización.'}`);
    return true;
  }

  const q = result.quote;
  if (cmd.type === 'RECHAZAR') {
    await sendWhatsAppText(
      env,
      adminClean,
      `❌ Cotización *${q.code}* marcada como rechazada. Ya avisamos amablemente a *${q.cliente_nombre}*.`
    );
  } else {
    await sendWhatsAppText(
      env,
      adminClean,
      `✅ *¡Listo!* Cotización *${q.code}* aprobada en *${formatCOP(q.precio_aprobado_cop || 0)}*.\n` +
        `Ya le enviamos el mensaje a *${q.cliente_nombre}* (+${q.cliente_telefono}) desde el WhatsApp oficial de *${NOMBRE_OFICIAL_NEGOCIO}*. Apenas ella confirme día y hora, el Bot le generará su link de pago de *Bold* por ese valor exacto 💖.`
    );
  }

  return true;
}

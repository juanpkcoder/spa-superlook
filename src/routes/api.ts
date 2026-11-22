import { Hono } from 'hono';
import {
  CitaConServicioRow,
  CitaRow,
  Env,
  formatCOP,
  MODALIDAD_ATENCION_RESERVA,
  NOMBRE_OFICIAL_NEGOCIO,
  ServicioRow,
  TEXTO_LEGAL_RETENCION_20,
} from '../types';
import { createWompiPaymentLink } from '../services/wompi';
import { createBoldPaymentLink } from '../services/bold';
import { sendWhatsAppText } from '../services/whatsapp';
import { calcularBloquesDisponibles } from '../services/gemini-bot';
import {
  buildClientCitaUrl,
  createAdminSessionToken,
  getDashboardSigningSecret,
  isValidAdminRequest,
  timingSafeEqualStr,
  verifyCitaAccessToken,
} from '../services/security';

export const apiRoutes = new Hono<{ Bindings: Env }>();

// ============================================================================
// 1. AUTENTICACIÓN ADMINISTRATIVA (PARA MAMÁ / ADMIN)
// ============================================================================

/**
 * POST /api/admin/login
 * Valida la contraseña/PIN administrativa contra ADMIN_DASHBOARD_SECRET y
 * emite un token Bearer firmado con HMAC-SHA256 válido por 24 horas.
 */
apiRoutes.post('/admin/login', async (c) => {
  const secret = getDashboardSigningSecret(c.env);
  if (!secret) {
    return c.json(
      {
        ok: false,
        error:
          'ADMIN_DASHBOARD_SECRET no está configurado en el Worker. Configúralo en .dev.vars o con wrangler secret put ADMIN_DASHBOARD_SECRET.',
      },
      503
    );
  }

  let body: { password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Cuerpo JSON inválido' }, 400);
  }

  const password = (body.password || '').trim();
  if (!password || !timingSafeEqualStr(password, secret)) {
    return c.json({ ok: false, error: 'Contraseña o PIN administrativo incorrecto.' }, 401);
  }

  const token = await createAdminSessionToken(c.env);
  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    token,
    expires_in_hours: 24,
  });
});

/**
 * GET /api/admin/verify
 * Verifica si el token Bearer actual sigue siendo válido.
 */
apiRoutes.get('/admin/verify', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json({ ok: false, error: 'No autorizado' }, 401);
  }
  return c.json({ ok: true, admin: true, negocio: NOMBRE_OFICIAL_NEGOCIO });
});

// ============================================================================
// 2. ENDPOINTS PÚBLICOS DE CONSULTA Y RESERVA (CLIENTAS)
// ============================================================================

/**
 * GET /api/servicios
 * Lista los servicios activos configurados en Cloudflare D1 para las clientas.
 */
apiRoutes.get('/servicios', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, categoria, nombre, descripcion, duracion_minutos, precio_cop, activo FROM servicios WHERE activo = 1 ORDER BY categoria ASC, id ASC'
  ).all<ServicioRow>();

  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    modalidad: MODALIDAD_ATENCION_RESERVA,
    politica_cancelacion: TEXTO_LEGAL_RETENCION_20,
    servicios: results || [],
  });
});

/**
 * GET /api/disponibilidad?fecha=YYYY-MM-DD&servicio_id=1
 * Filtra bloques ocupados en `citas` donde el estado sea `CONFIRMADA`
 * o `PENDIENTE_PAGO` creada hace menos de 20 minutos.
 * No expone datos personales de las clientas.
 */
apiRoutes.get('/disponibilidad', async (c) => {
  const fecha = c.req.query('fecha') || new Date().toISOString().slice(0, 10);
  const servicioIdParam = c.req.query('servicio_id');
  const cutoff20MinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  const dayStart = `${fecha}T00:00:00.000Z`;
  const dayEnd = `${fecha}T23:59:59.999Z`;

  const { results: bloquesOcupados } = await c.env.DB.prepare(
    `SELECT fecha_hora_inicio, fecha_hora_fin, estado
     FROM citas
     WHERE fecha_hora_inicio <= ?1
       AND fecha_hora_fin >= ?2
       AND (
         estado = 'CONFIRMADA'
         OR (estado = 'PENDIENTE_PAGO' AND created_at > ?3)
       )
     ORDER BY fecha_hora_inicio ASC`
  )
    .bind(dayEnd, dayStart, cutoff20MinAgo)
    .all<Pick<CitaRow, 'fecha_hora_inicio' | 'fecha_hora_fin' | 'estado'>>();

  let duracionMinutos = 60;
  if (servicioIdParam) {
    const srv = await c.env.DB.prepare(
      'SELECT duracion_minutos FROM servicios WHERE id = ?1 AND activo = 1'
    )
      .bind(Number(servicioIdParam))
      .first<Pick<ServicioRow, 'duracion_minutos'>>();
    if (srv?.duracion_minutos) {
      duracionMinutos = srv.duracion_minutos;
    }
  }

  const horariosDisponibles = await calcularBloquesDisponibles(
    c.env.DB,
    fecha,
    duracionMinutos
  );

  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    modalidad: MODALIDAD_ATENCION_RESERVA,
    fecha,
    duracion_minutos: duracionMinutos,
    ventana_bloqueo_pendiente_minutos: 20,
    bloques_ocupados: bloquesOcupados || [],
    horarios_disponibles: horariosDisponibles,
  });
});

/**
 * POST /api/reservas
 * Verifica solapamiento de horarios justo antes de insertar en D1,
 * crea la cita como PENDIENTE_PAGO, calcula monto_reembolso_80 = Math.round(precio * 0.80),
 * genera el payment link en Wompi con referencia única y devuelve el link privado firmado
 * (?cita=UUID&token=HMAC) junto con el texto legal obligatorio de retención del 20%.
 */
apiRoutes.post('/reservas', async (c) => {
  let body: {
    cliente_nombre?: string;
    cliente_telefono?: string;
    servicio_id?: number;
    fecha_hora_inicio?: string;
    metodo_pago?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Cuerpo JSON inválido' }, 400);
  }

  const clienteNombre = (body.cliente_nombre || '').trim();
  const clienteTelefono = (body.cliente_telefono || '').replace(/\D/g, '');
  const servicioId = Number(body.servicio_id);
  const fechaHoraInicioRaw = (body.fecha_hora_inicio || '').trim();

  if (!clienteNombre || !clienteTelefono || !servicioId || !fechaHoraInicioRaw) {
    return c.json(
      {
        ok: false,
        error:
          'Los campos cliente_nombre, cliente_telefono, servicio_id y fecha_hora_inicio son obligatorios.',
      },
      400
    );
  }

  const servicio = await c.env.DB.prepare(
    'SELECT id, categoria, nombre, descripcion, duracion_minutos, precio_cop, activo FROM servicios WHERE id = ?1 AND activo = 1'
  )
    .bind(servicioId)
    .first<ServicioRow>();

  if (!servicio) {
    return c.json({ ok: false, error: 'Servicio no encontrado o inactivo.' }, 404);
  }

  const startDate = new Date(fechaHoraInicioRaw);
  if (Number.isNaN(startDate.getTime())) {
    return c.json(
      { ok: false, error: 'fecha_hora_inicio debe ser una fecha ISO8601 válida.' },
      400
    );
  }

  const endDate = new Date(startDate.getTime() + servicio.duracion_minutos * 60 * 1000);
  const fechaHoraInicio = startDate.toISOString();
  const fechaHoraFin = endDate.toISOString();
  const cutoff20MinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  // REQUISITO 3D: Verificar solapamiento de horarios justo antes de insertar en D1
  const conflicto = await c.env.DB.prepare(
    `SELECT id, estado FROM citas
     WHERE fecha_hora_inicio < ?1
       AND fecha_hora_fin > ?2
       AND (
         estado = 'CONFIRMADA'
         OR (estado = 'PENDIENTE_PAGO' AND created_at > ?3)
       )
     LIMIT 1`
  )
    .bind(fechaHoraFin, fechaHoraInicio, cutoff20MinAgo)
    .first<Pick<CitaRow, 'id' | 'estado'>>();

  if (conflicto) {
    return c.json(
      {
        ok: false,
        error: 'El bloque horario seleccionado ya se encuentra ocupado o en proceso de pago.',
      },
      409
    );
  }

  const citaId = crypto.randomUUID();
  const precio = servicio.precio_cop;
  const montoReembolso80 = Math.round(precio * 0.80);
  const montoRetencion20 = precio - montoReembolso80;
  const wompiReference = `WMP-${citaId.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  const createdAt = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO citas (
      id,
      cliente_nombre,
      cliente_telefono,
      servicio_id,
      fecha_hora_inicio,
      fecha_hora_fin,
      estado,
      monto_total,
      monto_reembolso_80,
      wompi_reference,
      wompi_transaction_id,
      metodo_pago,
      recordatorio_24h,
      recordatorio_2h,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDIENTE_PAGO', ?7, ?8, ?9, NULL, ?10, 0, 0, ?11)`
  )
    .bind(
      citaId,
      clienteNombre,
      clienteTelefono,
      servicio.id,
      fechaHoraInicio,
      fechaHoraFin,
      precio,
      montoReembolso80,
      wompiReference,
      body.metodo_pago || 'WOMPI',
      createdAt
    )
    .run();

  // REQUISITO 3C: Construir URL con token HMAC exclusivo para que la clienta solo vea/cancele su cita
  const { token: citaAccessToken, url: citaManageUrl } = await buildClientCitaUrl(c.env, citaId);

  const preferredGateway =
    (body.metodo_pago || '').toUpperCase() === 'BOLD' ||
    (!c.env.WOMPI_PUBLIC_KEY && Boolean(c.env.BOLD_IDENTITY_KEY))
      ? 'BOLD'
      : 'WOMPI';

  const payment =
    preferredGateway === 'BOLD'
      ? await createBoldPaymentLink(c.env, {
          reference: wompiReference,
          amountCop: precio,
          serviceName: servicio.nombre,
          customerName: clienteNombre,
          customerPhone: clienteTelefono,
          redirectUrl: citaManageUrl,
        })
      : await createWompiPaymentLink(c.env, {
          reference: wompiReference,
          amountCop: precio,
          serviceName: servicio.nombre,
          customerName: clienteNombre,
          customerPhone: clienteTelefono,
          redirectUrl: citaManageUrl,
        });

  return c.json(
    {
      ok: true,
      negocio: NOMBRE_OFICIAL_NEGOCIO,
      cita: {
        id: citaId,
        cliente_nombre: clienteNombre,
        cliente_telefono: clienteTelefono,
        servicio_id: servicio.id,
        servicio_categoria: servicio.categoria || 'General',
        servicio_nombre: servicio.nombre,
        fecha_hora_inicio: fechaHoraInicio,
        fecha_hora_fin: fechaHoraFin,
        estado: 'PENDIENTE_PAGO',
        monto_total: precio,
        monto_retencion_20: montoRetencion20,
        monto_reembolso_80: montoReembolso80,
        wompi_reference: wompiReference,
        created_at: createdAt,
      },
      payment_link: payment.paymentUrl,
      wompi_reference: payment.reference,
      integrity_signature: payment.integritySignature,
      cita_access_token: citaAccessToken,
      cita_manage_url: citaManageUrl,
      texto_legal_retencion_20: TEXTO_LEGAL_RETENCION_20,
    },
    201
  );
});

// ============================================================================
// 3. ACCESO SEGURO A UNA CITA ESPECÍFICA (CLIENTA CON TOKEN HMAC O ADMIN)
// ============================================================================

/**
 * GET /api/citas/:id?token=HMAC
 * Permite a una clienta consultar ÚNICAMENTE su propia cita mediante su token firmado HMAC,
 * o a la administradora autenticada con Bearer token.
 */
apiRoutes.get('/citas/:id', async (c) => {
  const citaId = c.req.param('id');
  const queryToken = c.req.query('token') || c.req.header('X-Cita-Token');

  const isAdmin = await isValidAdminRequest(c);
  const isClientAuthorized = await verifyCitaAccessToken(citaId, queryToken, c.env);

  if (!isAdmin && !isClientAuthorized) {
    return c.json(
      {
        ok: false,
        error: 'Acceso no autorizado. Se requiere el enlace firmado de tu cita o sesión de administrador.',
      },
      401
    );
  }

  const cita = await c.env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre, s.categoria AS servicio_categoria
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     WHERE c.id = ?1`
  )
    .bind(citaId)
    .first<CitaConServicioRow>();

  if (!cita) {
    return c.json({ ok: false, error: 'Cita no encontrada.' }, 404);
  }

  const montoReembolso80 = cita.monto_reembolso_80 || Math.round(cita.monto_total * 0.80);
  const montoRetencion20 = cita.monto_total - montoReembolso80;

  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    cita: {
      ...cita,
      monto_retencion_20: montoRetencion20,
      monto_reembolso_80: montoReembolso80,
    },
    politica_cancelacion: TEXTO_LEGAL_RETENCION_20,
  });
});

/**
 * POST /api/citas/:id/cancelar
 * Protegido: Solo puede cancelar la administradora (Bearer token) o la clienta dueña
 * de la cita con su token HMAC (?token=HMAC, header X-Cita-Token o body.token).
 * Cambia el estado de la cita a REEMBOLSO_MANUAL_PENDIENTE (si estaba CONFIRMADA) o
 * CANCELADA (si estaba PENDIENTE_PAGO) y envía notificación por WhatsApp a ADMIN_PHONE
 * y a la clienta con el monto exacto a devolver (80%) y retención (20%).
 */
apiRoutes.post('/citas/:id/cancelar', async (c) => {
  const citaId = c.req.param('id');
  let bodyToken: string | undefined;
  try {
    const body = await c.req.json<{ token?: string }>();
    bodyToken = body?.token;
  } catch {
    // Cuerpo opcional
  }

  const clientToken = c.req.query('token') || c.req.header('X-Cita-Token') || bodyToken;
  const isAdmin = await isValidAdminRequest(c);
  const isClientAuthorized = await verifyCitaAccessToken(citaId, clientToken, c.env);

  if (!isAdmin && !isClientAuthorized) {
    return c.json(
      {
        ok: false,
        error: 'No autorizado para cancelar esta cita. Usa el enlace privado de tu reserva o inicia sesión como administrador.',
      },
      401
    );
  }

  const cita = await c.env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     WHERE c.id = ?1`
  )
    .bind(citaId)
    .first<CitaConServicioRow>();

  if (!cita) {
    return c.json({ ok: false, error: 'Cita no encontrada.' }, 404);
  }

  if (
    cita.estado === 'REEMBOLSO_MANUAL_PENDIENTE' ||
    cita.estado === 'REEMBOLSADA' ||
    cita.estado === 'CANCELADA'
  ) {
    return c.json(
      { ok: false, error: `La cita ya se encuentra en estado ${cita.estado}.` },
      400
    );
  }

  const montoReembolso80 = cita.monto_reembolso_80 || Math.round(cita.monto_total * 0.80);
  const montoRetencion20 = cita.monto_total - montoReembolso80;
  const origenCancelacion = isAdmin ? 'Administración Spa Superlook' : 'Clienta';

  await c.env.DB.prepare(
    `UPDATE citas
     SET estado = 'REEMBOLSO_MANUAL_PENDIENTE',
         monto_reembolso_80 = ?1
     WHERE id = ?2`
  )
    .bind(montoReembolso80, citaId)
    .run();

  const servicioNombre = cita.servicio_nombre || `Servicio #${cita.servicio_id}`;

  // Notificar por WhatsApp a ADMIN_PHONE (mamá) con el monto exacto a devolver (80%)
  const adminMessage =
    `⚠️ *[${NOMBRE_OFICIAL_NEGOCIO} - Cancelación de Cita / Reembolso 80% Pendiente]*\n` +
    `• Cancelada por: ${origenCancelacion}\n` +
    `• ID Cita: ${cita.id}\n` +
    `• Clienta: ${cita.cliente_nombre} (${cita.cliente_telefono})\n` +
    `• Servicio: ${servicioNombre}\n` +
    `• Fecha cita: ${cita.fecha_hora_inicio}\n` +
    `• Ref. Wompi: ${cita.wompi_reference || 'N/A'}\n` +
    `• Valor del servicio (100%): ${formatCOP(cita.monto_total)}\n` +
    `• Retención administrativa (20%): ${formatCOP(montoRetencion20)}\n` +
    `• *MONTO EXACTO A REEMBOLSAR (80%): ${formatCOP(montoReembolso80)}*`;

  if (c.env.ADMIN_PHONE) {
    await sendWhatsAppText(c.env, c.env.ADMIN_PHONE, adminMessage);
  }

  // Notificar también a la clienta sobre su reembolso en trámite del 80%
  const clientMessage =
    `Hola *${cita.cliente_nombre}*, tu cita de *${servicioNombre}* (${cita.fecha_hora_inicio}) en *${NOMBRE_OFICIAL_NEGOCIO}* ha sido cancelada.\n\n` +
    `De acuerdo con nuestra política obligatoria de cancelación (retención del 20% equivalentes a ${formatCOP(montoRetencion20)} por gastos administrativos y reserva de agenda), hemos registrado tu reembolso del *80%* por un valor de *${formatCOP(montoReembolso80)}*.`;

  await sendWhatsAppText(c.env, cita.cliente_telefono, clientMessage);

  return c.json({
    ok: true,
    cita_id: cita.id,
    nuevo_estado: 'REEMBOLSO_MANUAL_PENDIENTE',
    cancelada_por: origenCancelacion,
    monto_total: cita.monto_total,
    monto_retencion_20: montoRetencion20,
    monto_reembolso_80: montoReembolso80,
    admin_notificado: Boolean(c.env.ADMIN_PHONE),
    texto_legal_retencion_20: TEXTO_LEGAL_RETENCION_20,
  });
});

// ============================================================================
// 4. ENDPOINTS EXCLUSIVOS DE ADMINISTRACIÓN (PROTEGIDOS CON BEARER TOKEN)
// ============================================================================

/**
 * GET /api/citas
 * PROTEGIDO (Solo Admin): Lista todas las citas registradas en el negocio.
 */
apiRoutes.get('/citas', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json(
      { ok: false, error: 'Acceso restringido. Inicia sesión en el Dashboard Administrativo.' },
      401
    );
  }

  const { results } = await c.env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre, s.categoria AS servicio_categoria
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     ORDER BY c.fecha_hora_inicio DESC`
  ).all<CitaConServicioRow>();

  // Incluir la URL firmada de cada cita para que la mamá pueda compartirla si lo necesita
  const citasConLinks = await Promise.all(
    (results || []).map(async (cita) => {
      const { url } = await buildClientCitaUrl(c.env, cita.id);
      return {
        ...cita,
        monto_retencion_20: cita.monto_total - cita.monto_reembolso_80,
        client_manage_url: url,
      };
    })
  );

  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    citas: citasConLinks,
  });
});

/**
 * POST /api/citas/:id/reembolsar
 * PROTEGIDO (Solo Admin): Marca una cita en REEMBOLSO_MANUAL_PENDIENTE como REEMBOLSADA
 * cuando la mamá ya realizó la devolución del 80% a la clienta.
 */
apiRoutes.post('/citas/:id/reembolsar', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json({ ok: false, error: 'No autorizado.' }, 401);
  }

  const citaId = c.req.param('id');
  const cita = await c.env.DB.prepare(
    `SELECT c.*, s.nombre AS servicio_nombre
     FROM citas c
     LEFT JOIN servicios s ON s.id = c.servicio_id
     WHERE c.id = ?1`
  )
    .bind(citaId)
    .first<CitaConServicioRow>();

  if (!cita) {
    return c.json({ ok: false, error: 'Cita no encontrada.' }, 404);
  }

  await c.env.DB.prepare(`UPDATE citas SET estado = 'REEMBOLSADA' WHERE id = ?1`)
    .bind(citaId)
    .run();

  const servicioNombre = cita.servicio_nombre || `Servicio #${cita.servicio_id}`;
  await sendWhatsAppText(
    c.env,
    cita.cliente_telefono,
    `✅ *${NOMBRE_OFICIAL_NEGOCIO} - Reembolso del 80% Procesado*\nHola *${cita.cliente_nombre}*, te confirmamos que hemos completado el reembolso del 80% (*${formatCOP(cita.monto_reembolso_80)}*) correspondiente a la cancelación de tu cita de *${servicioNombre}*.`
  );

  return c.json({
    ok: true,
    cita_id: citaId,
    nuevo_estado: 'REEMBOLSADA',
    monto_reembolso_80: cita.monto_reembolso_80,
  });
});

/**
 * GET /api/admin/servicios
 * PROTEGIDO (Solo Admin): Lista todos los servicios (activos e inactivos) para gestión del catálogo.
 */
apiRoutes.get('/admin/servicios', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json({ ok: false, error: 'No autorizado.' }, 401);
  }

  const { results } = await c.env.DB.prepare(
    'SELECT id, categoria, nombre, descripcion, duracion_minutos, precio_cop, activo FROM servicios ORDER BY categoria ASC, id ASC'
  ).all<ServicioRow>();

  return c.json({
    ok: true,
    servicios: results || [],
  });
});

/**
 * POST /api/servicios
 * PROTEGIDO (Solo Admin): Crea un nuevo servicio en el catálogo de Spa Superlook.
 */
apiRoutes.post('/servicios', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json({ ok: false, error: 'No autorizado.' }, 401);
  }

  let body: {
    categoria?: string;
    nombre?: string;
    descripcion?: string;
    duracion_minutos?: number;
    precio_cop?: number;
    activo?: number;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Cuerpo JSON inválido' }, 400);
  }

  const categoria = (body.categoria || 'General').trim();
  const nombre = (body.nombre || '').trim();
  const descripcion = (body.descripcion || '').trim();
  const duracionMinutos = Number(body.duracion_minutos);
  const precioCop = Number(body.precio_cop);
  const activo = body.activo === undefined ? 1 : body.activo ? 1 : 0;

  if (!nombre || !descripcion || !duracionMinutos || duracionMinutos <= 0 || !precioCop || precioCop <= 0) {
    return c.json(
      {
        ok: false,
        error: 'Nombre, descripción, duración en minutos (>0) y precio en COP (>0) son obligatorios.',
      },
      400
    );
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO servicios (categoria, nombre, descripcion, duracion_minutos, precio_cop, activo)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(categoria, nombre, descripcion, duracionMinutos, precioCop, activo)
    .run();

  return c.json(
    {
      ok: true,
      servicio: {
        id: res.meta.last_row_id,
        categoria,
        nombre,
        descripcion,
        duracion_minutos: duracionMinutos,
        precio_cop: precioCop,
        activo,
      },
    },
    201
  );
});

/**
 * PUT /api/servicios/:id
 * PROTEGIDO (Solo Admin): Actualiza un servicio existente (categoría, nombre, precio, duración, estado activo).
 */
apiRoutes.put('/servicios/:id', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json({ ok: false, error: 'No autorizado.' }, 401);
  }

  const servicioId = Number(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT * FROM servicios WHERE id = ?1')
    .bind(servicioId)
    .first<ServicioRow>();

  if (!existing) {
    return c.json({ ok: false, error: 'Servicio no encontrado.' }, 404);
  }

  let body: Partial<ServicioRow>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Cuerpo JSON inválido' }, 400);
  }

  const categoria = body.categoria !== undefined ? String(body.categoria).trim() : existing.categoria || 'General';
  const nombre = body.nombre !== undefined ? String(body.nombre).trim() : existing.nombre;
  const descripcion = body.descripcion !== undefined ? String(body.descripcion).trim() : existing.descripcion;
  const duracionMinutos =
    body.duracion_minutos !== undefined ? Number(body.duracion_minutos) : existing.duracion_minutos;
  const precioCop = body.precio_cop !== undefined ? Number(body.precio_cop) : existing.precio_cop;
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : existing.activo;

  await c.env.DB.prepare(
    `UPDATE servicios
     SET categoria = ?1,
         nombre = ?2,
         descripcion = ?3,
         duracion_minutos = ?4,
         precio_cop = ?5,
         activo = ?6
     WHERE id = ?7`
  )
    .bind(categoria, nombre, descripcion, duracionMinutos, precioCop, activo, servicioId)
    .run();

  return c.json({
    ok: true,
    servicio: {
      id: servicioId,
      categoria,
      nombre,
      descripcion,
      duracion_minutos: duracionMinutos,
      precio_cop: precioCop,
      activo,
    },
  });
});

/**
 * DELETE /api/servicios/:id
 * PROTEGIDO (Solo Admin): Desactiva (soft-delete) un servicio del catálogo para no romper integridad de citas históricas.
 */
apiRoutes.delete('/servicios/:id', async (c) => {
  const isAdmin = await isValidAdminRequest(c);
  if (!isAdmin) {
    return c.json({ ok: false, error: 'No autorizado.' }, 401);
  }

  const servicioId = Number(c.req.param('id'));
  await c.env.DB.prepare('UPDATE servicios SET activo = 0 WHERE id = ?1').bind(servicioId).run();

  return c.json({
    ok: true,
    servicio_id: servicioId,
    activo: 0,
  });
});

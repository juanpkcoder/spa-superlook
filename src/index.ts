import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  Env,
  MODALIDAD_ATENCION_RESERVA,
  NOMBRE_OFICIAL_NEGOCIO,
  TEXTO_LEGAL_RETENCION_20,
} from './types';
import { apiRoutes } from './routes/api';
import { webhookRoutes } from './routes/webhooks';
import { processScheduledReminders } from './cron/reminders';
import { createSupabaseD1Adapter } from './services/supabase-d1';
import { isValidAdminRequest, timingSafeEqualStr } from './services/security';

export const app = new Hono<{ Bindings: Env }>();

function readMergedEnv(cfEnv: Partial<Env> | undefined): Env {
  const hasProc = typeof process !== 'undefined' && typeof process.env === 'object' && process.env !== null;
  const pick = (cfVal: string | undefined, procVal: string | undefined, fallback = ''): string => {
    const a = (cfVal || '').trim();
    if (a) return a;
    const b = (procVal || '').trim();
    if (b) return b;
    return fallback;
  };

  const merged: Env = {
    DB: cfEnv?.DB as D1Database,
    BUCKET: cfEnv?.BUCKET,
    ASSETS: cfEnv?.ASSETS,
    DASHBOARD_URL: pick(
      cfEnv?.DASHBOARD_URL,
      hasProc ? process.env.DASHBOARD_URL : undefined,
      'https://spa-superlook.vercel.app'
    ),
    ADMIN_PHONE: pick(
      cfEnv?.ADMIN_PHONE,
      hasProc ? process.env.ADMIN_PHONE : undefined,
      '573102319617'
    ),
    WOMPI_BASE_URL: pick(
      cfEnv?.WOMPI_BASE_URL,
      hasProc ? process.env.WOMPI_BASE_URL : undefined,
      'https://sandbox.wompi.co/v1'
    ),
    SUPABASE_URL: pick(cfEnv?.SUPABASE_URL, hasProc ? process.env.SUPABASE_URL : undefined),
    SUPABASE_SERVICE_ROLE_KEY: pick(
      cfEnv?.SUPABASE_SERVICE_ROLE_KEY,
      hasProc ? process.env.SUPABASE_SERVICE_ROLE_KEY : undefined
    ),
    CRON_SECRET: pick(cfEnv?.CRON_SECRET, hasProc ? process.env.CRON_SECRET : undefined),
    ADMIN_DASHBOARD_SECRET: pick(
      cfEnv?.ADMIN_DASHBOARD_SECRET,
      hasProc ? process.env.ADMIN_DASHBOARD_SECRET : undefined
    ),
    WOMPI_PUBLIC_KEY: pick(
      cfEnv?.WOMPI_PUBLIC_KEY,
      hasProc ? process.env.WOMPI_PUBLIC_KEY : undefined
    ),
    WOMPI_PRIVATE_KEY: pick(
      cfEnv?.WOMPI_PRIVATE_KEY,
      hasProc ? process.env.WOMPI_PRIVATE_KEY : undefined
    ),
    WOMPI_EVENTS_SECRET: pick(
      cfEnv?.WOMPI_EVENTS_SECRET,
      hasProc ? process.env.WOMPI_EVENTS_SECRET : undefined
    ),
    WOMPI_INTEGRITY_SECRET: pick(
      cfEnv?.WOMPI_INTEGRITY_SECRET,
      hasProc ? process.env.WOMPI_INTEGRITY_SECRET : undefined
    ),
    BOLD_IDENTITY_KEY: pick(
      cfEnv?.BOLD_IDENTITY_KEY,
      hasProc ? process.env.BOLD_IDENTITY_KEY : undefined
    ),
    BOLD_SECRET_KEY: pick(
      cfEnv?.BOLD_SECRET_KEY,
      hasProc ? process.env.BOLD_SECRET_KEY : undefined
    ),
    WHATSAPP_PHONE_NUMBER_ID: pick(
      cfEnv?.WHATSAPP_PHONE_NUMBER_ID,
      hasProc ? process.env.WHATSAPP_PHONE_NUMBER_ID : undefined
    ),
    WHATSAPP_ACCESS_TOKEN: pick(
      cfEnv?.WHATSAPP_ACCESS_TOKEN,
      hasProc ? process.env.WHATSAPP_ACCESS_TOKEN : undefined
    ),
    WHATSAPP_VERIFY_TOKEN: pick(
      cfEnv?.WHATSAPP_VERIFY_TOKEN,
      hasProc ? process.env.WHATSAPP_VERIFY_TOKEN : undefined
    ),
    META_APP_SECRET: pick(
      cfEnv?.META_APP_SECRET,
      hasProc ? process.env.META_APP_SECRET : undefined
    ),
    GEMINI_API_KEY: pick(
      cfEnv?.GEMINI_API_KEY,
      hasProc ? process.env.GEMINI_API_KEY : undefined
    ),
  };

  if (!merged.DB && merged.SUPABASE_URL && merged.SUPABASE_SERVICE_ROLE_KEY) {
    merged.DB = createSupabaseD1Adapter(
      merged.SUPABASE_URL,
      merged.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  return merged;
}

// Middleware híbrido Cloudflare Workers (D1) + Vercel Edge/Node (Supabase PostgreSQL) + Cabeceras de Seguridad
app.use('*', async (c, next) => {
  c.env = readMergedEnv(c.env);
  await next();
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  if (c.req.path.startsWith('/api/')) {
    c.header('Cache-Control', 'no-store, max-age=0');
  }
});

// Manejo centralizado de errores en JSON limpio (sin filtrar trazas ni credenciales)
app.onError((err, c) => {
  console.error('Unhandled error in Spa Superlook API:', err);
  return c.json(
    {
      ok: false,
      error: 'Ocurrió un error interno procesando la solicitud. Intenta de nuevo.',
    },
    500
  );
});

// Configurar CORS restringido únicamente a env.DASHBOARD_URL (y localhost solo en desarrollo)
app.use(
  '/api/*',
  cors({
    origin: (requestOrigin, c) => {
      const configuredUrl = (c.env.DASHBOARD_URL || 'https://spa-superlook.vercel.app').replace(/\/$/, '');
      if (!requestOrigin) {
        return configuredUrl;
      }
      const normalizedOrigin = requestOrigin.replace(/\/$/, '');
      if (normalizedOrigin === configuredUrl) {
        return requestOrigin;
      }

      const isLocalDev =
        configuredUrl.includes('localhost') || configuredUrl.includes('127.0.0.1');
      if (
        isLocalDev &&
        (normalizedOrigin.startsWith('http://localhost:') ||
          normalizedOrigin.startsWith('http://127.0.0.1:'))
      ) {
        return requestOrigin;
      }

      return configuredUrl;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Cita-Token'],
    maxAge: 86400,
  })
);

// Endpoint de salud y metadatos públicos del servicio
app.get('/api/info', (c) => {
  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    modalidad: MODALIDAD_ATENCION_RESERVA,
    politica_cancelacion: TEXTO_LEGAL_RETENCION_20,
    retencion_porcentaje: 20,
    reembolso_porcentaje: 80,
    db_connected: Boolean(c.env.DB),
    whatsapp_configured: Boolean(c.env.WHATSAPP_PHONE_NUMBER_ID && c.env.WHATSAPP_ACCESS_TOKEN),
  });
});

// Endpoint para Cron Jobs en Vercel (/api/cron/reminders) o ejecución manual autenticada
app.get('/api/cron/reminders', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const cronSecret = (c.env.CRON_SECRET || c.env.ADMIN_DASHBOARD_SECRET || '').trim();
  const isAdmin = await isValidAdminRequest(c);
  const isCronAuth =
    cronSecret !== '' &&
    authHeader.startsWith('Bearer ') &&
    timingSafeEqualStr(authHeader.slice(7).trim(), cronSecret);

  if (!isAdmin && !isCronAuth) {
    return c.json({ ok: false, error: 'No autorizado para ejecutar recordatorios.' }, 401);
  }

  const summary = await processScheduledReminders(c.env);
  return c.json({
    ok: true,
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    summary,
  });
});

// Rutas de API para el Frontend / Dashboard
app.route('/api', apiRoutes);

// Rutas de Webhooks para Wompi, Bold y Meta WhatsApp Cloud API
app.route('/webhooks', webhookRoutes);

// Fallback y página 404 para rutas no encontradas
app.all('*', async (c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/webhooks/')) {
    return c.json(
      {
        ok: false,
        error: 'Recurso no encontrado (404).',
      },
      404
    );
  }
  if (c.env.ASSETS) {
    const assetRes = await c.env.ASSETS.fetch(c.req.raw);
    if (assetRes.status === 404) {
      const notFoundUrl = new URL('/404.html', c.req.url);
      const custom404 = await c.env.ASSETS.fetch(new Request(notFoundUrl.toString()));
      return new Response(custom404.body, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return assetRes;
  }
  return c.json(
    {
      ok: false,
      error: 'Página no encontrada (404).',
    },
    404
  );
});

export default {
  fetch: app.fetch,

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(processScheduledReminders(readMergedEnv(env)));
  },
};

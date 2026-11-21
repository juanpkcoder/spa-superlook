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

// Middleware híbrido Cloudflare Workers (D1) + Vercel (Supabase PostgreSQL)
app.use('*', async (c, next) => {
  const globalProc = (globalThis as unknown as { process?: { env?: Record<string, string> } })
    .process;
  const procEnv = globalProc?.env || {};
  const mergedEnv = Object.assign(
    {
      DASHBOARD_URL: procEnv.DASHBOARD_URL || 'http://localhost:3000',
      ADMIN_PHONE: procEnv.ADMIN_PHONE || '573102319617',
      WOMPI_BASE_URL: procEnv.WOMPI_BASE_URL || 'https://sandbox.wompi.co/v1',
    },
    procEnv,
    c.env || {}
  ) as Env;

  if (!mergedEnv.DB && mergedEnv.SUPABASE_URL && mergedEnv.SUPABASE_SERVICE_ROLE_KEY) {
    mergedEnv.DB = createSupabaseD1Adapter(
      mergedEnv.SUPABASE_URL,
      mergedEnv.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  c.env = mergedEnv;
  await next();
});

// Configurar CORS restringido únicamente a env.DASHBOARD_URL (y localhost solo en desarrollo)
app.use(
  '/api/*',
  cors({
    origin: (requestOrigin, c) => {
      const configuredUrl = (c.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
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

// Rutas de Webhooks para Wompi y Meta WhatsApp Cloud API
app.route('/webhooks', webhookRoutes);

// Fallback: Si el binding de ASSETS está disponible, sirve el Dashboard; de lo contrario, JSON de estado
app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({
    ok: true,
    service: 'superlook-estetica-worker',
    negocio: NOMBRE_OFICIAL_NEGOCIO,
    modalidad: MODALIDAD_ATENCION_RESERVA,
    runtime: 'Cloudflare Workers / Vercel Edge + Hono + D1 / Supabase',
    politica_cancelacion: TEXTO_LEGAL_RETENCION_20,
  });
});

export default {
  fetch: app.fetch,

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(processScheduledReminders(env));
  },
};

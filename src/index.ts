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

const app = new Hono<{ Bindings: Env }>();

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
    runtime: 'Cloudflare Workers + Hono + D1 + R2',
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

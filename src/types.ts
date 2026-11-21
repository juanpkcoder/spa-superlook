export interface Env {
  // Bindings de Cloudflare
  DB: D1Database;
  BUCKET?: R2Bucket;
  ASSETS?: Fetcher;

  // Variables públicas en [vars] (wrangler.toml)
  DASHBOARD_URL: string;
  ADMIN_PHONE: string;
  WOMPI_BASE_URL: string;

  // Variables secretas (.dev.vars / wrangler secret)
  ADMIN_DASHBOARD_SECRET: string;
  WOMPI_PUBLIC_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_EVENTS_SECRET: string;
  WOMPI_INTEGRITY_SECRET: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_VERIFY_TOKEN: string;
  META_APP_SECRET?: string;
  GEMINI_API_KEY: string;
}

export type EstadoCita =
  | 'PENDIENTE_PAGO'
  | 'CONFIRMADA'
  | 'CANCELADA'
  | 'REEMBOLSO_MANUAL_PENDIENTE'
  | 'REEMBOLSADA';

export interface ServicioRow {
  id: number;
  categoria?: string;
  nombre: string;
  descripcion: string;
  duracion_minutos: number;
  precio_cop: number;
  activo: number;
}

export interface CitaRow {
  id: string;
  cliente_nombre: string;
  cliente_telefono: string;
  servicio_id: number;
  fecha_hora_inicio: string;
  fecha_hora_fin: string;
  estado: EstadoCita;
  monto_total: number;
  monto_reembolso_80: number;
  wompi_reference: string | null;
  wompi_transaction_id: string | null;
  metodo_pago: string | null;
  recordatorio_24h: number;
  recordatorio_2h: number;
  created_at: string;
}

export interface CitaConServicioRow extends CitaRow {
  servicio_nombre: string;
  servicio_categoria?: string;
}

export interface ChatSesionRow {
  telefono: string;
  historial_json: string;
  updated_at: string;
}

export const NOMBRE_OFICIAL_NEGOCIO = 'Spa Superlook';

export const MODALIDAD_ATENCION_RESERVA =
  'Atención ÚNICAMENTE bajo reserva previa confirmada. No manejamos horario fijo de atención al público sin cita; la disponibilidad depende de los bloques libres en agenda.';

export const TEXTO_LEGAL_RETENCION_20 =
  'Política obligatoria de reserva y cancelación de Spa Superlook: Atendemos únicamente bajo reserva previa con pago anticipado del 100%. En caso de cancelación, se reembolsa el 80% del valor pagado y se retiene el 20% por gastos administrativos y reserva de agenda.';

export function formatCOP(valor: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(valor);
}

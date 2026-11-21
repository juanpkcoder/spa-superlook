import { Env } from '../types';

export interface WompiWebhookPayload {
  event: string;
  data: {
    transaction?: {
      id: string;
      status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'PENDING';
      reference: string;
      amount_in_cents: number;
      currency: string;
      payment_method_type?: string;
      customer_email?: string;
    };
    [key: string]: unknown;
  };
  environment?: string;
  signature?: {
    properties: string[];
    checksum: string;
  };
  timestamp: number;
  sent_at?: string;
}

export interface CreatePaymentLinkParams {
  reference: string;
  amountCop: number;
  serviceName: string;
  customerName: string;
  customerPhone: string;
  redirectUrl: string;
}

export interface CreatePaymentLinkResult {
  paymentUrl: string;
  reference: string;
  amountInCents: number;
  integritySignature: string;
}

/**
 * Calcula un hash SHA-256 hexadecimal usando Web Crypto API nativa de Cloudflare Workers.
 */
export async function sha256Hex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Genera la firma de integridad de Wompi:
 * SHA256(referencia + montoEnCentavos + moneda + secretoIntegridad)
 */
export async function generateWompiIntegritySignature(
  reference: string,
  amountInCents: number,
  currency: string,
  integritySecret: string
): Promise<string> {
  const raw = `${reference}${amountInCents}${currency}${integritySecret}`;
  return sha256Hex(raw);
}

/**
 * Crea un link de pago para Wompi.
 * Si WOMPI_PRIVATE_KEY está configurada y se desea crear vía API (/payment_links), intenta crearlo;
 * además construye la URL firmada de Web Checkout con la referencia única garantizada.
 */
export async function createWompiPaymentLink(
  env: Env,
  params: CreatePaymentLinkParams
): Promise<CreatePaymentLinkResult> {
  const amountInCents = Math.round(params.amountCop * 100);
  const currency = 'COP';
  const integritySecret = env.WOMPI_INTEGRITY_SECRET || 'test_integrity_secret';
  const publicKey = env.WOMPI_PUBLIC_KEY || 'pub_test_placeholder';

  const integritySignature = await generateWompiIntegritySignature(
    params.reference,
    amountInCents,
    currency,
    integritySecret
  );

  // Intentar crear Payment Link vía API REST de Wompi si hay llave privada configurada
  if (env.WOMPI_PRIVATE_KEY && env.WOMPI_BASE_URL) {
    try {
      const response = await fetch(`${env.WOMPI_BASE_URL.replace(/\/$/, '')}/payment_links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WOMPI_PRIVATE_KEY}`,
        },
        body: JSON.stringify({
          name: `Reserva: ${params.serviceName}`,
          description: `Cita para ${params.customerName} (${params.reference}) - Retención 20% por cancelación`,
          single_use: true,
          collect_shipping: false,
          currency,
          amount_in_cents: amountInCents,
          redirect_url: params.redirectUrl,
          sku: params.reference,
        }),
      });

      if (response.ok) {
        const json = (await response.json()) as { data?: { id?: string } };
        if (json?.data?.id) {
          return {
            paymentUrl: `https://checkout.wompi.co/l/${json.data.id}`,
            reference: params.reference,
            amountInCents,
            integritySignature,
          };
        }
      }
    } catch {
      // Fallback silencioso a URL firmada de Web Checkout
    }
  }

  // Construcción de URL firmada para Wompi Web Checkout con referencia única
  const query = new URLSearchParams({
    'public-key': publicKey,
    currency,
    'amount-in-cents': String(amountInCents),
    reference: params.reference,
    'signature:integrity': integritySignature,
    'redirect-url': params.redirectUrl,
    'customer-data:full-name': params.customerName,
    'customer-data:phone-number': params.customerPhone.replace(/^57/, ''),
    'customer-data:phone-number-prefix': '+57',
  });

  return {
    paymentUrl: `https://checkout.wompi.co/p/?${query.toString()}`,
    reference: params.reference,
    amountInCents,
    integritySignature,
  };
}

/**
 * Extrae una propiedad anidada desde `data` usando notación de puntos (ej. "transaction.id").
 */
function getNestedValue(obj: Record<string, unknown>, path: string): string {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }
  return current === undefined || current === null ? '' : String(current);
}

/**
 * Valida la firma criptográfica `x-event-checksum` de un webhook de Wompi
 * usando Web Crypto API (`crypto.subtle.digest('SHA-256', ...)`) con `WOMPI_EVENTS_SECRET`.
 */
export async function verifyWompiWebhookSignature(
  payload: WompiWebhookPayload,
  headerChecksum: string | null | undefined,
  eventsSecret: string
): Promise<boolean> {
  if (!eventsSecret) {
    return false;
  }

  const expectedChecksum = (headerChecksum || payload.signature?.checksum || '').trim().toLowerCase();
  const properties = payload.signature?.properties;

  if (!expectedChecksum || !Array.isArray(properties) || typeof payload.timestamp !== 'number') {
    return false;
  }

  const concatenatedProps = properties
    .map((propPath) => getNestedValue(payload.data as Record<string, unknown>, propPath))
    .join('');

  const rawToHash = `${concatenatedProps}${payload.timestamp}${eventsSecret}`;
  const computedChecksum = (await sha256Hex(rawToHash)).toLowerCase();

  if (computedChecksum.length !== expectedChecksum.length) {
    return false;
  }

  // Comparación en tiempo constante
  let mismatch = 0;
  for (let i = 0; i < computedChecksum.length; i++) {
    mismatch |= computedChecksum.charCodeAt(i) ^ expectedChecksum.charCodeAt(i);
  }
  return mismatch === 0;
}

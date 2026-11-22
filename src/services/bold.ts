import { Env } from '../types';
import { sha256Hex, CreatePaymentLinkParams, CreatePaymentLinkResult } from './wompi';
import { hmacSha256Hex, timingSafeEqualStr } from './security';

export interface BoldWebhookEvent {
  id?: string;
  type: 'SALE_APPROVED' | 'SALE_REJECTED' | 'VOID_APPROVED' | 'VOID_REJECTED' | string;
  subject?: string;
  time?: number;
  data?: {
    payment_id?: string;
    payment_link?: string;
    reference?: string;
    amount?: { total?: number; currency?: string };
    metadata?: { reference?: string };
    payment_method?: string;
  };
}

/**
 * Genera el hash de integridad oficial de Bold:
 * SHA-256(reference + amountCop + currency + boldSecretKey)
 * Nota: A diferencia de Wompi (que usa centavos), Bold usa el monto entero en pesos (COP).
 */
export async function generateBoldIntegritySignature(
  reference: string,
  amountCop: number,
  currency: string,
  boldSecretKey: string
): Promise<string> {
  const raw = `${reference}${Math.round(amountCop)}${currency}${boldSecretKey}`;
  return sha256Hex(raw);
}

/**
 * Crea un Link de Pago automático en Bold vía API oficial (`POST /online/link/v1`).
 * Devuelve la URL oficial de checkout de Bold (`https://checkout.bold.co/payment/LNK_...`)
 * y el `payment_link` (`LNK_...`) que Bold enviará luego en `metadata.reference` del Webhook.
 */
export async function createBoldPaymentLink(
  env: Env,
  params: CreatePaymentLinkParams
): Promise<CreatePaymentLinkResult> {
  const amountCop = Math.round(params.amountCop);
  const currency = 'COP';
  const identityKey = (env.BOLD_IDENTITY_KEY || '').trim();
  const secretKey = (env.BOLD_SECRET_KEY || '').trim() || 'bold_sk_test_placeholder';

  const integritySignature = await generateBoldIntegritySignature(
    params.reference,
    amountCop,
    currency,
    secretKey
  );

  // 1. Crear Link de Pago automático vía API oficial de Bold
  if (identityKey && !identityKey.includes('placeholder')) {
    try {
      const cleanDesc = `Spa Superlook: ${params.serviceName} - ${params.customerName}`.slice(0, 95);
      const response = await fetch('https://integrations.api.bold.co/online/link/v1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `x-api-key ${identityKey}`,
        },
        body: JSON.stringify({
          amount_type: 'CLOSE',
          amount: {
            currency,
            total_amount: amountCop,
            tip_amount: 0,
          },
          description: cleanDesc,
          callback_url: params.redirectUrl,
        }),
      });

      if (response.ok) {
        const json = (await response.json()) as {
          payload?: { payment_link?: string; url?: string };
        };
        if (json?.payload?.url) {
          const boldLinkId = json.payload.payment_link || params.reference;
          return {
            paymentUrl: json.payload.url,
            reference: boldLinkId,
            amountInCents: amountCop * 100,
            integritySignature,
          };
        }
      } else {
        const errBody = await response.text();
        console.error(`Bold API /online/link/v1 error (${response.status}):`, errBody);
      }
    } catch (err) {
      console.error('Bold API network error:', err);
    }
  }

  // 2. Fallback a URL de Checkout de Bold con firma de integridad SHA-256
  const query = new URLSearchParams({
    'api-key': identityKey || 'bold_pk_test_placeholder',
    'order-id': params.reference,
    amount: String(amountCop),
    currency,
    'integrity-signature': integritySignature,
    description: `Reserva Spa Superlook: ${params.serviceName}`.slice(0, 95),
    'redirection-url': params.redirectUrl,
  });

  return {
    paymentUrl: `https://checkout.bold.co/payment/?${query.toString()}`,
    reference: params.reference,
    amountInCents: amountCop * 100,
    integritySignature,
  };
}

/**
 * Codifica un string UTF-8 a Base64 compatible con Cloudflare Workers / Vercel Edge.
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Verifica la firma `x-bold-signature` de un webhook de Bold:
 * HMAC-SHA256(key = BOLD_SECRET_KEY o BOLD_IDENTITY_KEY, message = base64(rawBody)) en hexadecimal.
 */
export async function verifyBoldWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  boldSecretKey: string | undefined,
  boldIdentityKey?: string | undefined
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }
  const cleanSignature = signatureHeader.trim().toLowerCase();
  const base64Body = utf8ToBase64(rawBody);
  const candidateSecrets = [boldSecretKey, boldIdentityKey]
    .map((s) => (s || '').trim())
    .filter((s) => s.length > 0);

  if (candidateSecrets.length === 0) {
    return false;
  }

  for (const secret of candidateSecrets) {
    const expectedBase64Hex = (await hmacSha256Hex(secret, base64Body)).toLowerCase();
    if (timingSafeEqualStr(expectedBase64Hex, cleanSignature)) {
      return true;
    }
    const directHex = (await hmacSha256Hex(secret, rawBody)).toLowerCase();
    if (timingSafeEqualStr(directHex, cleanSignature)) {
      return true;
    }
  }

  return false;
}

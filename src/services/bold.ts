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
 * Crea un Link de Pago en Bold (vía API de Links de Pago o URL de Checkout con firma de integridad).
 */
export async function createBoldPaymentLink(
  env: Env,
  params: CreatePaymentLinkParams
): Promise<CreatePaymentLinkResult> {
  const amountCop = Math.round(params.amountCop);
  const currency = 'COP';
  const identityKey = (env.BOLD_IDENTITY_KEY || '').trim() || 'bold_pk_test_placeholder';
  const secretKey = (env.BOLD_SECRET_KEY || '').trim() || 'bold_sk_test_placeholder';

  const integritySignature = await generateBoldIntegritySignature(
    params.reference,
    amountCop,
    currency,
    secretKey
  );

  // 1. Intentar crear Link de Pago vía API oficial de Bold si BOLD_IDENTITY_KEY está configurada
  if (env.BOLD_IDENTITY_KEY && !env.BOLD_IDENTITY_KEY.includes('placeholder')) {
    try {
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
          },
          reference: params.reference,
          description: `Reserva Spa Superlook: ${params.serviceName} - ${params.customerName} (${params.reference})`,
          callback_url: params.redirectUrl,
        }),
      });

      if (response.ok) {
        const json = (await response.json()) as {
          payload?: { payment_link?: string; url?: string };
        };
        if (json?.payload?.url) {
          return {
            paymentUrl: json.payload.url,
            reference: params.reference,
            amountInCents: amountCop * 100,
            integritySignature,
          };
        }
      }
    } catch {
      // Fallback a URL de Checkout Bold firmada
    }
  }

  // 2. Fallback a URL de Checkout de Bold con parámetros firmados
  const query = new URLSearchParams({
    'api-key': identityKey,
    'order-id': params.reference,
    amount: String(amountCop),
    currency,
    'integrity-signature': integritySignature,
    description: `Reserva Spa Superlook: ${params.serviceName}`,
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
 * HMAC-SHA256(key = BOLD_SECRET_KEY, message = base64(rawBody)) en hexadecimal.
 */
export async function verifyBoldWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  boldSecretKey: string | undefined
): Promise<boolean> {
  if (!boldSecretKey || !signatureHeader) {
    return false;
  }
  const cleanSignature = signatureHeader.trim().toLowerCase();
  const base64Body = utf8ToBase64(rawBody);
  const expectedHex = (await hmacSha256Hex(boldSecretKey.trim(), base64Body)).toLowerCase();

  // También soportar firma sobre rawBody directo por compatibilidad entre versiones de Bold
  if (timingSafeEqualStr(expectedHex, cleanSignature)) {
    return true;
  }
  const directHex = (await hmacSha256Hex(boldSecretKey.trim(), rawBody)).toLowerCase();
  return timingSafeEqualStr(directHex, cleanSignature);
}

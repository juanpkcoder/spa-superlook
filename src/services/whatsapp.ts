import { Env } from '../types';

export interface WhatsAppApiResponse {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface WhatsAppMediaDownloadResult {
  ok: boolean;
  base64?: string;
  mimeType?: string;
  sizeBytes?: number;
  error?: string;
}

const META_GRAPH_VERSION = 'v21.0';
const MAX_MEDIA_BYTES = 5 * 1024 * 1024; // 5 MB máximo seguro para Edge/Workers

export function normalizeWhatsAppPhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) {
    return `57${digits}`;
  }
  return digits;
}

function normalizePhone(phone: string): string {
  return normalizeWhatsAppPhone(phone);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Descarga un archivo multimedia (foto de referencia de uñas/cabello) desde Meta Graph API
 * y lo devuelve en base64 + mimeType listo para enviarlo a Gemini Vision.
 */
export async function downloadWhatsAppMediaAsBase64(
  env: Env,
  mediaId: string
): Promise<WhatsAppMediaDownloadResult> {
  if (!mediaId || !env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: 'Media ID o WHATSAPP_ACCESS_TOKEN no disponible' };
  }

  try {
    const metaUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!metaRes.ok) {
      return { ok: false, error: `Meta media lookup HTTP ${metaRes.status}` };
    }

    const metaJson = (await metaRes.json()) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };

    if (!metaJson.url) {
      return { ok: false, error: 'Meta no devolvió URL de descarga para la imagen' };
    }

    if (metaJson.file_size && metaJson.file_size > MAX_MEDIA_BYTES) {
      return { ok: false, error: 'La imagen supera el límite máximo permitido (5 MB)' };
    }

    const binRes = await fetch(metaJson.url, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!binRes.ok) {
      return { ok: false, error: `Meta media download HTTP ${binRes.status}` };
    }

    const buffer = await binRes.arrayBuffer();
    if (buffer.byteLength > MAX_MEDIA_BYTES) {
      return { ok: false, error: 'La imagen descargada supera los 5 MB' };
    }

    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      mimeType: metaJson.mime_type || binRes.headers.get('content-type') || 'image/jpeg',
      sizeBytes: buffer.byteLength,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error descargando imagen de WhatsApp',
    };
  }
}

/**
 * Reenvía una imagen de WhatsApp (por su media_id de Meta) con un caption informativo.
 * Ideal para reenviarle a Mamá la foto real de uñas o cabello que mandó la clienta.
 * Si falla el envío de imagen, hace fallback automático a texto para no perder la alerta.
 */
export async function sendWhatsAppImageById(
  env: Env,
  toPhone: string,
  mediaId: string,
  caption: string
): Promise<WhatsAppApiResponse> {
  const cleanTo = normalizePhone(toPhone);
  if (!cleanTo) {
    return { ok: false, error: 'Número de destino vacío o inválido' };
  }

  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`[WhatsApp Mock Image (${mediaId}) -> ${cleanTo}]: ${caption}`);
    return { ok: true, messageId: `mock-img-${Date.now()}` };
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'image',
        image: {
          id: mediaId,
          caption: caption.slice(0, 1020),
        },
      }),
    });

    const data = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message: string };
    };

    if (!response.ok) {
      console.error('sendWhatsAppImageById fallback a texto:', data?.error?.message || response.status);
      return sendWhatsAppText(env, cleanTo, caption);
    }

    return {
      ok: true,
      messageId: data?.messages?.[0]?.id,
    };
  } catch (err) {
    console.error('sendWhatsAppImageById network fallback a texto:', err);
    return sendWhatsAppText(env, cleanTo, caption);
  }
}

/**
 * Envía un mensaje de texto libre mediante Meta WhatsApp Cloud API.
 */
export async function sendWhatsAppText(
  env: Env,
  toPhone: string,
  bodyText: string
): Promise<WhatsAppApiResponse> {
  const cleanTo = normalizePhone(toPhone);
  if (!cleanTo) {
    return { ok: false, error: 'Número de destino vacío o inválido' };
  }

  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`[WhatsApp Mock Text -> ${cleanTo}]: ${bodyText}`);
    return { ok: true, messageId: `mock-msg-${Date.now()}` };
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'text',
        text: {
          preview_url: true,
          body: bodyText,
        },
      }),
    });

    const data = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message: string };
    };

    if (!response.ok) {
      return {
        ok: false,
        error: data?.error?.message || `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      messageId: data?.messages?.[0]?.id,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error de red enviando mensaje de WhatsApp',
    };
  }
}

/**
 * Envía una plantilla aprobada de Meta WhatsApp Cloud API.
 * Si la plantilla falla o no está configurada, hace fallback opcional a mensaje de texto.
 */
export async function sendWhatsAppTemplate(
  env: Env,
  toPhone: string,
  templateName: string,
  parameters: string[],
  languageCode = 'es_CO',
  fallbackText?: string
): Promise<WhatsAppApiResponse> {
  const cleanTo = normalizePhone(toPhone);
  if (!cleanTo) {
    return { ok: false, error: 'Número de destino vacío o inválido' };
  }

  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    console.log(
      `[WhatsApp Mock Template (${templateName}) -> ${cleanTo}]: params=${JSON.stringify(parameters)}`
    );
    return { ok: true, messageId: `mock-tpl-${Date.now()}` };
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
          components: [
            {
              type: 'body',
              parameters: parameters.map((text) => ({
                type: 'text',
                text,
              })),
            },
          ],
        },
      }),
    });

    const data = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message: string };
    };

    if (!response.ok) {
      if (fallbackText) {
        return sendWhatsAppText(env, cleanTo, fallbackText);
      }
      return {
        ok: false,
        error: data?.error?.message || `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      messageId: data?.messages?.[0]?.id,
    };
  } catch (err) {
    if (fallbackText) {
      return sendWhatsAppText(env, cleanTo, fallbackText);
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error de red enviando plantilla de WhatsApp',
    };
  }
}

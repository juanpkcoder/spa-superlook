import { Env } from '../types';

export interface WhatsAppApiResponse {
  ok: boolean;
  messageId?: string;
  error?: string;
}

const META_GRAPH_VERSION = 'v21.0';

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) {
    return `57${digits}`;
  }
  return digits;
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

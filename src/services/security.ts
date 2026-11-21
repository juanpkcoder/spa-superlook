import { Context } from 'hono';
import { Env } from '../types';

const encoder = new TextEncoder();

/**
 * Genera un HMAC-SHA256 en formato hexadecimal usando Web Crypto API.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Comparación de strings en tiempo constante para evitar ataques de timing.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Obtiene el secreto maestro para firmar tokens del dashboard y enlaces de citas.
 */
export function getDashboardSigningSecret(env: Env): string {
  return (env.ADMIN_DASHBOARD_SECRET || '').trim();
}

/**
 * Genera el token HMAC exclusivo para que una clienta consulte o cancele únicamente su cita.
 */
export async function generateCitaAccessToken(citaId: string, env: Env): Promise<string> {
  const secret = getDashboardSigningSecret(env) || 'superlook-dev-fallback-secret-change-in-prod';
  return hmacSha256Hex(secret, `cita:${citaId}`);
}

/**
 * Verifica el token HMAC de acceso a una cita específica.
 */
export async function verifyCitaAccessToken(
  citaId: string,
  token: string | undefined | null,
  env: Env
): Promise<boolean> {
  if (!citaId || !token) return false;
  const expected = await generateCitaAccessToken(citaId, env);
  return timingSafeEqualStr(expected.toLowerCase(), token.trim().toLowerCase());
}

/**
 * Construye la URL firmada hacia el Dashboard para que la clienta vea o cancele su cita.
 */
export async function buildClientCitaUrl(env: Env, citaId: string): Promise<{
  token: string;
  url: string;
}> {
  const token = await generateCitaAccessToken(citaId, env);
  const baseUrl = (env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
  const url = `${baseUrl}/?cita=${encodeURIComponent(citaId)}&token=${encodeURIComponent(token)}`;
  return { token, url };
}

/**
 * Genera un token de sesión administrativo firmado con HMAC (válido por 24 horas).
 */
export async function createAdminSessionToken(env: Env): Promise<string> {
  const secret = getDashboardSigningSecret(env);
  if (!secret) {
    throw new Error('ADMIN_DASHBOARD_SECRET no está configurado.');
  }
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  const payload = `admin.${exp}`;
  const sig = await hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

/**
 * Verifica si el request incluye un token Bearer de administrador válido
 * (ya sea un token de sesión firmado vigente o la clave ADMIN_DASHBOARD_SECRET directa).
 */
export async function isValidAdminRequest(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const secret = getDashboardSigningSecret(c.env);
  if (!secret) {
    return false;
  }

  const authHeader = c.req.header('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return false;
  }

  // 1. Permitir match directo con ADMIN_DASHBOARD_SECRET (útil para API/CLI)
  if (timingSafeEqualStr(token, secret)) {
    return true;
  }

  // 2. Verificar token de sesión firmado: admin.<exp>.<hmac>
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'admin') {
    return false;
  }

  const exp = Number(parts[1]);
  const providedSig = parts[2].toLowerCase();
  if (!Number.isFinite(exp) || Date.now() > exp) {
    return false;
  }

  const expectedSig = (await hmacSha256Hex(secret, `admin.${parts[1]}`)).toLowerCase();
  return timingSafeEqualStr(providedSig, expectedSig);
}

/**
 * Valida la firma X-Hub-Signature-256 enviada por Meta WhatsApp Cloud API
 * usando META_APP_SECRET.
 */
export async function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  metaAppSecret: string
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const providedHex = signatureHeader.slice('sha256='.length).trim().toLowerCase();
  const expectedHex = (await hmacSha256Hex(metaAppSecret, rawBody)).toLowerCase();
  return timingSafeEqualStr(providedHex, expectedHex);
}

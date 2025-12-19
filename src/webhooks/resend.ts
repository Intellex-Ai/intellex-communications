import crypto from 'node:crypto';

export const RESEND_SIGNATURE_HEADER = 'resend-signature';
const SIGNATURE_VERSION = 'v1';
const SIGNATURE_SEPARATOR = ',';
const SIGNATURE_KV_SEPARATOR = '=';
const PAYLOAD_SEPARATOR = '.';
const DEFAULT_TOLERANCE_SECONDS = 300;

export type ResendSignature = {
  timestamp: number;
  signature: string;
};

type VerificationResult = {
  ok: boolean;
  timestamp?: number;
  reason?: string;
};

function parseKeyValue(part: string): { key: string; value: string } | null {
  const trimmed = part.trim();
  if (!trimmed) return null;
  const [key, value] = trimmed.split(SIGNATURE_KV_SEPARATOR, 2);
  if (!key || value === undefined) return null;
  return { key, value };
}

export function parseResendSignatureHeader(
  headerValue: string | string[] | undefined,
): ResendSignature | null {
  if (!headerValue) return null;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;

  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of raw.split(SIGNATURE_SEPARATOR)) {
    const pair = parseKeyValue(part);
    if (!pair) continue;
    if (pair.key === 't') {
      const parsed = Number.parseInt(pair.value, 10);
      if (Number.isFinite(parsed)) {
        timestamp = parsed;
      }
      continue;
    }
    if (pair.key === SIGNATURE_VERSION) {
      signature = pair.value;
    }
  }

  if (timestamp === null || !signature) return null;
  return { timestamp, signature };
}

function buildSignedPayload(timestamp: number, payload: string): string {
  return `${timestamp}${PAYLOAD_SEPARATOR}${payload}`;
}

export function computeResendSignature(secret: string, timestamp: number, payload: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(buildSignedPayload(timestamp, payload));
  return hmac.digest('hex');
}

function timingSafeEqual(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function verifyResendSignature(options: {
  secret: string;
  signatureHeader: string | string[] | undefined;
  payload: string;
  toleranceSeconds?: number;
  now?: number;
}): VerificationResult {
  const { secret, signatureHeader, payload, toleranceSeconds, now } = options;
  const parsed = parseResendSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, reason: 'missing signature header' };
  }

  const nowSeconds = Math.floor((now ?? Date.now()) / 1000);
  const tolerance = toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'signature timestamp outside tolerance', timestamp: parsed.timestamp };
  }

  const expected = computeResendSignature(secret, parsed.timestamp, payload);
  if (!timingSafeEqual(expected, parsed.signature)) {
    return { ok: false, reason: 'signature mismatch', timestamp: parsed.timestamp };
  }

  return { ok: true, timestamp: parsed.timestamp };
}

export function createResendSignatureHeader(secret: string, timestamp: number, payload: string): string {
  const signature = computeResendSignature(secret, timestamp, payload);
  return `t=${timestamp},${SIGNATURE_VERSION}=${signature}`;
}

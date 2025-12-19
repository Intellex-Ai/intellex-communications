import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';

import type { SendRequest, SendResponse } from './contracts/send';
import { RESEND_SIGNATURE_HEADER, verifyResendSignature } from './webhooks/resend';

dotenv.config();

const app = express();

type RawBodyRequest = Request & { rawBody?: string };

const JSON_BODY_LIMIT = '1mb';
app.use(
  express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf.toString('utf8');
    },
  }),
);

const DEFAULT_PORT = 8700;
const port = parsePort(process.env.PORT, DEFAULT_PORT);
const bindHost = process.env.BIND_HOST || process.env.HOST || '0.0.0.0';
const templatesDir = path.resolve(__dirname, '..', 'templates');
const emailFrom = process.env.EMAIL_FROM;
const resendKey = process.env.EMAIL_PROVIDER_KEY;
const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET;
const apiSecret = process.env.COMMUNICATIONS_API_SECRET;
const apiBaseUrl = process.env.API_BASE_URL;
const resend = resendKey ? new Resend(resendKey) : null;
const allowedTemplates = safeDiscoverTemplates(templatesDir);

const API_EVENTS_PATH = '/communications/events';
const API_MESSAGES_PATH = '/communications/messages';
const API_REQUEST_TIMEOUT_MS = 5000;
const PROVIDER_NAME = 'resend';
const CHANNEL_EMAIL = 'email';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_LENGTH = 180;
const MAX_ID_LENGTH = 120;
const MAX_DATA_BYTES = 20000;
const SEND_RATE_LIMIT = 30;
const SEND_WINDOW_MS = 60_000;
const WEBHOOK_TOLERANCE_SECONDS = 300;
const EPOCH_MS_THRESHOLD = 1_000_000_000_000;

const COMMUNICATION_STATUSES = {
  queued: 'queued',
  sent: 'sent',
  failed: 'failed',
  delivered: 'delivered',
  bounced: 'bounced',
  complaint: 'complaint',
  dropped: 'dropped',
} as const;

type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[keyof typeof COMMUNICATION_STATUSES];

type ApiMessagePayload = {
  requestId: string;
  provider: string;
  providerMessageId?: string;
  channel: string;
  template?: string;
  recipient?: string;
  subject?: string;
  metadata?: Record<string, unknown>;
  status: CommunicationStatus;
  error?: string;
  timestamp: number;
};

type ApiEventPayload = {
  provider: string;
  messageId?: string;
  requestId?: string;
  status: CommunicationStatus;
  timestamp: number;
  payload?: Record<string, unknown>;
};

const sendLimiter = rateLimit({
  windowMs: SEND_WINDOW_MS,
  max: SEND_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  },
  keyGenerator: (req) => {
    const header = req.headers['x-communications-secret'];
    if (Array.isArray(header)) {
      return `secret:${header[0] || ''}`;
    }
    if (header) {
      return `secret:${header}`;
    }
    return ipKeyGenerator(req.ip || '');
  },
});

function parsePort(portRaw: string | undefined, fallbackPort: number): number {
  if (!portRaw) return fallbackPort;
  const parsed = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallbackPort;
  }
  return parsed;
}

function joinUrl(base: string, pathSuffix: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function postApiPayload(pathSuffix: string, payload: ApiMessagePayload | ApiEventPayload) {
  if (!apiBaseUrl) {
    console.warn('API_BASE_URL not set; skipping communications event forwarding');
    return;
  }
  if (!apiSecret) {
    console.warn('COMMUNICATIONS_API_SECRET not set; skipping communications event forwarding');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
  try {
    const url = joinUrl(apiBaseUrl, pathSuffix);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-communications-secret': apiSecret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Communications event forward failed (${response.status})`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Communications event forward error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const EVENT_STATUS_ALIASES: Record<string, CommunicationStatus> = {
  delivered: COMMUNICATION_STATUSES.delivered,
  bounced: COMMUNICATION_STATUSES.bounced,
  complaint: COMMUNICATION_STATUSES.complaint,
  complained: COMMUNICATION_STATUSES.complaint,
  dropped: COMMUNICATION_STATUSES.dropped,
  sent: COMMUNICATION_STATUSES.sent,
  failed: COMMUNICATION_STATUSES.failed,
  queued: COMMUNICATION_STATUSES.queued,
};

function normalizeStatus(raw: string): CommunicationStatus | null {
  const lowered = raw.toLowerCase().trim().replace(/^email\./, '');
  return EVENT_STATUS_ALIASES[lowered] ?? null;
}

const MESSAGE_ID_PATHS = [
  ['data', 'email_id'],
  ['data', 'id'],
  ['data', 'message_id'],
  ['data', 'messageId'],
  ['email_id'],
  ['message_id'],
  ['messageId'],
  ['id'],
];

const TIMESTAMP_PATHS = [
  ['data', 'created_at'],
  ['data', 'timestamp'],
  ['created_at'],
  ['timestamp'],
  ['event_timestamp'],
];

function getNestedValue(payload: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = payload;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function extractMessageId(payload: Record<string, unknown>): string | null {
  for (const pathParts of MESSAGE_ID_PATHS) {
    const value = getNestedValue(payload, pathParts);
    const asString = readString(value);
    if (asString) return asString;
  }
  return null;
}

function extractStatus(payload: Record<string, unknown>): CommunicationStatus | null {
  const candidates = [payload.type, payload.event, payload.status];
  for (const candidate of candidates) {
    const asString = readString(candidate);
    if (!asString) continue;
    const normalized = normalizeStatus(asString);
    if (normalized) return normalized;
  }
  return null;
}

function extractTimestampMs(payload: Record<string, unknown>): number {
  for (const pathParts of TIMESTAMP_PATHS) {
    const value = getNestedValue(payload, pathParts);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > EPOCH_MS_THRESHOLD ? value : value * 1000;
    }
    const asString = readString(value);
    if (asString) {
      const parsed = Date.parse(asString);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
      const numeric = Number(asString);
      if (Number.isFinite(numeric)) {
        return numeric > EPOCH_MS_THRESHOLD ? numeric : numeric * 1000;
      }
    }
  }
  return Date.now();
}

function buildWebhookEvent(payload: Record<string, unknown>): ApiEventPayload | null {
  const status = extractStatus(payload);
  if (!status) return null;
  return {
    provider: PROVIDER_NAME,
    messageId: extractMessageId(payload) ?? undefined,
    status,
    timestamp: extractTimestampMs(payload),
    payload,
  };
}

function discoverTemplates(baseDir: string): Set<string> {
  const templates = new Set<string>();
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.html')) {
        const relative = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const normalized = relative.replace(/\.html$/i, '');
        templates.add(normalized);
      }
    });
  };

  walk(baseDir);
  return templates;
}

function safeDiscoverTemplates(baseDir: string): Set<string> {
  try {
    return discoverTemplates(baseDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to discover templates under ${baseDir}: ${message}`);
    return new Set<string>();
  }
}

function normalizeTemplateName(template: string): string {
  if (!template || typeof template !== 'string') {
    throw new Error('Template is required');
  }
  if (template.includes('..')) {
    throw new Error('Invalid template path');
  }
  const cleaned = template.trim().replace(/^\/+/, '').replace(/\.html$/i, '');
  if (!cleaned) {
    throw new Error('Template is required');
  }
  return cleaned;
}

function resolveTemplatePath(template: string): string {
  const normalized = normalizeTemplateName(template);
  if (!allowedTemplates.has(normalized)) {
    throw new Error('Unknown template');
  }
  const resolved = path.resolve(templatesDir, `${normalized}.html`);
  if (!resolved.startsWith(templatesDir + path.sep) && resolved !== templatesDir) {
    throw new Error('Template path outside allowed directory');
  }
  return resolved;
}

function renderTemplate(raw: string, data: Record<string, unknown>): string {
  return raw.replace(/{{\s*\.([A-Za-z0-9_]+)\s*}}/g, (_, key: string) => {
    const value = data?.[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

async function loadTemplate(template: string, data: Record<string, unknown>): Promise<string> {
  const filePath = resolveTemplatePath(template);
  const raw = await readFile(filePath, 'utf8');
  return renderTemplate(raw, data);
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

function validateSendRequest(body: Partial<SendRequest>) {
  if (!body?.id || typeof body.id !== 'string' || body.id.trim().length === 0) {
    throw new Error('id is required');
  }
  const id = body.id.trim();
  if (id.length > MAX_ID_LENGTH) {
    throw new Error('id too long');
  }

  if (body.channel !== CHANNEL_EMAIL) {
    throw new Error(`Unsupported channel: ${body?.channel ?? 'unknown'}`);
  }
  const channel = body.channel;

  const templateName = normalizeTemplateName(body.template as string);
  if (!allowedTemplates.has(templateName)) {
    throw new Error('Unknown template');
  }

  const to = body.to?.trim();
  if (!to || to.length > 320 || !EMAIL_REGEX.test(to)) {
    throw new Error('Valid "to" email is required');
  }

  const subject = (body.subject ?? 'Intellex notification').toString().trim();
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(`subject is required and must be <= ${MAX_SUBJECT_LENGTH} characters`);
  }

  const data = body.data;
  if (!data || typeof data !== 'object') {
    throw new Error('data must be an object');
  }
  const payloadSize = JSON.stringify(data).length;
  if (payloadSize > MAX_DATA_BYTES) {
    throw new Error('data payload too large');
  }

  return { id, templateName, to, subject, data, channel };
}

app.post('/send', sendLimiter, async (req: Request, res: Response) => {
  // Auth check - fail closed if secret not configured
  if (!apiSecret) {
    res.status(503).json({ error: 'COMMUNICATIONS_API_SECRET not configured' });
    return;
  }
  const headerValue = req.headers['x-communications-secret'];
  const providedSecret = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (providedSecret !== apiSecret) {
    res.status(401).json({ error: 'Invalid or missing secret' });
    return;
  }

  if (allowedTemplates.size === 0) {
    res.status(503).json({ error: 'No templates available' });
    return;
  }

  const body = req.body as Partial<SendRequest>;
  let validated: {
    id: string;
    templateName: string;
    to: string;
    subject: string;
    data: Record<string, unknown>;
    channel: string;
  };
  try {
    validated = validateSendRequest(body);
  } catch (validationError) {
    const message = validationError instanceof Error ? validationError.message : 'Invalid request';
    res.status(400).json({ error: message });
    return;
  }

  if (!resend || !emailFrom) {
    const response: SendResponse = {
      id: validated.id,
      provider: PROVIDER_NAME,
      status: 'failed',
      error: 'EMAIL_PROVIDER_KEY and EMAIL_FROM must be configured',
    };
    res.status(503).json(response);
    return;
  }

  try {
    const html = await loadTemplate(validated.templateName, validated.data);
    const subject = validated.subject || 'Intellex notification';
    const result = await resend.emails.send({
      from: emailFrom,
      to: validated.to,
      subject,
      html,
    });
    const messageId = (result as any)?.data?.id;

    const response: SendResponse = {
      id: validated.id,
      provider: PROVIDER_NAME,
      status: COMMUNICATION_STATUSES.sent,
      messageId,
    };
    await postApiPayload(API_MESSAGES_PATH, {
      requestId: validated.id,
      provider: PROVIDER_NAME,
      providerMessageId: messageId,
      channel: validated.channel,
      template: validated.templateName,
      recipient: validated.to,
      subject,
      metadata: body.metadata ?? undefined,
      status: COMMUNICATION_STATUSES.sent,
      timestamp: Date.now(),
    });
    res.json(response);
  } catch (error) {
    const response: SendResponse = {
      id: validated.id,
      provider: PROVIDER_NAME,
      status: COMMUNICATION_STATUSES.failed,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    await postApiPayload(API_MESSAGES_PATH, {
      requestId: validated.id,
      provider: PROVIDER_NAME,
      channel: validated.channel,
      template: validated.templateName,
      recipient: validated.to,
      subject: validated.subject,
      metadata: body.metadata ?? undefined,
      status: COMMUNICATION_STATUSES.failed,
      error: response.error,
      timestamp: Date.now(),
    });
    res.status(500).json(response);
  }
});

app.post('/webhooks/provider', (req: Request, res: Response) => {
  if (!webhookSecret) {
    res.status(503).send('EMAIL_WEBHOOK_SECRET not configured');
    return;
  }

  const rawBody = (req as RawBodyRequest).rawBody;
  if (!rawBody) {
    res.status(400).send('Missing raw request body');
    return;
  }

  const verification = verifyResendSignature({
    secret: webhookSecret,
    signatureHeader: req.headers[RESEND_SIGNATURE_HEADER],
    payload: rawBody,
    toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
  });
  if (!verification.ok) {
    res.status(401).send(verification.reason || 'Invalid signature');
    return;
  }

  const payload = req.body as Record<string, unknown>;
  const normalized = buildWebhookEvent(payload);
  if (normalized) {
    void postApiPayload(API_EVENTS_PATH, normalized);
  }

  res.status(204).end();
});

const server = app.listen(port, bindHost, () => {
  console.log(`intellex-communications listening on ${bindHost}:${port}`);
});

server.on('error', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`intellex-communications failed to start: ${message}`);
  process.exit(1);
});

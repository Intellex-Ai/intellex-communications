import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';

import type { SendRequest, SendResponse, ProviderEvent } from './contracts/send';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT || 8700);
const templatesDir = path.resolve(__dirname, '..', 'templates');
const emailFrom = process.env.EMAIL_FROM;
const resendKey = process.env.EMAIL_PROVIDER_KEY;
const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET;
const apiSecret = process.env.COMMUNICATIONS_API_SECRET;
const resend = resendKey ? new Resend(resendKey) : null;
const allowedTemplates = discoverTemplates(templatesDir);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_LENGTH = 180;
const MAX_ID_LENGTH = 120;
const MAX_DATA_BYTES = 20000;
const SEND_RATE_LIMIT = 30;
const SEND_WINDOW_MS = 60_000;

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
      return header.join(',');
    }
    return header || req.ip || 'anon';
  },
});

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

  if (body.channel !== 'email') {
    throw new Error(`Unsupported channel: ${body?.channel ?? 'unknown'}`);
  }

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

  return { id, templateName, to, subject, data };
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

  const body = req.body as Partial<SendRequest>;
  let validated: { id: string; templateName: string; to: string; subject: string; data: Record<string, unknown> };
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
      provider: 'resend',
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

    const response: SendResponse = {
      id: validated.id,
      provider: 'resend',
      status: 'sent',
      messageId: (result as any)?.data?.id,
    };
    res.json(response);
  } catch (error) {
    const response: SendResponse = {
      id: validated.id,
      provider: 'resend',
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    res.status(500).json(response);
  }
});

app.post('/webhooks/provider', (req: Request, res: Response) => {
  if (webhookSecret) {
    const provided = req.headers['x-email-webhook-secret'];
    if (provided !== webhookSecret) {
      res.status(401).send('invalid webhook secret');
      return;
    }
  }

  const event = req.body as ProviderEvent;
  res.status(204).end();
});

app.listen(port, () => {
  console.log(`intellex-communications listening on :${port}`);
});

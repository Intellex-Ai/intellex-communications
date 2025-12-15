import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
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

function normalizeTemplatePath(template: string): string {
  // Block path traversal attempts
  if (template.includes('..')) {
    throw new Error('Invalid template path');
  }
  const cleaned = template.replace(/^\/+/, '');
  const withExt = cleaned.endsWith('.html') ? cleaned : `${cleaned}.html`;
  const resolved = path.resolve(templatesDir, withExt);
  // Ensure resolved path stays within templates directory
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
  const filePath = normalizeTemplatePath(template);
  const raw = await readFile(filePath, 'utf8');
  return renderTemplate(raw, data);
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.post('/send', async (req: Request, res: Response) => {
  // Auth check - fail closed if secret not configured
  if (!apiSecret) {
    res.status(503).json({ error: 'COMMUNICATIONS_API_SECRET not configured' });
    return;
  }
  const providedSecret = req.headers['x-communications-secret'];
  if (providedSecret !== apiSecret) {
    res.status(401).json({ error: 'Invalid or missing secret' });
    return;
  }

  const body = req.body as SendRequest;
  if (!body?.id || !body?.channel || !body?.template || !body?.to) {
    res.status(400).json({ error: 'id, channel, template, and to are required' });
    return;
  }

  if (body.channel !== 'email') {
    const response: SendResponse = {
      id: body.id,
      provider: 'none',
      status: 'failed',
      error: `Unsupported channel: ${body.channel}`,
    };
    res.status(400).json(response);
    return;
  }

  if (!resend || !emailFrom) {
    const response: SendResponse = {
      id: body.id,
      provider: 'resend',
      status: 'failed',
      error: 'EMAIL_PROVIDER_KEY and EMAIL_FROM must be configured',
    };
    res.status(503).json(response);
    return;
  }

  try {
    const html = await loadTemplate(body.template, body.data || {});
    const subject = body.subject || 'Intellex notification';
    const result = await resend.emails.send({
      from: emailFrom,
      to: body.to,
      subject,
      html,
    });

    const response: SendResponse = {
      id: body.id,
      provider: 'resend',
      status: 'sent',
      messageId: (result as any)?.data?.id,
    };
    res.json(response);
  } catch (error) {
    const response: SendResponse = {
      id: body.id,
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

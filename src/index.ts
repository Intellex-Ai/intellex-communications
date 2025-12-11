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
const resend = resendKey ? new Resend(resendKey) : null;

function normalizeTemplatePath(template: string): string {
  const cleaned = template.replace(/^\/+/, '');
  const withExt = cleaned.endsWith('.html') ? cleaned : `${cleaned}.html`;
  return path.join(templatesDir, withExt);
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

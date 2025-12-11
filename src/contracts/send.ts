export type Channel = 'email' | 'sms' | 'push';

export interface SendRequest {
  id: string;
  channel: Channel;
  template: string;
  to: string;
  subject?: string;
  data: Record<string, unknown>;
  metadata?: {
    projectId?: string;
    userId?: string;
    traceId?: string;
    source?: string; // api | orchestrator | scheduler
  };
  callbackUrl?: string;
}

export interface SendResponse {
  id: string;
  provider: string;
  status: 'queued' | 'sent' | 'failed';
  messageId?: string;
  error?: string;
}

export interface ProviderEvent {
  provider: string;
  messageId: string;
  status: 'delivered' | 'bounced' | 'complaint' | 'dropped';
  timestamp: number;
  detail?: Record<string, unknown>;
}

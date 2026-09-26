// OpenAI Realtime GA: mints a short-lived client secret (POST /v1/realtime/client_secrets) with the full session
// configuration. The permanent key never leaves the server; provider error bodies are never passed to clients.
import { createHmac } from 'node:crypto';
import type { VoiceConfig } from '../../config.js';
import { voiceInstructions } from './instructions.js';
import { VOICE_TOOLS } from './tools.js';

export class VoiceProviderError extends Error {
  constructor(public readonly code: 'not_configured' | 'timeout' | 'provider_rejected' | 'provider_unavailable' | 'bad_response', public readonly status?: number) {
    super(code);
  }
}

export interface ClientSecret {
  value: string;
  expiresAt: Date;
}

export function realtimeSessionConfig(cfg: VoiceConfig, now = new Date()) {
  return {
    type: 'realtime',
    model: cfg.realtimeModel,
    instructions: voiceInstructions(now),
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: cfg.transcribeModel, language: 'ja' },
        noise_reduction: { type: 'near_field' },
        // Japanese speakers often pause before the sentence-final part; low eagerness avoids cutting them off.
        turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
      },
      output: { voice: cfg.realtimeVoice },
    },
    tools: VOICE_TOOLS,
    tool_choice: 'auto',
  };
}

/** Privacy-preserving stable identifier for provider abuse monitoring (HMAC of the user id). */
export function safetyIdentifier(hmacKey: Buffer, userId: string): string {
  return createHmac('sha256', hmacKey).update(`voice:${userId}`).digest('hex').slice(0, 32);
}

export async function createClientSecret(cfg: VoiceConfig, safetyId: string, fetchImpl: typeof fetch = fetch): Promise<ClientSecret> {
  if (!cfg.openaiApiKey) throw new VoiceProviderError('not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.providerTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.openaiBaseUrl}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.openaiApiKey}`,
        'content-type': 'application/json',
        'openai-safety-identifier': safetyId,
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: cfg.clientSecretTtlSeconds },
        session: realtimeSessionConfig(cfg),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new VoiceProviderError((e as Error).name === 'AbortError' ? 'timeout' : 'provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new VoiceProviderError(res.status >= 500 || res.status === 429 ? 'provider_unavailable' : 'provider_rejected', res.status);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new VoiceProviderError('bad_response', res.status);
  }
  // GA returns { value, expires_at } (older shapes nested it under client_secret).
  const value = json?.value ?? json?.client_secret?.value;
  const expiresRaw = json?.expires_at ?? json?.client_secret?.expires_at;
  if (typeof value !== 'string' || value.length < 8) throw new VoiceProviderError('bad_response', res.status);
  const expiresAt =
    typeof expiresRaw === 'number' ? new Date(expiresRaw * 1000) : typeof expiresRaw === 'string' ? new Date(expiresRaw) : new Date(Date.now() + cfg.clientSecretTtlSeconds * 1000);
  return { value, expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(Date.now() + cfg.clientSecretTtlSeconds * 1000) : expiresAt };
}

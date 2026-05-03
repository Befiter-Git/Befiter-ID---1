import { createHmac } from "crypto";
import { storage } from "./storage";
import type { WebhookDestination, WebhookEvent } from "@shared/schema";

const RETRY_SCHEDULE_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

interface ChannelConfig {
  url: string | undefined;
  secret: string | undefined;
}

function channelConfig(destination: WebhookDestination): ChannelConfig {
  if (destination === "com") {
    return {
      url: process.env.BEFITER_COM_WEBHOOK_URL,
      secret: process.env.WEBHOOK_SECRET_ID_TO_COM,
    };
  }
  return {
    url: process.env.BEFITER_STORE_WEBHOOK_URL,
    secret: process.env.BEFITER_ID_WEBHOOK_SECRET,
  };
}

export function isChannelConfigured(destination: WebhookDestination): boolean {
  const cfg = channelConfig(destination);
  return Boolean(cfg.url && cfg.secret);
}

function sign(body: string, secret: string): { ts: string; sig: string; header: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { ts, sig, header: `v1,t=${ts},sig=${sig}` };
}

async function deliverOne(event: WebhookEvent): Promise<void> {
  const destination = event.destination as WebhookDestination;
  const cfg = channelConfig(destination);

  if (!cfg.url || !cfg.secret) {
    await scheduleRetry(event, "channel_not_configured");
    return;
  }

  const { header } = sign(event.payload, cfg.secret);

  let response: Response;
  try {
    response = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Befiter-Signature": header,
        "X-Befiter-Event-Id": event.eventId,
        "X-Befiter-Event-Type": event.eventType,
      },
      body: event.payload,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scheduleRetry(event, `network_error: ${msg}`);
    return;
  }

  if (response.ok) {
    await storage.markWebhookDelivered(event.id);
    return;
  }

  const bodyText = await response.text().catch(() => "");
  await scheduleRetry(event, `http_${response.status}: ${bodyText.slice(0, 200)}`);
}

async function scheduleRetry(event: WebhookEvent, errorMsg: string): Promise<void> {
  const nextAttemptIndex = event.attempts;
  if (nextAttemptIndex >= RETRY_SCHEDULE_MS.length) {
    await storage.markWebhookDead(event.id, errorMsg);
    return;
  }
  const delayMs = RETRY_SCHEDULE_MS[nextAttemptIndex];
  const nextAt = new Date(Date.now() + delayMs);
  await storage.markWebhookFailed(event.id, errorMsg, nextAt);
}

let workerHandle: NodeJS.Timeout | null = null;
let isRunning = false;

async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const due = await storage.claimPendingWebhookEvents(20);
    for (const event of due) {
      try {
        await deliverOne(event);
      } catch (err) {
        console.error("[webhook-worker] unexpected error delivering event", event.id, err);
        await scheduleRetry(event, `worker_error: ${err instanceof Error ? err.message : String(err)}`)
          .catch(e => console.error("[webhook-worker] scheduleRetry failed", e));
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startWebhookWorker(): void {
  if (workerHandle) return;
  workerHandle = setInterval(() => {
    tick().catch(err => console.error("[webhook-worker] tick failed", err));
  }, 30_000);
  setTimeout(() => tick().catch(() => {}), 2_000);
}

export async function retryWebhookNow(eventId: string): Promise<void> {
  await storage.requeueWebhookEvent(eventId);
}

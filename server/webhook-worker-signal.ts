type WebhookWorkerWakeHandler = () => void;

let wakeHandler: WebhookWorkerWakeHandler | null = null;

export function registerWebhookWorkerWakeHandler(handler: WebhookWorkerWakeHandler): void {
  wakeHandler = handler;
}

export function wakeWebhookWorker(): void {
  wakeHandler?.();
}

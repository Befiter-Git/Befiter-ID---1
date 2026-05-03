import type { BefiterIdWithLinks, IdentityUpdate } from "@shared/schema";

export interface DashboardStats {
  totalIds: number;
  thisMonth: number;
  appBreakdown: { appName: string; count: number }[];
  duplicatePrevention: number;
  leads: {
    total: number;
    thisMonth: number;
    byStatus: { status: string; count: number }[];
    followUpsDue: number;
  };
  webhooks: {
    pending: number;
    dead: number;
    deliveredLast24h: number;
  };
}

export interface ApiKeyRecord {
  id: string;
  appName: string;
  keyPrefix: string;
  isActive: boolean;
  createdAt: string;
}

export async function adminFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

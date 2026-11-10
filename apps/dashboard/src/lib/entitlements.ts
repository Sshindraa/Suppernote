'use client';

export type Entitlements = { restaurantId?: string; capabilities: Record<string, boolean> };

type GetJson = <T = unknown>(path: string) => Promise<T>;

/** One `entitlements` request in flight per scope: concurrent readers (sidebar, page, hooks) share it. */
const inFlight = new Map<string, Promise<Entitlements>>();

export function readEntitlements(scope: string, get: GetJson): Promise<Entitlements> {
  const pending = inFlight.get(scope);
  if (pending) return pending;
  const request = get<Entitlements>('entitlements').finally(() => {
    inFlight.delete(scope);
  });
  inFlight.set(scope, request);
  return request;
}

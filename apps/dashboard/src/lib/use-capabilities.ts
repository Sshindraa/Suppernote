'use client';

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { readEntitlements } from '@/lib/entitlements';

/**
 * Effective rights of this restaurant (`GET entitlements`). `null` until the server answers for the
 * current restaurant; a failed probe stays `null`, so nothing gated is shown (fail closed).
 */
export function useCapabilities(): Record<string, boolean> | null {
  const { get, orgId } = useApi();
  const [state, setState] = useState<{ scope?: string; capabilities: Record<string, boolean> }>({
    capabilities: {},
  });

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    readEntitlements(orgId, get)
      .then((result) => {
        if (!cancelled) setState({ scope: orgId, capabilities: result.capabilities ?? {} });
      })
      .catch(() => {
        // Fail closed: a failed probe reveals nothing gated.
      });
    return () => {
      cancelled = true;
    };
  }, [get, orgId]);

  return state.scope === orgId ? state.capabilities : null;
}

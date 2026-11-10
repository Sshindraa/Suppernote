'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import { readEntitlements } from '@/lib/entitlements';

/** Read effective server rights, including legacy grants. Never infer access from the plan label. */
export function useServiceCopilotAccess(enabled = true, restaurantId?: string) {
  const { get, orgId } = useApi();
  const scope = restaurantId ?? orgId;
  const getRef = useRef(get);
  getRef.current = get;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ scope?: string; allowed: boolean; error: boolean }>({
    allowed: false,
    error: false,
  });
  useEffect(() => {
    if (!enabled || !scope) return;
    let cancelled = false;
    setState({ allowed: false, error: false });
    readEntitlements(scope, getRef.current)
      .then((result) => {
        if (cancelled) return;
        if (result.restaurantId !== scope) throw new Error('Unexpected restaurant scope');
        setState({
          scope,
          allowed: result.capabilities['floorPlan.copilot'] === true,
          error: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ scope, allowed: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, scope, revision]);
  const current = enabled && Boolean(scope) && state.scope === scope;
  return {
    allowed: current && state.allowed,
    loading: enabled && Boolean(scope) && !current,
    error: current && state.error,
    retry: () => setRevision((value) => value + 1),
  };
}

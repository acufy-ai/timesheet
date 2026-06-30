import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { dashboardApi } from '@/api/client';
import {
  usePortfolio, useManagerFinancials, useEvm, useRevenueRecognition,
  useTeamResourcing, useTeamOnTimeStats,
} from '@/hooks/useDashboard';
import type { WidgetScope } from '@/types/customDashboard';

// Widgets read their metric data through `useWidgetBundles(scope, widgetId)`
// rather than calling the dashboard hooks directly. That lets the SAME widget
// components render in two places AND respect a per-widget scope:
//   - authenticated grid (mode 'live')  → unscoped widgets share the portfolio
//     bundle (cheap); scoped widgets fetch their own bundle (deduped by scope
//     via react-query).
//   - public share view (mode 'static') → data comes from the pre-computed
//     bundle the public endpoint returned: the shared bundle for unscoped
//     widgets, or `bundle.__scoped__[widgetId]` for scoped ones.
// Each slot mirrors a react-query result: { data, isLoading }.

export interface Slot<T = unknown> { data: T | undefined; isLoading: boolean }

export interface WidgetBundles {
  portfolio: Slot;
  financials: Slot;
  evm: Slot;
  revrec: Slot;
  resourcing: Slot;
  ontime: Slot;
}

const EMPTY: Slot = { data: undefined, isLoading: false };
const EMPTY_BUNDLES: WidgetBundles = {
  portfolio: EMPTY, financials: EMPTY, evm: EMPTY, revrec: EMPTY, resourcing: EMPTY, ontime: EMPTY,
};

type Mode =
  | { kind: 'live' }
  | { kind: 'static'; bundle: Record<string, unknown> };

const ModeContext = createContext<Mode>({ kind: 'live' });

const scopeClients = (s?: WidgetScope) => [...(s?.clientIds ?? []), ...(s?.clientId ? [s.clientId] : [])];
const scopeProjects = (s?: WidgetScope) => [...(s?.projectIds ?? []), ...(s?.projectId ? [s.projectId] : [])];
const hasScope = (s?: WidgetScope) =>
  !!s && (scopeClients(s).length > 0 || scopeProjects(s).length > 0 || !!s.taskId || !!s.userId);

// Stable cache key for a scope (so react-query dedupes identical scopes).
const scopeKey = (s?: WidgetScope) =>
  hasScope(s)
    ? `${[...new Set(scopeClients(s))].sort().join('.')}|${[...new Set(scopeProjects(s))].sort().join('.')}|${s!.taskId ?? ''}|${s!.userId ?? ''}|${s!.resourceMode ?? 'contribution'}`
    : 'all';

// ── Providers ────────────────────────────────────────────────────────────────
export function AuthedWidgetData({ children }: { children: ReactNode }) {
  return <ModeContext.Provider value={{ kind: 'live' }}>{children}</ModeContext.Provider>;
}

export function StaticWidgetData({ bundle, children }: { bundle: Record<string, unknown>; children: ReactNode }) {
  return <ModeContext.Provider value={{ kind: 'static', bundle }}>{children}</ModeContext.Provider>;
}

// ── The widget-facing hook ───────────────────────────────────────────────────
// Returns the metric bundles for the given scope. Hooks are always called in a
// fixed order (rules of hooks); the unused branch is disabled via react-query's
// `enabled`, so a static-mode or unscoped widget makes no extra requests.
export function useWidgetBundles(scope?: WidgetScope, widgetId?: string): WidgetBundles {
  const mode = useContext(ModeContext);
  const live = mode.kind === 'live';
  const scoped = live && hasScope(scope);

  // Unscoped live bundles (shared across all unscoped widgets — react-query
  // dedupes by key). Disabled in static mode or when this widget is scoped.
  const sharedEnabled = live && !scoped;
  const portfolio = usePortfolio(sharedEnabled);
  const financials = useManagerFinancials(sharedEnabled);
  const evm = useEvm(sharedEnabled);
  const revrec = useRevenueRecognition(sharedEnabled);
  const resourcing = useTeamResourcing(4, sharedEnabled);
  const ontime = useTeamOnTimeStats(90, sharedEnabled);

  // Scoped live bundles: one query per metric family, keyed by scope.
  const key = scopeKey(scope);
  const sPortfolio = useQuery({ queryKey: ['wd', 'portfolio', key], queryFn: () => dashboardApi.portfolio(scope).then((r) => r.data), enabled: scoped, staleTime: 60_000 });
  const sFinancials = useQuery({ queryKey: ['wd', 'financials', key], queryFn: () => dashboardApi.scopedFinancials(scope).then((r) => r.data), enabled: scoped, staleTime: 60_000 });
  const sEvm = useQuery({ queryKey: ['wd', 'evm', key], queryFn: () => dashboardApi.evm(scope).then((r) => r.data), enabled: scoped, staleTime: 60_000 });
  const sRevrec = useQuery({ queryKey: ['wd', 'revrec', key], queryFn: () => dashboardApi.revenueRecognition(scope).then((r) => r.data), enabled: scoped, staleTime: 60_000 });
  const sResourcing = useQuery({ queryKey: ['wd', 'resourcing', key], queryFn: () => dashboardApi.scopedResourcing(scope).then((r) => r.data), enabled: scoped, staleTime: 60_000 });
  const sOntime = useQuery({ queryKey: ['wd', 'ontime', key], queryFn: () => dashboardApi.scopedOnTime(scope).then((r) => r.data), enabled: scoped, staleTime: 60_000 });

  if (mode.kind === 'static') {
    // Read from the pre-computed bundle: per-widget scoped data if present, else
    // the shared bundle.
    const scopedBundle = (mode.bundle.__scoped__ as Record<string, Record<string, unknown>> | undefined)?.[widgetId ?? ''];
    const src = (scopedBundle ?? mode.bundle) as Record<string, unknown>;
    const slot = (k: string): Slot => ({ data: src[k], isLoading: false });
    return {
      portfolio: slot('portfolio'), financials: slot('financials'), evm: slot('evm'),
      revrec: slot('revrec'), resourcing: slot('resourcing'), ontime: slot('ontime'),
    };
  }

  if (scoped) {
    return {
      portfolio: { data: sPortfolio.data, isLoading: sPortfolio.isLoading },
      financials: { data: sFinancials.data, isLoading: sFinancials.isLoading },
      evm: { data: sEvm.data, isLoading: sEvm.isLoading },
      revrec: { data: sRevrec.data, isLoading: sRevrec.isLoading },
      resourcing: { data: sResourcing.data, isLoading: sResourcing.isLoading },
      ontime: { data: sOntime.data, isLoading: sOntime.isLoading },
    };
  }

  return {
    portfolio: { data: portfolio.data, isLoading: portfolio.isLoading },
    financials: { data: financials.data, isLoading: financials.isLoading },
    evm: { data: evm.data, isLoading: evm.isLoading },
    revrec: { data: revrec.data, isLoading: revrec.isLoading },
    resourcing: { data: resourcing.data, isLoading: resourcing.isLoading },
    ontime: { data: ontime.data, isLoading: ontime.isLoading },
  };
}

// Back-compat: widgets that don't need scope can keep calling the old name.
export const useWidgetData = (): WidgetBundles => useWidgetBundles(undefined, undefined);

void EMPTY_BUNDLES;

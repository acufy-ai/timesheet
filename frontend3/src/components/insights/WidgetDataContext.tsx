import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  usePortfolio, useManagerFinancials, useEvm, useRevenueRecognition,
  useTeamResourcing, useTeamOnTimeStats,
} from '@/hooks/useDashboard';

// Widgets read their metric data from this context instead of calling the
// dashboard hooks directly. That lets the SAME widget components render in two
// places:
//   - the authenticated Insights grid  → AuthedWidgetData wires the live hooks.
//   - the public (no-login) share view → StaticWidgetData feeds the data bundle
//     the public endpoint returned (already computed as the owner).
// Each slot mirrors a react-query result: { data, isLoading }.

export interface Slot<T = unknown> { data: T | undefined; isLoading: boolean }

export interface WidgetData {
  portfolio: Slot;
  financials: Slot;
  evm: Slot;
  revrec: Slot;
  resourcing: Slot;
  ontime: Slot;
}

const EMPTY: Slot = { data: undefined, isLoading: false };
const WidgetDataContext = createContext<WidgetData>({
  portfolio: EMPTY, financials: EMPTY, evm: EMPTY, revrec: EMPTY, resourcing: EMPTY, ontime: EMPTY,
});

export const useWidgetData = () => useContext(WidgetDataContext);

// Live provider for the authenticated grid: all bundles fetched via the hooks.
export function AuthedWidgetData({ children }: { children: ReactNode }) {
  const portfolio = usePortfolio();
  const financials = useManagerFinancials();
  const evm = useEvm();
  const revrec = useRevenueRecognition();
  const resourcing = useTeamResourcing();
  const ontime = useTeamOnTimeStats();
  const value = useMemo<WidgetData>(() => ({
    portfolio: { data: portfolio.data, isLoading: portfolio.isLoading },
    financials: { data: financials.data, isLoading: financials.isLoading },
    evm: { data: evm.data, isLoading: evm.isLoading },
    revrec: { data: revrec.data, isLoading: revrec.isLoading },
    resourcing: { data: resourcing.data, isLoading: resourcing.isLoading },
    ontime: { data: ontime.data, isLoading: ontime.isLoading },
  }), [portfolio.data, portfolio.isLoading, financials.data, financials.isLoading,
    evm.data, evm.isLoading, revrec.data, revrec.isLoading,
    resourcing.data, resourcing.isLoading, ontime.data, ontime.isLoading]);
  return <WidgetDataContext.Provider value={value}>{children}</WidgetDataContext.Provider>;
}

// Static provider for the public view: data comes from the share bundle.
// A missing bundle just renders the widget's own empty state (isLoading false).
export function StaticWidgetData({ bundle, children }: { bundle: Record<string, unknown>; children: ReactNode }) {
  const value = useMemo<WidgetData>(() => {
    const slot = (k: string): Slot => ({ data: bundle?.[k], isLoading: false });
    return {
      portfolio: slot('portfolio'), financials: slot('financials'), evm: slot('evm'),
      revrec: slot('revrec'), resourcing: slot('resourcing'), ontime: slot('ontime'),
    };
  }, [bundle]);
  return <WidgetDataContext.Provider value={value}>{children}</WidgetDataContext.Provider>;
}

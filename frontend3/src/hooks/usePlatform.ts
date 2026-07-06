import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { platformApi } from '@/api/client';
import type { CreateTenantBody, PlatformAuditParams } from '@/types/platform';

// Platform-admin data + mutations. All gated to PLATFORM_ADMIN by the backend.

export function useTenants(includeArchived = false, enabled = true) {
  return useQuery({
    queryKey: ['platform', 'tenants', includeArchived],
    queryFn: () => platformApi.tenants(includeArchived).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function useTenantUsersCount(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'tenant-users-count'],
    queryFn: () => platformApi.tenantUsersCount().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTenantBody) => platformApi.createTenant(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'tenants'] }),
  });
}

export function useAddTenantAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, full_name, email }: { id: number; full_name: string; email: string }) =>
      platformApi.addTenantAdmin(id, { full_name, email }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'tenants'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'tenant-stats'] });
    },
  });
}

// Shared invalidation for admin mutations: refresh the admin list + counts.
function invalidateAdmins(qc: ReturnType<typeof useQueryClient>, id: number) {
  void qc.invalidateQueries({ queryKey: ['platform', 'tenant-admins', id] });
  void qc.invalidateQueries({ queryKey: ['platform', 'tenant-stats'] });
}

export function useUpdateTenantAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId, full_name, email }: { id: number; userId: number; full_name?: string; email?: string }) =>
      platformApi.updateTenantAdmin(id, userId, { full_name, email }).then((r) => r.data),
    onSuccess: (_d, v) => invalidateAdmins(qc, v.id),
  });
}

export function useRemoveTenantAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: number; userId: number }) =>
      platformApi.removeTenantAdmin(id, userId).then((r) => r.data),
    onSuccess: (_d, v) => invalidateAdmins(qc, v.id),
  });
}

export function useUpdateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<{ name: string; slug: string; status: string; ingestion_enabled: boolean; project_management_enabled: boolean; max_mailboxes: number; timezone: string }> }) =>
      platformApi.updateTenant(id, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'tenants'] }),
  });
}

export function useTenantLifecycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, token }: { id: number; action: string; token?: string }) =>
      platformApi.tenantLifecycle(id, action, token).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'tenants'] }),
  });
}

export function usePlatformSummary(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'summary'],
    queryFn: () => platformApi.summary().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function usePlatformHealth(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'health'],
    queryFn: () => platformApi.health().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function usePlatformAudit(params: PlatformAuditParams, enabled = true) {
  return useQuery({
    queryKey: [
      'platform',
      'audit',
      params.limit ?? 50,
      params.offset ?? 0,
      params.category ?? 'all',
      params.tenant_id ?? 'all',
      params.search ?? '',
      params.range_start ?? '',
      params.range_end ?? '',
    ],
    queryFn: () => platformApi.audit(params).then((r) => r.data),
    enabled,
    staleTime: 15_000,
  });
}

export function usePlatformCalendar(params: { range_start: string; range_end: string }, enabled = true) {
  return useQuery({
    queryKey: ['platform', 'calendar', params.range_start, params.range_end],
    queryFn: () => platformApi.calendar(params).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function usePlatformSmtp(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'smtp'],
    queryFn: () => platformApi.getSmtp().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Single audit-event detail (lazy; for the drawer).
export function usePlatformAuditEvent(eventId: number | null) {
  return useQuery({
    queryKey: ['platform', 'audit-event', eventId],
    queryFn: () => platformApi.auditEvent(eventId as number).then((r) => r.data),
    enabled: eventId != null,
  });
}

// Per-tenant compact stats keyed by tenant id.
export function useTenantStats(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'tenant-stats'],
    queryFn: () => platformApi.tenantStats().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// A tenant's admins (by multi-role membership).
export function useTenantAdmins(id: number | null) {
  return useQuery({
    queryKey: ['platform', 'tenant-admins', id],
    queryFn: () => platformApi.tenantAdmins(id as number).then((r) => r.data),
    enabled: id != null,
    staleTime: 60_000,
  });
}

// Per-tenant feature flags.
export function useTenantFeatures(id: number | null) {
  return useQuery({
    queryKey: ['platform', 'tenant-features', id],
    queryFn: () => platformApi.tenantFeatures(id as number).then((r) => r.data),
    enabled: id != null,
    staleTime: 30_000,
  });
}
export function useUpdateTenantFeatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: Partial<{ custom_outbound_email: boolean; custom_email_template: boolean }> }) =>
      platformApi.updateTenantFeatures(id, updates).then((r) => r.data),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['platform', 'tenant-features', v.id] }),
  });
}

// Service tokens per tenant.
export function useServiceTokens(id: number | null) {
  return useQuery({
    queryKey: ['platform', 'service-tokens', id],
    queryFn: () => platformApi.serviceTokens(id as number).then((r) => r.data),
    enabled: id != null,
    staleTime: 30_000,
  });
}
export function useCreateServiceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, issuer }: { id: number; name: string; issuer: string }) =>
      platformApi.createServiceToken(id, { name, issuer }).then((r) => r.data),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['platform', 'service-tokens', v.id] }),
  });
}
export function useRevokeServiceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tokenId }: { id: number; tokenId: number }) => platformApi.revokeServiceToken(id, tokenId),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['platform', 'service-tokens', v.id] }),
  });
}
export function useProvisionSystemUser() {
  return useMutation({
    mutationFn: (id: number) => platformApi.provisionSystemUser(id).then((r) => r.data),
  });
}

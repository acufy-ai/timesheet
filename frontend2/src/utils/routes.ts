/**
 * Append query-string params to a route, skipping null/undefined/empty
 * values so callers can build URLs from sparse param maps without
 * littering the result with `?foo=&bar=undefined`.
 */
export const buildRouteWithParams = (
  route: string,
  params?: Record<string, string | number | boolean | null> | null,
): string => {
  if (!params) return route;

  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    searchParams.set(key, String(value));
  });

  const query = searchParams.toString();
  return query ? `${route}?${query}` : route;
};

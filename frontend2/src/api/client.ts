import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

// Create axios instance
const _apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export const apiClient: AxiosInstance = axios.create({
  baseURL: _apiBase,
  headers: {
    'Content-Type': 'application/json',
  },
  // Accept 304 as a success status — the ETag interceptor below
  // substitutes the cached body for the (empty) 304 response. Without
  // this, axios would reject 304 as an error before our handler runs.
  validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
});

// Add token to requests
apiClient.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Silent token refresh on 401 ──────────────────────────────────
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null) => {
  for (const prom of failedQueue) {
    if (token) {
      prom.resolve(token);
    } else {
      prom.reject(error);
    }
  }
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    const requestUrl = String(originalRequest?.url || '');
    const isAuthRequest = requestUrl.includes('/auth/login') || requestUrl.includes('/auth/refresh');
    const hadToken = Boolean(originalRequest?.headers?.Authorization);

    // Only attempt refresh on 401 from authenticated, non-auth requests
    if (error.response?.status !== 401 || isAuthRequest || !hadToken || originalRequest._retry) {
      return Promise.reject(error);
    }

    const refreshToken = sessionStorage.getItem('refreshToken');
    if (!refreshToken) {
      sessionStorage.clear();
      const base = (import.meta.env.BASE_URL as string || '/').replace(/\/$/, '');
      window.location.href = `${base}/login`;
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // Another request is already refreshing — queue this one
      return new Promise((resolve, reject) => {
        failedQueue.push({
          resolve: (token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(apiClient(originalRequest));
          },
          reject,
        });
      });
    }

    isRefreshing = true;
    originalRequest._retry = true;

    try {
      const response = await axios.post(
        `${_apiBase}/auth/refresh`,
        { refresh_token: refreshToken },
      );

      const { access_token, refresh_token: newRefreshToken } = response.data;

      // Write new tokens to storage BEFORE releasing the queue so that
      // any request interceptor that reads sessionStorage picks up the
      // new token, not the expired one.
      sessionStorage.setItem('accessToken', access_token);
      if (newRefreshToken) {
        sessionStorage.setItem('refreshToken', newRefreshToken);
      }

      // Clear the refreshing flag before draining the queue so newly
      // arriving 401s don't get queued behind an already-resolved refresh.
      isRefreshing = false;
      processQueue(null, access_token);

      originalRequest.headers.Authorization = `Bearer ${access_token}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      isRefreshing = false;
      processQueue(refreshError, null);
      sessionStorage.clear();
      const base = (import.meta.env.BASE_URL as string || '/').replace(/\/$/, '');
      window.location.href = `${base}/login`;
      return Promise.reject(refreshError);
    }
  },
);

// ── ETag-based conditional GET cache ───────────────────────────────
//
// Backend returns an ETag on selected GETs (e.g. /auth/me,
// /tenants/mine). We stash {etag, body} in sessionStorage keyed by
// the request URL. Subsequent requests send If-None-Match; a 304
// reply means the body is unchanged, so we substitute the cached body
// and resolve the call as if the server had returned the data.
//
// Cache lives in sessionStorage so it dies with the tab — exactly the
// right scope (next mount may want fresh data after auth changes).
// Storage key is prefixed so it can't collide with other entries.

const ETAG_CACHE_PREFIX = 'etag:';

const _etagCacheKey = (url: string): string => `${ETAG_CACHE_PREFIX}${url}`;

const _readEtagCache = (url: string): { etag: string; body: unknown } | null => {
  try {
    const raw = sessionStorage.getItem(_etagCacheKey(url));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const _writeEtagCache = (url: string, etag: string, body: unknown): void => {
  try {
    sessionStorage.setItem(_etagCacheKey(url), JSON.stringify({ etag, body }));
  } catch {
    // Storage quota exceeded — swallow. Worst case is we just skip the
    // cache for this entry, not a correctness issue.
  }
};

apiClient.interceptors.request.use((config) => {
  // Only apply to GETs; only when we have a cached etag for this URL.
  if ((config.method?.toLowerCase() ?? 'get') !== 'get') return config;
  const url = config.url ?? '';
  if (!url) return config;
  const cached = _readEtagCache(url);
  if (cached?.etag) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)['If-None-Match'] = cached.etag;
  }
  return config;
});

apiClient.interceptors.response.use((response) => {
  const url = response.config.url ?? '';
  const status = response.status;

  // Server says nothing changed — return the cached body in place of
  // the empty 304 response. axios callers see a normal 200-shaped
  // result and never know the wire was a 304.
  if (status === 304 && url) {
    const cached = _readEtagCache(url);
    if (cached) {
      response.data = cached.body;
      response.status = 200;
    }
    return response;
  }

  // Fresh response with an ETag — stash it so the next request can
  // ride the cache.
  const etag = response.headers?.etag || response.headers?.ETag;
  if (etag && url && status >= 200 && status < 300) {
    _writeEtagCache(url, etag, response.data);
  }
  return response;
});

export default apiClient;

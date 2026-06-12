// Prepend the app's deploy base path to an absolute in-app path. Use this for
// any navigation that bypasses react-router's <Link>/navigate (which already
// honor the router basename) — e.g. window.open, window.location.href, raw
// <a href> — so sub-path deploys (prod: /apps/timesheet/) don't drop the prefix
// and land on the host root.
//
//   withBase('/dashboard')  -> '/apps/timesheet/dashboard'  (prod)
//                           -> '/dashboard'                  (root deploy / dev)
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, ''); // '' at root, '/apps/timesheet' in prod
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

// Same, but absolute (origin + base + path) — for new-tab / full-page nav.
export function withOrigin(path: string): string {
  return `${window.location.origin}${withBase(path)}`;
}

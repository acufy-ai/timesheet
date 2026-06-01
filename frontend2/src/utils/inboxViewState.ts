/**
 * Inbox view state persistence.
 *
 * When a reviewer opens a row in the inbox and clicks "Back to inbox"
 * from the review panel, we want them to land at the same row they
 * opened, with the same filters / search active, and scrolled into
 * the same place. Without this, every back-navigation snaps the list
 * back to the top, which is a real headache once the list has more
 * than ~20 rows.
 *
 * Persistence lives in sessionStorage (keyed by tenant id so two tabs
 * on two tenants don't collide). The state automatically clears when
 * the browser tab closes — a full reload SHOULD reset to a clean view,
 * but a same-session navigation should be preserved.
 *
 * Restoration on the inbox side is conditional: if the saved active
 * row is no longer in the list (e.g., it was approved and the filter
 * is `pending`), we fall back to restoring the scroll Y offset only.
 * That keeps the user's place in the list without misleadingly
 * highlighting a row that no longer matches.
 */

export interface InboxViewState {
  /** Status filter value as stored in the page's state. Empty string = no filter. */
  statusFilter: string;
  /** Client filter as a string id ('' = no filter). */
  clientId: string;
  /** Free-text search input. */
  search: string;
  /** window.scrollY at the moment of row-open. */
  scrollY: number;
  /** The `group.key` of the row the user clicked (see InboxPage row-group key). */
  activeRowKey: string | null;
  /** Wall-clock when this snapshot was taken. Used to age out stale entries. */
  savedAt: number;
}

const STORAGE_PREFIX = 'inbox.viewState';

// Older-than-this entries are ignored on restore. Bounds the "I came back
// 6 hours later in the same tab" weirdness — long enough to survive a
// quick coffee break, short enough that day-old state doesn't fight a
// fresh visit.
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Build the sessionStorage key for a given tenant. Returns null when
 * tenant is not available (so we degrade gracefully without polluting
 * a shared key across tenants).
 */
const buildKey = (tenantId: number | null | undefined): string | null => {
  if (tenantId == null) return null;
  return `${STORAGE_PREFIX}.${tenantId}`;
};

const safeSession = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // Private-mode Safari and a couple of locked-down browser configs
    // throw on access. Treat as "no persistence available" rather than
    // crashing the page.
    return null;
  }
};

/**
 * Persist the current inbox view. Called when a reviewer clicks a row
 * to open the review panel — that's the moment we want to remember
 * where they came from. Best-effort; storage failures are swallowed.
 */
export const writeInboxViewState = (
  tenantId: number | null | undefined,
  state: Omit<InboxViewState, 'savedAt'>,
): void => {
  const storage = safeSession();
  const key = buildKey(tenantId);
  if (!storage || !key) return;
  try {
    const payload: InboxViewState = { ...state, savedAt: Date.now() };
    storage.setItem(key, JSON.stringify(payload));
  } catch {
    // QuotaExceededError or similar — non-fatal.
  }
};

/**
 * Read the persisted view, or null when nothing's there / it's too old
 * / the JSON shape doesn't match (degrade silently rather than crash on
 * a stale schema). Doesn't clear on read — callers that want one-shot
 * semantics should call clearInboxViewState() after consuming.
 */
export const readInboxViewState = (
  tenantId: number | null | undefined,
): InboxViewState | null => {
  const storage = safeSession();
  const key = buildKey(tenantId);
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InboxViewState>;
    if (
      typeof parsed.statusFilter !== 'string'
      || typeof parsed.clientId !== 'string'
      || typeof parsed.search !== 'string'
      || typeof parsed.scrollY !== 'number'
      || typeof parsed.savedAt !== 'number'
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      return null;
    }
    return {
      statusFilter: parsed.statusFilter,
      clientId: parsed.clientId,
      search: parsed.search,
      scrollY: parsed.scrollY,
      activeRowKey:
        typeof parsed.activeRowKey === 'string' ? parsed.activeRowKey : null,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
};

/**
 * Drop the persisted view for the given tenant. Use after a successful
 * restore so a subsequent fresh visit (page reload, switch-and-back)
 * doesn't pull yesterday's state. Failures are swallowed.
 */
export const clearInboxViewState = (
  tenantId: number | null | undefined,
): void => {
  const storage = safeSession();
  const key = buildKey(tenantId);
  if (!storage || !key) return;
  try {
    storage.removeItem(key);
  } catch {
    // Non-fatal.
  }
};

/**
 * Scroll a row identified by ``data-row-key="..."`` into view and apply
 * a brief 2-second highlight class so the user can spot it. The class
 * name is added then removed on a timer — no CSS file change required
 * if the consumer has a `inbox-row-highlight` class on a stylesheet
 * (the inbox uses Tailwind, so we set inline styles instead for full
 * isolation).
 *
 * Returns true when a matching row was found and scrolled, false when
 * the saved key didn't match any rendered row.
 */
export const scrollAndHighlightRow = (rowKey: string): boolean => {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector<HTMLElement>(
    `[data-row-key="${CSS.escape(rowKey)}"]`,
  );
  if (!el) return false;

  el.scrollIntoView({ block: 'nearest', behavior: 'auto' });

  // Brief visual highlight via inline style transitions. We use the
  // CSS variable ``--primary`` (tailwind theme color) so the highlight
  // matches the app's accent regardless of light/dark mode. Inline so
  // we don't depend on a stylesheet class that might or might not
  // exist.
  const prevTransition = el.style.transition;
  const prevBackground = el.style.backgroundColor;
  el.style.transition = 'background-color 0.5s ease-out';
  el.style.backgroundColor = 'rgba(var(--primary-rgb, 124, 58, 237), 0.18)';

  window.setTimeout(() => {
    el.style.backgroundColor = prevBackground;
  }, 1600);
  window.setTimeout(() => {
    el.style.transition = prevTransition;
  }, 2100);

  return true;
};

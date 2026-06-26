// Single source of truth for the served/retained calendar window (spec §5).
// The poller expands each feed's recurrence over this window into the events
// table; the read service rejects ranges that fall fully outside it; and
// /calendars + /calendar/view expose it (window: { past_days, future_days }) so
// first-party consumers read the policy instead of hard-coding it (F-018).
// Symmetric ±365 days (widened from -7/+90, F-018 2026-06-26).

export const WINDOW_PAST_DAYS = 365;
export const WINDOW_FUTURE_DAYS = 365;

const DAY_MS = 86_400_000;
export const WINDOW_PAST_MS = WINDOW_PAST_DAYS * DAY_MS;
export const WINDOW_FUTURE_MS = WINDOW_FUTURE_DAYS * DAY_MS;

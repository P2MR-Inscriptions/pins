// SPDX-License-Identifier: Apache-2.0
/**
 * Backoff for failed explorer content loads (images and text frames).
 * Honours Retry-After when the server sent one (429 and 503 do). Does not use
 * blob: object URLs, so the page CSP can keep img-src as 'self'.
 */

/** Retries after the first attempt. Four tries in total. */
export const CONTENT_RETRIES = 3;

const MAX_DELAY_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;
const BASE_DELAY_MS = 400;

/**
 * How long to wait before the next try. `header` is the Retry-After value
 * (seconds or an HTTP date). `attempt` is 0-based after the first failure.
 * The wait is capped at 30s.
 */
export function retryDelayMs(header, attempt, base = BASE_DELAY_MS) {
  const n = Math.max(0, Number(attempt) || 0);
  if (typeof header === "string" && header.trim()) {
    const raw = header.trim();
    if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_DELAY_MS);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), MAX_DELAY_MS);
  }
  return Math.min(base * 2 ** n, MAX_BACKOFF_MS);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch `url` and retry on 429, 503, or a network error. Other HTTP statuses
 * are returned as-is. After the last try, a failing Response is returned and a
 * network error is thrown.
 */
export async function fetchWithRetry(url, init, opts = {}) {
  const attempts = (opts.attempts ?? CONTENT_RETRIES) + 1;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastError = undefined;
      if (res.status !== 429 && res.status !== 503) return res;
      if (i === attempts - 1) return res;
      await wait(retryDelayMs(res.headers.get("Retry-After"), i));
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) throw err;
      await wait(retryDelayMs(null, i));
    }
  }
  if (lastError) throw lastError;
  throw new Error("content fetch failed");
}

/**
 * After an <img> error, probe the same URL so Retry-After can be honoured,
 * then point `img.src` at the URL again (with a cache-busting query). Call
 * `onGiveUp` when retries are exhausted or the status is not 429/503.
 * A cache-busting query is ignored by the content route.
 */
export function attachImageRetry(img, url, onGiveUp) {
  let attempt = 0;
  const fail = async () => {
    if (!img.isConnected) return;
    if (attempt >= CONTENT_RETRIES) {
      onGiveUp();
      return;
    }
    let delay = retryDelayMs(null, attempt);
    try {
      const res = await fetch(url, { cache: "reload" });
      if (res.ok) {
        attempt += 1;
        img.src = withRetryQuery(url, attempt);
        return;
      }
      if (res.status !== 429 && res.status !== 503) {
        onGiveUp();
        return;
      }
      delay = retryDelayMs(res.headers.get("Retry-After"), attempt);
    } catch {
      // Network error: use the exponential backoff.
    }
    attempt += 1;
    await wait(delay);
    if (!img.isConnected) return;
    img.src = withRetryQuery(url, attempt);
  };
  img.addEventListener("error", () => {
    void fail();
  });
}

function withRetryQuery(url, attempt) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}retry=${attempt}`;
}

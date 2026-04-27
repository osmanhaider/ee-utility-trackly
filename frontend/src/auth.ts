const KEY = "ee-utility-trackly:token";
const CALLBACK_PATH = "/auth/callback";
const ERROR_KEY = "ee-utility-trackly:auth-callback-error";

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // localStorage disabled (private mode) — token won't persist but the
    // session is still valid for the current page load.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}

/**
 * One-shot bootstrap: when the iOS redirect-mode sign-in flow lands the
 * user on `/auth/callback#token=…`, persist the token into localStorage,
 * scrub the URL so a refresh doesn't leak it, and let the rest of the
 * app boot normally. Errors get stashed so the LoginScreen can surface
 * them after the redirect home.
 *
 * Call this once at module load (before <App/> mounts) so `getToken()`
 * is already populated by the time state is initialised.
 */
export function consumeAuthCallback(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== CALLBACK_PATH) return;

  const fragment = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(fragment);
  const token = params.get("token");
  const error = params.get("error");

  if (token) {
    setToken(token);
  } else if (error) {
    try {
      sessionStorage.setItem(ERROR_KEY, error);
    } catch {
      // ignore
    }
  }

  // Strip the callback path + fragment so a refresh doesn't replay it
  // and the URL bar reads cleanly.
  window.history.replaceState(null, "", "/");
}

export function readAuthCallbackError(): string | null {
  try {
    const v = sessionStorage.getItem(ERROR_KEY);
    if (v) sessionStorage.removeItem(ERROR_KEY);
    return v;
  } catch {
    return null;
  }
}

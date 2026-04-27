/**
 * Lazy loader and minimal types for Google Identity Services (GIS).
 *
 * The GIS script (`https://accounts.google.com/gsi/client`) registers a
 * global `window.google.accounts.id` namespace. We only use a tiny slice of
 * its surface: `initialize`, `renderButton`, and `disableAutoSelect`.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback?: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
            /** When set to "redirect", GIS does a full-page POST to
             *  `login_uri` instead of using the popup/iframe credential
             *  callback. Required for iOS standalone PWAs where the
             *  popup credential delivery is broken. */
            ux_mode?: "popup" | "redirect";
            login_uri?: string;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: Record<string, unknown>,
          ) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

let loadPromise: Promise<void> | null = null;

export function loadGoogleIdentityServices(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("GIS script failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("GIS script failed to load"));
    document.head.appendChild(s);
  });
  return loadPromise;
}

export function getGoogleClientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
}

/** True for iPhone / iPad Safari, including iPadOS-as-Mac (which reports
 *  "MacIntel" but has touch points). The popup-based GIS flow misbehaves
 *  on iOS standalone PWAs (storage partitioning + cross-origin
 *  postMessage), so the login screen swaps to a full-page redirect flow
 *  on these devices. */
export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ identifies as MacIntel but has touch.
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1;
}

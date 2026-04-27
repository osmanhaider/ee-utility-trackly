import { useEffect, useMemo, useRef, useState } from "react";
import {
  Receipt, AlertCircle, Loader2, BarChart2, Sparkles, Lock, Users,
} from "lucide-react";
import axios from "axios";
import { api } from "../api";
import { readAuthCallbackError, setToken } from "../auth";
import { getGoogleClientId, isIOSDevice, loadGoogleIdentityServices } from "../google";
import { useTheme } from "../theme";

interface Props {
  onSuccess: () => void;
}

const TAGLINES: { lead: string; punchline: string }[] = [
  { lead: "Welcome to the world of high-stakes finance.", punchline: "Just kidding — it's your gas bill." },
  { lead: "Bull markets. Bear markets. Korteriühistu markets.", punchline: "Track 'em all here." },
  { lead: "Your CFO will see you now.", punchline: "(Your CFO is a parser written in Python.)" },
  { lead: "Spreadsheets, but make them charts.", punchline: "Twelve charts, in fact. We counted." },
];

const FEATURES: { icon: React.ElementType; title: string; body: string }[] = [
  {
    icon: Sparkles,
    title: "Drop a PDF, get structured data",
    body: "Local OCR for Estonian bills. AI fallback for anything weirder.",
  },
  {
    icon: BarChart2,
    title: "12 sections of suspiciously specific charts",
    body: "MoM, YoY, seasonal, price vs consumption. The works.",
  },
  {
    icon: Users,
    title: "Compare with the community (or don't)",
    body: "See what your neighbours pay. Lock the bills you'd rather not share.",
  },
  {
    icon: Lock,
    title: "Public-by-default, private-when-you-want",
    body: "One toggle hides a bill from the Community tab forever.",
  },
];

const REDIRECT_ERROR_MESSAGES: Record<string, string> = {
  csrf:
    "Sign-in failed CSRF check. This usually means the session was opened in one browser and finished in another — try again.",
  "invalid-token":
    "Google rejected the sign-in token. Try again, or use a different Google account.",
};

export default function LoginScreen({ onSuccess }: Props) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  // Surface any error stashed by the iOS redirect-callback handler
  // (/auth/callback#error=…) so the user sees it after they get bounced
  // back to the login screen. One-shot read; sessionStorage clears on
  // first call.
  const [runtimeError, setRuntimeError] = useState<string | null>(() => {
    const code = readAuthCallbackError();
    if (!code) return null;
    return REDIRECT_ERROR_MESSAGES[code] ?? "Sign-in didn't complete. Please try again.";
  });
  const [exchanging, setExchanging] = useState(false);
  const [ready, setReady] = useState(false);
  const [taglineIdx, setTaglineIdx] = useState(() =>
    Math.floor(Math.random() * TAGLINES.length),
  );
  const clientId = getGoogleClientId();
  const { resolved } = useTheme();
  // iOS Safari (and especially the standalone home-screen PWA) cannot
  // reliably receive credentials from GIS's popup/iframe flow — the
  // credential delivery hits storage-partitioning and cross-origin
  // postMessage walls, which surfaces as Google's "try again" right
  // after the user confirms. Switch GIS to redirect mode there: Google
  // does a full-page POST to a backend endpoint, which validates and
  // redirects back to /auth/callback#token=… for the SPA to consume.
  const useRedirectFlow = isIOSDevice();
  const apiBase = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
  const loginUri = apiBase ? `${apiBase}/api/auth/google-redirect` : null;
  const configError =
    !clientId
      ? "Google sign-in is not configured. Set VITE_GOOGLE_CLIENT_ID on the frontend and GOOGLE_CLIENT_ID on the backend."
      : useRedirectFlow && !loginUri
        ? "Sign-in needs VITE_API_URL configured on the frontend so iOS can redirect through the backend."
        : null;
  const error = configError ?? runtimeError;
  const tagline = TAGLINES[taglineIdx];

  // Cycle the joke every ~6 seconds. Users who linger long enough deserve
  // a second punchline.
  useEffect(() => {
    const id = setInterval(
      () => setTaglineIdx(i => (i + 1) % TAGLINES.length),
      6500,
    );
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!clientId) return;
    if (useRedirectFlow && !loginUri) return; // configError already surfaces this
    let cancelled = false;
    loadGoogleIdentityServices()
      .then(() => {
        if (cancelled || !window.google || !buttonRef.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          ...(useRedirectFlow
            ? { ux_mode: "redirect", login_uri: loginUri ?? undefined }
            : {
                callback: async (resp) => {
                  setRuntimeError(null);
                  setExchanging(true);
                  try {
                    const r = await api.loginWithGoogle(resp.credential);
                    setToken(r.data.token);
                    onSuccess();
                  } catch (e) {
                    if (axios.isAxiosError(e)) {
                      const detail = (e.response?.data as { detail?: string } | undefined)?.detail;
                      setRuntimeError(detail ?? "Sign-in failed. Please try again.");
                    } else {
                      setRuntimeError("Could not reach the server. Check your connection.");
                    }
                  } finally {
                    setExchanging(false);
                  }
                },
              }),
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: resolved === "dark" ? "filled_black" : "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
          width: 300,
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setRuntimeError("Couldn't load Google Sign-In. Try refreshing the page.");
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, onSuccess, resolved, useRedirectFlow, loginUri]);

  const isWide = useIsWide();

  // Build a tiny animated chart preview in the right column. Computed once
  // per mount so the line draws in deterministically.
  const chartPath = useMemo(() => {
    const values = [22, 28, 24, 32, 30, 38, 36, 44, 41, 50, 48, 56];
    const w = 280;
    const h = 110;
    const pad = 8;
    const xs = values.length;
    const max = Math.max(...values);
    const points = values.map((v, i) => {
      const x = pad + (i / (xs - 1)) * (w - pad * 2);
      const y = h - pad - (v / max) * (h - pad * 2);
      return [x, y] as const;
    });
    const path = points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    const area = `${path} L${points[points.length - 1][0].toFixed(1)},${(h - pad).toFixed(1)} L${points[0][0].toFixed(1)},${(h - pad).toFixed(1)} Z`;
    return { path, area, points, w, h };
  }, []);

  const supportingContent = (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 540 }}>
      {/* Feature list */}
      <ul
        className="list-stagger"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: isWide ? "1fr 1fr" : "1fr",
          gap: 12,
        }}
      >
        {FEATURES.map(({ icon: Icon, title, body }, i) => (
          <li
            key={title}
            className="lift"
            style={{
              ["--i" as string]: i,
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "12px 14px",
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 12,
            } as React.CSSProperties}
          >
            <div
              style={{
                width: 32, height: 32, borderRadius: 8,
                background: "var(--accent-soft)", color: "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Icon size={15} />
            </div>
            <div>
              <div style={{ color: "var(--text-1)", fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                {title}
              </div>
              <div style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.45 }}>
                {body}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Mini animated chart preview */}
      <div
        className="lift"
        style={{
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Sneak peek · Monthly Trend
          </div>
          <div style={{ fontSize: 11, color: "var(--text-2)", whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--success)", fontWeight: 600 }}>+154%</span> over 12 months
          </div>
        </div>
        <svg viewBox={`0 0 ${chartPath.w} ${chartPath.h}`} width="100%" height="auto" style={{ display: "block" }}>
          <defs>
            <linearGradient id="loginChartFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.36" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={chartPath.area} fill="url(#loginChartFill)" />
          <path
            d={chartPath.path}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              strokeDasharray: 720,
              strokeDashoffset: 720,
              animation: "drawLine 1.6s ease-out 0.3s forwards",
            }}
          />
          {chartPath.points.map(([x, y], i) => (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={2.5}
              fill="var(--accent)"
              style={{
                opacity: 0,
                animation: `popIn 0.45s ease ${0.4 + i * 0.06}s forwards`,
              }}
            />
          ))}
        </svg>
      </div>
    </div>
  );

  return (
    <div
      className="login-page"
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text-1)",
        padding: 24,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Decorative animated orbs in the background. They're absolutely
          positioned and sit behind the main content. */}
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 1080,
          margin: "0 auto",
          minHeight: isWide ? "calc(100vh - 48px)" : "auto",
          display: "grid",
          gridTemplateColumns: isWide ? "1.05fr 1fr" : "1fr",
          gap: isWide ? 56 : 20,
          alignItems: "center",
        }}
      >
        {/* Hero column */}
        <div className="slide-up" style={{ display: "flex", flexDirection: "column", gap: isWide ? 24 : 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              className="pulse-accent"
              style={{
                width: 52, height: 52,
                background: "linear-gradient(135deg, var(--accent), var(--accent-strong))",
                borderRadius: 14,
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "var(--shadow-accent)",
              }}
            >
              <Receipt size={24} color="var(--text-on-accent)" />
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-1)", letterSpacing: -0.4 }}>
                EE Utility Tracker
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", letterSpacing: 0.2 }}>
                Estonia bill analytics · since you asked
              </div>
            </div>
          </div>

          <div>
            <h1
              style={{
                margin: 0,
                fontSize: isWide ? 40 : 30,
                fontWeight: 800,
                lineHeight: 1.1,
                letterSpacing: -0.6,
                color: "var(--text-1)",
              }}
            >
              <span
                key={`lead-${taglineIdx}`}
                className="fade-in"
                style={{ display: "inline-block" }}
              >
                {tagline.lead}
              </span>
              <br />
              <span
                key={`pun-${taglineIdx}`}
                className="fade-in"
                style={{
                  background: "linear-gradient(90deg, var(--accent), var(--info))",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  display: "inline-block",
                  marginTop: 4,
                }}
              >
                {tagline.punchline}
              </span>
            </h1>
            <p
              style={{
                color: "var(--text-2)",
                fontSize: 15,
                lineHeight: 1.55,
                margin: isWide ? "14px 0 0" : "12px 0 0",
                maxWidth: 520,
              }}
            >
              Drop your monthly utility bills, watch the parser shred the line items,
              then tour twelve dashboard sections of charts you didn't know you needed.
              Keep them private or share them with friends in the Community tab.
            </p>
          </div>

          {isWide && supportingContent}
        </div>

        {/* Sign-in column */}
        <div
          className="slide-up"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 18,
            padding: 32,
            display: "flex",
            flexDirection: "column",
            gap: 20,
            alignItems: "center",
            boxShadow: "var(--shadow-lg)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            animationDelay: "120ms",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-1)", letterSpacing: -0.2 }}>
              Sign in to get started
            </div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 6, lineHeight: 1.5 }}>
              No password to remember. We never see anything beyond your name and avatar.
            </div>
          </div>

          <div
            ref={buttonRef}
            style={{ minHeight: 48, display: "flex", justifyContent: "center" }}
          />

          {!ready && !error && (
            <div style={{ color: "var(--text-2)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              Warming up sign-in…
            </div>
          )}

          {exchanging && (
            <div style={{ color: "var(--accent)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              Signing you in…
            </div>
          )}

          {error && (
            <div
              className="fade-in"
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                color: "var(--danger)",
                fontSize: 13,
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                width: "100%",
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              textAlign: "center",
              borderTop: "1px solid var(--divider)",
              width: "100%",
              paddingTop: 14,
              lineHeight: 1.5,
            }}
          >
            By signing in you accept that this is a hobby project, your parsed
            bill data lives in Supabase/Postgres, and at least one of these
            jokes will land.
          </div>
        </div>

        {!isWide && (
          <div className="slide-up" style={{ animationDelay: "180ms" }}>
            {supportingContent}
          </div>
        )}
      </div>

      {/* Page-local keyframes for the orbs and chart line. Theme transitions
          are intentionally suppressed on the orbs (.no-theme-transition) so
          they don't blink during a theme swap. */}
      <style>{`
        .login-page .orb {
          position: absolute;
          z-index: 0;
          border-radius: 50%;
          filter: blur(64px);
          pointer-events: none;
          opacity: 0.55;
          will-change: transform;
        }
        .login-page .orb-1 {
          width: 480px; height: 480px;
          left: -120px; top: -160px;
          background: radial-gradient(circle, var(--accent), transparent 70%);
          animation: floatA 14s ease-in-out infinite;
        }
        .login-page .orb-2 {
          width: 380px; height: 380px;
          right: -120px; top: 40%;
          background: radial-gradient(circle, var(--info), transparent 70%);
          animation: floatB 18s ease-in-out infinite;
          opacity: 0.4;
        }
        .login-page .orb-3 {
          width: 320px; height: 320px;
          left: 30%; bottom: -160px;
          background: radial-gradient(circle, var(--accent-strong), transparent 70%);
          animation: floatC 22s ease-in-out infinite;
          opacity: 0.35;
        }
        @keyframes floatA {
          0%, 100% { transform: translate(0, 0); }
          50%      { transform: translate(40px, 30px); }
        }
        @keyframes floatB {
          0%, 100% { transform: translate(0, 0); }
          50%      { transform: translate(-50px, -20px); }
        }
        @keyframes floatC {
          0%, 100% { transform: translate(0, 0); }
          50%      { transform: translate(20px, -40px); }
        }
        @keyframes drawLine {
          to { stroke-dashoffset: 0; }
        }
        @keyframes popIn {
          from { opacity: 0; transform: scale(0.4); transform-origin: center; }
          to   { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .login-page .orb { animation: none; }
        }
      `}</style>
    </div>
  );
}

function useIsWide(): boolean {
  const [wide, setWide] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 880px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 880px)");
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

import { useEffect, useState } from "react";
import UploadTab from "./components/UploadTab";
import BillsTab from "./components/BillsTab";
import AnalyticsTab from "./components/AnalyticsTab";
import HelpTab from "./components/HelpTab";
import CommunityTab from "./components/CommunityTab";
import SettingsTab from "./components/SettingsTab";
import LoginScreen from "./components/LoginScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import ThemeToggle from "./components/ThemeToggle";
import {
  BarChart2, Receipt, Upload, HelpCircle, LogOut, Users as UsersIcon,
  Settings as SettingsIcon,
} from "lucide-react";
import { api, type User } from "./api";
import { clearToken, getToken } from "./auth";
import { useIsMobile } from "./hooks/useIsMobile";
import { useTheme } from "./theme";

type Tab = "upload" | "bills" | "analytics" | "community" | "settings" | "help";
type AuthState = "loading" | "required" | "authed";
const TABS: Tab[] = ["upload", "bills", "analytics", "community", "settings", "help"];

function tabFromHash(): Tab {
  const raw = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  return TABS.includes(raw as Tab) ? (raw as Tab) : "upload";
}

function hashForTab(tab: Tab): string {
  return `#/${tab}`;
}

export default function App() {
  // Drives the document `data-theme` attribute so the whole app retheme
  // happens via CSS vars in styles/theme.css.
  useTheme();

  const [tab, setTab] = useState<Tab>(() => tabFromHash());
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploadsRunning, setUploadsRunning] = useState(false);
  // Lazy initial: skip the loading state entirely if there's no token to verify.
  const [authState, setAuthState] = useState<AuthState>(() =>
    getToken() ? "loading" : "required",
  );
  const [me, setMe] = useState<User | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const isMobile = useIsMobile();

  const refresh = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigateTab = (next: Tab) => {
    if (tab === next) return;
    window.history.pushState(null, "", hashForTab(next));
    setTab(next);
  };

  // On mount, validate the stored token by hitting /api/auth/me. The axios
  // 401 interceptor handles expired tokens by emitting `auth:logout`.
  useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      return;
    }
    api
      .getMe()
      .then((res) => {
        if (cancelled) return;
        setMe(res.data);
        setAuthState("authed");
      })
      .catch(() => {
        if (!cancelled) setAuthState("required");
      });
    const onLogout = () => {
      setMe(null);
      setAuthState("required");
    };
    window.addEventListener("auth:logout", onLogout);
    return () => {
      cancelled = true;
      window.removeEventListener("auth:logout", onLogout);
    };
  }, []);

  const onLoginSuccess = () => {
    api
      .getMe()
      .then((res) => {
        setMe(res.data);
        setAuthState("authed");
      })
      .catch(() => setAuthState("required"));
  };

  const logout = () => {
    clearToken();
    setMe(null);
    setProfileOpen(false);
    setAuthState("required");
  };

  if (authState === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg)",
          color: "var(--text-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Loading…
      </div>
    );
  }

  if (authState === "required") {
    return <LoginScreen onSuccess={onLoginSuccess} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text-1)" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "color-mix(in oklab, var(--bg-elev) 88%, transparent)",
          backdropFilter: "saturate(140%) blur(10px)",
          WebkitBackdropFilter: "saturate(140%) blur(10px)",
          borderBottom: "1px solid var(--border)",
          padding: isMobile ? "8px 10px" : "14px 24px",
          display: "flex",
          alignItems: "center",
          gap: isMobile ? 6 : 16,
          overflowX: isMobile ? "auto" : "visible",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12 }}>
          <div
            style={{
              width: isMobile ? 30 : 34,
              height: isMobile ? 30 : 34,
              background: "linear-gradient(135deg, var(--accent), var(--accent-strong))",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              boxShadow: "var(--shadow-accent)",
            }}
          >
            <Receipt size={17} color="var(--text-on-accent)" />
          </div>
          {!isMobile && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)", letterSpacing: -0.1 }}>
                EE Utility Tracker
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>Estonia bill analytics</div>
            </div>
          )}
        </div>

        <nav
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: isMobile ? 2 : 4,
            alignItems: "center",
            minWidth: isMobile ? "max-content" : undefined,
          }}
        >
          {          ([
            ["upload", "Upload", Upload],
            ["bills", "Bills", Receipt],
            ["analytics", "Analytics", BarChart2],
            ["community", "Community", UsersIcon],
            ["settings", "Settings", SettingsIcon],
            ["help", "Help", HelpCircle],
          ] as [Tab, string, React.ElementType][]).map(([id, label, Icon]) => {
            const active = tab === id;
            const showRunningDot = id === "upload" && uploadsRunning && !active;
            return (
              <button
                key={id}
                onClick={() => navigateTab(id)}
                title={label}
                className="btn-press"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: isMobile ? "10px 11px" : "8px 14px",
                  borderRadius: 8,
                  border: "1px solid",
                  borderColor: active ? "transparent" : "transparent",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent)" : "var(--text-2)",
                  position: "relative",
                }}
              >
                <Icon size={16} />
                {!isMobile && label}
                {showRunningDot && (
                  <span
                    aria-label="Uploads in progress"
                    style={{
                      position: "absolute",
                      top: 6,
                      right: 6,
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      boxShadow: "0 0 0 2px var(--bg-elev)",
                      animation: "pulseAccent 1.4s ease-in-out infinite",
                    }}
                  />
                )}
              </button>
            );
          })}

          <span style={{ width: isMobile ? 2 : 8, display: "inline-block" }} />
          <ThemeToggle compact={isMobile} />

          {me && (
            <div style={{ position: "relative", marginLeft: isMobile ? 4 : 8, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setProfileOpen(open => !open)}
                title={me.email ?? me.name ?? "Profile"}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                className="btn-press"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: isMobile ? "4px 6px" : "4px 10px 4px 4px",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: profileOpen ? "var(--accent-soft)" : "var(--surface-1)",
                  color: profileOpen ? "var(--accent)" : "var(--text-2)",
                  cursor: "pointer",
                }}
              >
                {me.picture ? (
                  <img
                    src={me.picture}
                    alt=""
                    width={26}
                    height={26}
                    referrerPolicy="no-referrer"
                    style={{ borderRadius: "50%", display: "block" }}
                  />
                ) : (
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      color: "var(--text-on-accent)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {(me.name ?? me.email ?? "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
                {!isMobile && (
                  <span
                    style={{
                      fontSize: 12,
                      maxWidth: 140,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {me.name ?? me.email}
                  </span>
                )}
              </button>
              {profileOpen && (
                <>
                  <button
                    aria-label="Close profile menu"
                    onClick={() => setProfileOpen(false)}
                    style={{
                      position: "fixed",
                      inset: 0,
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "default",
                      zIndex: 29,
                    }}
                  />
                  <div
                    role="menu"
                    className="slide-up"
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 10px)",
                      zIndex: 30,
                      minWidth: isMobile ? 220 : 240,
                      background: "var(--surface-1)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      boxShadow: "var(--shadow-lg)",
                      padding: 10,
                    }}
                  >
                    <div style={{ padding: "6px 8px 10px", borderBottom: "1px solid var(--divider)", marginBottom: 8 }}>
                      <div style={{ color: "var(--text-1)", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {me.name ?? "Signed in"}
                      </div>
                      <div style={{ color: "var(--text-3)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {me.email}
                      </div>
                    </div>
                    <button
                      onClick={logout}
                      role="menuitem"
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        background: "transparent",
                        border: "none",
                        borderRadius: 8,
                        color: "var(--danger)",
                        padding: "9px 10px",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 600,
                        textAlign: "left",
                      }}
                    >
                      <LogOut size={14} />
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </nav>
      </header>

      <main
        style={{
          padding: isMobile ? "16px 12px" : "28px 24px",
          maxWidth: 1280,
          margin: "0 auto",
        }}
      >
        <ErrorBoundary>
          {/* Upload stays mounted across tab switches so an in-flight queue
              isn't lost when the user navigates away and comes back. */}
          <div
            style={{ display: tab === "upload" ? "block" : "none" }}
            aria-hidden={tab !== "upload"}
          >
            <UploadTab
              onSuccess={() => { refresh(); navigateTab("bills"); }}
              onRunningChange={setUploadsRunning}
              isActive={tab === "upload"}
            />
          </div>
          {tab !== "upload" && (
            <div key={tab} className="tab-content">
              {tab === "bills" && <BillsTab onDataChange={refresh} />}
              {tab === "analytics" && <AnalyticsTab reloadKey={refreshKey} />}
              {tab === "community" && <CommunityTab reloadKey={refreshKey} />}
              {tab === "settings" && <SettingsTab />}
              {tab === "help" && <HelpTab />}
            </div>
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}

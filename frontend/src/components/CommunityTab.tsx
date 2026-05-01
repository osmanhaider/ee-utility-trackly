import { useCallback, useEffect, useMemo, useState } from "react";
import { Users as UsersIcon, Loader2, AlertCircle } from "lucide-react";
import { api, type Bill, type CommunityUser } from "../api";
import AnalyticsTab from "./AnalyticsTab";
import { useIsMobile } from "../hooks/useIsMobile";

const UTILITY_ICONS: Record<string, string> = {
  electricity: "⚡", gas: "🔥", water: "💧",
  heating: "♨️", internet: "🌐", waste: "🗑️", other: "📄",
};

const TYPE_COLORS: Record<string, string> = {
  electricity: "#f59e0b", gas: "#f97316", water: "#0ea5e9",
  heating: "#dc2626", internet: "#8b5cf6", waste: "#64748b", other: "#94a3b8",
};

interface CommunityTabProps {
  /** Bumped by the parent on data mutations to force a refetch. */
  reloadKey?: number;
}

export default function CommunityTab({ reloadKey }: CommunityTabProps = {}) {
  const [users, setUsers] = useState<CommunityUser[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingBills, setLoadingBills] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    api.listCommunityUsers()
      .then((r) => {
        if (cancelled) return;
        setUsers(r.data);
        // Default to the first user (sorted by bill_count DESC server-side
        // so the most-active person leads). The aggregate "All users" view
        // is intentionally not exposed any more — analytics + bills are
        // always scoped to a single user.
        setSelectedUserId((prev) => prev ?? r.data[0]?.id ?? null);
      })
      .catch(() => { if (!cancelled) setError("Couldn't load community users."); })
      .finally(() => { if (!cancelled) setLoadingUsers(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    // Skip the fetch entirely when no user is picked — the JSX renders
    // a "Pick a member above" empty state purely from selectedUserId,
    // so any stale bills array from a previous selection is harmless
    // (it's never read in that branch). Means we can also avoid a
    // setState-in-effect for the clear case.
    if (!selectedUserId) return;
    let cancelled = false;
    // Showing the loader on user-picker changes is the whole point of this
    // effect — disabling the rule here is intentional, not an oversight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingBills(true);
    api.listCommunityBills(selectedUserId)
      .then((r) => { if (!cancelled) setBills(r.data); })
      .catch(() => { if (!cancelled) setError("Couldn't load community bills."); })
      .finally(() => { if (!cancelled) setLoadingBills(false); });
    return () => { cancelled = true; };
  }, [selectedUserId, reloadKey]);

  const analyticsSource = useCallback(
    () => api.getCommunityAnalytics(selectedUserId ?? undefined),
    [selectedUserId],
  );

  const totalEur = useMemo(
    () => bills.reduce((s, b) => s + (b.amount_eur ?? 0), 0),
    [bills],
  );

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-1)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
  };

  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ color: "var(--text-1)", margin: 0, fontSize: 22, letterSpacing: -0.2 }}>Community</h2>
        <p style={{ color: "var(--text-2)", margin: "4px 0 0", fontSize: 13 }}>
          Insights from individual signed-in users. Pick a person to see their dashboard.
          Anything anyone marks private stays out of view here.
        </p>
      </div>

      <div style={{ ...cardStyle, padding: 12, marginBottom: 16, overflowX: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "nowrap" : "wrap" }}>
          {users.map((u) => (
            <UserChip
              key={u.id}
              active={selectedUserId === u.id}
              onClick={() => setSelectedUserId(u.id)}
              picture={u.picture_url ?? null}
              primary={u.name ?? u.email ?? "Anon"}
              secondary={`${u.bill_count} bill${u.bill_count === 1 ? "" : "s"}`}
            />
          ))}
          {loadingUsers && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-2)", fontSize: 12, padding: "0 8px" }}>
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              Loading users…
            </span>
          )}
          {!loadingUsers && users.length === 0 && (
            <span style={{ color: "var(--text-2)", fontSize: 12, padding: "0 8px" }}>
              No community users yet.
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{ ...cardStyle, padding: 12, marginBottom: 16, borderLeft: "3px solid var(--danger)", display: "flex", gap: 8, alignItems: "center", color: "var(--danger)", fontSize: 13 }}>
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {selectedUserId ? (
        <AnalyticsTab
          source={analyticsSource}
          // Each (reloadKey, user) pair gets a unique reloadKey so
          // AnalyticsTab refetches when either changes. Hashing the userId
          // (instead of just `1`) avoids cross-user analytics getting
          // served from the cache when switching between people.
          reloadKey={(reloadKey ?? 0) * 100000 + hashUserId(selectedUserId)}
        />
      ) : !loadingUsers ? (
        <div style={{ ...cardStyle, padding: 32, textAlign: "center", color: "var(--text-3)" }}>
          <UsersIcon size={28} style={{ marginBottom: 8 }} />
          <div>Pick a community member above to see their dashboard.</div>
        </div>
      ) : null}

      <div style={{ marginTop: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ color: "var(--text-1)", margin: 0, fontSize: 16 }}>
            {selectedUser
              ? <>Public bills from <strong>{selectedUser.name ?? selectedUser.email}</strong></>
              : "Public bills"}
          </h3>
          <div style={{ fontSize: 12, color: "var(--text-2)" }}>
            {bills.length} bill{bills.length === 1 ? "" : "s"} · Total: <strong style={{ color: "var(--success)" }}>€{totalEur.toFixed(2)}</strong>
          </div>
        </div>
        {!selectedUserId ? (
          <div style={{ ...cardStyle, padding: 32, textAlign: "center", color: "var(--text-3)" }}>
            <UsersIcon size={28} style={{ marginBottom: 8 }} />
            <div>Pick a member above to see their public bills.</div>
          </div>
        ) : loadingBills ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 56, borderRadius: 12 }} />
            ))}
          </div>
        ) : bills.length === 0 ? (
          <div style={{ ...cardStyle, padding: 32, textAlign: "center", color: "var(--text-3)" }}>
            <UsersIcon size={28} style={{ marginBottom: 8 }} />
            <div>No public bills from this user yet.</div>
          </div>
        ) : (
          <div className="list-stagger" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {bills.map((bill, i) => {
              const color = TYPE_COLORS[bill.utility_type ?? "other"] ?? "#9ca3af";
              return (
                <div
                  key={bill.id}
                  className="lift"
                  style={{
                    ...cardStyle,
                    padding: isMobile ? "10px 12px" : "14px 18px",
                    display: "flex", alignItems: "center", gap: 14,
                    ["--i" as string]: Math.min(i, 12),
                  } as React.CSSProperties}
                >
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: `${color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                    {UTILITY_ICONS[bill.utility_type ?? "other"] ?? "📄"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, color: "var(--text-1)", fontSize: 14 }}>{bill.provider ?? "Unknown Provider"}</span>
                      {bill.utility_type && (
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: `${color}22`, color, border: `1px solid ${color}44`, textTransform: "capitalize" }}>
                          {bill.utility_type}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>{bill.bill_date ?? bill.upload_date?.slice(0, 10)}</span>
                      <span style={{ color: "var(--border-strong)" }}>·</span>
                      {bill.owner_picture ? (
                        <img src={bill.owner_picture} alt="" width={14} height={14} referrerPolicy="no-referrer" style={{ borderRadius: "50%" }} />
                      ) : null}
                      <span>{bill.owner_name ?? "Unknown"}</span>
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: "var(--success)", flexShrink: 0 }}>
                    {bill.amount_eur != null ? `€${bill.amount_eur.toFixed(2)}` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Tiny djb2 hash so each user gets a stable numeric reloadKey. The
 *  exact value doesn't matter — only that it changes when the userId
 *  changes, which forces AnalyticsTab to refetch on user-switch. */
function hashUserId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  // Keep within a comfortable safe integer range when added to reloadKey.
  return Math.abs(h) % 100000;
}

interface UserChipProps {
  active: boolean;
  onClick: () => void;
  picture?: string | null;
  icon?: React.ReactNode;
  primary: string;
  secondary: string;
}

function UserChip({ active, onClick, picture, icon, primary, secondary }: UserChipProps) {
  return (
    <button
      onClick={onClick}
      className="btn-press"
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 12px 6px 6px",
        borderRadius: 999,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent-soft)" : "var(--surface-2)",
        color: active ? "var(--accent)" : "var(--text-1)",
        cursor: "pointer",
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      {picture ? (
        <img src={picture} alt="" width={26} height={26} referrerPolicy="no-referrer" style={{ borderRadius: "50%" }} />
      ) : (
        <div
          style={{
            width: 26, height: 26, borderRadius: "50%",
            background: active ? "var(--accent)" : "var(--surface-3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: active ? "var(--text-on-accent)" : "var(--text-1)",
          }}
        >
          {icon ?? primary.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.1 }}>
        <span style={{ fontWeight: 600 }}>{primary}</span>
        <span style={{ color: active ? "var(--accent)" : "var(--text-2)", fontSize: 11, opacity: active ? 0.85 : 1 }}>{secondary}</span>
      </div>
    </button>
  );
}

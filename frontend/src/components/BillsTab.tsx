import { useEffect, useState } from "react";
import { api, type Bill } from "../api";
import {
  Trash2, ChevronDown, ChevronUp, AlertCircle, Loader2, Lock, Globe,
  Square, CheckSquare,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

const UTILITY_ICONS: Record<string, string> = {
  electricity: "⚡", gas: "🔥", water: "💧",
  heating: "♨️", internet: "🌐", waste: "🗑️", other: "📄",
};

const TYPE_COLORS: Record<string, string> = {
  electricity: "#f59e0b", gas: "#f97316", water: "#3b82f6",
  heating: "#ef4444", internet: "#8b5cf6", waste: "#6b7280", other: "#9ca3af",
};

/**
 * Format a backend UTC ISO-8601 timestamp into the device's local
 * timezone. Returns both an absolute string (e.g. "Apr 30, 2026, 11:42
 * GMT+3") for tooltips / detail views, and a relative string (e.g. "3
 * hours ago") for inline display.
 *
 * Uses Intl.* so the formatting follows the user's locale, calendar,
 * and active timezone — no hardcoded "en-US" or "Europe/Tallinn".
 */
function fmtLocal(iso: string | null | undefined): { absolute: string; relative: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const absolute = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  }).format(d);

  const diffMs = d.getTime() - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  // Pick the largest unit whose threshold the elapsed delta clears so
  // a 90-minute-old bill reads "an hour ago" rather than "90 minutes ago".
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let secsPerUnit = 1;
  for (const [u, s] of units) {
    if (absSec >= s) {
      unit = u;
      secsPerUnit = s;
      break;
    }
  }
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const value = Math.round(diffMs / 1000 / secsPerUnit);
  return { absolute, relative: rtf.format(value, unit) };
}

interface BillsTabProps {
  /** Called whenever the bill list mutates. Lets the parent invalidate
   * cached data on other tabs (Analytics / Community). */
  onDataChange?: () => void;
}

export default function BillsTab({ onDataChange }: BillsTabProps = {}) {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [sortKey, setSortKey] = useState<"bill_date" | "amount_eur" | "utility_type">("bill_date");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    api.listBills().then(r => { setBills(r.data); setLoading(false); });
  }, []);

  /** Always pull from the server after a mutation so the UI reflects truth,
   * not the optimistic guess. */
  const refetch = async () => {
    try {
      const r = await api.listBills();
      setBills(r.data);
    } catch {
      // Network error — leave state alone; the user can reload manually.
    }
    onDataChange?.();
  };

  const deleteBill = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this bill?")) return;
    try {
      await api.deleteBill(id);
    } catch {
      alert("Couldn't delete this bill. The server didn't accept the request.");
      return;
    }
    setBills(bs => bs.filter(b => b.id !== id));
    setSelected(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onDataChange?.();
  };

  const togglePrivate = async (bill: Bill, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !bill.is_private;
    setBills(bs => bs.map(b => b.id === bill.id ? { ...b, is_private: next ? 1 : 0 } : b));
    try {
      await api.updateBill(bill.id, { is_private: next ? 1 : 0 });
      onDataChange?.();
    } catch {
      // Revert on failure so the UI stays accurate.
      setBills(bs => bs.map(b => b.id === bill.id ? { ...b, is_private: bill.is_private } : b));
    }
  };

  const toggleSelected = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const bulkDelete = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    if (!confirm(`Delete ${ids.length} bill${ids.length === 1 ? "" : "s"}? This can't be undone.`)) return;
    setBulkDeleting(true);
    const results = await Promise.allSettled(ids.map(id => api.deleteBill(id)));
    const failed = results.filter(r => r.status === "rejected").length;
    // Whatever happened, sync the UI to the actual server state — that
    // way the user can never see "deleted" rows that quietly came back.
    await refetch();
    setSelected(new Set());
    setBulkDeleting(false);
    if (failed > 0) {
      alert(`${failed} of ${ids.length} bill${ids.length === 1 ? "" : "s"} couldn't be deleted. The list has been refreshed from the server.`);
    }
  };

  const types = ["all", ...Array.from(new Set(bills.map(b => b.utility_type).filter(Boolean) as string[]))];
  const filtered = bills
    .filter(b => filter === "all" || b.utility_type === filter)
    .sort((a, b) => {
      if (sortKey === "amount_eur") return (b.amount_eur ?? 0) - (a.amount_eur ?? 0);
      if (sortKey === "utility_type") return (a.utility_type ?? "").localeCompare(b.utility_type ?? "");
      return (b.bill_date ?? b.upload_date).localeCompare(a.bill_date ?? a.upload_date);
    });

  const totalEur = filtered.reduce((s, b) => s + (b.amount_eur ?? 0), 0);
  const allFilteredSelected = filtered.length > 0 && filtered.every(b => selected.has(b.id));
  const toggleAllVisible = () => {
    if (allFilteredSelected) {
      setSelected(prev => {
        const next = new Set(prev);
        filtered.forEach(b => next.delete(b.id));
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        filtered.forEach(b => next.add(b.id));
        return next;
      });
    }
  };

  const isMobile = useIsMobile();
  const cardStyle = {
    background: "var(--surface-1)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
  } as const;
  const rowIconButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 0,
    width: 40,
    height: 40,
    borderRadius: 8,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  const inputStyle = {
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text-1)",
    padding: "7px 11px",
    fontSize: 13,
  } as const;

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 64, borderRadius: 12 }} />
        ))}
      </div>
    );
  }

  if (!bills.length) {
    return (
      <div
        className="fade-in"
        style={{
          textAlign: "center",
          padding: "80px 24px",
          color: "var(--text-3)",
          background: "var(--surface-1)",
          borderRadius: 14,
          border: "1px dashed var(--border)",
        }}
      >
        <AlertCircle size={36} style={{ marginBottom: 10, color: "var(--text-3)" }} />
        <p style={{ margin: 0, fontSize: 14 }}>No bills yet. Upload your first utility bill!</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ color: "var(--text-1)", margin: 0, fontSize: 22, letterSpacing: -0.2 }}>Bill History</h2>
          <p style={{ color: "var(--text-2)", margin: "4px 0 0", fontSize: 13 }}>
            {filtered.length} bill{filtered.length !== 1 ? "s" : ""} · Total: <strong style={{ color: "var(--success)" }}>€{totalEur.toFixed(2)}</strong>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={toggleAllVisible}
            disabled={filtered.length === 0}
            className="btn-press"
            style={{
              ...inputStyle,
              cursor: filtered.length === 0 ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: 6,
              opacity: filtered.length === 0 ? 0.5 : 1,
            }}
          >
            {allFilteredSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            {allFilteredSelected ? "Unselect" : "Select all"}
          </button>
          <select value={filter} onChange={e => setFilter(e.target.value)} style={inputStyle}>
            {types.map(t => <option key={t} value={t}>{t === "all" ? "All types" : `${UTILITY_ICONS[t] || ""} ${t}`}</option>)}
          </select>
          <select value={sortKey} onChange={e => setSortKey(e.target.value as typeof sortKey)} style={inputStyle}>
            <option value="bill_date">Sort: Date</option>
            <option value="amount_eur">Sort: Amount</option>
            <option value="utility_type">Sort: Type</option>
          </select>
        </div>
      </div>

      {selected.size > 0 && (
        <div
          className="slide-up"
          style={{
            position: "sticky", top: 64, zIndex: 5,
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            background: "var(--accent-soft)",
            border: "1px solid var(--accent)",
            borderRadius: 12, padding: "10px 14px", marginBottom: 12,
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            boxShadow: "var(--shadow-md)",
          }}
        >
          <span style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600 }}>
            {selected.size} selected
          </span>
          <button
            onClick={clearSelection}
            disabled={bulkDeleting}
            className="btn-press"
            style={{
              background: "transparent", border: "1px solid var(--border-strong)",
              borderRadius: 6, color: "var(--text-1)", padding: "5px 10px",
              fontSize: 12, cursor: bulkDeleting ? "not-allowed" : "pointer",
            }}
          >
            Clear
          </button>
          <button
            onClick={bulkDelete}
            disabled={bulkDeleting}
            className={bulkDeleting ? "" : "btn-press"}
            style={{
              marginLeft: "auto",
              display: "flex", alignItems: "center", gap: 6,
              background: bulkDeleting ? "var(--danger-strong)" : "var(--danger)",
              border: "none", borderRadius: 8, color: "var(--text-on-accent)",
              padding: "7px 14px", fontSize: 13, fontWeight: 600,
              cursor: bulkDeleting ? "not-allowed" : "pointer",
              boxShadow: bulkDeleting ? "none" : "var(--shadow-sm)",
            }}
          >
            {bulkDeleting
              ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              : <Trash2 size={14} />}
            {bulkDeleting ? "Deleting…" : `Delete ${selected.size}`}
          </button>
        </div>
      )}

      <div className="list-stagger" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((bill, idx) => {
          const isOpen = expanded === bill.id;
          const color = TYPE_COLORS[bill.utility_type ?? "other"] ?? "#9ca3af";
          const raw = bill.raw_json ? JSON.parse(bill.raw_json) : {};

          const isSelected = selected.has(bill.id);
          return (
            <div
              key={bill.id}
              className="lift"
              style={{
                ...cardStyle,
                overflow: "hidden",
                outline: isSelected ? "2px solid var(--accent)" : "none",
                outlineOffset: -1,
                ["--i" as string]: Math.min(idx, 12),
              } as React.CSSProperties}
            >
              <div
                onClick={() => setExpanded(isOpen ? null : bill.id)}
                style={{ padding: isMobile ? "12px 14px" : "16px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: isMobile ? 10 : 16 }}
              >
                <button
                  onClick={(e) => toggleSelected(bill.id, e)}
                  title={isSelected ? "Unselect" : "Select"}
                  style={{
                    background: "transparent", border: "none", padding: 4,
                    cursor: "pointer",
                    color: isSelected ? "var(--accent)" : "var(--text-3)",
                    flexShrink: 0, display: "flex", alignItems: "center",
                  }}
                >
                  {isSelected ? <CheckSquare size={18} /> : <Square size={18} />}
                </button>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: `${color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                  {UTILITY_ICONS[bill.utility_type ?? "other"] ?? "📄"}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: "var(--text-1)", fontSize: isMobile ? 14 : 15 }}>{bill.provider ?? "Unknown Provider"}</span>
                    {bill.utility_type && !isMobile && (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: `${color}22`, color, border: `1px solid ${color}44`, textTransform: "capitalize" }}>
                        {bill.utility_type}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6 }}>
                    <span>{bill.bill_date ?? bill.upload_date?.slice(0, 10)}</span>
                    {bill.period_start && bill.period_end && !isMobile && (
                      <span>· {bill.period_start} → {bill.period_end}</span>
                    )}
                    {(() => {
                      const t = fmtLocal(bill.upload_date);
                      if (!t) return null;
                      return (
                        <span
                          title={`Uploaded ${t.absolute}`}
                          style={{ color: "var(--text-3)", fontSize: 11, whiteSpace: "nowrap" }}
                        >
                          · uploaded {t.relative}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: isMobile ? 15 : 18, color: "var(--success)" }}>
                    {bill.amount_eur != null ? `€${bill.amount_eur.toFixed(2)}` : "—"}
                  </div>
                  {bill.consumption_kwh != null && !isMobile && <div style={{ fontSize: 12, color: "var(--text-2)" }}>{bill.consumption_kwh} kWh</div>}
                  {bill.consumption_m3 != null && !isMobile && <div style={{ fontSize: 12, color: "var(--text-2)" }}>{bill.consumption_m3} m³</div>}
                </div>
                <button
                  onClick={e => togglePrivate(bill, e)}
                  title={bill.is_private ? "Private — only you can see this bill. Click to make it public." : "Public — visible to all signed-in users. Click to make it private."}
                  style={{
                    ...rowIconButtonStyle,
                    color: bill.is_private ? "var(--warning)" : "var(--success)",
                  }}
                >
                  {bill.is_private ? <Lock size={15} /> : <Globe size={15} />}
                </button>
                <button
                  onClick={e => deleteBill(bill.id, e)}
                  style={{
                    ...rowIconButtonStyle,
                    color: "var(--text-3)",
                  }}
                >
                  <Trash2 size={15} />
                </button>
                {isOpen
                  ? <ChevronUp size={15} style={{ flexShrink: 0, color: "var(--text-3)" }} />
                  : <ChevronDown size={15} style={{ flexShrink: 0, color: "var(--text-3)" }} />}
              </div>

              {isOpen && (
                <div className="fade-in" style={{ borderTop: "1px solid var(--divider)", padding: "16px 20px" }}>
                  {raw.translated_summary && (
                    <div style={{ marginBottom: 16, padding: "12px 14px", background: "var(--accent-soft)", borderLeft: "3px solid var(--accent)", borderRadius: 6 }}>
                      <div style={{ fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontWeight: 600 }}>
                        🌍 English Summary
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text-1)", lineHeight: 1.5 }}>{raw.translated_summary}</div>
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px 24px" }}>
                    {[
                      ["Account #", bill.account_number],
                      ["Address", bill.address],
                      ["Filename", bill.filename],
                      ["Uploaded", fmtLocal(bill.upload_date)?.absolute],
                      ["Due Date", raw.due_date],
                      ["Period (EN)", raw.period_en ?? raw.period],
                      ["VAT", raw.vat_amount != null ? `€${raw.vat_amount}` : null],
                      ["Without VAT", raw.amount_without_vat != null ? `€${raw.amount_without_vat}` : null],
                      ["Meter Start", raw.meter_reading_start],
                      ["Meter End", raw.meter_reading_end],
                      ["Confidence", raw.confidence],
                    ].map(([label, val]) => val ? (
                      <div key={label as string}>
                        <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
                        <div style={{ fontSize: 13, color: "var(--text-1)", marginTop: 2, wordBreak: "break-all" }}>{val as string}</div>
                      </div>
                    ) : null)}
                  </div>

                  {Array.isArray(raw.line_items) && raw.line_items.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8, fontWeight: 600 }}>
                        Line Items (Estonian → English)
                      </div>
                      <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 360 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--border)" }}>
                            <th style={{ padding: "6px 0", textAlign: "left", color: "var(--text-3)", fontSize: 11, fontWeight: 600 }}>ESTONIAN</th>
                            <th style={{ padding: "6px 0", textAlign: "left", color: "var(--text-3)", fontSize: 11, fontWeight: 600 }}>ENGLISH</th>
                            <th style={{ padding: "6px 0", textAlign: "right", color: "var(--text-3)", fontSize: 11, fontWeight: 600 }}>AMOUNT</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(raw.line_items as Array<Record<string, unknown>>).map((li, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid var(--divider)" }}>
                              <td style={{ padding: "6px 8px 6px 0", color: "var(--text-2)" }}>{String(li.description_et ?? "—")}</td>
                              <td style={{ padding: "6px 0", color: "var(--text-1)" }}>{String(li.description_en ?? "—")}</td>
                              <td style={{ padding: "6px 0", textAlign: "right", color: "var(--success)", fontVariantNumeric: "tabular-nums" }}>
                                {li.amount_eur != null ? `€${(li.amount_eur as number).toFixed(2)}` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </div>
                  )}

                  {raw.glossary && typeof raw.glossary === "object" && Object.keys(raw.glossary).length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8, fontWeight: 600 }}>
                        📖 Glossary
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6 }}>
                        {Object.entries(raw.glossary as Record<string, string>).map(([et, en]) => (
                          <div key={et} style={{ background: "var(--surface-2)", padding: "6px 10px", borderRadius: 6, fontSize: 12 }}>
                            <span style={{ color: "var(--text-2)" }}>{et}</span>
                            <span style={{ color: "var(--text-3)", margin: "0 6px" }}>→</span>
                            <span style={{ color: "var(--text-1)" }}>{en}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {bill.notes && (
                    <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--surface-2)", borderRadius: 6, fontSize: 13, color: "var(--text-2)" }}>
                      {bill.notes}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

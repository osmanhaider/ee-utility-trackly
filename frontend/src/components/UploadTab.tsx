import { useState, useCallback, useEffect, useRef } from "react";
import axios from "axios";
import { api, type ByokKey } from "../api";
import {
  Upload, CheckCircle, AlertCircle, Loader2, RefreshCw, FileText, X,
  ChevronDown, ChevronUp,
} from "lucide-react";

const UTILITY_ICONS: Record<string, string> = {
  electricity: "⚡",
  gas: "🔥",
  water: "💧",
  heating: "♨️",
  internet: "🌐",
  waste: "🗑️",
  other: "📄",
};

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — must match backend MAX_UPLOAD_BYTES
const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

interface UploadTabProps {
  onSuccess: () => void;
  /** Bubbled to App so the nav can show a pulse dot when uploads are
   *  running and the user has navigated away. */
  onRunningChange?: (running: boolean) => void;
  /** True when the Upload tab is the currently visible tab. We refresh
   *  the saved BYOK key list whenever this transitions to true so a key
   *  added in Settings shows up without remounting. */
  isActive?: boolean;
}

type ItemStatus = "pending" | "uploading" | "success" | "replaced" | "error" | "low_quality" | "too_large";

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  errorMsg?: string;
  parsed?: Record<string, unknown>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadTab({ onSuccess, onRunningChange, isActive }: UploadTabProps) {
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);

  // Mirror running state to the parent so it can render a navigation hint.
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // The Upload tab is now BYOK-only. The backend's auto-fallback chain
  // (round-robin LRU across the user's saved keys, skipping any that
  // were just rate-limited) decides which key to use, so the UI no
  // longer offers a per-upload key picker. We still load the key list
  // so we can warn the user when ALL of their keys are exhausted, and
  // surface healthy/exhausted counts as ambient context.
  const [byokKeys, setByokKeys] = useState<ByokKey[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** Refresh saved BYOK keys. Called on mount and whenever the Upload
   *  tab becomes active so adding/removing keys in Settings is
   *  reflected without remounting the always-mounted UploadTab. */
  const reloadByokKeys = useCallback(() => {
    api.listMyByokKeys()
      .then(res => setByokKeys(res.data ?? []))
      .catch(() => {
        // BYOK might be disabled on the server — keep the option hidden.
      });
  }, []);

  useEffect(() => {
    reloadByokKeys();
  }, [reloadByokKeys]);

  // Refetch when the Upload tab becomes active, so keys added in Settings
  // appear immediately on the user's next visit (UploadTab stays mounted
  // across tab switches to preserve in-flight queues).
  useEffect(() => {
    if (isActive) reloadByokKeys();
  }, [isActive, reloadByokKeys]);

  const healthyKeys = byokKeys.filter(k => !k.is_exhausted);
  const exhaustedKeys = byokKeys.filter(k => k.is_exhausted);
  const allKeysExhausted = byokKeys.length > 0 && healthyKeys.length === 0;

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue(q => q.map(it => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const processQueue = useCallback(async (items: QueueItem[]) => {
    setRunning(true);

    let successCount = 0;
    let problemCount = 0;
    let needsKeyRefresh = false;
    for (const item of items) {
      if (item.status !== "pending") continue;
      updateItem(item.id, { status: "uploading" });
      try {
        // Always BYOK with no explicit key id — the backend rotates
        // through the user's saved keys (LRU among healthy ones,
        // skipping any that just got rate-limited). The user manages
        // the key set in Settings; per-upload key picking is gone.
        const res = await api.uploadBill(item.file, "byok");
        const parsed = res.data.parsed;
        const lowQuality = Boolean(parsed?._low_quality);
        if (lowQuality) {
          problemCount += 1;
          updateItem(item.id, { status: "low_quality", parsed });
        } else {
          successCount += 1;
          updateItem(item.id, { status: res.data.replaced ? "replaced" : "success", parsed });
        }
      } catch (e: unknown) {
        problemCount += 1;
        // FastAPI returns 422 for extraction failures with `detail.message`.
        // Surface that exact message so the user knows whether it was a
        // rate-limit, a bad model response, or something else.
        let msg = e instanceof Error ? e.message : "Upload failed";
        if (axios.isAxiosError(e) && e.response?.data) {
          const data = e.response.data as { detail?: unknown };
          if (typeof data.detail === "string") {
            msg = data.detail;
          } else if (data.detail && typeof data.detail === "object") {
            const d = data.detail as { message?: string; all_keys_exhausted?: boolean };
            if (typeof d.message === "string") msg = d.message;
            if (d.all_keys_exhausted) needsKeyRefresh = true;
          }
        }
        updateItem(item.id, { status: "error", errorMsg: msg });
      }
    }
    setRunning(false);
    // Refresh the keys list so the badge state reflects whatever the
    // backend just marked exhausted.
    if (needsKeyRefresh || problemCount > 0) reloadByokKeys();
    // Auto-navigate only if everything went smoothly (no errors, no low quality).
    if (successCount > 0 && problemCount === 0) {
      setTimeout(onSuccess, 2000);
    }
  }, [updateItem, onSuccess, reloadByokKeys]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const items: QueueItem[] = files.map(file => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (file.size > MAX_FILE_BYTES) {
        return {
          id,
          file,
          status: "too_large",
          errorMsg: `File too large (${formatBytes(file.size)}). Maximum size is ${MAX_FILE_MB} MB per file.`,
        };
      }
      return { id, file, status: "pending" };
    });
    setQueue(items);
    const toUpload = items.filter(it => it.status === "pending");
    if (toUpload.length > 0) {
      // Defer to next tick so React commits the queue first — otherwise the
      // first file's "uploading" status overwrites the initial render.
      setTimeout(() => processQueue(toUpload), 0);
    }
  }, [processQueue]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (running) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) addFiles(files);
  }, [addFiles, running]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) addFiles(files);
    e.target.value = "";
  };

  const removeItem = (id: string) => {
    if (running) return;
    setQueue(q => q.filter(it => it.id !== id));
  };

  const clearAll = () => {
    if (running) return;
    setQueue([]);
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-1)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    padding: 24,
  };

  const allDone = queue.length > 0 && queue.every(it => it.status !== "pending" && it.status !== "uploading");
  const singleSuccess = queue.length === 1 && (queue[0].status === "success" || queue[0].status === "replaced" || queue[0].status === "low_quality");
  const detailItem = singleSuccess ? queue[0] : null;
  const parsed = detailItem?.parsed;

  const successCount = queue.filter(it => it.status === "success" || it.status === "replaced").length;
  const problemCount = queue.filter(it => it.status === "error" || it.status === "low_quality" || it.status === "too_large").length;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <h2 style={{ color: "var(--text-1)", marginBottom: 8, fontSize: 22, letterSpacing: -0.2 }}>Upload Invoice / Bill</h2>
      <p style={{ color: "var(--text-2)", marginBottom: 16, fontSize: 14 }}>
        Drop one or more files (up to {MAX_FILE_MB} MB each) to extract data.
      </p>

      {/* Auto-routing status: replaces the old parser-mode picker.
          Bills always go through the user's saved BYOK keys; the
          backend chooses which one round-robin and falls over to the
          next when one's rate-limited. */}
      <div style={{ ...cardStyle, marginBottom: 16, padding: 14 }}>
        {allKeysExhausted ? (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <AlertCircle size={18} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ color: "var(--danger)", fontWeight: 600, marginBottom: 2 }}>
                All saved API keys are currently rate-limited
              </div>
              <div style={{ color: "var(--text-2)" }}>
                Wait a few minutes and try again, or add another provider in{" "}
                <strong style={{ color: "var(--text-1)" }}>Settings</strong>.
                Adding more keys lets the auto-fallback chain stay healthy.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Upload size={16} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 3 }} />
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ color: "var(--text-1)", fontWeight: 600, marginBottom: 2 }}>
                Auto-routing across {byokKeys.length} saved key{byokKeys.length === 1 ? "" : "s"}
                {exhaustedKeys.length > 0 && (
                  <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                    {" "}· {healthyKeys.length} healthy, {exhaustedKeys.length} rate-limited
                  </span>
                )}
              </div>
              <div style={{ color: "var(--text-3)", fontSize: 12 }}>
                Manage keys in <strong style={{ color: "var(--text-1)" }}>Settings</strong>.
                Each upload picks the least-recently-used healthy key, so adding more keys
                spreads load and gives the chain somewhere to fall over.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Drop zone — hidden once the queue has items so the queue takes over the visual focus. */}
      {queue.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          style={{
            ...cardStyle,
            border: `2px dashed ${dragging ? "var(--accent)" : "var(--border-strong)"}`,
            background: dragging ? "var(--accent-soft)" : "var(--surface-1)",
            textAlign: "center",
            padding: "48px 24px",
            cursor: "pointer",
            transition: "background 180ms ease, border-color 180ms ease, transform 180ms ease",
            transform: dragging ? "scale(1.01)" : "scale(1)",
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            multiple
            style={{ display: "none" }}
            onChange={onFileChange}
          />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 64, height: 64,
                background: "var(--accent-soft)",
                borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--accent)",
                boxShadow: dragging ? "var(--shadow-accent)" : "none",
                transition: "box-shadow 180ms ease",
              }}
            >
              <Upload size={28} />
            </div>
            <div>
              <p style={{ color: "var(--text-1)", margin: 0, fontWeight: 600 }}>Drop your bills here</p>
              <p style={{ color: "var(--text-2)", margin: "4px 0 0", fontSize: 13 }}>
                or click to browse — multiple files allowed, up to {MAX_FILE_MB} MB each
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Upload queue */}
      {queue.length > 0 && (
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ color: "var(--text-1)", fontSize: 14, fontWeight: 600 }}>
              {running ? `Processing ${queue.length} file${queue.length === 1 ? "" : "s"}…` : `${queue.length} file${queue.length === 1 ? "" : "s"}`}
              {!running && allDone && (
                <span style={{ color: "var(--text-3)", fontWeight: 400, marginLeft: 8 }}>
                  · {successCount} succeeded{problemCount > 0 ? `, ${problemCount} with issues` : ""}
                </span>
              )}
            </div>
            {allDone && !running && (
              <button
                onClick={clearAll}
                className="btn-press"
                style={{
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text-2)",
                  padding: "5px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Upload more
              </button>
            )}
          </div>
          <div className="list-stagger" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {queue.map((item, i) => (
              <QueueRow
                key={item.id}
                item={item}
                index={i}
                onRemove={removeItem}
                disabled={running}
                expanded={expandedRow === item.id}
                onToggle={(id) => setExpandedRow(prev => (prev === id ? null : id))}
              />
            ))}
          </div>
          {allDone && successCount > 0 && (
            <div className="fade-in" style={{ marginTop: 12, fontSize: 12, color: "var(--text-2)" }}>
              {problemCount === 0
                ? "Redirecting to bills list…"
                : <>Some files had issues — you can fix them and try again, or <button onClick={onSuccess} style={{ background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" }}>view bills</button>.</>}
            </div>
          )}
        </div>
      )}

      {/* Detail panel — only when exactly one file was processed. */}
      {detailItem && parsed && Boolean(parsed._low_quality) && (
        <div className="slide-up" style={{
          ...cardStyle,
          marginTop: 24,
          borderLeft: "3px solid var(--warning)",
          background: "var(--warning-soft)",
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}>
          <AlertCircle size={20} style={{ flexShrink: 0, marginTop: 1, color: "var(--warning)" }} />
          <div>
            <div style={{ color: "var(--warning)", fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
              Couldn't extract data from this invoice
            </div>
            {typeof parsed.error === "string" ? (
              <div style={{ color: "var(--text-1)", fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                <code style={{ background: "var(--surface-2)", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>
                  {parsed.error}
                </code>
              </div>
            ) : null}
            <div style={{ color: "var(--text-1)", fontSize: 13, lineHeight: 1.5 }}>
              {typeof parsed.error === "string" && /rate limit|exhausted|out of credits/i.test(parsed.error) ? (
                <>
                  All saved keys are temporarily rate-limited. Wait a few minutes
                  and re-upload, or add another provider key in{" "}
                  <strong style={{ color: "var(--accent)" }}>Settings</strong>{" "}
                  so the auto-fallback chain has somewhere to go.
                </>
              ) : (
                <>
                  Try uploading a clearer scan. If the issue is on the provider's
                  end, check{" "}
                  <strong style={{ color: "var(--accent)" }}>Settings</strong>{" "}
                  for a per-key error badge — you may need to top up credits or
                  rotate the key.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {detailItem && parsed && parsed._routed_via ? (
        <div className="fade-in" style={{
          ...cardStyle,
          marginTop: 16,
          borderLeft: "3px solid var(--accent)",
          padding: "10px 14px",
          fontSize: 12,
        }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>
            Routed via <code>{String(parsed._routed_via)}</code>
          </div>
          <div style={{ color: "var(--text-3)" }}>
            Model used: <code>{String(parsed._model_used ?? "auto")}</code>
          </div>
        </div>
      ) : null}

      {detailItem && parsed && (
        <>
          <div className="slide-up" style={{ ...cardStyle, marginTop: 24 }}>
            <h3 style={{ color: "var(--text-1)", margin: "0 0 16px", fontSize: 16 }}>
              {UTILITY_ICONS[parsed.utility_type as string] || "📄"} Extracted Details
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 24px" }}>
              {[
                ["Provider", parsed.provider],
                ["Type", parsed.utility_type],
                ["Amount", parsed.amount_eur != null ? `€${(parsed.amount_eur as number).toFixed(2)}` : null],
                ["Bill Date", parsed.bill_date],
                ["Period", parsed.period_en ?? (parsed.period_start && parsed.period_end ? `${parsed.period_start} → ${parsed.period_end}` : parsed.period)],
                ["Consumption", parsed.consumption_kwh != null ? `${parsed.consumption_kwh} kWh` : parsed.consumption_m3 != null ? `${parsed.consumption_m3} m³` : null],
                ["Account", parsed.account_number],
                ["Confidence", parsed.confidence],
              ].map(([label, value]) =>
                value ? (
                  <div key={String(label)}>
                    <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{String(label)}</div>
                    <div style={{ fontSize: 14, color: "var(--text-1)", marginTop: 2 }}>{String(value)}</div>
                  </div>
                ) : null
              )}
            </div>
          </div>

          {parsed.translated_summary ? (
            <div style={{ ...cardStyle, marginTop: 16, borderLeft: "3px solid var(--accent)" }}>
              <div style={{ fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontWeight: 600 }}>
                🌍 English Summary
              </div>
              <div style={{ fontSize: 14, color: "var(--text-1)", lineHeight: 1.5 }}>
                {String(parsed.translated_summary)}
              </div>
            </div>
          ) : null}

          {Array.isArray(parsed.line_items) && parsed.line_items.length > 0 ? (
            <div style={{ ...cardStyle, marginTop: 16 }}>
              <h3 style={{ color: "var(--text-1)", margin: "0 0 12px", fontSize: 14 }}>Line Items</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "8px 0", textAlign: "left", color: "var(--text-3)", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Description</th>
                    <th style={{ padding: "8px 0", textAlign: "left", color: "var(--text-3)", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>English</th>
                    <th style={{ padding: "8px 0", textAlign: "right", color: "var(--text-3)", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(parsed.line_items as Array<Record<string, unknown>>).map((li, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--divider)" }}>
                      <td style={{ padding: "8px 8px 8px 0", color: "var(--text-2)" }}>{String(li.description_et ?? "—")}</td>
                      <td style={{ padding: "8px 0", color: "var(--text-1)" }}>{String(li.description_en ?? "—")}</td>
                      <td style={{ padding: "8px 0", textAlign: "right", color: "var(--success)", fontVariantNumeric: "tabular-nums" }}>
                        {li.amount_eur != null ? `€${(li.amount_eur as number).toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {parsed.glossary && typeof parsed.glossary === "object" && Object.keys(parsed.glossary as object).length > 0 ? (
            <div style={{ ...cardStyle, marginTop: 16 }}>
              <h3 style={{ color: "var(--text-1)", margin: "0 0 12px", fontSize: 14 }}>📖 Glossary</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                {Object.entries(parsed.glossary as Record<string, string>).map(([et, en]) => (
                  <div key={et} style={{ background: "var(--surface-2)", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>
                    <span style={{ color: "var(--text-2)" }}>{et}</span>
                    <span style={{ color: "var(--text-3)", margin: "0 6px" }}>→</span>
                    <span style={{ color: "var(--text-1)" }}>{en}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      <div style={{ ...cardStyle, marginTop: 24 }}>
        <h3 style={{ color: "var(--text-1)", margin: "0 0 4px", fontSize: 14 }}>Supported Invoice Types</h3>
        <p style={{ color: "var(--text-3)", fontSize: 12, margin: "0 0 12px" }}>
          Local text extraction (OCR + native PDF) runs first; the result is then
          structured by your saved AI provider. Any invoice format works — the
          parser is provider-driven, not template-driven.
        </p>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontWeight: 600 }}>
            Utility bills (highest extraction accuracy)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {["Electricity", "Gas", "Water", "Heating", "Internet / Telecom", "Waste Collection", "Housing Association"].map(p => (
              <span key={p} style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)", borderRadius: 6, padding: "4px 10px", fontSize: 12, color: "var(--accent)" }}>
                {p}
              </span>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
            Any invoice (AI-routed)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {["Rent", "Subscriptions", "Services", "Repairs", "Insurance", "Any format or language"].map(p => (
              <span key={p} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px", fontSize: 12, color: "var(--text-1)" }}>
                {p}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface QueueRowProps {
  item: QueueItem;
  index: number;
  onRemove: (id: string) => void;
  disabled: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function QueueRow({ item, index, onRemove, disabled, expanded, onToggle }: QueueRowProps) {
  const { status, file, errorMsg, parsed } = item;
  const StatusIcon = (() => {
    switch (status) {
      case "uploading": return <Loader2 size={16} style={{ color: "var(--accent)", animation: "spin 1s linear infinite" }} />;
      case "success": return <CheckCircle size={16} style={{ color: "var(--success)" }} />;
      case "replaced": return <RefreshCw size={16} style={{ color: "var(--warning)" }} />;
      case "low_quality": return <AlertCircle size={16} style={{ color: "var(--warning)" }} />;
      case "error":
      case "too_large": return <AlertCircle size={16} style={{ color: "var(--danger)" }} />;
      default: return <FileText size={16} style={{ color: "var(--text-3)" }} />;
    }
  })();
  const statusLabel = (() => {
    switch (status) {
      case "pending": return "Queued";
      case "uploading": return "Uploading…";
      case "success": return "Uploaded";
      case "replaced": return "Replaced existing bill";
      case "low_quality": return "Saved — extraction failed";
      case "error": return errorMsg || "Upload failed";
      case "too_large": return errorMsg || `File too large — max ${MAX_FILE_MB} MB`;
    }
  })();
  const statusColor = (() => {
    switch (status) {
      case "success": return "var(--success)";
      case "replaced":
      case "low_quality": return "var(--warning)";
      case "error":
      case "too_large": return "var(--danger)";
      case "uploading": return "var(--accent)";
      default: return "var(--text-2)";
    }
  })();
  const canRemove = !disabled && status !== "uploading";
  const isExpandable =
    status === "error" || status === "low_quality" || status === "too_large";
  const errorText = (() => {
    if (status === "low_quality") {
      const e = parsed?.error;
      return typeof e === "string" ? e : "The parser couldn't extract enough fields from this invoice.";
    }
    if (status === "too_large") return errorMsg || `File too large — max ${MAX_FILE_MB} MB`;
    return errorMsg || "Upload failed";
  })();
  const isRateLimit = /rate limit|exhausted|429/i.test(errorText);
  const hint = (() => {
    if (status === "too_large") {
      return `Trim or compress the PDF below ${MAX_FILE_MB} MB and re-drop it. Most invoices fit easily — usually a scan resolution issue.`;
    }
    if (isRateLimit) {
      return "All saved API keys are temporarily rate-limited. Wait a few minutes and re-upload, or add another provider in Settings so the auto-fallback chain has somewhere to go.";
    }
    if (status === "low_quality") {
      return "The model returned a response but with too few useful fields. Try a clearer scan, or pick a stronger model on one of your saved keys (Settings → Edit → Default model).";
    }
    return "Try uploading the file again. If this keeps happening, check the browser console for the underlying network error.";
  })();
  return (
    <div
      style={{
        background: "var(--surface-2)",
        borderRadius: 8,
        border: status === "error" || status === "too_large" ? "1px solid var(--danger)" : "1px solid transparent",
        ["--i" as string]: Math.min(index, 12),
        overflow: "hidden",
      } as React.CSSProperties}
    >
      <div
        onClick={isExpandable ? () => onToggle(item.id) : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px",
          cursor: isExpandable ? "pointer" : "default",
        }}
      >
        <div style={{ flexShrink: 0 }}>{StatusIcon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--text-1)", fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name}
          </div>
          <div style={{ color: statusColor, fontSize: 11, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {formatBytes(file.size)} · {statusLabel}
          </div>
        </div>
        {isExpandable && (
          expanded
            ? <ChevronUp size={14} style={{ color: "var(--text-3)", flexShrink: 0 }} />
            : <ChevronDown size={14} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        )}
        {canRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
            title="Remove"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-3)",
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {isExpandable && expanded && (
        <div
          className="fade-in"
          style={{
            borderTop: "1px solid var(--divider)",
            padding: "10px 12px",
            background: "var(--surface-1)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            Error
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--text-1)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 200,
              overflow: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
            }}
          >
            {errorText}
          </pre>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "var(--text-1)" }}>Suggestion:</strong> {hint}
          </div>
        </div>
      )}
    </div>
  );
}

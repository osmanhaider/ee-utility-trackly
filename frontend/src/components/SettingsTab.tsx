import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import axios from "axios";
import {
  Key, Plus, Trash2, AlertCircle, Loader2, Eye, EyeOff,
  CheckCircle, ExternalLink, Star, Pencil, Wifi, X,
} from "lucide-react";
import { api, type ByokKey, type ByokProvider } from "../api";

const cardStyle: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 20,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-1)",
  padding: "8px 11px",
  fontSize: 13,
};

interface ProbeState {
  status: "idle" | "probing" | "ok" | "fail";
  message?: string;
  /** Snapshot of the inputs the probe ran against. Used to derive
   *  staleness without a setState-in-effect: when the current inputs
   *  diverge from this fingerprint, the badge is considered stale and
   *  hidden. */
  fingerprint?: string;
}

function probeFingerprint(provider: string, key: string, baseUrl: string): string {
  // Order matters but the contents are joined with a control character
  // that can't appear in a URL/key, so collisions are impossible.
  return `${provider}\x00${key}\x00${baseUrl}`;
}

export default function SettingsTab() {
  const [providers, setProviders] = useState<ByokProvider[]>([]);
  const [configured, setConfigured] = useState(true);
  const [keys, setKeys] = useState<ByokKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Add-key form state
  const [providerId, setProviderId] = useState<string>("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });

  // Per-row test/default UI state
  const [rowProbe, setRowProbe] = useState<Record<string, ProbeState>>({});
  const [defaulting, setDefaulting] = useState<string | null>(null);

  // Edit modal state
  const [editing, setEditing] = useState<ByokKey | null>(null);

  const provider = useMemo(
    () => providers.find(p => p.id === providerId) ?? null,
    [providers, providerId],
  );

  useEffect(() => {
    let cancelled = false;
    api.listByokProviders()
      .then(async (provRes) => {
        if (cancelled) return;
        const list = provRes.data.providers ?? [];
        setProviders(list);
        setConfigured(provRes.data.configured);
        if (list.length > 0) {
          setProviderId(list[0].id);
          setModel(list[0].default_model);
          setBaseUrl(list[0].base_url);
        }
        if (!provRes.data.configured) {
          setKeys([]);
          return;
        }
        const keysRes = await api.listMyByokKeys();
        if (!cancelled) setKeys(keysRes.data ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        if (axios.isAxiosError(e) && e.response?.status === 503) {
          setConfigured(false);
          setKeys([]);
        } else {
          setErr("Couldn't load BYOK settings.");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const onProviderChange = (id: string) => {
    setProviderId(id);
    const p = providers.find(prov => prov.id === id);
    if (p) {
      setModel(p.default_model);
      setBaseUrl(p.base_url);
    }
  };

  // Hide a previous probe badge whenever the inputs diverge from what
  // we tested — derived synchronously, no setState-in-effect needed.
  const currentFingerprint = probeFingerprint(providerId, secret.trim(), baseUrl.trim());
  const visibleProbe: ProbeState = (
    probe.status === "probing"
    || (probe.fingerprint != null && probe.fingerprint === currentFingerprint)
  )
    ? probe
    : { status: "idle" };

  const onProbe = async () => {
    if (!provider) return;
    const fp = currentFingerprint;
    setProbe({ status: "probing", fingerprint: fp });
    try {
      const res = await api.probeByokKey({
        provider: provider.id,
        key: secret.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
      });
      setProbe({
        status: res.data.ok ? "ok" : "fail",
        message: res.data.message,
        fingerprint: fp,
      });
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? ((e.response?.data as { detail?: string } | undefined)?.detail ?? e.message)
        : "Network error.";
      setProbe({ status: "fail", message: msg, fingerprint: fp });
    }
  };

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    setSaving(true);
    setFormErr(null);
    try {
      const res = await api.addByokKey({
        provider: provider.id,
        label: label.trim(),
        key: secret.trim(),
        default_model: model.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        is_default: isDefault,
      });
      // If the new row is default, demote local defaults for the same
      // provider so the UI reflects what the server just wrote.
      setKeys(ks => {
        const others = isDefault
          ? ks.map(k => k.provider === res.data.provider ? { ...k, is_default: false } : k)
          : ks;
        return [res.data, ...others];
      });
      setLabel("");
      setSecret("");
      setShowSecret(false);
      setIsDefault(false);
      setModel(provider.default_model);
      setBaseUrl(provider.base_url);
      setProbe({ status: "idle" });
      setJustAdded(res.data.id);
      setTimeout(() => setJustAdded(null), 2200);
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.data) {
        const detail = (e.response.data as { detail?: string }).detail;
        setFormErr(typeof detail === "string" ? detail : "Couldn't save the key.");
      } else {
        setFormErr("Network error. Try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (key: ByokKey) => {
    if (!confirm(`Delete key “${key.label}”? You can re-add it any time.`)) return;
    const prev = keys;
    setKeys(ks => ks.filter(k => k.id !== key.id));
    try {
      await api.deleteByokKey(key.id);
    } catch {
      alert("Couldn't delete the key.");
      setKeys(prev);
    }
  };

  const onMakeDefault = async (key: ByokKey) => {
    if (key.is_default) return;
    setDefaulting(key.id);
    const prev = keys;
    // Optimistic: clear other defaults for this provider, set this one.
    setKeys(ks => ks.map(k => {
      if (k.provider !== key.provider) return k;
      return { ...k, is_default: k.id === key.id };
    }));
    try {
      await api.setDefaultByokKey(key.id);
    } catch {
      setKeys(prev);
      alert("Couldn't set this key as the default.");
    } finally {
      setDefaulting(null);
    }
  };

  const onTestSaved = async (key: ByokKey) => {
    setRowProbe(p => ({ ...p, [key.id]: { status: "probing" } }));
    try {
      // Use the per-key endpoint — it decrypts server-side and probes
      // with the real key. The generic /probe endpoint takes a
      // plaintext key from the body, which we deliberately don't have
      // on the frontend, so reusing it would always 401 against any
      // provider that gates /v1/models behind auth.
      const res = await api.probeSavedByokKey(key.id);
      setRowProbe(p => ({
        ...p,
        [key.id]: {
          status: res.data.ok ? "ok" : "fail",
          message: res.data.message,
        },
      }));
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? ((e.response?.data as { detail?: string } | undefined)?.detail ?? e.message)
        : "Network error.";
      setRowProbe(p => ({ ...p, [key.id]: { status: "fail", message: msg } }));
    }
    // Auto-clear the row badge after 4s so it doesn't linger.
    setTimeout(() => {
      setRowProbe(p => {
        const next = { ...p };
        delete next[key.id];
        return next;
      });
    }, 4000);
  };

  const providerName = (id: string) =>
    providers.find(p => p.id === id)?.name ?? id;

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 64, borderRadius: 12 }} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ color: "var(--text-1)", margin: 0, fontSize: 22, letterSpacing: -0.2 }}>
          Settings
        </h2>
        <p style={{ color: "var(--text-2)", margin: "4px 0 0", fontSize: 13, lineHeight: 1.55 }}>
          Optional: bring your own API keys for OpenAI-compatible providers. When configured,
          you can pick "Use my API key" on the Upload tab and bills are extracted directly
          via your account — no FreeLLMAPI router involved. Self-hosted endpoints (Ollama,
          custom gateways) are also supported via the Custom provider.
        </p>
      </div>

      {!configured && (
        <div
          className="fade-in"
          style={{
            ...cardStyle,
            marginBottom: 16,
            borderLeft: "3px solid var(--warning)",
            background: "var(--warning-soft)",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <AlertCircle size={18} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ color: "var(--warning)", fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
              BYOK is disabled on this server
            </div>
            <div style={{ color: "var(--text-1)", fontSize: 12, lineHeight: 1.5 }}>
              The deployment is missing <code>BYOK_ENCRYPTION_KEY</code>. Ask the operator to set
              it before adding API keys here.
            </div>
          </div>
        </div>
      )}

      {err && (
        <div style={{ ...cardStyle, marginBottom: 16, borderLeft: "3px solid var(--danger)", color: "var(--danger)", fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* Existing keys */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "20px 0 12px" }}>
        <h3 style={{ color: "var(--text-1)", margin: 0, fontSize: 14 }}>
          Your API keys
        </h3>
        <span style={{ color: "var(--text-3)", fontSize: 12 }}>
          {keys.length} saved
        </span>
      </div>

      {keys.length === 0 ? (
        <div
          style={{
            ...cardStyle,
            textAlign: "center",
            padding: 40,
            color: "var(--text-3)",
            border: "1px dashed var(--border)",
          }}
        >
          <Key size={28} style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 13 }}>You haven't added any keys yet. Add one below.</div>
        </div>
      ) : (
        <div className="list-stagger" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {keys.map((k, i) => {
            const rp = rowProbe[k.id];
            return (
              <div
                key={k.id}
                className="lift"
                style={{
                  ...cardStyle,
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  ["--i" as string]: i,
                  outline: justAdded === k.id ? "2px solid var(--accent)" : undefined,
                  outlineOffset: -1,
                } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => onMakeDefault(k)}
                  title={k.is_default ? "Default for this provider" : "Set as default for this provider"}
                  className="btn-press"
                  disabled={defaulting === k.id}
                  style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: k.is_default ? "var(--accent-soft)" : "var(--surface-2)",
                    color: k.is_default ? "var(--accent)" : "var(--text-3)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                    border: k.is_default ? "1px solid var(--accent)" : "1px solid var(--border)",
                    cursor: defaulting === k.id ? "wait" : "pointer",
                  }}
                >
                  {defaulting === k.id
                    ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                    : <Star size={14} fill={k.is_default ? "currentColor" : "none"} />}
                </button>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: "var(--text-1)", fontSize: 13 }}>
                      {k.label}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        color: "var(--text-2)",
                      }}
                    >
                      {providerName(k.provider)}
                    </span>
                    {k.is_default && (
                      <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>
                        <Star size={11} fill="currentColor" /> default
                      </span>
                    )}
                    {justAdded === k.id && (
                      <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--success)", fontSize: 11 }}>
                        <CheckCircle size={12} /> Added
                      </span>
                    )}
                    {rp && (
                      <span style={{
                        display: "flex", alignItems: "center", gap: 4,
                        color: rp.status === "ok" ? "var(--success)"
                          : rp.status === "fail" ? "var(--danger)"
                            : "var(--text-2)",
                        fontSize: 11, fontWeight: 600,
                      }}>
                        {rp.status === "probing"
                          ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                          : rp.status === "ok"
                            ? <CheckCircle size={11} />
                            : <AlertCircle size={11} />}
                        {rp.status === "probing" ? "Testing…" : rp.message}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, fontFamily: "ui-monospace, SFMono-Regular, monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {k.masked_key}
                    {k.default_model ? <span style={{ color: "var(--text-3)" }}> · {k.default_model}</span> : null}
                    {k.base_url_override ? <span style={{ color: "var(--text-3)" }}> · {k.base_url_override}</span> : null}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => onTestSaved(k)}
                    title="Test connection"
                    className="btn-press"
                    disabled={rp?.status === "probing"}
                    style={iconBtnStyle}
                  >
                    <Wifi size={13} />
                  </button>
                  <button
                    onClick={() => setEditing(k)}
                    title="Edit"
                    className="btn-press"
                    style={iconBtnStyle}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => onDelete(k)}
                    title="Delete key"
                    className="btn-press"
                    style={iconBtnStyle}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add new */}
      <h3 style={{ color: "var(--text-1)", margin: "32px 0 12px", fontSize: 14 }}>
        Add a new key
      </h3>
      <form onSubmit={onAdd} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>Provider</span>
            <select
              value={providerId}
              onChange={(e) => onProviderChange(e.target.value)}
              disabled={saving || providers.length === 0}
              style={inputStyle}
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>Label</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Personal / Work / Side project"
              disabled={saving}
              style={inputStyle}
            />
          </label>
        </div>

        {provider?.requires_base_url && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              Base URL <span style={{ color: "var(--text-3)" }}>(required for {provider.name})</span>
            </span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={provider.id === "ollama" ? "https://your-host:11434/v1" : "https://endpoint/v1"}
              disabled={saving}
              style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            />
          </label>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>API key {provider?.allows_empty_key && <span style={{ color: "var(--text-3)" }}>(optional)</span>}</span>
            {provider?.key_url && (
              <a
                href={provider.key_url}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                Get a key <ExternalLink size={11} />
              </a>
            )}
          </span>
          <div style={{ position: "relative" }}>
            <input
              type={showSecret ? "text" : "password"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={provider?.key_hint ?? "your API key"}
              disabled={saving}
              autoComplete="off"
              style={{ ...inputStyle, paddingRight: 38, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            />
            <button
              type="button"
              onClick={() => setShowSecret(s => !s)}
              tabIndex={-1}
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: "var(--text-3)",
                cursor: "pointer",
                padding: 4,
                display: "flex",
              }}
              title={showSecret ? "Hide" : "Show"}
            >
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>
            Default model {provider && provider.default_model ? <span style={{ color: "var(--text-3)" }}>(prefilled from {provider.name})</span> : null}
          </span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider?.id === "custom" ? "model id, e.g. anthropic/claude-sonnet-4-6" : ""}
            disabled={saving}
            style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-2)" }}>
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            disabled={saving}
            style={{ cursor: "pointer" }}
          />
          <span>Make this the default key for {provider?.name ?? "this provider"}</span>
        </label>

        {formErr && (
          <div style={{ color: "var(--danger)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <AlertCircle size={13} /> {formErr}
          </div>
        )}

        {visibleProbe.status !== "idle" && (
          <div style={{
            color: visibleProbe.status === "ok" ? "var(--success)"
              : visibleProbe.status === "fail" ? "var(--danger)"
                : "var(--text-2)",
            fontSize: 12,
            display: "flex", alignItems: "center", gap: 6,
            background: visibleProbe.status === "ok"
              ? "var(--accent-soft)"
              : visibleProbe.status === "fail"
                ? "var(--danger-soft)"
                : "transparent",
            padding: visibleProbe.status === "probing" ? 0 : "8px 10px",
            borderRadius: 8,
          }}>
            {visibleProbe.status === "probing"
              ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Testing connection…</>
              : visibleProbe.status === "ok"
                ? <><CheckCircle size={13} /> {visibleProbe.message}</>
                : <><AlertCircle size={13} /> {visibleProbe.message}</>}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onProbe}
            disabled={
              saving
              || !configured
              || !provider
              || (!provider.allows_empty_key && !secret.trim())
              || (provider.requires_base_url && !baseUrl.trim())
              ||               visibleProbe.status === "probing"
            }
            className="btn-press"
            style={secondaryBtnStyle}
          >
            {visibleProbe.status === "probing"
              ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              : <Wifi size={14} />}
            Test connection
          </button>
          <button
            type="submit"
            disabled={
              saving
              || !configured
              || !label.trim()
              || !provider
              || (!provider.allows_empty_key && !secret.trim())
              || (provider.requires_base_url && !baseUrl.trim())
            }
            className="btn-press"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              cursor: saving ? "not-allowed" : "pointer",
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              fontWeight: 600,
              fontSize: 13,
              opacity: saving ? 0.7 : 1,
              boxShadow: "var(--shadow-sm)",
            }}
          >
            {saving
              ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              : <Plus size={14} />}
            {saving ? "Saving…" : "Save key"}
          </button>
        </div>
      </form>

      <p style={{ color: "var(--text-3)", fontSize: 11, marginTop: 16, lineHeight: 1.55 }}>
        Keys are encrypted with AES-256-GCM before they hit the database.
        Plaintext never leaves the backend, and listings only return masked values.
        In production they persist in Supabase/Postgres alongside your bills.
      </p>

      {editing && (
        <EditKeyModal
          k={editing}
          provider={providers.find(p => p.id === editing.provider) ?? null}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setKeys(ks => ks.map(k => k.id === updated.id ? { ...k, ...updated } : k));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-3)",
  padding: "6px 8px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-1)",
  fontSize: 13,
  cursor: "pointer",
};

interface EditModalProps {
  k: ByokKey;
  provider: ByokProvider | null;
  onClose: () => void;
  onSaved: (patch: Partial<ByokKey> & { id: string }) => void;
}

// Portalled to <body> to escape any ancestor containers and keep the
// fixed-position scrim covering the whole viewport on mobile.
function EditKeyModal({ k, provider, onClose, onSaved }: EditModalProps) {
  const [label, setLabel] = useState(k.label);
  const [model, setModel] = useState(k.default_model ?? "");
  const [baseUrl, setBaseUrl] = useState(k.base_url_override ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });

  // Esc closes; click-outside on scrim closes too (handled below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onTest = async () => {
    if (!provider) return;
    // Probe the *saved* key — server-side decrypt so we don't need the
    // plaintext on the frontend. Tests against whatever base URL is
    // currently saved, not the one the user may be typing into the
    // modal. If they're changing the URL, they should Save first.
    setProbe({ status: "probing" });
    try {
      const res = await api.probeSavedByokKey(k.id);
      setProbe({
        status: res.data.ok ? "ok" : "fail",
        message: res.data.message,
      });
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? ((e.response?.data as { detail?: string } | undefined)?.detail ?? e.message)
        : "Network error.";
      setProbe({ status: "fail", message: msg });
    }
  };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    const trimmedLabel = label.trim();
    const trimmedModel = model.trim();
    const trimmedUrl = baseUrl.trim();
    const patch: { label?: string; default_model?: string | null; base_url?: string | null } = {};
    if (trimmedLabel !== k.label) patch.label = trimmedLabel;
    if (trimmedModel !== (k.default_model ?? "")) patch.default_model = trimmedModel || null;
    if (trimmedUrl !== (k.base_url_override ?? "")) patch.base_url = trimmedUrl || null;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    try {
      await api.updateByokKey(k.id, patch);
      onSaved({
        id: k.id,
        label: trimmedLabel,
        default_model: trimmedModel || null,
        base_url_override: trimmedUrl || null,
      });
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? ((e.response?.data as { detail?: string } | undefined)?.detail ?? "Couldn't save changes.")
        : "Network error.";
      setErr(msg);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${k.label}`}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={onSave}
        style={{
          width: "100%", maxWidth: 480,
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 20,
          display: "flex", flexDirection: "column", gap: 12,
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, color: "var(--text-1)", fontSize: 16 }}>
            Edit “{k.label}”
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: "transparent", border: "none", color: "var(--text-3)", cursor: "pointer", padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>

        <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          The encrypted key value isn't editable here — to rotate it, delete and re-add.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>Label</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={saving}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>Default model</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={saving}
            style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          />
        </label>

        {(provider?.requires_base_url || !!k.base_url_override) && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              Base URL {provider?.requires_base_url && <span style={{ color: "var(--text-3)" }}>(required)</span>}
            </span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://endpoint/v1"
              disabled={saving}
              style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            />
          </label>
        )}

        {err && (
          <div style={{ color: "var(--danger)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <AlertCircle size={13} /> {err}
          </div>
        )}

        {probe.status !== "idle" && probe.status !== "probing" && (
          <div style={{
            color: probe.status === "ok" ? "var(--success)" : "var(--danger)",
            fontSize: 12, display: "flex", alignItems: "center", gap: 6,
            background: probe.status === "ok" ? "var(--accent-soft)" : "var(--danger-soft)",
            padding: "8px 10px", borderRadius: 8,
          }}>
            {probe.status === "ok" ? <CheckCircle size={13} /> : <AlertCircle size={13} />}
            {probe.message}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onTest}
            disabled={saving || probe.status === "probing"}
            className="btn-press"
            style={secondaryBtnStyle}
            title="Tests the saved key against its currently-saved base URL. Save your changes first to probe a new URL."
          >
            {probe.status === "probing"
              ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              : <Wifi size={14} />}
            Test
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="btn-press"
              style={secondaryBtnStyle}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !label.trim()
                || (provider?.requires_base_url && !baseUrl.trim())}
              className="btn-press"
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "8px 14px", borderRadius: 8, border: "none",
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                fontWeight: 600, fontSize: 13,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving
                ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                : <CheckCircle size={14} />}
              Save changes
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}

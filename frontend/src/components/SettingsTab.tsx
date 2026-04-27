import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Key, Plus, Trash2, AlertCircle, Loader2, Eye, EyeOff,
  CheckCircle, ExternalLink,
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
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

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
    if (p) setModel(p.default_model);
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
      });
      setKeys(ks => [res.data, ...ks]);
      setLabel("");
      setSecret("");
      setShowSecret(false);
      setModel(provider.default_model);
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
          via your account — no FreeLLMAPI router involved.
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
          {keys.map((k, i) => (
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
              <div
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: "var(--accent-soft)", color: "var(--accent)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Key size={16} />
              </div>
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
                  {justAdded === k.id && (
                    <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--success)", fontSize: 11 }}>
                      <CheckCircle size={12} /> Added
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
                  {k.masked_key}
                  {k.default_model ? <span style={{ color: "var(--text-3)" }}> · {k.default_model}</span> : null}
                </div>
              </div>
              <button
                onClick={() => onDelete(k)}
                title="Delete key"
                className="btn-press"
                style={{
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
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
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

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>API key</span>
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
            Default model {provider ? <span style={{ color: "var(--text-3)" }}>(prefilled from {provider.name})</span> : null}
          </span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={saving}
            style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          />
        </label>

        {formErr && (
          <div style={{ color: "var(--danger)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <AlertCircle size={13} /> {formErr}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            disabled={saving || !configured || !label.trim() || !secret.trim() || !provider}
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
    </div>
  );
}

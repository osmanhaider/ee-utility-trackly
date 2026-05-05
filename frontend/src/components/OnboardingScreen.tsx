import { useEffect, useMemo, useState } from "react";
import { Key, ExternalLink, Loader2, AlertCircle, Eye, EyeOff, Sparkles, Wifi } from "lucide-react";
import axios from "axios";
import { api, type ByokProvider } from "../api";

interface Props {
  onKeyAdded: () => void;
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 24,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-1)",
  padding: "10px 12px",
  fontSize: 14,
};

const buttonPrimary: React.CSSProperties = {
  background: "var(--accent)",
  color: "white",
  border: "none",
  borderRadius: 8,
  padding: "10px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

// Curated set of recommended free providers for new users. Every entry
// here exists in `byok.PROVIDERS` on the backend; the onboarding page
// is intentionally narrower than the full Settings list — too many
// choices on the very first screen would be paralysing.
const RECOMMENDED_PROVIDER_IDS = ["groq", "google", "cerebras", "openrouter"];

/**
 * Full-screen onboarding gate shown once a freshly-signed-in user has
 * zero saved BYOK keys. Adding even one key dismisses the gate and
 * unlocks the rest of the app.
 *
 * The app needs at least one provider key to parse uploaded bills,
 * since we don't ship a managed parsing backend. We funnel new users
 * here rather than letting them land on a non-functional Upload tab,
 * which used to confuse people into thinking the app was broken.
 */
export default function OnboardingScreen({ onKeyAdded }: Props) {
  const [providers, setProviders] = useState<ByokProvider[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  // Onboarding intentionally doesn't ask for a label — the user can
  // edit it later in Settings. We auto-fill it with the provider name
  // on submit so the saved key still has a sensible display string.
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [providersErr, setProvidersErr] = useState<string | null>(null);

  // Pull the provider catalogue from the backend on mount. The
  // catalogue is anonymous-public so this works even before the user
  // has any keys saved.
  useEffect(() => {
    let cancelled = false;
    api.listByokProviders()
      .then((res) => {
        if (cancelled) return;
        const all = res.data.providers ?? [];
        if (all.length === 0) {
          setProvidersErr(
            "BYOK isn't configured on this deployment. Ask the operator to set BYOK_ENCRYPTION_KEY.",
          );
          return;
        }
        setProviders(all);
        // Default to Groq if available — generous free tier, fastest.
        const recommended = all.find((p) => p.id === "groq") ?? all[0];
        setProviderId(recommended.id);
        setModel(recommended.default_model);
        setBaseUrl(recommended.base_url);
      })
      .catch((e) => {
        if (cancelled) return;
        if (axios.isAxiosError(e) && e.response?.status === 503) {
          setProvidersErr(
            "BYOK isn't configured on this deployment. Ask the operator to set BYOK_ENCRYPTION_KEY.",
          );
        } else {
          setProvidersErr("Couldn't load the provider list.");
        }
      })
      .finally(() => { if (!cancelled) setLoadingProviders(false); });
    return () => { cancelled = true; };
  }, []);

  const provider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? null,
    [providers, providerId],
  );

  // Show the "recommended for new users" subset first, then the rest.
  // Keeps the onboarding picker uncluttered while still letting power
  // users pick anything (e.g. their existing OpenAI account).
  const orderedProviders = useMemo(() => {
    if (providers.length === 0) return [];
    const recommended = RECOMMENDED_PROVIDER_IDS
      .map((id) => providers.find((p) => p.id === id))
      .filter((p): p is ByokProvider => Boolean(p));
    const rest = providers.filter((p) => !RECOMMENDED_PROVIDER_IDS.includes(p.id));
    return [...recommended, ...rest];
  }, [providers]);

  const onProviderChange = (id: string) => {
    setProviderId(id);
    const p = providers.find((prov) => prov.id === id);
    if (p) {
      setModel(p.default_model);
      setBaseUrl(p.base_url);
    }
    setProbeMsg(null);
  };

  const onProbe = async () => {
    if (!provider) return;
    setProbing(true);
    setProbeMsg(null);
    try {
      const res = await api.probeByokKey({
        provider: provider.id,
        key: secret.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
      });
      setProbeMsg({ ok: res.data.ok, text: res.data.message });
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? ((e.response?.data as { detail?: string } | undefined)?.detail ?? e.message)
        : "Network error.";
      setProbeMsg({ ok: false, text: msg });
    } finally {
      setProbing(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    setSaving(true);
    setErr(null);
    try {
      // Auto-fill label with provider name — onboarding deliberately
      // doesn't ask for one. The user can rename later in Settings.
      const effectiveLabel = `${provider.name} (default)`;
      await api.addByokKey({
        provider: provider.id,
        label: effectiveLabel,
        key: secret.trim(),
        default_model: model.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        is_default: true,  // first key is automatically the default
      });
      onKeyAdded();
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.data) {
        const detail = (e.response.data as { detail?: string }).detail;
        setErr(typeof detail === "string" ? detail : "Couldn't save the key.");
      } else {
        setErr("Network error. Try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadingProviders) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
        <Loader2 size={28} style={{ color: "var(--accent)", animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  if (providersErr) {
    return (
      <div style={{ ...cardStyle, maxWidth: 600, margin: "60px auto", borderColor: "var(--danger)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertCircle size={24} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
          <div>
            <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>BYOK not configured</h2>
            <p style={{ margin: 0, color: "var(--text-2)" }}>{providersErr}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "32px auto", padding: "0 16px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 56, height: 56, borderRadius: 14, background: "var(--accent-soft)",
          marginBottom: 12,
        }}>
          <Key size={28} style={{ color: "var(--accent)" }} />
        </div>
        <h1 style={{ margin: "0 0 8px", fontSize: 24 }}>One last step — add an AI key</h1>
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 15, lineHeight: 1.5 }}>
          Bills are parsed with whichever AI provider you choose. Pick a free one
          below and paste your API key — it's encrypted at rest before being saved.
        </p>
      </div>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, color: "var(--text-2)", fontSize: 13 }}>
          <Sparkles size={16} style={{ color: "var(--accent)" }} />
          <span>Recommended free providers</span>
        </div>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Provider
            </label>
            <select
              value={providerId}
              onChange={(e) => onProviderChange(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              {orderedProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {RECOMMENDED_PROVIDER_IDS.includes(p.id) ? " — free tier" : ""}
                </option>
              ))}
            </select>
            {provider?.key_url && (
              <a
                href={provider.key_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  marginTop: 6, fontSize: 12, color: "var(--accent)", textDecoration: "none",
                }}
              >
                Get a {provider.name} key <ExternalLink size={12} />
              </a>
            )}
          </div>

          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              API key {provider?.allows_empty_key && <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(optional for this provider)</span>}
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={provider?.key_hint ?? "sk-..."}
                style={{ ...inputStyle, paddingRight: 40, fontFamily: "monospace" }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer", color: "var(--text-3)",
                  padding: 4,
                }}
                aria-label={showSecret ? "Hide key" : "Show key"}
              >
                {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {provider?.requires_base_url && (
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                Base URL
              </label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-host/v1"
                style={inputStyle}
              />
            </div>
          )}

          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Default model
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider?.default_model ?? "model-name"}
              style={{ ...inputStyle, fontFamily: "monospace" }}
            />
          </div>

          {probeMsg && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: probeMsg.ok ? "var(--success-soft)" : "var(--danger-soft)",
                color: probeMsg.ok ? "var(--success)" : "var(--danger)",
                fontSize: 13,
                lineHeight: 1.4,
              }}
            >
              {probeMsg.text}
            </div>
          )}

          {err && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--danger-soft)",
                color: "var(--danger)",
                fontSize: 13,
                lineHeight: 1.4,
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{err}</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onProbe}
              disabled={probing || (!secret.trim() && !provider?.allows_empty_key)}
              style={{
                background: "transparent",
                color: "var(--text-1)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: probing ? "not-allowed" : "pointer",
                opacity: probing ? 0.6 : 1,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {probing
                ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Testing…</>
                : <><Wifi size={14} /> Test connection</>}
            </button>
            <button
              type="submit"
              disabled={saving || (!secret.trim() && !provider?.allows_empty_key)}
              style={{
                ...buttonPrimary,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {saving
                ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Saving…</>
                : "Save and continue"}
            </button>
          </div>
        </form>
      </div>

      <p style={{ textAlign: "center", color: "var(--text-3)", fontSize: 12, margin: 0 }}>
        You can add more keys, change them, or remove them any time from the Settings tab.
        Adding multiple keys enables automatic fall-over when one provider is rate limited.
      </p>
    </div>
  );
}

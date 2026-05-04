import axios from "axios";
import { clearToken, getToken } from "./auth";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// Attach the bearer token to every outgoing request (when present) and
// log the user out automatically on 401 so a stale token can't pin the
// UI to a broken state.
axios.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers["Authorization"] = `Bearer ${token}`;
  }
  return config;
});

// Sign-in endpoints — a 401 from these means "couldn't sign you in",
// not "your existing session expired". Treating those as session expiry
// would clear a legitimate token and bounce the user back to the login
// screen on every wrong-password attempt or revoked-Google-token retry.
const _AUTH_ENTRY_PATHS = [
  "/api/auth/google",
  "/api/auth/google-redirect",
  "/api/auth/status",
];

axios.interceptors.response.use(
  (r) => r,
  (err) => {
    const url = String(err?.config?.url ?? "");
    const isAuthEntry = _AUTH_ENTRY_PATHS.some(p => url.includes(p));
    if (err?.response?.status === 401 && !isAuthEntry) {
      clearToken();
      window.dispatchEvent(new Event("auth:logout"));
    }
    return Promise.reject(err);
  },
);

export interface Bill {
  id: string;
  filename: string;
  upload_date: string;
  bill_date: string | null;
  provider: string | null;
  utility_type: string | null;
  amount_eur: number | null;
  consumption_kwh: number | null;
  consumption_m3: number | null;
  period_start: string | null;
  period_end: string | null;
  account_number: string | null;
  address: string | null;
  raw_json: string | null;
  notes: string | null;
  is_private?: number | null;
  user_id?: string | null;
  owner_name?: string | null;
  owner_picture?: string | null;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

export interface CommunityUser {
  id: string;
  email: string | null;
  name: string | null;
  picture_url: string | null;
  bill_count: number;
}

export interface ByokProvider {
  id: string;
  name: string;
  default_model: string;
  key_hint: string;
  key_url: string;
  /** Provider's preset endpoint, or "" for self-hosted providers
   *  where the user supplies the URL. */
  base_url: string;
  /** True when the user must supply a base URL with their key
   *  (custom / self-hosted, e.g. Ollama). */
  requires_base_url: boolean;
  /** True when the provider's /v1/models endpoint can be probed
   *  without an API key (e.g. local Ollama with no auth). */
  allows_empty_key: boolean;
}

export interface ByokKey {
  id: string;
  label: string;
  provider: string;
  masked_key: string;
  default_model: string | null;
  /** User-supplied base URL override; null means "use provider preset". */
  base_url_override: string | null;
  /** True when this key is the per-provider default for the user. */
  is_default: boolean;
  created_at: string;
}

export interface ByokProbeResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface AnalyticsSummary {
  totals: BillTotals;
  by_type: TypeStat[];
  by_month: MonthTypeStat[];
  by_year: YearStat[];
  annual_total: AnnualTotal[];
  seasonal: SeasonalStat[];
  by_provider: ProviderStat[];
  monthly_total: MonthlyTotal[];
  line_item_trends: LineItemTrend[];
}

export interface BillTotals {
  bill_count: number;
  total_eur: number;
  avg_eur: number;
  min_eur: number;
  max_eur: number;
}

export interface LineItemTrend {
  month: string;
  description_en: string;
  description_et: string;
  amount_eur: number;
  quantity: number | null;
  unit: string;
  unit_price: number | null;
}

export interface TypeStat {
  utility_type: string;
  bill_count: number;
  total_eur: number;
  avg_eur: number;
  min_eur: number;
  max_eur: number;
  total_kwh: number | null;
  total_m3: number | null;
}

export interface MonthTypeStat {
  month: string;
  utility_type: string;
  total_eur: number;
  bill_count: number;
}

export interface YearStat {
  year: string;
  utility_type: string;
  total_eur: number;
  /** Average amount per bill-category row (one row per bill split into
   *  this category). Not a per-calendar-month average. */
  avg_per_bill_eur: number;
  bill_count: number;
}

export interface AnnualTotal {
  year: string;
  bill_count: number;
  total_eur: number;
  avg_bill_eur: number;
}

export interface SeasonalStat {
  month_num: string;
  avg_eur: number;
  /** Optional — set by newer backends so the radar can compute weighted
   *  averages. Older payloads (deploy lag) won't include these. */
  total_eur?: number;
  bill_count?: number;
  utility_type: string;
}

export interface ProviderStat {
  provider: string;
  bill_count: number;
  total_eur: number;
  avg_eur: number;
}

export interface MonthlyTotal {
  month: string;
  total_eur: number;
  /** Calendar-aware trailing 3-month average. Falls back to fewer points
   *  on sparse data; equals total_eur when only this month has data. */
  rolling_avg_3m: number;
  /** Calendar-aware MoM/YoY against the full monthly total. Null when
   *  the immediately preceding calendar month (or year) has no data. */
  mom_delta_eur: number | null;
  mom_delta_pct: number | null;
  yoy_delta_eur: number | null;
  yoy_delta_pct: number | null;
}

export const api = {
  uploadBill: (file: File, parser?: string, model?: string, byokKeyId?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (parser) fd.append("parser", parser);
    if (model) fd.append("model", model);
    if (byokKeyId) fd.append("byok_key_id", byokKeyId);
    return axios.post<{ id: string; parsed: Record<string, unknown>; replaced: boolean }>(`${BASE}/api/bills/upload`, fd);
  },
  listBills: () => axios.get<Bill[]>(`${BASE}/api/bills`),
  deleteBill: (id: string) => axios.delete(`${BASE}/api/bills/${id}`),
  updateBill: (id: string, data: Partial<Bill>) => axios.put(`${BASE}/api/bills/${id}`, data),
  // _t cache-buster guarantees URL uniqueness per call so any layer of
  // browser HTTP caching (notably iOS Safari standalone-PWA shell) can't
  // silently return the previous payload after a delete/edit. The
  // backend also sends Cache-Control: no-store on all /api/* responses,
  // but this is defence in depth.
  getAnalytics: () => axios.get<AnalyticsSummary>(`${BASE}/api/analytics/summary`, {
    params: { _t: Date.now() },
  }),
  getFreeLlmModels: () =>
    axios.get<{ models: { id: string; label: string }[]; cached?: boolean; error?: string }>(
      `${BASE}/api/freellmapi-models`
    ),
  getAuthStatus: () =>
    axios.get<{ auth_required: boolean; google_configured: boolean }>(`${BASE}/api/auth/status`),
  loginWithGoogle: (idToken: string) =>
    axios.post<{ token: string; user: User }>(`${BASE}/api/auth/google`, { id_token: idToken }),
  getMe: () => axios.get<User>(`${BASE}/api/auth/me`),
  listCommunityUsers: () => axios.get<CommunityUser[]>(`${BASE}/api/community/users`),
  listCommunityBills: (targetUserId?: string) =>
    axios.get<Bill[]>(`${BASE}/api/community/bills`, {
      params: targetUserId ? { target_user_id: targetUserId } : undefined,
    }),
  getCommunityAnalytics: (targetUserId?: string) =>
    axios.get<AnalyticsSummary>(`${BASE}/api/community/analytics`, {
      params: { _t: Date.now(), ...(targetUserId ? { target_user_id: targetUserId } : {}) },
    }),
  listByokProviders: () =>
    axios.get<{ configured: boolean; providers: ByokProvider[] }>(`${BASE}/api/byok-providers`),
  listMyByokKeys: () => axios.get<ByokKey[]>(`${BASE}/api/byok-keys`),
  addByokKey: (input: {
    label: string;
    provider: string;
    key: string;
    default_model?: string;
    base_url?: string;
    is_default?: boolean;
  }) => axios.post<ByokKey>(`${BASE}/api/byok-keys`, input),
  updateByokKey: (
    id: string,
    input: { label?: string; default_model?: string | null; base_url?: string | null },
  ) => axios.patch<{ status: string }>(`${BASE}/api/byok-keys/${id}`, input),
  setDefaultByokKey: (id: string) =>
    axios.post<{ status: string }>(`${BASE}/api/byok-keys/${id}/default`),
  probeByokKey: (input: { provider: string; key?: string; base_url?: string }) =>
    axios.post<ByokProbeResult>(`${BASE}/api/byok-keys/probe`, input),
  probeSavedByokKey: (id: string) =>
    axios.post<ByokProbeResult>(`${BASE}/api/byok-keys/${id}/probe`),
  deleteByokKey: (id: string) => axios.delete(`${BASE}/api/byok-keys/${id}`),
};

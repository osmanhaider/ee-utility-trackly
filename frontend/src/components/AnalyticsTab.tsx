import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useTheme } from "../theme";
import { api, type AnalyticsSummary } from "../api";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, Loader2, AlertCircle, Download } from "lucide-react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

// McKinsey-inspired palette: one primary blue, a complementary teal/emerald,
// warm accents for amber/orange, and red/green reserved for directional signals.
const COLORS: Record<string, string> = {
  electricity: "var(--warning)",   // amber
  gas: "#f97316",           // orange
  water: "#0ea5e9",         // sky
  heating: "#dc2626",       // red
  internet: "#8b5cf6",      // violet
  telecom: "#8b5cf6",
  waste: "#64748b",         // slate
  management: "#0d9488",    // teal
  other: "#94a3b8",         // slate-400
};

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PALETTE = [
  "#2563eb", "#0d9488", "var(--warning)", "#dc2626", "#8b5cf6",
  "#0ea5e9", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
];

const TYPE_LABELS: Record<string, string> = {
  electricity: "Electricity",
  gas: "Gas",
  water: "Water",
  heating: "Heating",
  internet: "Internet",
  telecom: "Telecom",
  waste: "Waste",
  management: "Management",
  other: "Other",
};

function labelFor(t: string) {
  return TYPE_LABELS[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

function colorFor(t: string, i = 0) {
  return COLORS[t] ?? PALETTE[i % PALETTE.length];
}

// ── Pie-slice text contrast ──────────────────────────────────────────────
// Resolves a slice fill (hex or `var(--token)`) and returns a text color
// (#0f172a or #ffffff) that maintains WCAG-friendly contrast on top of it.
// Used by the share-of-spend pie so amber/light slices don't render
// white-on-white in light mode.
const TEXT_DARK = "#0f172a";
const TEXT_LIGHT = "#ffffff";

function resolveCssVar(value: string): string {
  if (typeof window === "undefined") return value;
  const m = value.match(/var\((--[^,)\s]+)/);
  if (!m) return value;
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return v || value;
}

function contrastTextOn(bg: string): string {
  const resolved = resolveCssVar(bg);
  const hex = resolved.replace("#", "");
  if (hex.length !== 6) return TEXT_LIGHT;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return TEXT_LIGHT;
  // YIQ luma — values >= 140 are bright enough that dark text reads better.
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? TEXT_DARK : TEXT_LIGHT;
}


const legendStyle = {
  fontSize: 11,
  paddingTop: 8,
  color: "var(--text-2)",
} as const;

function legendFormatter(value: string) {
  return <span style={{ color: "var(--text-2)" }}>{labelFor(value)}</span>;
}

// "2025-01" → "Jan '25"
function fmtMonthShort(m: unknown): string {
  const s = String(m ?? "");
  const match = s.match(/^(\d{4})-(\d{2})$/);
  if (!match) return s;
  const mo = parseInt(match[2], 10);
  return `${MONTH_NAMES[mo]} '${match[1].slice(2)}`;
}

interface TooltipPayloadItem {
  value: number;
  name: string;
  color: string;
  dataKey: string;
}

// McKinsey-style tooltip: shows only non-zero values, ranks by magnitude,
// caps the list at `maxItems`, and sums the tail.
function RichTooltip({
  active, payload, label, maxItems = 8, showTotal = true, unit = "€",
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  maxItems?: number;
  showTotal?: boolean;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const items = payload
    .filter(p => typeof p.value === "number" && Math.abs(p.value) > 0.005)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const shown = items.slice(0, maxItems);
  const hidden = items.slice(maxItems);
  const total = items.reduce((s, p) => s + p.value, 0);
  const hiddenTotal = hidden.reduce((s, p) => s + p.value, 0);
  const labelText = label && /^\d{4}-\d{2}$/.test(label) ? fmtMonthShort(label) : label;

  const fmt = (v: number) =>
    unit === "€" ? `€${v.toFixed(2)}` :
    unit === "%" ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` :
    `${v.toFixed(4)}`;

  return (
    <div style={{
      background: "var(--surface-1)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      padding: "10px 14px", fontSize: 12,
      minWidth: 180,
      boxShadow: "var(--shadow-lg)",
    }}>
      {labelText && <div style={{ color: "var(--text-1)", fontWeight: 600, marginBottom: 8, fontSize: 12 }}>{labelText}</div>}
      {shown.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, justifyContent: "space-between" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
            <span style={{ color: "var(--text-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>{p.name}</span>
          </span>
          <span style={{ color: "var(--text-1)", fontVariantNumeric: "tabular-nums", fontWeight: 500, marginLeft: 12 }}>{fmt(p.value)}</span>
        </div>
      ))}
      {hidden.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-3)", marginTop: 4, fontSize: 11 }}>
          <span>+{hidden.length} more</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(hiddenTotal)}</span>
        </div>
      )}
      {showTotal && items.length > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 6, color: "var(--text-1)", fontWeight: 600 }}>
          <span>Total</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(total)}</span>
        </div>
      )}
    </div>
  );
}


function PctBadge({ v, label }: { v: number | null; label: string }) {
  if (v == null) return <span style={{ color: "var(--text-3)", fontSize: 12 }}>—</span>;
  const pos = v > 0;
  const flat = Math.abs(v) < 0.5;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      color: flat ? "var(--text-2)" : pos ? "var(--danger)" : "var(--success)",
      fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums",
    }}>
      {flat ? <Minus size={12} /> : pos ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {pos ? "+" : ""}{v.toFixed(1)}%
      <span style={{ color: "var(--text-3)", fontWeight: 400, fontSize: 11 }}>{label}</span>
    </span>
  );
}

function StatCard({ label, value, sub, trend }: { label: string; value: string; sub?: React.ReactNode; trend?: "up" | "down" | "flat" }) {
  return (
    <div
      className="lift"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "18px 20px",
        minHeight: 126,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-1)", lineHeight: 1.05 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
          {trend === "up" && <TrendingUp size={12} color="var(--danger)" />}
          {trend === "down" && <TrendingDown size={12} color="var(--success)" />}
          {trend === "flat" && <Minus size={12} color="var(--text-2)" />}
          {sub}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 style={{ color: "var(--text-1)", fontSize: 16, fontWeight: 600, margin: "32px 0 16px" }}>{children}</h3>;
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div
      className="lift"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 24,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ marginBottom: 20, minHeight: subtitle ? 48 : 24 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>{subtitle}</div>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

interface AnalyticsTabProps {
  /** Optional override so the Community tab can reuse the same charts. */
  source?: () => Promise<{ data: AnalyticsSummary }>;
  /** Optional re-fetch trigger; bumping this value re-runs `source`. */
  reloadKey?: number;
}

export default function AnalyticsTab({ source, reloadKey }: AnalyticsTabProps = {}) {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  // Subscribing to the resolved theme forces a re-render on light/dark
  // switches so colour-dependent computations like pie-slice contrast
  // pick up the new CSS-variable values.
  useTheme();
  const dashboardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Toggling the loader when source/reloadKey changes is the whole point
    // of this effect — the lint rule's general advice doesn't apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const fetcher = source ?? (() => api.getAnalytics());
    fetcher()
      .then((r) => {
        if (cancelled) return;
        setData(r.data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, reloadKey]);

  async function exportToPDF() {
    if (!dashboardRef.current) return;
    setExporting(true);
    setExportError(null);
    try {
      // Resolve the current theme background so the PDF matches the on-screen
      // surface (dark slate or cream) instead of a hard-coded color.
      const themeBg =
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() ||
        "#0c111c";
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();   // 210mm
      const pageHeight = pdf.internal.pageSize.getHeight(); // 297mm
      const margin = 10;
      const usableWidth = pageWidth - 2 * margin;
      const usableHeight = pageHeight - 2 * margin;
      const gap = 3;                                        // mm between chunks

      // Render each top-level child to its own canvas so we can paginate at
      // chunk boundaries instead of slicing through chart bodies.
      const children = Array.from(dashboardRef.current.children) as HTMLElement[];
      let currentY = margin;
      let isFirstChunk = true;

      for (const child of children) {
        const canvas = await html2canvas(child, {
          backgroundColor: themeBg,
          scale: 2,
          useCORS: true,
          logging: false,
        });
        const imgW = usableWidth;
        const imgH = (canvas.height * imgW) / canvas.width;

        // Chunk fits on a single page — place whole, starting a new page if needed.
        if (imgH <= usableHeight) {
          if (!isFirstChunk && currentY + imgH > pageHeight - margin) {
            pdf.addPage();
            currentY = margin;
          }
          pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, currentY, imgW, imgH);
          currentY += imgH + gap;
          isFirstChunk = false;
          continue;
        }

        // Chunk is taller than a page — slice it across pages by copying
        // horizontal bands of the source canvas into a scratch canvas.
        const pxPerMm = canvas.width / usableWidth;
        let remainingMm = imgH;
        let srcY = 0;
        if (!isFirstChunk) {
          pdf.addPage();
          currentY = margin;
        }
        while (remainingMm > 0) {
          const roomMm = pageHeight - margin - currentY;
          const sliceMm = Math.min(remainingMm, roomMm);
          const sliceHpx = Math.floor(sliceMm * pxPerMm);
          const slice = document.createElement("canvas");
          slice.width = canvas.width;
          slice.height = sliceHpx;
          const ctx = slice.getContext("2d");
          if (ctx) {
            ctx.fillStyle = themeBg;
            ctx.fillRect(0, 0, slice.width, slice.height);
            ctx.drawImage(canvas, 0, srcY, canvas.width, sliceHpx, 0, 0, canvas.width, sliceHpx);
          }
          pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, currentY, imgW, sliceMm);
          srcY += sliceHpx;
          remainingMm -= sliceMm;
          if (remainingMm > 0) {
            pdf.addPage();
            currentY = margin;
          } else {
            currentY += sliceMm + gap;
          }
        }
        isFirstChunk = false;
      }

      const stamp = new Date().toISOString().slice(0, 10);
      pdf.save(`utility-bills-dashboard-${stamp}.pdf`);
    } catch (err) {
      console.error("Export failed:", err);
      setExportError(err instanceof Error ? err.message : "Unknown error — see console for details.");
    } finally {
      setExporting(false);
    }
  }

  // Full-page spinner only on the *initial* load when we have nothing
  // to show. Background refetches (after a delete / privacy toggle /
  // upload) keep the existing dashboard visible and surface a small
  // "Refreshing…" badge below — far less jarring than blanking the
  // whole page on every mutation.
  if (loading && !data) return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 200, gap: 12, color: "var(--text-2)" }}>
      <Loader2 size={24} style={{ animation: "spin 1s linear infinite" }} /> Loading analytics…
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!data || data.monthly_total.length === 0) return (
    <div style={{ textAlign: "center", padding: 80, color: "var(--text-3)" }}>
      <AlertCircle size={40} style={{ marginBottom: 12 }} />
      <p>No data yet. Upload some bills to see analytics!</p>
    </div>
  );

  // Background refetch in flight — old data stays visible; a small
  // pill in the header tells the user fresh numbers are on the way.
  const refreshing = loading;

  const totalSpend = data.totals.total_eur;
  const latestMonth = data.monthly_total[data.monthly_total.length - 1];
  // Trust the backend's calendar-aware delta — it is already null when
  // the immediately preceding calendar month has no data, so a row-based
  // fallback would misleadingly fill those gaps.
  const momChange = latestMonth.mom_delta_pct;
  const latestYoy = latestMonth.yoy_delta_pct;

  const momRows = data.monthly_total
    .filter(r => r.mom_delta_pct != null)
    .map(r => ({ month: r.month, delta: r.mom_delta_pct!, eur: r.mom_delta_eur!, total: r.total_eur }));

  const types = Array.from(new Set(data.by_month.map(r => r.utility_type)));

  const monthlyStacked: Record<string, Record<string, number | string>> = {};
  for (const r of data.by_month) {
    if (!monthlyStacked[r.month]) monthlyStacked[r.month] = { month: r.month };
    monthlyStacked[r.month][r.utility_type] = r.total_eur;
  }
  const stackedRows = Object.values(monthlyStacked).sort((a, b) => String(a.month).localeCompare(String(b.month)));

  const seasonalMap: Record<string, Record<string, number | string>> = {};
  for (const r of data.seasonal) {
    const mn = MONTH_NAMES[parseInt(r.month_num)];
    if (!seasonalMap[mn]) seasonalMap[mn] = { month: mn };
    seasonalMap[mn][r.utility_type] = parseFloat(r.avg_eur.toFixed(2));
  }
  const seasonalRows = Object.values(seasonalMap).sort((a, b) =>
    MONTH_NAMES.indexOf(String(a.month)) - MONTH_NAMES.indexOf(String(b.month))
  );

  const yoyRows = data.monthly_total
    .filter(r => r.yoy_delta_pct != null)
    .map(r => ({ month: r.month, delta: r.yoy_delta_pct!, eur: r.yoy_delta_eur! }));

  const radarTypes = types.slice(0, 5);
  // Prefer weighted averages (Σtotal / Σcount) so the season's value
  // reflects the true per-bill average across the season's months
  // instead of averaging averages. Fall back to averaging avg_eur when
  // total_eur/bill_count aren't on the payload (e.g. during a backend
  // deploy lag against an older response shape).
  const radarData = ["Winter", "Spring", "Summer", "Autumn"].map((season, si) => {
    const entry: Record<string, string | number> = { season };
    const months = [[12, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]][si];
    for (const t of radarTypes) {
      const relevant = data.seasonal.filter(r => months.includes(parseInt(r.month_num)) && r.utility_type === t);
      if (relevant.length === 0) {
        entry[t] = 0;
        continue;
      }
      const billCount = relevant.reduce((s, r) => s + (typeof r.bill_count === "number" ? r.bill_count : 0), 0);
      if (billCount > 0) {
        const totalEur = relevant.reduce((s, r) => s + (typeof r.total_eur === "number" ? r.total_eur : 0), 0);
        entry[t] = parseFloat((totalEur / billCount).toFixed(2));
      } else {
        // Unweighted fallback for legacy payloads.
        entry[t] = parseFloat(
          (relevant.reduce((s, r) => s + r.avg_eur, 0) / relevant.length).toFixed(2),
        );
      }
    }
    return entry;
  });

  const topProviders = data.by_provider.slice(0, 8);

  const annualByType: Record<string, Record<string, number | string>> = {};
  for (const r of data.by_year) {
    if (!annualByType[r.year]) annualByType[r.year] = { year: r.year };
    annualByType[r.year][r.utility_type] = parseFloat(r.total_eur.toFixed(2));
  }
  const annualRows = Object.values(annualByType).sort((a, b) => String(a.year).localeCompare(String(b.year)));
  const annualTotals = [...(data.annual_total ?? [])].sort((a, b) =>
    a.year.localeCompare(b.year)
  );

  // ── Line-item analytics ─────────────────────────────────────────────────
  const lit = data.line_item_trends ?? [];
  const liMonths = Array.from(new Set(lit.map(r => r.month))).sort();
  const liLabels = Array.from(new Set(lit.map(r => r.description_en))).sort();
  // Latest two months are used by both card 11 (decomposition) and card 12
  // (side-by-side line item comparison).
  const [prevMonthLabel, latestMonthLabel] = liMonths.slice(-2);

  // Unit-price trend per line item across months. The backend already
  // aggregates duplicate (month, label) rows with a quantity-weighted unit
  // price, so a direct lookup is safe and we don't need to defend against
  // overwriting duplicates here.
  const unitPriceByLabel: Record<string, Record<string, number | string>> = {};
  for (const r of lit) {
    if (r.unit_price == null) continue;
    if (!unitPriceByLabel[r.month]) unitPriceByLabel[r.month] = { month: r.month };
    unitPriceByLabel[r.month][r.description_en] = r.unit_price;
  }
  const unitPriceRows = Object.values(unitPriceByLabel).sort((a, b) => String(a.month).localeCompare(String(b.month)));

  // Price vs Consumption decomposition for metered items (have a unit_price and quantity).
  // Only compare the latest two months; older month-over-month changes are less
  // actionable and made the chart noisy.
  //
  // We use a Bennet (symmetric) decomposition so the two effects sum
  // exactly to the total cost change, eliminating the residual cross-term
  // that a Laspeyres split (Δp · q₀ + p₀ · Δq) silently drops:
  //   Δcost = Δp · (q₀ + q₁)/2 + Δq · (p₀ + p₁)/2
  const meteredLabels = Array.from(new Set(
    lit.filter(r => r.unit_price != null && r.quantity != null && r.quantity > 0).map(r => r.description_en)
  ));
  const decompAll: { label: string; month: string; priceEffect: number; volEffect: number; total: number; xLabel: string }[] = [];
  for (const label of meteredLabels) {
    const series = lit.filter(r => r.description_en === label && r.unit_price != null && r.quantity != null)
                      .sort((a, b) => a.month.localeCompare(b.month));
    const prev = series.find(r => r.month === prevMonthLabel);
    const cur = series.find(r => r.month === latestMonthLabel);
    if (!prev || !cur || !prev.unit_price || !cur.unit_price || !prev.quantity || !cur.quantity) continue;
    const avgQ = (prev.quantity + cur.quantity) / 2;
    const avgP = (prev.unit_price + cur.unit_price) / 2;
    const priceEff = parseFloat(((cur.unit_price - prev.unit_price) * avgQ).toFixed(2));
    const volEff   = parseFloat(((cur.quantity   - prev.quantity)   * avgP).toFixed(2));
    decompAll.push({
      label,
      month: cur.month,
      priceEffect: priceEff,
      volEffect: volEff,
      total: parseFloat((cur.amount_eur - prev.amount_eur).toFixed(2)),
      xLabel: label,
    });
  }
  // Only show entries where at least one effect is meaningful; rank by
  // magnitude so the most interesting bars appear first.
  const decompRows = decompAll
    .filter(r => Math.abs(r.priceEffect) + Math.abs(r.volEffect) > 0.5)
    .sort((a, b) => (Math.abs(b.priceEffect) + Math.abs(b.volEffect)) - (Math.abs(a.priceEffect) + Math.abs(a.volEffect)))
    .slice(0, 12);

  // Month-vs-month comparison table: last two months side by side
  const comparisonItems = liLabels.map(label => {
    const prev = lit.find(r => r.month === prevMonthLabel && r.description_en === label);
    const curr = lit.find(r => r.month === latestMonthLabel && r.description_en === label);
    if (!prev && !curr) return null;
    const amtDiff = (curr?.amount_eur ?? 0) - (prev?.amount_eur ?? 0);
    const priceDiff = curr?.unit_price != null && prev?.unit_price != null ? curr.unit_price - prev.unit_price : null;
    return { label, prev, curr, amtDiff, priceDiff };
  }).filter(Boolean) as { label: string; prev: typeof lit[0] | undefined; curr: typeof lit[0] | undefined; amtDiff: number; priceDiff: number | null }[];

  // Pick the line items whose unit prices actually vary across months.
  // Rank by relative variance (range / mean) so the most "interesting" price
  // movements surface first; cap at 8 to keep the chart readable.
  const priceVaryingLabels = liLabels
    .map(label => {
      const prices = lit.filter(r => r.description_en === label && r.unit_price != null).map(r => r.unit_price!);
      if (prices.length < 2) return null;
      const min = Math.min(...prices), max = Math.max(...prices);
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const range = max - min;
      if (range < 0.001 || mean === 0) return null;
      return { label, variance: range / mean };
    })
    .filter(Boolean)
    .sort((a, b) => b!.variance - a!.variance)
    .slice(0, 8)
    .map(x => x!.label);

  // Restrict the stacked-bar to the trailing 12 calendar months — older
  // bars crush horizontal real estate without telling a useful story for
  // the current period, and the side-by-side comparison (card 12)
  // already covers month-over-month detail.
  const liStackMonths = new Set(liMonths.slice(-12));
  const recentLit = lit.filter(r => liStackMonths.has(r.month));
  const recentLabels = Array.from(new Set(recentLit.map(r => r.description_en)));

  // Cap the stacked-bar line items at top 8 by total € *within the
  // visible window*, aggregating the rest as "Other". Computing topLabels
  // over the same window the chart shows keeps the legend in sync with
  // the visible bars.
  const labelTotals: Record<string, number> = {};
  for (const r of recentLit) {
    labelTotals[r.description_en] = (labelTotals[r.description_en] ?? 0) + r.amount_eur;
  }
  const topLabels = Object.entries(labelTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l]) => l);
  const topLabelSet = new Set(topLabels);
  const hasOther = recentLabels.some(l => !topLabelSet.has(l));
  const liStackLabels = hasOther ? [...topLabels, "Other"] : topLabels;

  const liStackRows: Record<string, Record<string, number | string>> = {};
  for (const r of recentLit) {
    if (!liStackRows[r.month]) liStackRows[r.month] = { month: r.month };
    const key = topLabelSet.has(r.description_en) ? r.description_en : "Other";
    const cur = (liStackRows[r.month][key] as number) ?? 0;
    liStackRows[r.month][key] = parseFloat((cur + r.amount_eur).toFixed(2));
  }
  const liStackData = Object.values(liStackRows).sort((a, b) =>
    String(a.month).localeCompare(String(b.month)),
  );

  const dashboardGrid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: isMobile ? "1fr" : "repeat(12, minmax(0, 1fr))",
    gap: isMobile ? 12 : 20,
    alignItems: "stretch",
  };
  const halfCard: React.CSSProperties = { gridColumn: isMobile ? "1 / -1" : "span 6" };
  const fullCard: React.CSSProperties = { gridColumn: "1 / -1" };
  const kpiGrid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: isMobile
      ? "repeat(auto-fit, minmax(150px, 1fr))"
      : "repeat(4, minmax(0, 1fr))",
    gap: isMobile ? 12 : 16,
    marginBottom: 8,
    alignItems: "stretch",
  };
  const chartH = (base: number) => isMobile ? Math.round(base * 0.75) : base;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ color: "var(--text-1)", margin: 0, fontSize: 22, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            Analytics Dashboard
            {refreshing && (
              <span
                aria-live="polite"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  background: "var(--accent-soft)", color: "var(--accent)",
                  border: "1px solid var(--accent)",
                  padding: "2px 10px", borderRadius: 999,
                  fontSize: 11, fontWeight: 600,
                }}
              >
                <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                Refreshing
              </span>
            )}
          </h2>
          <p style={{ color: "var(--text-2)", margin: "4px 0 0", fontSize: 13 }}>
            {data.totals.bill_count} bills · {types.length} utility types
          </p>
        </div>
        <button
          onClick={exportToPDF}
          disabled={exporting}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            background: exporting ? "var(--border-strong)" : "var(--accent)",
            color: "var(--text-1)",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: exporting ? "wait" : "pointer",
            transition: "background 120ms",
          }}
          onMouseEnter={e => { if (!exporting) e.currentTarget.style.background = "var(--accent-strong)"; }}
          onMouseLeave={e => { if (!exporting) e.currentTarget.style.background = "var(--accent)"; }}
        >
          {exporting ? (
            <>
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
              Exporting…
            </>
          ) : (
            <>
              <Download size={16} />
              Download PDF
            </>
          )}
        </button>
      </div>

      {exportError && (
        <div style={{
          background: "var(--danger-soft)",
          border: "1px solid #7f1d1d",
          borderLeft: "3px solid #ef4444",
          borderRadius: 8,
          padding: "12px 16px",
          marginBottom: 16,
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}>
          <AlertCircle size={18} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
              PDF export failed
            </div>
            <div style={{ color: "var(--text-1)", fontSize: 12 }}>{exportError}</div>
          </div>
          <button
            onClick={() => setExportError(null)}
            style={{ background: "transparent", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      <div ref={dashboardRef}>

      {/* KPI Cards */}
      <div style={kpiGrid}>
        <StatCard label="Total Spend" value={`€${totalSpend.toFixed(2)}`} />
        <StatCard
          label="Latest Month"
          value={`€${latestMonth.total_eur.toFixed(2)}`}
          sub={momChange != null ? `${momChange > 0 ? "+" : ""}${momChange.toFixed(1)}% MoM` : undefined}
          trend={momChange == null ? undefined : momChange > 5 ? "up" : momChange < -5 ? "down" : "flat"}
        />
        {latestYoy != null && (
          <StatCard
            label="YoY Change"
            value={`${latestYoy > 0 ? "+" : ""}${latestYoy.toFixed(1)}%`}
            sub={latestMonth.yoy_delta_eur != null ? `€${latestMonth.yoy_delta_eur > 0 ? "+" : ""}${latestMonth.yoy_delta_eur.toFixed(2)} vs same month last year` : "vs same month last year"}
            trend={latestYoy > 5 ? "up" : latestYoy < -5 ? "down" : "flat"}
          />
        )}
        <StatCard label="3-Month Avg" value={`€${latestMonth.rolling_avg_3m.toFixed(2)}`} sub="rolling average" />
        <StatCard label="Highest Single Bill" value={`€${data.totals.max_eur.toFixed(2)}`} />
        <StatCard
          label="Avg per Active Month"
          value={`€${(totalSpend / Math.max(data.monthly_total.length, 1)).toFixed(2)}`}
          sub={`across ${data.monthly_total.length} months with data`}
        />
        {data.by_type.find(t => t.total_kwh) && (
          <StatCard label="Total Electricity" value={`${data.by_type.find(t => t.total_kwh)!.total_kwh!.toFixed(0)} kWh`} />
        )}
      </div>

      {/* 1. Total spend over time */}
      <SectionTitle>📈 1. Monthly Spending Trend &amp; Rolling Average</SectionTitle>
      <div style={dashboardGrid}>
        <div style={halfCard}><ChartCard title="Total Monthly Spend — Line" subtitle="Clean line chart of monthly total with labeled points">
          <ResponsiveContainer width="100%" height={chartH(260)}>
            <LineChart data={data.monthly_total} margin={{ top: 20, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `€${v}`} />
              <Tooltip content={<RichTooltip unit="€" showTotal={false} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
              <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
              <Line
                type="monotone"
                dataKey="total_eur"
                stroke="#2563eb"
                strokeWidth={3}
                name="Monthly Total"
                dot={{ r: 5, fill: "#2563eb", strokeWidth: 2, stroke: "var(--bg)" }}
                activeDot={{ r: 7 }}
                label={{
                  position: "top",
                  fill: "var(--text-1)",
                  fontSize: 11,
                  formatter: (v: unknown) => `€${(v as number).toFixed(0)}`,
                }}
              />
              <Line
                type="monotone"
                dataKey="rolling_avg_3m"
                stroke="var(--warning)"
                strokeDasharray="5 5"
                strokeWidth={2}
                name="3-Month Avg"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard></div>

        <div style={halfCard}><ChartCard title="Total Monthly Spend — Area" subtitle="Filled area view · Dashed line = 3-month rolling average">
          <ResponsiveContainer width="100%" height={chartH(260)}>
            <AreaChart data={data.monthly_total}>
              <defs>
                <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `€${v}`} />
              <Tooltip content={<RichTooltip unit="€" showTotal={false} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
              <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
              <Area type="monotone" dataKey="total_eur" stroke="#2563eb" fill="url(#totalGrad)" name="Monthly Total" strokeWidth={2} />
              <Line type="monotone" dataKey="rolling_avg_3m" stroke="var(--warning)" strokeDasharray="5 5" name="3-Month Avg" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard></div>
      </div>

      {/* 2. MoM & YoY % Change */}
      {(momRows.length > 0 || yoyRows.length > 0) && (
        <>
          <SectionTitle>📉 2. Month-over-Month &amp; Year-over-Year % Change</SectionTitle>
          <div style={dashboardGrid}>
            {momRows.length > 0 && (
              <div style={halfCard}><ChartCard title="Month-over-Month Change" subtitle="Green = cheaper than previous month · Red = more expensive">
                <ResponsiveContainer width="100%" height={chartH(260)}>
                  <BarChart data={momRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
                    <YAxis tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `${v}%`} />
                    <Tooltip content={<RichTooltip unit="%" showTotal={false} maxItems={2} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                    <Bar dataKey="delta" name="MoM %" radius={[3, 3, 0, 0]}>
                      {momRows.map((r, i) => (
                        <Cell key={i} fill={r.delta > 0 ? "var(--danger)" : "var(--success)"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard></div>
            )}

            {yoyRows.length > 0 && (
              <div style={halfCard}><ChartCard title="Year-over-Year Change" subtitle="Green = cheaper than same month last year · Red = more expensive">
                <ResponsiveContainer width="100%" height={chartH(260)}>
                  <BarChart data={yoyRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
                    <YAxis tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `${v}%`} />
                    <Tooltip content={<RichTooltip unit="%" showTotal={false} maxItems={2} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                    <Bar dataKey="delta" name="YoY %" radius={[3, 3, 0, 0]}>
                      {yoyRows.map((r, i) => (
                        <Cell key={i} fill={r.delta > 0 ? "var(--danger)" : "var(--success)"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard></div>
            )}
          </div>

          {/* Change table */}
          <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", marginTop: 20 }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", fontSize: 14, fontWeight: 600, color: "var(--text-1)" }}>
              Change Metrics — All Months
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Month", "Total (€)", "MoM Change", "MoM (€)", "YoY Change", "YoY (€)"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "var(--text-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...data.monthly_total].reverse().map((row, i) => (
                    <tr key={row.month} style={{ borderBottom: i < data.monthly_total.length - 1 ? "1px solid var(--divider)" : "none" }}>
                      <td style={{ padding: "10px 16px", color: "var(--text-1)", fontWeight: 500 }}>{row.month}</td>
                      <td style={{ padding: "10px 16px", color: "var(--success)", fontVariantNumeric: "tabular-nums" }}>€{row.total_eur.toFixed(2)}</td>
                      <td style={{ padding: "10px 16px" }}><PctBadge v={row.mom_delta_pct} label="MoM" /></td>
                      <td style={{ padding: "10px 16px", color: row.mom_delta_eur == null ? "var(--text-3)" : row.mom_delta_eur > 0 ? "var(--danger)" : "var(--success)", fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                        {row.mom_delta_eur != null ? `${row.mom_delta_eur > 0 ? "+" : ""}€${row.mom_delta_eur.toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px" }}><PctBadge v={row.yoy_delta_pct} label="YoY" /></td>
                      <td style={{ padding: "10px 16px", color: row.yoy_delta_eur == null ? "var(--text-3)" : row.yoy_delta_eur > 0 ? "var(--danger)" : "var(--success)", fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                        {row.yoy_delta_eur != null ? `${row.yoy_delta_eur > 0 ? "+" : ""}€${row.yoy_delta_eur.toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 3. Breakdown by type */}
      <SectionTitle>🗂️ 3. Spend Breakdown by Utility Type</SectionTitle>
      <div style={dashboardGrid}>
        <div style={halfCard}><ChartCard title="Monthly Stacked by Type" subtitle="See which utilities drive costs each month">
          <ResponsiveContainer width="100%" height={chartH(320)}>
            <BarChart data={stackedRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={v => `€${v}`} />
              <Tooltip content={<RichTooltip unit="€" maxItems={7} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
              <Legend wrapperStyle={legendStyle} iconSize={10} formatter={legendFormatter} />
              {types.map((t, i) => (
                <Bar key={t} dataKey={t} stackId="a" fill={colorFor(t, i)} name={t} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard></div>

        <div style={halfCard}><ChartCard title="Share of Total Spend" subtitle="Cumulative share per category">
          <ResponsiveContainer width="100%" height={chartH(320)}>
            <PieChart>
              <Pie
                data={data.by_type}
                dataKey="total_eur"
                nameKey="utility_type"
                cx="50%" cy="45%"
                innerRadius={55}
                outerRadius={95}
                paddingAngle={2}
                label={(props) => {
                  const { cx, cy, midAngle, innerRadius, outerRadius, percent, fill } = props as {
                    cx: number; cy: number; midAngle: number;
                    innerRadius: number; outerRadius: number; percent: number;
                    fill: string;
                  };
                  if (!percent || percent < 0.04) return null;
                  const RAD = Math.PI / 180;
                  const r = (innerRadius + outerRadius) / 2;
                  const x = cx + r * Math.cos(-midAngle * RAD);
                  const y = cy + r * Math.sin(-midAngle * RAD);
                  // Pick black or white based on the slice's actual luma so
                  // amber/light slices remain readable in both themes.
                  return (
                    <text x={x} y={y} fill={contrastTextOn(fill)} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600}>
                      {`${(percent * 100).toFixed(0)}%`}
                    </text>
                  );
                }}
                labelLine={false}
              >
                {data.by_type.map((entry, i) => (
                  <Cell key={entry.utility_type} fill={colorFor(entry.utility_type, i)} />
                ))}
              </Pie>
              <Tooltip content={<RichTooltip unit="€" />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
              <Legend
                verticalAlign="bottom"
                iconType="circle"
                wrapperStyle={{ ...legendStyle, fontSize: 12 }}
                formatter={legendFormatter}
              />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard></div>
      </div>

      {/* 4. Seasonal patterns */}
      <SectionTitle>🌡️ 4. Seasonal Cost Patterns</SectionTitle>
      <div style={dashboardGrid}>
        <div style={halfCard}><ChartCard title="Average Bill by Calendar Month" subtitle="Reveals heating spikes in winter, A/C in summer">
          <ResponsiveContainer width="100%" height={chartH(320)}>
            <BarChart data={seasonalRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `€${v}`} />
              <Tooltip content={<RichTooltip unit="€" />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
              <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
              {types.map((t, i) => (
                <Bar key={t} dataKey={t} fill={colorFor(t, i)} name={t} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard></div>

        <div style={halfCard}><ChartCard title="Seasonal Radar Profile" subtitle="Shape = energy use pattern across 4 seasons">
          <ResponsiveContainer width="100%" height={chartH(320)}>
            <RadarChart data={radarData} cx="50%" cy="45%" outerRadius={75}>
              <PolarGrid stroke="var(--border)" />
              <PolarAngleAxis dataKey="season" tick={{ fill: "var(--text-2)", fontSize: 12 }} />
              {radarTypes.map((t, i) => (
                <Radar key={t} name={t} dataKey={t} stroke={colorFor(t, i)} fill={colorFor(t, i)} fillOpacity={0.15} />
              ))}
              <Legend wrapperStyle={{ ...legendStyle, paddingTop: 12 }} formatter={legendFormatter} />
              <Tooltip content={<RichTooltip unit="€" showTotal={false} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
            </RadarChart>
          </ResponsiveContainer>
        </ChartCard></div>
      </div>

      {/* 5. Year-over-year annual view */}
      {annualRows.length > 1 && (
        <>
          <SectionTitle>📅 5. Annual Spend Comparison</SectionTitle>
          <div style={dashboardGrid}>
            <div style={fullCard}>
              <ChartCard title="Annual Spend by Category" subtitle="Compare total utility cost across years">
                <ResponsiveContainer width="100%" height={chartH(320)}>
                  <BarChart data={annualRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: "var(--text-3)", fontSize: 12 }} />
                    <YAxis tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `€${v}`} />
                    <Tooltip content={<RichTooltip unit="€" />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                    <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
                    {types.map((t, i) => (
                      <Bar key={t} dataKey={t} fill={colorFor(t, i)} name={t} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </div>
        </>
      )}

      {/* 6. Provider breakdown */}
      {topProviders.length > 0 && (
        <>
          <SectionTitle>🏢 6. Spend by Provider</SectionTitle>
          <div style={dashboardGrid}>
            <div style={fullCard}>
              <ChartCard title="Top Providers by Total Spend" subtitle="Identify your most expensive suppliers">
                <ResponsiveContainer width="100%" height={chartH(260)}>
                  <BarChart data={topProviders} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: "var(--text-3)", fontSize: 12 }} tickFormatter={v => `€${v}`} />
                    <YAxis type="category" dataKey="provider" tick={{ fill: "var(--text-2)", fontSize: isMobile ? 10 : 12 }} width={isMobile ? 80 : 140} />
                    <Tooltip content={<RichTooltip unit="€" />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                    <Bar dataKey="total_eur" fill="#2563eb" name="Total Spend" radius={[0, 4, 4, 0]}>
                      {topProviders.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </div>
        </>
      )}

      {/* 7. Per-type trend lines */}
      <SectionTitle>📊 7. Per-Utility Trend Lines</SectionTitle>
      <div style={dashboardGrid}>
        <div style={fullCard}>
          <ChartCard title="Each Utility Type Over Time" subtitle="A sudden spike = price change or leak">
            <ResponsiveContainer width="100%" height={chartH(340)}>
              <LineChart data={stackedRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={v => `€${v}`} />
                <Tooltip content={<RichTooltip />} />
            <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
                {types.map((t, i) => (
                  <Line key={t} type="monotone" dataKey={t} stroke={colorFor(t, i)} name={t} strokeWidth={2} dot={{ r: 3 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>

      {/* 8. Summary stats table */}
      <SectionTitle>🔢 8. Summary Statistics by Type</SectionTitle>
      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 520 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Type", "Bills", "Total", "Avg/Bill", "Min", "Max", "Consumption"].map(h => (
                <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: "var(--text-3)", fontWeight: 600, fontSize: 12, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.by_type.map((row, i) => (
              <tr key={row.utility_type} style={{ borderBottom: i < data.by_type.length - 1 ? "1px solid var(--divider)" : "none" }}>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: colorFor(row.utility_type, i), display: "inline-block" }} />
                    <span style={{ color: "var(--text-1)" }}>{labelFor(row.utility_type)}</span>
                  </span>
                </td>
                <td style={{ padding: "12px 16px", color: "var(--text-2)" }}>{row.bill_count}</td>
                <td style={{ padding: "12px 16px", color: "var(--success)", fontWeight: 600 }}>€{row.total_eur.toFixed(2)}</td>
                <td style={{ padding: "12px 16px", color: "var(--text-1)" }}>€{row.avg_eur.toFixed(2)}</td>
                <td style={{ padding: "12px 16px", color: "var(--text-2)" }}>€{row.min_eur.toFixed(2)}</td>
                <td style={{ padding: "12px 16px", color: "var(--text-2)" }}>€{row.max_eur.toFixed(2)}</td>
                <td style={{ padding: "12px 16px", color: "var(--text-2)" }}>
                  {row.total_kwh ? `${row.total_kwh.toFixed(0)} kWh` : row.total_m3 ? `${row.total_m3.toFixed(1)} m³` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* 9. Line-item unit price trends */}
      {priceVaryingLabels.length > 0 && (
        <>
          <SectionTitle>💶 9. Unit Price Trends (€ per unit)</SectionTitle>
          <ChartCard
            title="Price per Unit Over Time"
            subtitle={`Top ${priceVaryingLabels.length} most-varying unit prices — reveals tariff hikes independent of consumption`}
          >
            <ResponsiveContainer width="100%" height={chartH(340)}>
              <LineChart data={unitPriceRows} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={v => `€${Number(v).toFixed(2)}`} />
                <Tooltip content={<RichTooltip unit="€" showTotal={false} maxItems={8} />} />
                <Legend wrapperStyle={legendStyle} iconSize={10} formatter={legendFormatter} />
                {priceVaryingLabels.map((label, i) => (
                  <Line key={label} type="monotone" dataKey={label} stroke={PALETTE[i % PALETTE.length]}
                    name={label} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}

      {/* 10. Line-item cost comparison across months */}
      {liStackData.length > 1 && liStackLabels.length > 0 && (
        <>
          <SectionTitle>🧾 10. Line-Item Cost Comparison Across Months</SectionTitle>
          <ChartCard
            title="Every Line Item by Month"
            subtitle={`Last ${liStackData.length} months · Top ${topLabels.length} charges by total spend${hasOther ? ' · rest grouped as "Other"' : ''}`}
          >
            <div style={{ overflowX: "auto" }}>
              <ResponsiveContainer width={Math.max(600, liStackData.length * 90)} height={360}>
                <BarChart data={liStackData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={fmtMonthShort} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={v => `€${v}`} />
                  <Tooltip content={<RichTooltip unit="€" showTotal maxItems={6} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                  <Legend wrapperStyle={legendStyle} iconSize={10} formatter={legendFormatter} />
                  {liStackLabels.map((label, i) => (
                    <Bar key={label} dataKey={label} stackId="a"
                      fill={label === "Other" ? "#475569" : PALETTE[i % PALETTE.length]}
                      name={label} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </>
      )}

      {/* 11. Price vs Consumption decomposition */}
      {decompRows.length > 0 && (
        <>
          <SectionTitle>⚖️ 11. Price vs Consumption Decomposition</SectionTitle>
          <ChartCard
            title="What drove the cost change? Price or usage?"
            subtitle={`${prevMonthLabel} → ${latestMonthLabel} · Bennet decomposition (price + volume = total) · Red = price effect · Blue = volume effect`}
          >
            <div style={{ overflowX: "auto" }}>
              <ResponsiveContainer width={Math.max(600, decompRows.length * 100)} height={360}>
                <BarChart data={decompRows} margin={{ top: 10, right: 20, left: 0, bottom: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="xLabel" tick={{ fill: "var(--text-2)", fontSize: 10 }} interval={0} angle={-35} textAnchor="end" height={100} />
                  <YAxis tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={v => `€${v}`} />
                  <Tooltip content={<RichTooltip unit="€" showTotal={false} maxItems={4} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                  <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
                  <Bar dataKey="priceEffect" name="Price effect (€)" fill="var(--danger)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="volEffect" name="Volume effect (€)" fill="#2563eb" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", marginTop: 20 }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", fontSize: 14, fontWeight: 600, color: "var(--text-1)" }}>
              Decomposition Table — All Months
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 700, borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Line Item", "Month", "Price Effect", "Volume Effect", "Total Change", "Interpretation"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "var(--text-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {decompRows.map((r, i) => {
                    const priceUp = r.priceEffect > 0.005;
                    const volUp = r.volEffect > 0.005;
                    const interpretation =
                      Math.abs(r.priceEffect) < 0.01 && Math.abs(r.volEffect) < 0.01 ? "Unchanged" :
                      priceUp && volUp ? "Higher price + more usage" :
                      priceUp && !volUp ? "Price hike (usage ↓ offset)" :
                      !priceUp && volUp ? "More usage (price stable)" :
                      !priceUp && !volUp ? "Lower price + less usage" :
                      r.priceEffect < -0.005 && r.volEffect > 0.005 ? "Cheaper rate, more used" :
                      "Mixed";
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid var(--divider)" }}>
                        <td style={{ padding: "10px 16px", color: "var(--text-1)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</td>
                        <td style={{ padding: "10px 16px", color: "var(--text-2)" }}>{r.month}</td>
                        <td style={{ padding: "10px 16px", color: r.priceEffect > 0 ? "var(--danger)" : r.priceEffect < 0 ? "var(--success)" : "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
                          {r.priceEffect > 0 ? "+" : ""}€{r.priceEffect.toFixed(2)}
                        </td>
                        <td style={{ padding: "10px 16px", color: r.volEffect > 0 ? "var(--warning)" : r.volEffect < 0 ? "var(--success)" : "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
                          {r.volEffect > 0 ? "+" : ""}€{r.volEffect.toFixed(2)}
                        </td>
                        <td style={{ padding: "10px 16px", color: r.total > 0 ? "var(--danger)" : r.total < 0 ? "var(--success)" : "var(--text-3)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                          {r.total > 0 ? "+" : ""}€{r.total.toFixed(2)}
                        </td>
                        <td style={{ padding: "10px 16px", color: "var(--text-2)", fontSize: 12 }}>{interpretation}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 12. Month-vs-month line item comparison table */}
      {comparisonItems.length > 0 && prevMonthLabel && latestMonthLabel && (
        <>
          <SectionTitle>📋 12. Line-Item Comparison: {prevMonthLabel} vs {latestMonthLabel}</SectionTitle>
          <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 700, borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Line Item", `${prevMonthLabel} (€)`, `${latestMonthLabel} (€)`, "Change (€)", "Unit price change", "Qty change"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "var(--text-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparisonItems.map((row, i) => (
                    <tr key={i} style={{ borderBottom: i < comparisonItems.length - 1 ? "1px solid var(--divider)" : "none", background: Math.abs(row.amtDiff) > 10 ? "rgba(239,68,68,0.04)" : "transparent" }}>
                      <td style={{ padding: "10px 16px", color: "var(--text-1)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</td>
                      <td style={{ padding: "10px 16px", color: "var(--text-2)", fontVariantNumeric: "tabular-nums" }}>
                        {row.prev ? `€${row.prev.amount_eur.toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", color: "var(--text-1)", fontVariantNumeric: "tabular-nums" }}>
                        {row.curr ? `€${row.curr.amount_eur.toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: row.amtDiff > 0.5 ? "var(--danger)" : row.amtDiff < -0.5 ? "var(--success)" : "var(--text-3)" }}>
                        {!row.prev || !row.curr ? "—" : `${row.amtDiff > 0 ? "+" : ""}€${row.amtDiff.toFixed(2)}`}
                      </td>
                      <td style={{ padding: "10px 16px", fontVariantNumeric: "tabular-nums", fontSize: 12, color: row.priceDiff == null ? "var(--text-3)" : row.priceDiff > 0.001 ? "var(--danger)" : row.priceDiff < -0.001 ? "var(--success)" : "var(--text-3)" }}>
                        {row.priceDiff == null ? "—" :
                          `${row.priceDiff > 0 ? "+" : ""}€${row.priceDiff.toFixed(4)}/unit`}
                      </td>
                      <td style={{ padding: "10px 16px", fontVariantNumeric: "tabular-nums", fontSize: 12, color: "var(--text-2)" }}>
                        {row.prev?.quantity != null && row.curr?.quantity != null
                          ? `${row.prev.quantity} → ${row.curr.quantity} ${row.curr.unit || ""}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 13. Annual total rollup */}
      {annualTotals.length > 0 && (
        <>
          <SectionTitle>🧮 13. Total Spend by Year</SectionTitle>
          <div style={dashboardGrid}>
            <div style={halfCard}>
              <ChartCard
                title="Annual Total Spend"
                subtitle="One bar per calendar year — all utility types combined"
              >
                <ResponsiveContainer width="100%" height={chartH(280)}>
                  <BarChart data={annualTotals} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: "var(--text-2)", fontSize: 12 }} />
                    <YAxis tick={{ fill: "var(--text-2)", fontSize: 11 }} tickFormatter={v => `€${v}`} />
                    <Tooltip content={<RichTooltip unit="€" showTotal={false} maxItems={2} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                    <Bar dataKey="total_eur" name="Total spend" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div style={{ ...halfCard, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", fontSize: 14, fontWeight: 600, color: "var(--text-1)" }}>
                Yearly Rollup
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: 420, borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      {["Year", "Bills", "Total", "Average bill"].map(h => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "var(--text-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...annualTotals].reverse().map((row, i) => (
                      <tr key={row.year} style={{ borderBottom: i < annualTotals.length - 1 ? "1px solid var(--divider)" : "none" }}>
                        <td style={{ padding: "10px 16px", color: "var(--text-1)", fontWeight: 600 }}>{row.year}</td>
                        <td style={{ padding: "10px 16px", color: "var(--text-2)" }}>{row.bill_count}</td>
                        <td style={{ padding: "10px 16px", color: "var(--success)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>€{row.total_eur.toFixed(2)}</td>
                        <td style={{ padding: "10px 16px", color: "var(--text-1)", fontVariantNumeric: "tabular-nums" }}>€{row.avg_bill_eur.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      <div style={{ height: 40 }} />
      </div>
    </div>
  );
}

import {
  Upload, Receipt, BarChart2, Users, Sparkles,
  FileText, RefreshCw, Download, ShieldCheck, Terminal,
  Lock, Globe, CheckSquare, Sun, Moon,
} from "lucide-react";

const cardStyle: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 24,
};

const sectionTitleStyle: React.CSSProperties = {
  color: "var(--text-1)",
  fontSize: 16,
  fontWeight: 600,
  margin: "32px 0 16px",
};

const subtleChip: React.CSSProperties = {
  display: "inline-block",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "3px 10px",
  fontSize: 12,
  color: "var(--text-1)",
  marginRight: 6,
  marginBottom: 6,
};

// 5-card quickstart that mirrors the actual app surface.
const STEPS: { icon: React.ElementType; title: string; body: string }[] = [
  {
    icon: ShieldCheck,
    title: "1 · Sign in with Google",
    body: "Each Google account gets its own private bill workspace. Your data is scoped to your `sub` claim, so other users can only see what you choose to share.",
  },
  {
    icon: Upload,
    title: "2 · Upload your bill",
    body: "Drop a PDF or photo on the Upload tab. Pick Local OCR for Estonian utility bills, or AI (FreeLLMAPI) to route through free LLM providers for any invoice format or language.",
  },
  {
    icon: Receipt,
    title: "3 · Review & curate",
    body: "Open the Bills tab to inspect every parsed line item. Toggle the lock to mark a bill private. Tick the checkboxes to bulk-delete a batch with one click.",
  },
  {
    icon: BarChart2,
    title: "4 · Explore your analytics",
    body: "The Analytics tab packs 12 dashboard sections: MoM/YoY change, unit-price trends, price vs consumption decomposition, per-utility line charts, and more.",
  },
  {
    icon: Users,
    title: "5 · See the community",
    body: "The Community tab aggregates every signed-in user's public bills. Pick \"All users\" for community-wide insights, or click a specific person to see only theirs.",
  },
];

// Dashboard sections — numbers match Analytics tab
const DASHBOARD_SECTIONS: [string, string][] = [
  ["KPI cards", "Total spend · latest month with MoM% · YoY change · rolling 3-month average · highest single bill"],
  ["1. Monthly Trend", "Line + area chart with 3-month rolling average overlay"],
  ["2. MoM & YoY %", "Bar charts + full change table with € and % deltas per month"],
  ["3. Type Breakdown", "Stacked bar + donut showing share of each utility category"],
  ["4. Seasonal Patterns", "Average bill by calendar month + 4-season radar profile"],
  ["5. Annual Comparison", "Year-over-year spend by category"],
  ["6. Top Providers", "Horizontal bar ranking suppliers by total spend"],
  ["7. Per-Utility Trends", "One line per utility type — spot individual spikes"],
  ["8. Summary Statistics", "Min/max/avg/consumption per utility type"],
  ["9. Unit Price Trends", "€/kWh, €/m², €/m³ over time — isolates tariff changes from usage"],
  ["10. Line-Item Cost by Month", "Stacked bars of every individual charge"],
  ["11. Price vs Consumption Decomposition", "Price effect vs volume effect per line item per month"],
  ["12. Month-vs-Month Comparison", "Side-by-side table of two recent months with deltas"],
];

// Curated glossary grouped by theme — full 180+ term dictionary lives
// in the backend (translation.py) and is applied automatically.
const GLOSSARY_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Housing association (korteriühistu)",
    rows: [
      ["Haldusteenus", "Building management service"],
      ["Raamatupidamisteenus", "Accounting service"],
      ["Tehnosüsteemide hooldusteenus", "Technical systems maintenance"],
      ["Sise- ja väliskoristus", "Interior & exterior cleaning"],
      ["Porivaiba renditeenus", "Doormat rental service"],
      ["Remondifond", "Repair / renovation fund"],
      ["Üldelekter", "Common area electricity"],
      ["Üldvesi", "Common area water"],
      ["Küte", "Heating"],
      ["Vee soojendamine", "Water heating"],
    ],
  },
  {
    title: "Electricity",
    rows: [
      ["Elektrienergia", "Electricity"],
      ["Elekter päevane / öine", "Electricity (daytime / night-time)"],
      ["Võrgutasu / Võrguteenus", "Grid fee / service"],
      ["Aktsiis", "Excise duty"],
      ["Taastuvenergia tasu", "Renewable energy fee"],
      ["Energiatõhususe tasu", "Energy efficiency fee"],
      ["Käibemaks (KM)", "VAT"],
    ],
  },
  {
    title: "Water, heating & gas",
    rows: [
      ["Külm vesi / Soe vesi", "Cold water / Hot water"],
      ["Kanalisatsioon", "Sewerage / wastewater"],
      ["Kaugküte", "District heating"],
      ["Soojusenergia", "Thermal energy"],
      ["Maagaas", "Natural gas"],
    ],
  },
  {
    title: "Invoice fields",
    rows: [
      ["Arve nr.", "Invoice no."],
      ["Kuupäev", "Date"],
      ["Tähtaeg", "Due date"],
      ["Viitenumber", "Reference number"],
      ["Periood", "Period"],
      ["Tasumisele kuulub", "Amount due"],
      ["Kokku", "Total"],
      ["Neto pind", "Net floor area"],
      ["Alg: … Löpp: …", "Start (opening meter) … End (closing meter)"],
    ],
  },
];

const KPI_NOTES: [string, string][] = [
  ["Total Spend", "Sum of every uploaded invoice total (not line items) — uses data.totals.total_eur."],
  ["Latest Month + MoM", "Most recent month grouped by billing period (period_start). Green % = cheaper."],
  ["YoY Change", "Compares same calendar month in prior year, when available."],
  ["Highest Single Bill", "Largest single invoice total across the whole history."],
];

const TIPS: [string, string][] = [
  ["AI vs local OCR", "Local OCR is fastest and works offline for Estonian utility bills. Switch to AI (FreeLLMAPI) for non-Estonian invoices, scanned docs with unusual layouts, or anything Tesseract can't quite read."],
  ["Use PDF when possible", "Native-text PDFs give 100% extraction confidence; images fall back to OCR (~95%)."],
  ["Bulk select & delete", "Tick the circle on each row, or hit Select all in the toolbar, then click the red Delete button. Failures are surfaced and the list refreshes from the server."],
  ["Public vs private", "Click the globe icon on a bill to toggle it private. Private bills only show on your own Bills tab and never appear in Community."],
  ["Pick a model", "On the Upload tab, the model dropdown reflects whatever is configured in your FreeLLMAPI dashboard. \"Auto\" lets the FreeLLMAPI router pick across your healthy provider keys."],
  ["Period-based grouping", "Analytics group by billing period, not invoice issue date. A March bill issued April 13 still counts as March."],
  ["Duplicate detection", "Re-uploading a file with the same filename (or same provider + period) replaces the previous entry — you'll see an amber 'Existing bill replaced' banner."],
  ["Theme & contrast", "The sun/moon button in the header cycles Light → Dark → System. Your choice persists across sessions."],
];

const PRIVACY_NOTES: [React.ElementType, string, string][] = [
  [Globe, "Public by default", "When you upload a bill it's visible in the Community tab to every signed-in user, including provider, amount, and address. Mark it private if you don't want that."],
  [Lock, "Private bills are yours alone", "Toggle the lock on any bill row. Private bills disappear from /api/community/bills and the community analytics aggregate immediately."],
  [ShieldCheck, "Allowlist sign-in", "If the deployment sets ALLOWED_EMAILS, only the listed Google accounts can sign in. Anyone else gets a clear \"not on the allowlist\" error."],
  [CheckSquare, "Cross-user isolation", "Even if a bill ID leaks, only the owner can edit or delete it — every mutation runs `WHERE id = ? AND user_id = ?` and returns 404 otherwise."],
];

export default function HelpTab() {
  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      <h2 style={{ color: "var(--text-1)", fontSize: 22, margin: "0 0 8px", letterSpacing: -0.2 }}>How to use this app</h2>
      <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 24px", lineHeight: 1.55 }}>
        Sign in with Google, upload monthly utility bills, and explore spend patterns through 12
        analytics sections. Use the <strong style={{ color: "var(--text-1)" }}>Community</strong> tab
        to see everyone else's public bills, or mark yours private to keep them out of view.
      </p>

      {/* Quickstart */}
      <div className="list-stagger" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <div
            key={title}
            className="lift"
            style={{ ...cardStyle, ["--i" as string]: i } as React.CSSProperties}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: "var(--accent-soft)", border: "1px solid var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--accent)",
              }}>
                <Icon size={16} />
              </div>
              <div style={{ color: "var(--text-1)", fontWeight: 600, fontSize: 14 }}>{title}</div>
            </div>
            <div style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.55 }}>{body}</div>
          </div>
        ))}
      </div>

      {/* Privacy & sharing */}
      <div style={sectionTitleStyle}>🔐 Privacy & sharing</div>
      <div className="lift" style={cardStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {PRIVACY_NOTES.map(([Icon, title, body]) => (
            <div key={title} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: "var(--accent-soft)", color: "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
                <Icon size={14} />
              </div>
              <div>
                <div style={{ color: "var(--text-1)", fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
                <div style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.5 }}>{body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tips */}
      <div style={sectionTitleStyle}>💡 Tips for best results</div>
      <div style={cardStyle}>
        {TIPS.map(([t, d], i) => (
          <div key={t} style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr",
            gap: 16,
            padding: "10px 0",
            borderBottom: i < TIPS.length - 1 ? "1px solid var(--divider)" : "none",
          }}>
            <div style={{ color: "var(--text-1)", fontWeight: 500, fontSize: 13 }}>{t}</div>
            <div style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>{d}</div>
          </div>
        ))}
      </div>

      {/* KPI cheat-sheet */}
      <div style={sectionTitleStyle}>📌 KPI cheat-sheet</div>
      <div style={cardStyle}>
        {KPI_NOTES.map(([t, d], i) => (
          <div key={t} style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr",
            gap: 16,
            padding: "10px 0",
            borderBottom: i < KPI_NOTES.length - 1 ? "1px solid var(--divider)" : "none",
          }}>
            <div style={{ color: "var(--text-1)", fontWeight: 500, fontSize: 13 }}>{t}</div>
            <div style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>{d}</div>
          </div>
        ))}
      </div>

      {/* Dashboard overview */}
      <div style={sectionTitleStyle}>📊 Dashboard sections</div>
      <div style={cardStyle}>
        {DASHBOARD_SECTIONS.map(([t, d], i) => (
          <div key={t} style={{
            display: "grid",
            gridTemplateColumns: "220px 1fr",
            gap: 16,
            padding: "9px 0",
            borderBottom: i < DASHBOARD_SECTIONS.length - 1 ? "1px solid var(--divider)" : "none",
          }}>
            <div style={{ color: "var(--text-1)", fontWeight: 500, fontSize: 13 }}>{t}</div>
            <div style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>{d}</div>
          </div>
        ))}
      </div>

      {/* Glossary */}
      <div style={sectionTitleStyle}>📖 Estonian → English glossary</div>
      <p style={{ color: "var(--text-3)", fontSize: 12, margin: "0 0 12px" }}>
        Most common terms used on Estonian utility bills. The backend dictionary covers 180+ terms
        and is applied automatically when you upload.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
        {GLOSSARY_GROUPS.map(group => (
          <div key={group.title} className="lift" style={cardStyle}>
            <div style={{
              fontSize: 11, color: "var(--accent)", textTransform: "uppercase",
              letterSpacing: "0.05em", fontWeight: 600, marginBottom: 10,
            }}>{group.title}</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {group.rows.map(([et, en], i) => (
                  <tr key={et} style={{ borderBottom: i < group.rows.length - 1 ? "1px solid var(--divider)" : "none" }}>
                    <td style={{ padding: "7px 0", color: "var(--text-2)", width: "45%" }}>{et}</td>
                    <td style={{ padding: "7px 0", color: "var(--text-1)" }}>{en}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* Feature chips */}
      <div style={sectionTitleStyle}>✨ What this app does</div>
      <div className="lift" style={cardStyle}>
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          <span style={subtleChip}><ShieldCheck size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Google sign-in (multi-user)</span>
          <span style={subtleChip}><Users size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Community insights tab</span>
          <span style={subtleChip}><Lock size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Per-bill private toggle</span>
          <span style={subtleChip}><FileText size={12} style={{ verticalAlign: -1, marginRight: 4 }} />OCR + native PDF parsing</span>
          <span style={subtleChip}><Sparkles size={12} style={{ verticalAlign: -1, marginRight: 4 }} />FreeLLMAPI multi-provider extraction</span>
          <span style={subtleChip}>Local Estonian glossary (180+ terms)</span>
          <span style={subtleChip}>Korteriühistu line-item split</span>
          <span style={subtleChip}><RefreshCw size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Duplicate detection & replace</span>
          <span style={subtleChip}><CheckSquare size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Bulk select & delete</span>
          <span style={subtleChip}>12-section dashboard</span>
          <span style={subtleChip}><Download size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Client-side PDF export</span>
          <span style={subtleChip}><Sun size={12} style={{ verticalAlign: -1, marginRight: 4 }} /><Moon size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Light & dark themes</span>
          <span style={subtleChip}><Terminal size={12} style={{ verticalAlign: -1, marginRight: 4 }} />FastAPI + React + Supabase/Postgres</span>
        </div>
      </div>

      <div style={{ height: 40 }} />
    </div>
  );
}

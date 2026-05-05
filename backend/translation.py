"""
Hardcoded Estonian → English translation for utility bills.
No API calls — pure dictionary + template logic.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Estonian months (lowercase keys so matching is case-insensitive)
# ---------------------------------------------------------------------------
MONTHS: dict[str, tuple[str, int]] = {
    "jaanuar":   ("January",   1),
    "veebruar":  ("February",  2),
    "märts":     ("March",     3),
    "marts":     ("March",     3),   # ä-less OCR variant
    "aprill":    ("April",     4),
    "mai":       ("May",       5),
    "juuni":     ("June",      6),
    "juuli":     ("July",      7),
    "august":    ("August",    8),
    "september": ("September", 9),
    "oktoober":  ("October",  10),
    "november":  ("November", 11),
    "detsember": ("December", 12),
}

# Three-letter abbreviations sometimes used on bills
MONTH_ABBR: dict[str, tuple[str, int]] = {
    "jaan": ("January",   1),
    "veeb": ("February",  2),
    "mär":  ("March",     3),
    "apr":  ("April",     4),
    "mai":  ("May",       5),
    "juun": ("June",      6),
    "juul": ("July",      7),
    "aug":  ("August",    8),
    "sept": ("September", 9),
    "okt":  ("October",  10),
    "nov":  ("November", 11),
    "dets": ("December", 12),
}

# ---------------------------------------------------------------------------
# Estonian weekdays (full & abbreviated)
# ---------------------------------------------------------------------------
WEEKDAYS: dict[str, str] = {
    "esmaspäev":  "Monday",
    "teisipäev":  "Tuesday",
    "kolmapäev":  "Wednesday",
    "neljapäev":  "Thursday",
    "reede":      "Friday",
    "laupäev":    "Saturday",
    "pühapäev":   "Sunday",
    # Common single-letter abbreviations on Estonian calendars
    "e":  "Monday",
    "t":  "Tuesday",
    "k":  "Wednesday",
    "n":  "Thursday",
    "r":  "Friday",
    "l":  "Saturday",
    "p":  "Sunday",
}

# ---------------------------------------------------------------------------
# Core glossary: Estonian term → English translation
# Keys are lowercase for case-insensitive matching.
# ---------------------------------------------------------------------------
GLOSSARY: dict[str, str] = {
    # -----------------------------------------------------------------------
    # Electricity
    # -----------------------------------------------------------------------
    "elektrienergia": "Electricity",
    "elekter": "Electricity",
    "elektrieneregia": "Electricity",          # common OCR/typo variant
    "elekter päevane": "Electricity (daytime)",
    "elekter öine": "Electricity (night-time)",
    "elekter öö": "Electricity (night-time)",
    "päevane elekter": "Electricity (daytime)",
    "öine elekter": "Electricity (night-time)",
    "päevane": "Daytime",
    "öine": "Night-time",
    "üldelekter": "Common area electricity",    # korteriühistu billing
    "üldelecter": "Common area electricity",    # common OCR/typo variant
    "üldenergia": "Common area energy",
    "võrguteenus": "Grid service",
    "võrgutasu": "Grid fee",
    "jaotusvõrguteenus": "Distribution network service",
    "jaotusvõrk": "Distribution network",
    "ülekandevõrk": "Transmission network",
    "põhivõrk": "Main grid",
    "aktsiis": "Excise duty",
    "elektriaktsiis": "Electricity excise duty",
    "taastuvenergia tasu": "Renewable energy fee",
    "taastuvenergia": "Renewable energy",
    "energiatõhususe tasu": "Energy efficiency fee",
    "energiatõhusus": "Energy efficiency",
    "universaalteenuse tasu": "Universal service fee",
    "võimsustasu": "Capacity fee",
    "võimsusmakse": "Capacity charge",
    "liitumistasu": "Connection fee",
    "püsitasu": "Fixed fee",
    "põhitariif": "Base tariff",
    "ületarbimistasu": "Excess consumption fee",
    "öötariif": "Night tariff",
    "päevane tariif": "Day tariff",
    "öine tariif": "Night tariff",
    "tippkoormus": "Peak load",
    "madalkoormus": "Off-peak load",
    "koormusjuhtimine": "Load management",
    "bilansienergia": "Balancing energy",
    "reaktiivenergia": "Reactive energy",

    # -----------------------------------------------------------------------
    # Gas
    # -----------------------------------------------------------------------
    "maagaas": "Natural gas",
    "gaas": "Gas",
    "gaasivõrguteenus": "Gas network service",
    "gaasimüük": "Gas sales",
    "gaasienergia": "Gas energy",
    "gaasi transport": "Gas transport",

    # -----------------------------------------------------------------------
    # Water
    # -----------------------------------------------------------------------
    "külm vesi": "Cold water",
    "soe vesi": "Hot water",
    "üldvesi": "Common area water",            # korteriühistu billing
    "vesi": "Water",
    "vee soojendamine": "Water heating",
    "soojavesi": "Hot water",
    "kanalisatsioon": "Sewerage / Wastewater",
    "ühisveevärk": "Public water supply",
    "äravool": "Drainage",
    "reovesi": "Wastewater",
    "sademevesi": "Stormwater",

    # -----------------------------------------------------------------------
    # Heating / district heating
    # -----------------------------------------------------------------------
    "küte": "Heating",
    "kaugküte": "District heating",
    "soojusenergia": "Thermal energy",
    "soojus": "Heat",
    "soojusvõrk": "Heat network",
    "küttesüsteem": "Heating system",

    # -----------------------------------------------------------------------
    # Internet / telecom
    # -----------------------------------------------------------------------
    "internetiteenus": "Internet service",
    "lairiba": "Broadband",
    "televisioon": "Television",
    "kaabeltelevisoon": "Cable TV",
    "telefoniteenus": "Phone service",
    "mobiilside": "Mobile service",
    "datapakett": "Data package",

    # -----------------------------------------------------------------------
    # Waste
    # -----------------------------------------------------------------------
    "prügivedu": "Waste collection",
    "jäätmevedu": "Waste collection",
    "jäätmekäitlus": "Waste management",
    "olmejäätmed": "Household waste",
    "prügivedamine": "Rubbish collection",
    "sorteeritud jäätmed": "Sorted / Recycled waste",
    "biojäätmed": "Bio waste",
    "pakend": "Packaging waste",

    # -----------------------------------------------------------------------
    # Housing association (korteriühistu) services
    # These appear on building management bills, not utility company bills.
    # -----------------------------------------------------------------------
    "korteriühistu": "Housing association (apartment co-op)",
    "haldusteenus": "Building management service",
    "haldus": "Management",
    "raamatupidamisteenus": "Accounting service",
    "raamatupidamine": "Accounting",
    "tehnosüsteemide hooldusteenus": "Technical systems maintenance",
    "tehnosüsteemide hooldus": "Technical systems maintenance",
    "tehnosüsteemid": "Technical systems",
    "hooldus": "Maintenance",
    "sise- ja väliskoristus": "Interior & exterior cleaning",
    "sise-ja väliskoristus": "Interior & exterior cleaning",
    "koristus": "Cleaning",
    "porivaiba renditeenus": "Doormat rental service",
    "porivaip": "Doormat",
    "renditeenus": "Rental service",
    "rent": "Rental",
    "remondifond": "Repair/Renovation fund",
    "remont": "Repair / Renovation",
    "fond": "Fund",
    "üldkulud": "Common area costs",
    "majanduskulud": "Operating costs",
    "halduskulud": "Administration costs",
    "koristusteenus": "Cleaning service",
    "valve": "Security / Guard service",
    "trepikoda": "Staircase",
    "koridor": "Corridor",
    "lift": "Elevator",
    "liftiteenus": "Elevator service",
    "parkla": "Parking",
    "garaaž": "Garage",
    "kelder": "Basement / Cellar",
    "pöönin": "Attic",
    "neto pind": "Net floor area",
    "pind": "Floor area",
    "eluruumid": "Living space",
    "äriruumid": "Commercial space",

    # -----------------------------------------------------------------------
    # Bill / invoice structure & field labels
    # -----------------------------------------------------------------------
    "arve": "Invoice",
    "arve nr": "Invoice no.",
    "arve nr.": "Invoice no.",
    "arve number": "Invoice number",
    "arve kuupäev": "Invoice date",
    "kuupäev": "Date",
    "tähtaeg": "Due date",
    "tasumise tähtaeg": "Payment due date",
    "maksetähtaeg": "Payment due date",
    "viitenumber": "Reference number",
    "viitenr": "Reference no.",
    "periood": "Period",
    "arvestusperiood": "Billing period",
    "arveldusperiood": "Billing period",
    "kirjeldus": "Description",
    "kogus": "Quantity",
    "ühik": "Unit",
    "ühikuhind": "Unit price",
    "hind": "Price",
    "summa": "Amount",
    "kokku": "Total",
    "käibemaks": "VAT (Value Added Tax)",
    "km": "VAT",
    "käibemaksumäär": "VAT rate",
    "käibemaksusumma": "VAT amount",
    "summa ilma käibemaksuta": "Amount excl. VAT",
    "summa käibemaksuga": "Amount incl. VAT",
    "tasumisele kuulub": "Amount due",
    "tasumisele kuulub eur": "Amount due (EUR)",
    "soodustus": "Discount",
    "allahindlus": "Discount",
    "viivis": "Late payment interest",
    "viivistasu": "Late payment fee",
    "meeldetuletus": "Reminder",
    "ettemaks": "Prepayment",
    "ettemaksu jääk": "Prepayment balance",
    "jääk": "Balance",
    "saldo": "Balance",
    "makstud": "Paid",
    "tasuda": "Amount due",
    "eelmise perioodi võlg": "Previous period debt",
    "laekumata arved": "Outstanding invoices",
    "krediit": "Credit",
    "intress": "Interest",
    "viimase laekumise kuupäev": "Last payment date",
    "viimased teatatud näidud": "Last reported meter readings",

    # -----------------------------------------------------------------------
    # Meter readings  (incl. korteriühistu inline format "Alg: X Löpp: Y")
    # -----------------------------------------------------------------------
    "mõõdik": "Meter",
    "mõõturi näit": "Meter reading",
    "näit": "Reading",
    "algnäit": "Opening reading",
    "lõppnäit": "Closing reading",
    "alg": "Start (opening reading)",
    "lõpp": "End (closing reading)",
    "löpp": "End (closing reading)",          # variant spelling seen in bills
    "tarbimine": "Consumption",
    "mõõtmine": "Measurement",
    "mõõtepunkt": "Metering point",
    "eic kood": "EIC code (meter ID)",

    # -----------------------------------------------------------------------
    # Customer / contract
    # -----------------------------------------------------------------------
    "klient": "Client / Customer",
    "kliendi number": "Customer number",
    "konto number": "Account number",
    "lepingu number": "Contract number",
    "leping": "Contract",
    "müüja": "Supplier",
    "ostja": "Customer / Buyer",
    "tarbija": "Consumer",
    "omanik": "Owner",
    "aadress": "Address",
    "teeninduskoht": "Service address",
    "käibemaksukohustuslase number": "VAT registration number",
    "registreerimisnumber": "Registration number",
    "reg nr": "Reg. no.",
    "reg. nr": "Reg. no.",
    "iban": "IBAN (bank account)",

    # -----------------------------------------------------------------------
    # Units
    # -----------------------------------------------------------------------
    "kwh": "kWh",
    "mwh": "MWh",
    "m²": "m² (square metres)",
    "m2": "m² (square metres)",
    "m³": "m³ (cubic metres)",
    "m3": "m³ (cubic metres)",
    "gj": "GJ",
    "mj": "MJ",
    "tk": "pcs",
    "krt": "occurrence / time",              # korteriühistu: per-unit charge
    "kuud": "months",
    "päevad": "days",
    "tund": "hour",
    "mw": "MW",
    "kw": "kW",
}

# Common Estonian providers with a short English description
PROVIDERS: dict[str, str] = {
    # Electricity / gas
    "eesti energia": "Eesti Energia (Estonian electricity & gas supplier)",
    "elektrilevi": "Elektrilevi (Estonian distribution network operator)",
    "elering": "Elering (Estonian transmission system operator)",
    "eesti gaas": "Eesti Gaas (Estonian gas supplier)",
    "gasum": "Gasum (gas supplier)",
    # Water
    "tallinna vesi": "Tallinna Vesi (Tallinn water utility)",
    "tartu veevärk": "Tartu Veevärk (Tartu water utility)",
    # Heating
    "adven": "Adven (district heating)",
    "utilitas": "Utilitas (district heating)",
    "gren": "Gren (district heating)",
    # Telecom
    "telia": "Telia (telecom: internet, TV, phone)",
    "elisa": "Elisa (telecom: internet, TV, phone)",
    "tele2": "Tele2 (mobile & internet)",
    "starman": "Starman (cable TV & internet)",
    # Waste
    "sts": "STS (waste management)",
    "ragn-sells": "Ragn-Sells (waste collection & recycling)",
    "eesti keskkonnateenused": "Estonian Environmental Services (waste)",
    # Housing associations — matched by suffix "korteriühistu"
    "korteriühistu": "Housing association (apartment building co-op)",
}

# Utility type labels
UTILITY_LABELS: dict[str, str] = {
    "electricity": "electricity",
    "gas": "gas",
    "water": "water",
    "heating": "district heating",
    "internet": "internet / telecom",
    "waste": "waste collection",
    "other": "building services",
}


import re as _re

# Matches meter reading suffix embedded in line descriptions:
# e.g. "Elekter päevane Alg: 9644 Löpp: 9726" or "Külm vesi Alg: 443,500 Löpp: 446,200"
# The character class after 'L' tolerates OCR misreads of õ as ö / ó / é / è / ê.
_METER_SUFFIX = _re.compile(
    r"\s+[Aa]lg[:\s]+[\d,\.]+\s+L[öõóéèêeoO0]?[pP]{1,2}[:\s]+[\d,\.]+",
    _re.IGNORECASE,
)

# Matches "MonthName Year" patterns like "Veebruar 2026" or "märts 2025"
_PERIOD_PATTERN = _re.compile(
    r"\b(" + "|".join(sorted(MONTHS.keys(), key=len, reverse=True)) + r")\b\s*(\d{4})?",
    _re.IGNORECASE,
)


# Categories used for analytics breakdown. Order of the checks below matters:
# heating must win over water for "vee soojendamine" (water heating), etc.
_LINE_ITEM_CATEGORIES: list[tuple[str, list[str]]] = [
    ("heating",     ["soojendamine", "küte", "soojus", "kaugküte"]),
    ("electricity", ["elektri", "elekter", "võrgu", "aktsiis", "taastuvenergia",
                     "energiatõhusus", "üldelekter", "üldelecter", "öine", "päevane",
                     "öötariif", "reaktiiv", "võimsus", "universaalteenus",
                     "bilansienergia"]),
    ("gas",         ["maagaas", "gaas"]),
    ("water",       ["vesi", " vee ", "kanalisatsioon", "üldvesi", "reovesi",
                     "sademevesi", "ühisveevärk", "äravool"]),
    ("waste",       ["prügi", "jäätme", "olmejäätmed", "biojäätmed", "pakend"]),
    ("telecom",     ["internet", "lairiba", "telefon", "mobiilside",
                     "televisioon", "kaabeltv", "kaabel"]),
    ("management",  ["haldus", "raamatupidamis", "raamatupidamine", "tehnosüsteem", "hooldus",
                     "koristus", "valve", "lift", "remondi", "remont",
                     "porivaip", "üldkulud", "majanduskulud", "halduskulud",
                     "fond", "renditeenus", "parkla", "garaaž"]),
]


def classify_line_item(description_et: str) -> str:
    """Map an Estonian line-item description to a utility category.

    Used for per-line-item analytics on korteriühistu bills, which bundle
    electricity, water, heating, waste collection and building management
    into a single invoice.
    """
    if not description_et:
        return "other"
    # Strip meter-reading suffix first so digits don't distract
    d = _METER_SUFFIX.sub("", description_et).lower().strip()
    # Pad with spaces so " vee " keyword can match word-boundary without regex
    padded = f" {d} "
    for category, keywords in _LINE_ITEM_CATEGORIES:
        if any(k in padded for k in keywords):
            return category
    return "other"


def translate_month_name(text: str) -> str | None:
    """Return the English name of an Estonian month word, or None."""
    key = text.strip().lower()
    if key in MONTHS:
        return MONTHS[key][0]
    if key in MONTH_ABBR:
        return MONTH_ABBR[key][0]
    return None


def month_number(text: str) -> int | None:
    """Return the month number 1-12 for an Estonian month name."""
    key = text.strip().lower()
    if key in MONTHS:
        return MONTHS[key][1]
    if key in MONTH_ABBR:
        return MONTH_ABBR[key][1]
    return None


def translate_period(text: str) -> str:
    """
    Replace every Estonian month word in `text` with its English equivalent.
    Preserves casing style ("Veebruar 2026" → "February 2026",
    "veebruar" → "february", "VEEBRUAR" → "FEBRUARY").
    """
    if not text:
        return text

    def _sub(match: _re.Match) -> str:
        word = match.group(1)
        year = match.group(2) or ""
        en = translate_month_name(word) or word
        # Preserve original casing
        if word.isupper():
            en = en.upper()
        elif word.islower():
            en = en.lower()
        return f"{en}{' ' + year if year else ''}"

    return _PERIOD_PATTERN.sub(_sub, text)


def translate_weekday(text: str) -> str | None:
    """Return the English weekday for an Estonian weekday name, or None."""
    return WEEKDAYS.get(text.strip().lower())


def translate_term(term: str) -> str:
    """Look up an Estonian term and return its English translation.
    Strips embedded meter-reading suffixes before lookup and also
    translates Estonian month names anywhere in the string.
    """
    raw = term.strip()
    meter_note = ""
    m = _METER_SUFFIX.search(raw)
    if m:
        nums = _re.findall(r"[\d,\.]+", m.group())
        if len(nums) >= 2:
            meter_note = f" [Start: {nums[0]}, End: {nums[1]}]"
        raw = raw[: m.start()].strip()

    # Translate any month words present in the raw text
    raw_translated_months = translate_period(raw)

    key = raw.lower()
    if key in GLOSSARY:
        return GLOSSARY[key] + meter_note

    # Direct month match (e.g. "Veebruar 2026")
    if _PERIOD_PATTERN.fullmatch(raw):
        return raw_translated_months + meter_note

    # Try partial match: find longest matching key that is a substring
    best = ""
    best_val = ""
    for k, v in GLOSSARY.items():
        if k in key and len(k) > len(best):
            best, best_val = k, v

    base = best_val if best_val else raw_translated_months.title() if raw_translated_months != raw else raw.title()
    return base + meter_note


def translate_line_items(raw_items: list[dict]) -> list[dict]:
    """
    Add `description_en` to each line item.

    Two paths, in priority order:

    1. **Trust AI-provided translations.** When the parser is an LLM
       (Claude / FreeLLMAPI / BYOK), it returns BOTH `description_et`
       (the raw original-language description) and `description_en`
       (its English translation). For non-Estonian bills — Spanish,
       German, Italian, anything outside the local glossary — the AI
       is the only thing that can produce a sensible English label.
       If we always overwrote `description_en` with `translate_term`,
       those bills would get title-cased original text in the English
       column ("Electricidad Consumida" instead of "Electricity used")
       because the Estonian glossary has no entries for those
       languages and `translate_term` falls through to `raw.title()`.

       So: if the AI gave us a non-empty `description_en` that isn't
       just an echo of `description_et`, we keep it as-is.

    2. **Glossary fallback.** When the parser is local Tesseract OCR
       (no AI involved) `description_en` is blank, so we run the
       Estonian-specific `translate_term` to look up the curated
       hardcoded translations. The same path also covers AI responses
       where the LLM skipped the field or just echoed the source.
    """
    result = []
    for item in raw_items:
        et = str(item.get("description_et") or item.get("description") or "").strip()
        ai_en = str(item.get("description_en") or "").strip()
        if et and ai_en and ai_en.casefold() != et.casefold():
            # Real AI translation — keep it.
            en = ai_en
        else:
            en = translate_term(et) if et else ""
        result.append({**item, "description_et": et, "description_en": en})
    return result


def build_glossary(line_items: list[dict], extra_terms: list[str] | None = None) -> dict[str, str]:
    """
    Build a glossary dict from the line items that appear in this bill,
    plus any extra Estonian terms found in the raw text.
    """
    seen = {}
    for item in line_items:
        et = str(item.get("description_et") or "").strip()
        if et:
            en = translate_term(et)
            if en.lower() != et.lower():  # only include when we have a real translation
                seen[et] = en
    if extra_terms:
        for t in extra_terms:
            t = t.strip()
            if t:
                en = translate_term(t)
                if en.lower() != t.lower():
                    seen[t] = en
    return seen


def generate_summary(parsed: dict) -> str:
    """
    Build a plain-English summary from structured bill fields.
    Handles both single-utility bills (Eesti Energia) and multi-service
    housing association (korteriühistu) bills.
    """
    provider = parsed.get("provider") or "Unknown provider"
    utype = UTILITY_LABELS.get(parsed.get("utility_type") or "", "building services")
    amount = parsed.get("amount_eur")
    period_start = parsed.get("period_start")
    period_end = parsed.get("period_end")
    bill_date = parsed.get("bill_date")
    consumption_kwh = parsed.get("consumption_kwh")
    consumption_m3 = parsed.get("consumption_m3")
    due_date = parsed.get("due_date")
    line_items: list[dict] = parsed.get("line_items") or []

    parts: list[str] = []
    amount_str = f"€{amount:.2f}" if amount is not None else "an unknown amount"
    is_housing = "korteriühistu" in provider.lower()

    # Core sentence
    if is_housing:
        period = f" for {period_start} to {period_end}" if period_start and period_end else ""
        parts.append(
            f"Housing association invoice{period} totalling {amount_str}. "
            f"Covers building management, maintenance, cleaning, utilities, and renovation fund."
        )
    elif period_start and period_end:
        parts.append(f"{provider} charged {amount_str} for {utype} covering {period_start} to {period_end}.")
    elif bill_date:
        parts.append(f"{provider} issued a {utype} bill for {amount_str} on {bill_date}.")
    else:
        parts.append(f"{provider} issued a {utype} bill for {amount_str}.")

    # Consumption detail
    if consumption_kwh is not None:
        parts.append(f"Total electricity consumption: {consumption_kwh:g} kWh.")
    elif consumption_m3 is not None:
        parts.append(f"Total consumption: {consumption_m3:g} m³.")

    # For housing bills, summarise service categories found in line items
    if is_housing and line_items:
        categories = {li.get("description_en", "") for li in line_items if li.get("description_en")}
        if categories:
            cat_list = ", ".join(sorted(categories)[:6])
            parts.append(f"Services billed: {cat_list}.")

    # Due date
    if due_date:
        parts.append(f"Payment is due by {due_date}.")

    return " ".join(parts)


def _normalize_scalar(value):
    """Coerce a documented-scalar field that the AI returned as a dict
    or a list into a renderable string. Multi-tariff bills tempt LLMs
    into returning structured meter readings like
    ``{"electricity_day": 9494, "electricity_night": 7283}`` for a
    field the schema documents as a single number — and the frontend
    crashes (React error #31) when fed that object directly. Flatten
    to ``"electricity_day: 9494, electricity_night: 7283"`` so the
    information survives without breaking the UI.

    Empty containers collapse to ``None`` so the frontend's
    truthy-check still skips the row instead of rendering an empty
    label.
    """
    if isinstance(value, dict):
        parts = [f"{k}: {v}" for k, v in value.items() if v is not None]
        return ", ".join(parts) if parts else None
    if isinstance(value, list):
        parts = [str(x) for x in value if x is not None]
        return ", ".join(parts) if parts else None
    return value


# Fields documented in the extraction prompt as scalar (string or
# numeric). Anything an LLM returns that's a dict / list on these
# names is by definition a schema violation we want to repair.
_SCALAR_FIELDS = (
    "provider",
    "utility_type",
    "amount_eur",
    "consumption_kwh",
    "consumption_m3",
    "bill_date",
    "period_start",
    "period_end",
    "period",
    "account_number",
    "address",
    "vat_amount",
    "amount_without_vat",
    "meter_reading_start",
    "meter_reading_end",
    "due_date",
    "confidence",
)


def enrich_parsed(parsed: dict) -> dict:
    """
    Take the raw dict from Claude (extraction only) and add all
    translation fields without any API call.
    """
    # Defend against AI parsers that return a dict or list for fields
    # the schema documents as scalar — see `_normalize_scalar`. We
    # mutate a copy so the caller's dict isn't surprised by the
    # rewrite.
    parsed = {
        k: _normalize_scalar(v) if k in _SCALAR_FIELDS else v
        for k, v in parsed.items()
    }
    # Translate line items
    raw_items = parsed.get("line_items") or []
    translated_items = translate_line_items(raw_items)

    # Build glossary from those items
    glossary = build_glossary(translated_items)

    # Add provider description if we recognise the provider
    provider_raw = (parsed.get("provider") or "").lower()
    for key, desc in PROVIDERS.items():
        if key in provider_raw:
            glossary[parsed.get("provider", key)] = desc
            break

    # Translate Estonian month words in the period field (if any)
    period_et = parsed.get("period")
    period_en = translate_period(period_et) if period_et else None

    # If Claude only returned "Veebruar 2026" as period without start/end dates,
    # derive ISO start/end dates from the month name + year
    pstart = parsed.get("period_start")
    pend = parsed.get("period_end")
    if not pstart and not pend and period_et:
        m = _PERIOD_PATTERN.search(period_et)
        if m and m.group(2):
            month_num = month_number(m.group(1))
            year = int(m.group(2))
            if month_num:
                import calendar
                last_day = calendar.monthrange(year, month_num)[1]
                pstart = f"{year:04d}-{month_num:02d}-01"
                pend = f"{year:04d}-{month_num:02d}-{last_day:02d}"

    # Add any Estonian month words we actually saw to the glossary
    haystack = " ".join([
        str(parsed.get("period") or ""),
        str(parsed.get("bill_date") or ""),
        " ".join(str(li.get("description_et") or "") for li in translated_items),
    ]).lower()
    for estonian_month, (english, _) in MONTHS.items():
        if estonian_month in haystack:
            glossary[estonian_month.capitalize()] = english

    # Generate English summary (uses possibly-derived dates)
    parsed_for_summary = {**parsed, "period_start": pstart, "period_end": pend}
    summary = generate_summary(parsed_for_summary)

    return {
        **parsed,
        "period_start": pstart,
        "period_end": pend,
        "period_en": period_en,
        "line_items": translated_items,
        "glossary": glossary,
        "translated_summary": summary,
    }

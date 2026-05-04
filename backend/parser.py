"""
Open-source bill parser — no API calls.

Pipeline:
1. OCR the image with Tesseract using the Estonian language pack (or pdfplumber
   for native-text PDFs).
2. Run regex patterns to pull out header fields (invoice no., dates, totals).
3. Parse the line-items table using column positions detected by Tesseract.
4. Classify utility_type from keywords.

Works well for the common korteriühistu invoice format and degrades
gracefully for other Estonian utility bills.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

import pytesseract
from PIL import Image

# ── Helpers ────────────────────────────────────────────────────────────────

def _num(s: str) -> float | None:
    """Convert Estonian number format ('1 234,56' or '1.234,56' or '123.45') to float."""
    if s is None:
        return None
    s = s.strip().replace(" ", "").replace(" ", "")
    # Replace comma decimal with dot, but keep thousands separators correct
    # e.g. "1.234,56" -> "1234.56", "123,45" -> "123.45", "123.45" -> "123.45"
    if "," in s and "." in s:
        # Assume '.' is thousands sep, ',' is decimal
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _est_date(s: str) -> str | None:
    """Parse a date like 13.04.2026 or 2026-04-13 into ISO YYYY-MM-DD."""
    if not s:
        return None
    s = s.strip()
    # dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy
    m = re.match(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})", s)
    if m:
        d, mo, y = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    # yyyy-mm-dd already
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return s[:10]
    return None


# ── OCR layer ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ExtractedText:
    text: str
    boxes: list[dict]
    source: str
    confidence: str

def ocr_image(path: str) -> tuple[str, list[dict]]:
    """Return (full_text, word_boxes). word_boxes is a list of
    {text, left, top, width, height, conf, line_num, block_num, par_num}."""
    img = Image.open(path)
    # Convert for consistent OCR
    if img.mode != "RGB":
        img = img.convert("RGB")
    config = "--oem 3 --psm 6"    # assume a uniform block of text
    text = pytesseract.image_to_string(img, lang="est+eng", config=config)
    data = pytesseract.image_to_data(img, lang="est+eng", config=config,
                                     output_type=pytesseract.Output.DICT)
    boxes: list[dict] = []
    n = len(data["text"])
    for i in range(n):
        t = (data["text"][i] or "").strip()
        if not t:
            continue
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1
        boxes.append({
            "text": t,
            "left": int(data["left"][i]),
            "top": int(data["top"][i]),
            "width": int(data["width"][i]),
            "height": int(data["height"][i]),
            "conf": conf,
            "line_num": int(data["line_num"][i]),
            "block_num": int(data["block_num"][i]),
            "par_num": int(data["par_num"][i]),
        })
    return text, boxes


def _pdf_to_image(path: str) -> str:
    """If given a PDF, render the first page to a temporary PNG and return its path."""
    from pdf2image import convert_from_path
    pages = convert_from_path(path, dpi=200, first_page=1, last_page=1)
    tmp = path + ".page1.png"
    pages[0].save(tmp, "PNG")
    return tmp


def pdf_native_words(path: str) -> tuple[str, list[dict]]:
    """Extract words + bounding boxes from a native-text PDF using pdfplumber.
    Returns (full_text, word_boxes) in the same shape as ocr_image().
    If the PDF has no extractable text (scanned), returns ('', [])."""
    import pdfplumber
    boxes: list[dict] = []
    all_text: list[str] = []
    with pdfplumber.open(path) as pdf:
        if not pdf.pages:
            return "", []
        for page_num, page in enumerate(pdf.pages[:1]):  # first page only (like OCR path)
            words = page.extract_words(
                x_tolerance=2,
                y_tolerance=3,
                keep_blank_chars=False,
                use_text_flow=True,
            )
            if not words:
                return "", []
            # Build synthetic line numbers by grouping words with similar y
            # coordinates (within 4px). Sort top-to-bottom, then left-to-right.
            words.sort(key=lambda w: (round(float(w["top"]) / 4), float(w["x0"])))
            current_line = -10
            line_num = 0
            for w in words:
                top = float(w["top"])
                if top - current_line > 4:
                    line_num += 1
                    current_line = top
                boxes.append({
                    "text": w["text"],
                    "left": int(w["x0"]),
                    "top": int(w["top"]),
                    "width": int(w["x1"] - w["x0"]),
                    "height": int(w["bottom"] - w["top"]),
                    "conf": 100.0,          # native text = perfect confidence
                    "line_num": line_num,
                    "block_num": 1,
                    "par_num": 1,
                })
            all_text.append(page.extract_text() or "")
    return "\n".join(all_text), boxes


def extract_bill_text(path: str) -> ExtractedText:
    """Extract invoice text once, choosing native PDF text before OCR."""
    source = "tesseract"
    confidence = "medium"

    if path.lower().endswith(".pdf"):
        # 1. Try native-text extraction first (most utility bills are vector PDFs)
        try:
            text, boxes = pdf_native_words(path)
        except Exception:
            text, boxes = "", []

        if len(text) > 80 and len(boxes) > 20:
            # Native text is available — use it directly, no OCR needed
            return ExtractedText(text=text, boxes=boxes, source="pdfplumber", confidence="high")

        # Scanned PDF: rasterize then OCR
        img_path = _pdf_to_image(path)
        try:
            text, boxes = ocr_image(img_path)
        finally:
            try:
                os.remove(img_path)
            except OSError:
                pass
        return ExtractedText(text=text, boxes=boxes, source=source, confidence=confidence)

    text, boxes = ocr_image(path)
    return ExtractedText(text=text, boxes=boxes, source=source, confidence=confidence)


# ── Field extractors ───────────────────────────────────────────────────────

_PATTERNS = {
    "account_number": re.compile(r"Arve\s*nr\S*\s*[\s:\-—–]*\s*(\d+)", re.IGNORECASE),
    "bill_date":      re.compile(r"Kuup[äa]ev\s*[:=\-—–]?\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})", re.IGNORECASE),
    "due_date":       re.compile(r"T[äa]htaeg\s*[:=\-—–]?\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})", re.IGNORECASE),
    "reference":      re.compile(r"Viitenumber\s*:?\s*(\d+)", re.IGNORECASE),
    "period":         re.compile(r"Periood\s*:?\s*([A-Za-zÄÖÜÕäöüõ]+(?:\s+\d{4})?)", re.IGNORECASE),
    "net_area":       re.compile(r"Neto\s*pind\s*:?\s*([\d,.]+)\s*m[²2]?", re.IGNORECASE),
    "total":          re.compile(r"Tasumisele\s*kuulub\s*(?:EUR)?\s*:?\s*([\d\s,.]+)", re.IGNORECASE),
    "total_kokku":    re.compile(r"\bKokku\b\s*:?\s*([\d\s,.]+)", re.IGNORECASE),
    "iban":           re.compile(r"IBAN\s*:?\s*([A-Z]{2}\d[\d\s]+)", re.IGNORECASE),
}


def extract_header(text: str) -> dict:
    """Pull header fields from the raw OCR text."""
    out: dict = {}

    # Provider (usually the first non-empty line, uppercase, may contain KORTERIÜHISTU)
    for line in text.splitlines():
        clean = line.strip()
        if clean and len(clean) > 4:
            out["provider"] = clean
            break

    for key, pat in _PATTERNS.items():
        m = pat.search(text)
        if not m:
            continue
        val = m.group(1).strip()
        if key == "bill_date":
            out["bill_date"] = _est_date(val)
        elif key == "due_date":
            out["due_date"] = _est_date(val)
        elif key == "total":
            out["amount_eur"] = _num(val)
        elif key == "total_kokku":
            # Only use as fallback if we didn't find the explicit "Tasumisele kuulub"
            out.setdefault("amount_eur", _num(val))
        elif key == "net_area":
            out["net_area_m2"] = _num(val)
        elif key == "period":
            # Sometimes the regex picks up just the month — check if a year follows
            remainder = text[m.end(): m.end() + 20]
            yr = re.match(r"\s*(\d{4})", remainder)
            if yr and str(yr.group(1)) not in val:
                val = f"{val} {yr.group(1)}"
            out["period"] = val
        else:
            out[key] = val
    return out


# ── Line items table ───────────────────────────────────────────────────────

# Column headers we expect in the table (Estonian). We locate these on the
# page and then classify each subsequent word by which column it falls under.
_TABLE_HEADERS = ["Kirjeldus", "Ühik", "Kogus", "Hind", "Summa"]


def extract_line_items(boxes: list[dict]) -> list[dict]:
    """Parse the line-items table using column x-positions from Tesseract."""
    # 1. Find the header row
    header_pos: dict[str, int] = {}
    header_top: int | None = None
    for b in boxes:
        if b["text"] in _TABLE_HEADERS and b["text"] not in header_pos:
            header_pos[b["text"]] = b["left"]
            if header_top is None or b["top"] < header_top + 5:
                header_top = min(header_top or b["top"], b["top"])
    if len(header_pos) < 3 or header_top is None:
        return []

    # 2. Collect all words below the header row and group them into rows
    #    by line_num within each block.
    body = [b for b in boxes if b["top"] > header_top + 5]
    # Group by visual line (same line_num within block)
    rows_raw: dict[tuple[int, int], list[dict]] = {}
    for b in body:
        key = (b["block_num"], b["par_num"], b["line_num"])
        rows_raw.setdefault(key, []).append(b)

    # Column boundaries. For the description column (Kirjeldus), we use the
    # LEFT edge of the next header so that long free-text rows (like
    # "Elekter päevane Alg: 9644 Löpp: 9726") stay together. For numeric
    # columns we use midpoints so they cleanly split short values.
    col_starts = sorted(header_pos.items(), key=lambda kv: kv[1])
    col_names = [c for c, _ in col_starts]
    boundaries: list[int] = []
    for i, (name, x) in enumerate(col_starts[:-1]):
        nxt = col_starts[i + 1][1]
        if name == "Kirjeldus":
            boundaries.append(nxt - 5)            # extend description right up to next header
        else:
            boundaries.append((x + nxt) // 2)     # midpoint for numeric columns
    def _column_for(x: int) -> str:
        for i, b in enumerate(boundaries):
            if x < b:
                return col_names[i]
        return col_names[-1]

    items: list[dict] = []
    for key, words in sorted(rows_raw.items()):
        words.sort(key=lambda w: w["left"])
        row: dict[str, list[str]] = {c: [] for c in col_names}
        for w in words:
            row[_column_for(w["left"])].append(w["text"])
        desc_parts = row.get("Kirjeldus", [])
        if not desc_parts:
            continue
        desc = " ".join(desc_parts).strip()
        # Filter out obvious footer rows and section headers
        if not desc:
            continue
        low = desc.lower()
        if any(k in low for k in ["kokku", "tasumisele", "viimase laekumise",
                                   "viimased teatatud", "tel.", "e-mail", "iban",
                                   "reg.", "reg nr", "konto"]):
            # Stop reading once we hit the totals section
            break

        unit = " ".join(row.get("Ühik", [])).strip() or None
        qty = _num(" ".join(row.get("Kogus", [])))
        price = _num(" ".join(row.get("Hind", [])))
        amount = _num(" ".join(row.get("Summa", [])))

        if amount is None and qty is None and price is None:
            continue  # skip pure noise rows

        items.append({
            "description_et": desc,
            "amount_eur": amount,
            "quantity": qty,
            "unit": unit,
            "price_per_unit": price,
        })
    return items


# ── Utility-type classifier ────────────────────────────────────────────────

_TYPE_KEYWORDS = {
    "electricity": ["elektrienergia", "elekter päevane", "elekter öine"],
    "gas":         ["maagaas", "gaasivõrk", "gaasienergia"],
    "water":       ["külm vesi", "soe vesi", "kanalisatsioon", "ühisveevärk"],
    "heating":     ["kaugküte", "soojusenergia"],
    "internet":    ["internetiteenus", "lairiba", "kaabel"],
    "waste":       ["jäätmevedu", "prügivedu"],
}


def classify(provider: str, line_items: list[dict]) -> str:
    provider_low = (provider or "").lower()
    if "korteriühistu" in provider_low or "korteriuhistu" in provider_low:
        return "other"  # housing association covers everything
    all_text = " ".join([i.get("description_et") or "" for i in line_items]).lower()
    scores: dict[str, int] = {}
    for utype, kws in _TYPE_KEYWORDS.items():
        scores[utype] = sum(1 for kw in kws if kw in all_text)
    if not scores or max(scores.values()) == 0:
        return "other"
    return max(scores, key=scores.get)


# ── Consumption totals ─────────────────────────────────────────────────────

def totals_from_line_items(items: list[dict]) -> tuple[float | None, float | None]:
    kwh = 0.0
    m3 = 0.0
    any_kwh = any_m3 = False
    for it in items:
        u = (it.get("unit") or "").lower()
        q = it.get("quantity")
        if q is None:
            continue
        if "kwh" in u:
            kwh += q
            any_kwh = True
        elif "m3" in u or "m³" in u:
            m3 += q
            any_m3 = True
    return (kwh if any_kwh else None, m3 if any_m3 else None)


# ── Entry point ────────────────────────────────────────────────────────────

def parse_bill(path: str) -> dict:
    """Full open-source extraction pipeline. Returns the same dict shape
    that the Claude-based parser used to return.

    Strategy:
      PDF (native text)   → pdfplumber words   → high confidence
      PDF (scanned)       → pdf2image + OCR    → medium confidence
      Image (png/jpg/etc) → Tesseract OCR      → medium confidence
    """
    extracted = extract_bill_text(path)
    text = extracted.text
    boxes = extracted.boxes

    header = extract_header(text)
    line_items = extract_line_items(boxes)

    kwh, m3 = totals_from_line_items(line_items)

    # Flag poor extraction: no line items and fewer than 3 useful header fields.
    # This typically means the invoice layout doesn't match the Estonian-specific
    # regex patterns, and the user should switch to Claude for better results.
    meaningful_fields = sum(
        1 for k, v in header.items()
        if v is not None and v != "" and k not in ("_source",)
    )
    _low_quality = len(line_items) == 0 and meaningful_fields < 3

    return {
        **header,
        "utility_type": classify(header.get("provider", ""), line_items),
        "line_items": line_items,
        "consumption_kwh": kwh,
        "consumption_m3": m3,
        "confidence": extracted.confidence,
        "_source": extracted.source,
        "_low_quality": _low_quality,
    }

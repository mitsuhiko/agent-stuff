# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "beautifulsoup4", "lxml"]
# ///
"""
book_fetch — search and download books from Library Genesis mirrors.

Mirror discovery via open-slum.org (Shadow Library Uptime Monitor).
Downloads via LibGen's ads.php → get.php pipeline.

⚠️  RESEARCH & PERSONAL USE ONLY
This tool is intended for academic research, personal study, and accessing
public domain or openly licensed materials.  Many books available through
shadow libraries are copyrighted.  Users are responsible for complying with
the copyright laws of their jurisdiction.  Please support authors by
purchasing books you find valuable.
"""

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Sanitisation — book metadata comes from untrusted HTML and could contain
# adversarial strings designed to trick an LLM that reads the JSON output.
# We strip anything that looks like prompt-injection attempts.
# ---------------------------------------------------------------------------

# Patterns that should never appear in book metadata
_INJECTION_PATTERNS = re.compile(
    r"<\|.*?\|>"          # common LLM control tokens
    r"|```"               # markdown code fences
    r"|</?system>"        # system tags
    r"|</?user>"
    r"|</?assistant>"
    r"|</?human>"
    r"|</?tool>"
    r"|\[INST\]"          # Llama-style markers
    r"|\[/INST\]"
    r"|<<SYS>>",
    re.IGNORECASE,
)


def _sanitize(text: str) -> str:
    """Remove control characters and prompt-injection markers from metadata."""
    # Strip ASCII control chars except space/newline
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    # Strip injection patterns
    text = _INJECTION_PATTERNS.sub("", text)
    # Collapse excessive whitespace
    text = re.sub(r"\s{3,}", "  ", text).strip()
    return text


def _clean_title(title: str) -> str:
    """Strip ISBNs, LibGen internal IDs, and other noise from book titles."""
    # Remove ISBN-like sequences (10 or 13 digits, optionally with hyphens/semicolons)
    title = re.sub(r"\b\d{9,13}[0-9X]\b", "", title)
    # Remove "b l 1234567" style LibGen internal IDs
    title = re.sub(r"\bb\s+l\s+\d+\b", "", title)
    # Remove bare semicolons left behind after ISBN removal
    title = re.sub(r"\s*;\s*", " ", title)
    # Remove "rep a 12345" patterns
    title = re.sub(r"\brep\s+a\s+\d+\b", "", title, flags=re.I)
    # Collapse whitespace
    title = re.sub(r"\s{2,}", " ", title).strip()
    # Strip trailing punctuation noise
    title = title.rstrip(" ;,.-")
    return title


# ---------------------------------------------------------------------------
# Mirror discovery
# ---------------------------------------------------------------------------

# SLUM endpoints (primary + unofficial Cloudflare Pages mirror)
SLUM_URLS = [
    "https://open-slum.org/",
    "https://open-slum.pages.dev/",
]

# Hardcoded fallback — update these if mirrors go stale
FALLBACK_LIBGEN_MIRRORS = [
    "https://libgen.li",
    "https://libgen.bz",
    "https://libgen.la",
    "https://libgen.gl",
    "https://libgen.vg",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def discover_mirrors(client: httpx.Client) -> list[str]:
    """Scrape open-slum.org for current LibGen mirror URLs.

    The mirror list is embedded in the static HTML — no JS rendering needed.
    Falls back to a hardcoded list if SLUM is unreachable.
    """
    for slum_url in SLUM_URLS:
        try:
            resp = client.get(slum_url, follow_redirects=True, timeout=10)
            if resp.status_code != 200:
                continue

            # Extract libgen.* URLs from page source
            found = re.findall(r"https?://libgen\.[a-z]{2,4}/?", resp.text)
            mirrors = sorted(set(u.rstrip("/") for u in found))
            if mirrors:
                return mirrors
        except Exception:
            continue

    return list(FALLBACK_LIBGEN_MIRRORS)


def probe_mirrors(client: httpx.Client, mirrors: list[str]) -> list[dict]:
    """Probe each mirror and return status info."""
    results = []
    for mirror in mirrors:
        entry = {"url": mirror, "status": "unknown"}
        try:
            resp = client.head(mirror, follow_redirects=True, timeout=8)
            entry["status"] = "up" if resp.status_code == 200 else f"http_{resp.status_code}"
        except httpx.TimeoutException:
            entry["status"] = "timeout"
        except Exception as e:
            entry["status"] = f"error: {type(e).__name__}"
        results.append(entry)
    return results


def find_working_mirror(client: httpx.Client, mirrors: list[str]) -> str | None:
    """Return the first mirror that responds with HTTP 200."""
    for mirror in mirrors:
        try:
            resp = client.head(mirror, follow_redirects=True, timeout=8)
            if resp.status_code == 200:
                return mirror
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

# LibGen index.php table columns (verified March 2026 across all mirrors):
#   [0] ID / Title / Series
#   [1] Author(s)
#   [2] Publisher
#   [3] Year
#   [4] Language
#   [5] Pages
#   [6] Size
#   [7] Extension
#   [8] Mirrors (links)

COLUMN_MAP = {
    "title": "def",
    "def": "def",
    "author": "author",
    "isbn": "identifier",
    "identifier": "identifier",
}


@dataclass
class BookResult:
    title: str
    authors: str
    year: str = ""
    extension: str = ""
    size: str = ""
    language: str = ""
    md5: str = ""
    mirrors: list[str] = field(default_factory=list)


def search(
    client: httpx.Client,
    base_url: str,
    query: str,
    column: str = "def",
    ext: str = "",
    max_results: int = 25,
) -> list[BookResult]:
    """Search a LibGen mirror. Returns structured results."""
    params: dict = {
        "req": query,
        "columns[]": ["t", "a"],
        "objects[]": ["f"],
        "topics[]": ["l"],
        "res": str(min(max_results, 100)),
    }

    resp = client.get(
        f"{base_url}/index.php",
        params=params,
        follow_redirects=True,
        timeout=30,
    )
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "lxml")
    results: list[BookResult] = []

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) < 3:
            continue
        if "Author" not in rows[0].get_text(strip=True):
            continue

        for row in rows[1:]:
            cells = row.find_all("td")
            if len(cells) < 9:
                continue

            try:
                book = BookResult(
                    title=_clean_title(_sanitize(cells[0].get_text(separator=" ", strip=True)[:300])),
                    authors=_sanitize(cells[1].get_text(separator=", ", strip=True)[:200]),
                    year=_sanitize(cells[3].get_text(strip=True)[:10]),
                    language=_sanitize(cells[4].get_text(strip=True)[:30]),
                    size=_sanitize(cells[6].get_text(strip=True)[:20]),
                    extension=_sanitize(cells[7].get_text(strip=True)[:10]).lower(),
                )

                # Extract MD5 and mirror links
                for a_tag in row.find_all("a", href=True):
                    href = a_tag["href"]
                    m = re.search(r"md5=([a-fA-F0-9]{32})", href, re.I)
                    if m and not book.md5:
                        book.md5 = m.group(1)
                    if any(kw in href for kw in ["ads.php", "get.php", "md5"]):
                        full = urljoin(base_url, href) if not href.startswith("http") else href
                        if full not in book.mirrors:
                            book.mirrors.append(full)

                if book.title and len(book.title) > 3 and book.md5:
                    # Apply extension filter if requested
                    if ext and book.extension != ext.lower():
                        continue
                    results.append(book)
            except (IndexError, AttributeError):
                continue

    return results


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def resolve_download_url(client: httpx.Client, base_url: str, md5: str) -> str | None:
    """Resolve an MD5 to a direct download URL via ads.php → get.php."""
    ads_url = f"{base_url}/ads.php?md5={md5}"
    try:
        resp = client.get(ads_url, follow_redirects=True, timeout=20)
        if resp.status_code != 200:
            return None

        soup = BeautifulSoup(resp.text, "lxml")
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            if "get.php" in href or "/get/" in href:
                return urljoin(f"{base_url}/", href)
    except Exception:
        pass
    return None


def download_file(
    client: httpx.Client,
    url: str,
    output_dir: Path,
    filename: str | None = None,
) -> Path | None:
    """Download a file from a direct URL."""
    resp = client.get(url, follow_redirects=True, timeout=300)
    resp.raise_for_status()

    content_type = resp.headers.get("content-type", "")
    if "html" in content_type and len(resp.content) < 50_000:
        # Got an error page instead of a file
        return None

    if not filename:
        cd = resp.headers.get("content-disposition", "")
        m = re.search(r'filename="?([^";\n]+)"?', cd)
        if m:
            filename = m.group(1).strip()
        else:
            filename = url.split("/")[-1].split("?")[0]
            if not filename or "." not in filename:
                filename = f"{resp.url.path.split('/')[-1] or 'book'}.pdf"

    filename = re.sub(r'[<>:"/\\|?*]', "_", filename)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / filename
    output_path.write_bytes(resp.content)
    return output_path


def download_by_md5(
    client: httpx.Client,
    mirrors: list[str],
    md5: str,
    output_dir: Path,
    filename: str | None = None,
) -> Path | None:
    """Try downloading a book by MD5, cycling through mirrors."""
    for mirror in mirrors:
        dl_url = resolve_download_url(client, mirror, md5)
        if not dl_url:
            continue
        try:
            path = download_file(client, dl_url, output_dir, filename)
            if path:
                return path
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# "grab" — search + pick best + download
# ---------------------------------------------------------------------------

# Size thresholds for scoring.  Books under 100 KB are almost certainly not
# real books (stubs, spam listings).  Books over 50 MB are usually raw page
# scans — still functional but slow to download and awkward to read.  The
# sweet spot is roughly 200 KB – 20 MB for a proper text-based PDF/EPUB.
_MIN_BYTES = 100 * 1024        # 100 KB
_IDEAL_MAX_BYTES = 50 * 1024**2  # 50 MB — above this we penalise


def _size_bytes(size_str: str) -> int:
    """Parse '3 MB' or '154 kB' to approximate bytes."""
    m = re.search(r"([\d.]+)\s*(kB|MB|GB)", size_str, re.I)
    if not m:
        return 0
    val = float(m.group(1))
    unit = m.group(2).lower()
    return int(val * {"kb": 1024, "mb": 1024**2, "gb": 1024**3}[unit])


def pick_best(results: list[BookResult], preferred_ext: str = "pdf") -> BookResult | None:
    """Pick the best result with these priorities:

    1. Correct file extension (pdf/epub as requested)
    2. English language
    3. Reasonable file size — not tiny (stubs) and not huge (scanned pages)

    The size scoring prefers the 200 KB – 20 MB range.  Files above 50 MB
    get a heavy penalty (likely scanned page images).
    """
    if not results:
        return None

    def score(r: BookResult) -> tuple:
        ext_match = 1 if r.extension == preferred_ext else 0
        is_english = 1 if r.language.lower().startswith("en") else 0
        size = _size_bytes(r.size)

        # Reject tiny files
        if size < _MIN_BYTES:
            return (0, 0, 0, 0)

        # Size score: penalise huge scanned-page PDFs, prefer the
        # ideal range.  Within the ideal range prefer *larger* files
        # because they're more likely to be the complete book rather
        # than a summary or stub.
        # 0 = terrible, 1 = fine, 2 = ideal sweet-spot
        if size <= 20 * 1024**2:         # ≤ 20 MB — ideal range
            size_score = 2
        elif size <= _IDEAL_MAX_BYTES:    # 20–50 MB — acceptable
            size_score = 1
        else:                             # > 50 MB — probably scanned pages
            size_score = 0

        return (ext_match, is_english, size_score, size)

    ranked = sorted(results, key=score, reverse=True)
    best = ranked[0]
    if score(best)[:3] == (0, 0, 0):
        return None
    return best


def grab(
    client: httpx.Client,
    mirrors: list[str],
    query: str,
    ext: str = "pdf",
    output_dir: Path = Path("~/Downloads/books").expanduser(),
) -> dict:
    """Search and download the best match. Returns status dict."""
    base_url = find_working_mirror(client, mirrors)
    if not base_url:
        return {"ok": False, "error": "No working LibGen mirror found"}

    results = search(client, base_url, query, ext=ext)
    if not results:
        # Retry without extension filter
        results = search(client, base_url, query)

    # LibGen search chokes on long queries — progressively shorten by
    # dropping trailing words until we get results or run out of words.
    words = query.split()
    while not results and len(words) > 2:
        words = words[:-1]
        shorter = " ".join(words)
        results = search(client, base_url, shorter, ext=ext)
        if not results:
            results = search(client, base_url, shorter)

    if not results:
        return {"ok": False, "error": f"No results for: {query}"}

    best = pick_best(results, preferred_ext=ext)
    if not best:
        return {
            "ok": False,
            "error": "Results found but all too small (likely not real books)",
            "results": [asdict(r) for r in results[:5]],
        }

    safe_title = re.sub(r"[^a-zA-Z0-9 _-]", "", best.title[:80]).strip().replace(" ", "_")
    filename = f"{safe_title}.{best.extension}"

    path = download_by_md5(client, mirrors, best.md5, output_dir, filename)
    if path:
        return {
            "ok": True,
            "path": str(path),
            "title": best.title,
            "authors": best.authors,
            "year": best.year,
            "extension": best.extension,
            "size": best.size,
            "md5": best.md5,
        }

    return {
        "ok": False,
        "error": "Download failed on all mirrors",
        "best_match": asdict(best),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cli():
    parser = argparse.ArgumentParser(
        description="Search and download books from Library Genesis mirrors.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # --- mirrors ---
    sub.add_parser("mirrors", help="Discover and probe current mirrors")

    # --- search ---
    p_search = sub.add_parser("search", help="Search for books")
    p_search.add_argument("query", nargs="+", help="Search query")
    p_search.add_argument(
        "--by",
        choices=["title", "author", "isbn"],
        default="title",
        help="Search field (default: title)",
    )
    p_search.add_argument("--ext", default="", help="Filter by extension (pdf, epub, ...)")
    p_search.add_argument("--limit", type=int, default=25, help="Max results")

    # --- download ---
    p_dl = sub.add_parser("download", help="Download a book by MD5 hash")
    p_dl.add_argument("md5", help="MD5 hash of the book")
    p_dl.add_argument("--output", default="~/Downloads/books", help="Output directory")
    p_dl.add_argument("--filename", default=None, help="Override filename")

    # --- grab ---
    p_grab = sub.add_parser("grab", help="Search and download best match")
    p_grab.add_argument("query", nargs="+", help="Search query")
    p_grab.add_argument("--ext", default="pdf", help="Preferred format (default: pdf)")
    p_grab.add_argument("--output", default="~/Downloads/books", help="Output directory")

    args = parser.parse_args()

    with httpx.Client(headers=HEADERS, timeout=30) as client:
        # Discover mirrors for all commands
        mirrors = discover_mirrors(client)

        if args.command == "mirrors":
            print(json.dumps(probe_mirrors(client, mirrors), indent=2))
            return

        if args.command == "search":
            base_url = find_working_mirror(client, mirrors)
            if not base_url:
                print(json.dumps({"error": "No working mirror found"}))
                sys.exit(1)

            query = " ".join(args.query)
            column = COLUMN_MAP.get(args.by, "def")
            results = search(client, base_url, query, column=column, ext=args.ext, max_results=args.limit)
            print(json.dumps([asdict(r) for r in results], indent=2, ensure_ascii=False))
            return

        if args.command == "download":
            output_dir = Path(args.output).expanduser()
            path = download_by_md5(client, mirrors, args.md5, output_dir, args.filename)
            if path:
                print(json.dumps({"ok": True, "path": str(path)}))
            else:
                print(json.dumps({"ok": False, "error": "Download failed"}))
                sys.exit(1)
            return

        if args.command == "grab":
            query = " ".join(args.query)
            output_dir = Path(args.output).expanduser()
            result = grab(client, mirrors, query, ext=args.ext, output_dir=output_dir)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            if not result["ok"]:
                sys.exit(1)
            return


if __name__ == "__main__":
    cli()

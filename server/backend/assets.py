"""Content-version local browser assets without Git metadata or a build step."""
from __future__ import annotations

import hashlib
import html
import re
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit


_TAG = re.compile(r"<(?:script|link)\b[^>]*>", re.IGNORECASE)
_URL = re.compile(r"(?P<attribute>\b(?:src|href)\s*=\s*)(?P<quote>[\"'])(?P<url>.*?)(?P=quote)", re.IGNORECASE)


def versioned_index(directory: str | Path) -> str:
    """Read one release's index and replace local JS/CSS query versions.

    Missing referenced files fail application setup instead of publishing a
    partially working release. Hash bytes, not timestamps or file sizes.
    """
    root = Path(directory).resolve(strict=True)
    source = (root / "index.html").read_text(encoding="utf-8")
    versions: dict[Path, str] = {}

    def replace_url(match: re.Match) -> str:
        url = urlsplit(html.unescape(match["url"]))
        if url.scheme or url.netloc or Path(url.path).suffix.lower() not in {".js", ".mjs", ".css"}:
            return match[0]
        asset = (root / unquote(url.path).lstrip("/")).resolve(strict=True)
        if not asset.is_relative_to(root):
            raise ValueError(f"Browser asset escapes web directory: {url.path}")
        if asset not in versions:
            versions[asset] = hashlib.sha256(asset.read_bytes()).hexdigest()
        query = [(key, value) for key, value in parse_qsl(url.query, keep_blank_values=True) if key != "v"]
        query.append(("v", versions[asset]))
        updated = urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), url.fragment))
        return f'{match["attribute"]}{match["quote"]}{html.escape(updated, quote=True)}{match["quote"]}'

    return _TAG.sub(lambda match: _URL.sub(replace_url, match[0]), source)

#!/usr/bin/env python3
"""Download a bounded Irkutsk road-source snapshot without an API key.

Prefer one bounded Overpass request. If it is unavailable, use the official
OSM map API sequentially with an adaptive, cached tile grid. Only highway
ways, their original vertices, traffic-control nodes and turn restrictions
are retained; buildings and land-use polygons are discarded.

This downloads source data; it never invents road connections or coordinates.
Requires requests (already used by the local import workflow).
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BBOX = (104.06, 52.20, 104.45, 52.40)  # west, south, east, north
USER_AGENT = "MarshrutkaIrkutskSourceDownloader/1.0 (bounded one-off OSM road extract)"
MAP_API = "https://www.openstreetmap.org/api/0.6/map"
OVERPASS = "https://overpass-api.de/api/interpreter"
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def save_gzip_json(filename: Path, payload: dict) -> None:
    filename.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    temporary = filename.with_suffix(filename.suffix + ".partial")
    temporary.write_bytes(gzip.compress(encoded, compresslevel=9, mtime=0))
    temporary.replace(filename)


def bbox_text(bbox: tuple[float, ...]) -> str:
    return ",".join(f"{coordinate:.6f}" for coordinate in bbox)


def tiles(bbox: tuple[float, ...], step: float):
    west, south, east, north = bbox
    nx, ny = math.ceil((east - west) / step - 1e-9), math.ceil((north - south) / step - 1e-9)
    for row in range(ny):
        for column in range(nx):
            yield (west + column * step, south + row * step,
                   min(east, west + (column + 1) * step), min(north, south + (row + 1) * step))


def split_tile(bbox: tuple[float, ...]):
    west, south, east, north = bbox
    mid_x, mid_y = (west + east) / 2, (south + north) / 2
    return [(west, south, mid_x, mid_y), (mid_x, south, east, mid_y),
            (west, mid_y, mid_x, north), (mid_x, mid_y, east, north)]


def xml_elements(payload: bytes):
    document = ET.fromstring(payload)
    elements = []
    for child in document:
        if child.tag not in {"node", "way", "relation"}:
            continue
        element = {"type": child.tag, "id": int(child.attrib["id"])}
        for key in ("version", "timestamp"):
            if key in child.attrib:
                element[key] = int(child.attrib[key]) if key == "version" else child.attrib[key]
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in child.findall("tag")}
        if tags:
            element["tags"] = tags
        if child.tag == "node":
            element.update(lat=float(child.attrib["lat"]), lon=float(child.attrib["lon"]))
        elif child.tag == "way":
            element["nodes"] = [int(node.attrib["ref"]) for node in child.findall("nd")]
        else:
            element["members"] = [{"type": member.attrib["type"], "ref": int(member.attrib["ref"]),
                                   "role": member.attrib.get("role", "")} for member in child.findall("member")]
        elements.append(element)
    return elements, document.find("meta").attrib if document.find("meta") is not None else {}


def road_subset(elements: list[dict]) -> list[dict]:
    ways = [element for element in elements if element["type"] == "way" and "highway" in element.get("tags", {})]
    required_nodes = {node for way in ways for node in way["nodes"]}
    restrictions = [element for element in elements if element["type"] == "relation"
                    and element.get("tags", {}).get("type") == "restriction"]
    for restriction in restrictions:
        required_nodes.update(member["ref"] for member in restriction["members"] if member["type"] == "node")
    nodes = [element for element in elements if element["type"] == "node" and
             (element["id"] in required_nodes or "highway" in element.get("tags", {})
              or "traffic_sign" in element.get("tags", {}))]
    return nodes + ways + restrictions


class DownloadError(RuntimeError):
    pass


class TooLarge(DownloadError):
    pass


class Downloader:
    def __init__(self, args):
        self.args = args
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.requests = 0
        self.sources = []
        self.elements = {}
        self.completed = []
        self.args.cache.mkdir(parents=True, exist_ok=True)

    def get(self, url, *, timeout, params=None):
        if self.requests >= self.args.max_requests:
            raise DownloadError(f"Safety limit of {self.args.max_requests} HTTP requests reached")
        if self.requests:
            time.sleep(self.args.delay)
        self.requests += 1
        with self.session.get(url, params=params, timeout=(15, timeout), stream=True) as response:
            if response.status_code == 400:
                body = response.content[:500].decode("utf-8", "replace")
                if "too many nodes" in body.lower() or "50000" in body or "50,000" in body:
                    raise TooLarge(body)
            if response.status_code in {429, 509}:
                limit = {"status": response.status_code, "url": response.url, "observedAt": utc_now(),
                         "retryAfter": response.headers.get("Retry-After"),
                         "headers": {key: value for key, value in response.headers.items()
                                     if key.lower() in {"retry-after", "content-type", "x-error", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"}},
                         "body": response.content[:2000].decode("utf-8", "replace")}
                (self.args.cache / "rate-limit.json").write_text(json.dumps(limit, indent=2), encoding="utf-8")
                raise DownloadError(f"OSM rate limit {response.status_code}; Retry-After={limit['retryAfter']}; "
                                    f"{limit['body'][:200]}; stop and resume from the cache later")
            response.raise_for_status()
            chunks, length = [], 0
            for chunk in response.iter_content(256 * 1024):
                length += len(chunk)
                if length > MAX_RESPONSE_BYTES:
                    raise TooLarge(f"Response exceeds {MAX_RESPONSE_BYTES} bytes")
                chunks.append(chunk)
            return b"".join(chunks), response.url

    def merge(self, elements):
        for element in elements:
            identity = (element["type"], element["id"])
            existing = self.elements.get(identity)
            if not existing or element.get("version", 0) >= existing.get("version", 0):
                self.elements[identity] = element

    def overpass(self):
        west, south, east, north = self.args.bbox
        query = (f'[out:json][timeout:25];way["highway"]({south},{west},{north},{east})->.roads;'
                 '(.roads;node(w.roads);rel(bw.roads)["type"="restriction"];);out body;')
        signature = hashlib.sha256(query.encode()).hexdigest()[:16]
        cache = self.args.cache / f"overpass-{signature}.json.gz"
        if cache.exists():
            data = json.loads(gzip.decompress(cache.read_bytes()))
            url, cached = OVERPASS + "?data=" + requests.utils.quote(query), True
        else:
            payload, url = self.get(OVERPASS, params={"data": query}, timeout=30)
            data, cached = json.loads(payload), False
            if data.get("remark"):
                raise DownloadError("Overpass returned a partial/error response: " + str(data["remark"]))
            if not data.get("elements"):
                raise DownloadError("Overpass returned no elements")
            save_gzip_json(cache, data)
        subset = road_subset(data["elements"])
        self.merge(subset)
        self.sources.append({"url": url, "cached": cached, "retrievedAt": utc_now(),
                             "osmBaseTimestamp": data.get("osm3s", {}).get("timestamp_osm_base")})
        self.completed = [list(self.args.bbox)]
        print(f"Overpass complete: {len(subset)} retained road-source elements", flush=True)

    def tile(self, bbox, depth=0):
        signature = bbox_text(bbox).replace(",", "_")
        cached_xml = self.args.cache / f"map-{signature}.osm.gz"
        cached_source = self.args.cache / f"map-{signature}.metadata.json"
        divided = self.args.cache / f"map-{signature}.split"
        if divided.exists():
            for child in split_tile(bbox):
                self.tile(child, depth + 1)
            return
        try:
            if cached_xml.exists():
                payload, cached = gzip.decompress(cached_xml.read_bytes()), True
                metadata = json.loads(cached_source.read_text(encoding="utf-8")) if cached_source.exists() else {}
                url = metadata.get("url", MAP_API + "?bbox=" + bbox_text(bbox))
            else:
                payload, url = self.get(MAP_API, params={"bbox": bbox_text(bbox)}, timeout=45)
                cached = False
            elements, api_meta = xml_elements(payload)
            node_count = sum(element["type"] == "node" for element in elements)
            if node_count >= 49500:
                raise TooLarge(f"Tile contains {node_count} nodes; approaching official API 50000-node limit")
        except TooLarge as error:
            west, south, east, north = bbox
            if depth >= self.args.max_depth or min(east - west, north - south) / 2 < self.args.min_tile:
                raise DownloadError(f"Cannot safely subdivide {bbox_text(bbox)}: {error}") from error
            divided.write_text(str(error), encoding="utf-8")
            print(f"Subdividing dense tile {bbox_text(bbox)}", flush=True)
            for child in split_tile(bbox):
                self.tile(child, depth + 1)
            return
        except (requests.RequestException, ET.ParseError) as error:
            raise DownloadError(f"Tile {bbox_text(bbox)} failed; cached completed tiles can be resumed: {error}") from error
        metadata = {"url": url, "bbox": list(bbox), "cached": cached, "retrievedAt": utc_now(),
                    "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload),
                    "nodeCount": node_count, **api_meta}
        if not cached_xml.exists():
            cached_xml.write_bytes(gzip.compress(payload, compresslevel=6, mtime=0))
            cached_source.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        subset = road_subset(elements)
        self.merge(subset)
        self.sources.append(metadata)
        self.completed.append(list(bbox))
        counts = self.counts()
        print(f"Tile {len(self.completed)} {bbox_text(bbox)}: {node_count} source nodes; "
              f"total {counts['way']} highway ways / {counts['node']} retained nodes; "
              f"HTTP {self.requests}{' (cache)' if cached else ''}", flush=True)

    def counts(self):
        return {kind: sum(key[0] == kind for key in self.elements) for kind in ("node", "way", "relation")}

    def write(self, mode, complete=True):
        nodes = {element["id"] for element in self.elements.values() if element["type"] == "node"}
        ways = {element["id"]: element for element in self.elements.values() if element["type"] == "way"}
        missing = sorted({node for way in ways.values() for node in way["nodes"] if node not in nodes})
        if missing:
            raise DownloadError(f"Incomplete source geometry: {len(missing)} missing road vertices; refusing final snapshot")
        incomplete_restrictions = []
        for element in self.elements.values():
            if element["type"] != "relation":
                continue
            missing_members = [member for member in element.get("members", []) if member["type"] == "way" and member["ref"] not in ways]
            if missing_members:
                incomplete_restrictions.append({"id": element["id"], "missingWayIds": [member["ref"] for member in missing_members]})
        tag_coverage = {key: sum(any(tag == key or tag.startswith(key + ":") for tag in way.get("tags", {}))
                                 for way in ways.values())
                        for key in ("name", "lanes", "maxspeed", "oneway", "turn:lanes", "change:lanes", "lane_markings")}
        payload = {"source": "OpenStreetMap public API / Overpass", "license": "ODbL-1.0",
                   "attribution": "© OpenStreetMap contributors", "retrievedAt": utc_now(),
                   "coverage": {"name": "Irkutsk urban bounding box with surrounding roads, including Novo-Lenino, Batareynaya and Lugovoe corridors",
                                "bbox": list(self.args.bbox), "bboxOrder": "west,south,east,north",
                                "scope": "Highway ways with OSM vertices in the bounded area; their complete geometry can extend past its boundary. This is not a claim to cover the whole municipal administrative territory.",
                                "complete": complete, "method": mode, "successfulTiles": self.completed},
                   "filter": "All highway-tagged ways, complete way-node geometry, highway/traffic-sign nodes and restriction relations. All original road tags retained; buildings discarded.",
                   "counts": self.counts(), "highwayClassCounts": dict(Counter(way.get("tags", {}).get("highway") for way in ways.values())),
                   "roadTagCoverage": tag_coverage, "incompleteBoundaryRestrictions": incomplete_restrictions,
                   "sources": self.sources,
                   "elements": sorted(self.elements.values(), key=lambda element: (element["type"], element["id"]))}
        save_gzip_json(self.args.output, payload)
        print(f"SAVED {self.args.output}: {self.args.output.stat().st_size} compressed bytes; {payload['counts']}; "
              f"{len(incomplete_restrictions)} boundary restrictions have out-of-extract members", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bbox", type=lambda value: tuple(map(float, value.split(","))), default=DEFAULT_BBOX,
                        help="west,south,east,north; default104.06,52.20,104.45,52.40")
    parser.add_argument("--output", type=Path, default=ROOT / "geography/source/irkutsk-city-roads.json.gz")
    parser.add_argument("--cache", type=Path, default=ROOT / "test-results/osm-map-cache")
    parser.add_argument("--tile-size", type=float, default=0.025)
    parser.add_argument("--min-tile", type=float, default=0.003)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--max-requests", type=int, default=900)
    parser.add_argument("--delay", type=float, default=0.35, help="minimum seconds between sequential uncached requests")
    parser.add_argument("--map-only", action="store_true", help="skip the initial bounded Overpass request")
    args = parser.parse_args()
    if len(args.bbox) != 4 or not (args.bbox[0] < args.bbox[2] and args.bbox[1] < args.bbox[3]):
        parser.error("Invalid bounded area")
    if (args.bbox[2] - args.bbox[0]) * (args.bbox[3] - args.bbox[1]) > 0.12:
        parser.error("Area exceeds this one-city downloader safety limit of0.12square degrees")
    if not (0.003 <= args.tile_size <= 0.025):
        parser.error("Tile size must be0.003..0.025degrees")
    downloader = Downloader(args)
    print(f"Bounded road extract {bbox_text(args.bbox)}; sequential requests, cached fallback grid", flush=True)
    if not args.map_only:
        try:
            downloader.overpass()
            downloader.write("one bounded Overpass highway query")
            return
        except (requests.RequestException, ValueError, DownloadError) as error:
            print(f"Overpass unavailable ({error}); falling back to official map API", flush=True)
            downloader.elements.clear()
            downloader.sources.clear()
            downloader.completed.clear()
    grid = list(tiles(args.bbox, args.tile_size))
    print(f"Official API initial grid: {len(grid)} bounded tiles", flush=True)
    for bbox in grid:
        downloader.tile(bbox)
    downloader.write("official OSM map API sequential adaptive cached grid")


if __name__ == "__main__":
    try:
        main()
    except (DownloadError, requests.RequestException) as error:
        print(f"DOWNLOAD PAUSED: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)

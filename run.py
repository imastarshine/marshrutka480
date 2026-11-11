"""Single-process launcher. Run from any directory: python /path/to/run.py."""
from __future__ import annotations

import argparse
import ipaddress
import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv


def main() -> None:
    root = Path(__file__).resolve().parent
    os.chdir(root)
    load_dotenv(root / ".env", override=False)
    parser = argparse.ArgumentParser(description="Маршрутка 480 — FastAPI + WebSocket")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    parser.add_argument(
        "--proxy-ips", default=os.getenv("M480_PROXY_IPS", ""),
        help="Exact trusted proxy IPs, comma separated; empty disables proxy headers",
    )
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.proxy_ips:
        try:
            args.proxy_ips = ",".join(str(ipaddress.ip_address(v.strip())) for v in args.proxy_ips.split(","))
        except ValueError:
            parser.error("--proxy-ips accepts explicit IP addresses only, never wildcards or CIDRs")
    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        workers=1,
        ws="websockets",
        ws_max_size=2048,
        ws_max_queue=8,
        ws_ping_interval=15,
        ws_ping_timeout=15,
        ws_per_message_deflate=False,
        timeout_keep_alive=5,
        limit_concurrency=256,
        proxy_headers=bool(args.proxy_ips),
        forwarded_allow_ips=args.proxy_ips,
        server_header=False,
    )


if __name__ == "__main__":
    main()

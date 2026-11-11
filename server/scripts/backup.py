"""Consistent SQLite backup, including a live WAL. Does not copy secrets to stdout."""
from __future__ import annotations

import argparse
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Consistent SQLite backup")
    parser.add_argument("database", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source = args.database.resolve(strict=True)
    if not source.is_file():
        parser.error("database must be an existing file")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = args.output or Path("backups") / f"marshrutka-{stamp}.sqlite3"
    destination = destination.resolve()
    if destination == source or destination.exists():
        parser.error("backup destination must be a new file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src:
            with closing(sqlite3.connect(destination)) as dest:
                src.backup(dest)
                result = dest.execute("PRAGMA integrity_check").fetchone()[0]
                if result != "ok":
                    raise RuntimeError("backup failed integrity_check")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    print(destination)


if __name__ == "__main__":
    main()

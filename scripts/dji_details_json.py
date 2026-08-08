#!/usr/bin/env python3
"""Emit details-only JSON for a DJI FlightRecord without using djirecord --json.

pydjirecord 1.3.0's ``export_json`` details-only path calls ``dataclasses.asdict``
and then mutates enum/datetime fields; that crashes on some v13+ logs. The
camelCase ``_dataclass_to_dict`` helper used for frame exports is safe.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: dji_details_json.py <FlightRecord.txt>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    data = path.read_bytes()

    from pydjirecord.djilog import DJILog
    from pydjirecord.export.json import _dataclass_to_dict, _json_default

    log = DJILog.from_bytes(data)
    payload = {
        "version": log.version,
        "details": _dataclass_to_dict(log.details),
    }
    json.dump(payload, sys.stdout, indent=2, default=_json_default)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        print(f"dji_details_json failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

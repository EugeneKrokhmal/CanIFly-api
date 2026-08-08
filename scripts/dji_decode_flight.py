#!/usr/bin/env python3
"""Decode a DJI FlightRecord into details + GPS track for CanIFly.

Avoids two pydjirecord CLI bugs:
1. ``--json`` details-only path crashes in ``_details_only_dict`` / ``asdict``.
2. ``--geojson`` / ``frames()`` can crash inside ``records_to_frames`` on some
   v13+ logs even after successful keychain decrypt.

We always serialize details via ``_dataclass_to_dict``. For tracks we try
``records_to_frames`` first, then fall back to walking decrypted OSD records.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _valid_gps(lat: float, lon: float) -> bool:
    if lat == 0.0 and lon == 0.0:
        return False
    return -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0


def _track_from_frames(frames: list) -> list[list[float]]:
    coords: list[list[float]] = []
    for f in frames:
        lat = float(f.osd.latitude)
        lon = float(f.osd.longitude)
        if not _valid_gps(lat, lon):
            continue
        alt = float(f.osd.altitude)
        coords.append([lon, lat, alt])
    return coords


def _track_from_osd_records(records: list) -> list[list[float]]:
    from pydjirecord.record.osd import OSD

    coords: list[list[float]] = []
    for rec in records:
        data = rec.data
        if not isinstance(data, OSD):
            continue
        lat = float(data.latitude)
        lon = float(data.longitude)
        if not _valid_gps(lat, lon):
            continue
        # Relative height above takeoff when home altitude is unknown.
        alt = float(getattr(data, "altitude", 0.0) or 0.0)
        coords.append([lon, lat, alt])
    return coords


def decode(path: Path, api_key: str) -> dict:
    from pydjirecord.djilog import DJILog
    from pydjirecord.export.json import _dataclass_to_dict
    from pydjirecord.frame.builder import records_to_frames

    log = DJILog.from_bytes(path.read_bytes())
    details = _dataclass_to_dict(log.details)

    track: list[list[float]] | None = None
    track_error: str | None = None
    track_source: str | None = None

    try:
        if log.version >= 13:
            if not api_key:
                track_error = "missing_api_key"
            else:
                keychains = log.fetch_keychains(api_key)
                records = log.records(keychains)
                try:
                    frames = records_to_frames(records, log.details)
                    track = _track_from_frames(frames)
                    track_source = "frames"
                except Exception as exc:  # noqa: BLE001 — fall back to OSD
                    track = _track_from_osd_records(records)
                    track_source = "osd_fallback"
                    if len(track) < 2:
                        track_error = f"frames_failed:{exc}"
        else:
            records = log.records(None)
            try:
                frames = records_to_frames(records, log.details)
                track = _track_from_frames(frames)
                track_source = "frames"
            except Exception as exc:  # noqa: BLE001
                track = _track_from_osd_records(records)
                track_source = "osd_fallback"
                if len(track) < 2:
                    track_error = f"frames_failed:{exc}"
    except Exception as exc:  # noqa: BLE001
        track_error = str(exc)
        track = None

    if track is not None and len(track) < 2:
        track = None
        if not track_error:
            track_error = "insufficient_gps_points"

    return {
        "version": log.version,
        "details": details,
        "trackCoordinates": track,
        "trackSource": track_source,
        "trackError": track_error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="CanIFly DJI FlightRecord decoder")
    parser.add_argument("file", type=Path)
    parser.add_argument(
        "--api-key",
        default="",
        help="DJI Open API key (or set DJI_API_KEY). Needed for v13+ tracks.",
    )
    args = parser.parse_args()
    if not args.file.is_file():
        print(f"dji_decode_flight failed: file not found: {args.file}", file=sys.stderr)
        return 2

    api_key = (args.api_key or os.environ.get("DJI_API_KEY") or "").strip()
    # Avoid stock CLI path picking up env accidentally inside helpers — we pass
    # the key explicitly to fetch_keychains only when decoding tracks.
    os.environ.pop("DJI_API_KEY", None)

    try:
        from pydjirecord.export.json import _json_default

        payload = decode(args.file, api_key)
        json.dump(payload, sys.stdout, indent=2, default=_json_default)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        print(f"dji_decode_flight failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

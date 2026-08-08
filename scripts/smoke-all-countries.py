#!/usr/bin/env python3
"""Thorough live smoke: country resolve, status, bbox for ES/DE/FR/CZ/PL."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE = "http://localhost:4000"
PARAMS = {
    "altitudeAgl": "120",
    "weightClass": "c0",
    "operationCategory": "open",
}

# status expectations: exact | one of set | "any_not_clear" | "any"
# country / backend must match when set
CASES = [
    # --- Spain ---
    {"id": "ES-Madrid", "lat": 40.4168, "lng": -3.7038, "country": "ES", "backend": {"servais", "postgis", "memory"}, "status": "any", "min_zones": 0},
    {"id": "ES-MAD-airport", "lat": 40.4719, "lng": -3.5626, "country": "ES", "backend": {"servais", "postgis", "memory"}, "status": {"prohibited", "restricted"}, "min_zones": 1},
    {"id": "ES-BCN", "lat": 41.3874, "lng": 2.1686, "country": "ES", "backend": {"servais", "postgis", "memory"}, "status": "any", "min_zones": 0},
    {"id": "ES-rural-castile", "lat": 41.6, "lng": -4.7, "country": "ES", "backend": {"servais", "postgis", "memory"}, "status": "any", "min_zones": 0},
    # --- Germany ---
    {"id": "DE-Berlin", "lat": 52.52, "lng": 13.405, "country": "DE", "backend": "dipul", "status": "any", "min_zones": 0},
    {"id": "DE-BER-airport", "lat": 52.3667, "lng": 13.5033, "country": "DE", "backend": "dipul", "status": {"prohibited"}, "min_zones": 1},
    {"id": "DE-MUC-airport", "lat": 48.3537, "lng": 11.775, "country": "DE", "backend": "dipul", "status": {"prohibited"}, "min_zones": 1},
    {"id": "DE-FRA-airport", "lat": 50.0379, "lng": 8.5622, "country": "DE", "backend": "dipul", "status": {"prohibited"}, "min_zones": 1},
    {"id": "DE-rural-bavaria", "lat": 49.0, "lng": 11.5, "country": "DE", "backend": "dipul", "status": "any", "min_zones": 0},
    # --- France ---
    {"id": "FR-Paris", "lat": 48.8566, "lng": 2.3522, "country": "FR", "backend": "geopf", "status": {"prohibited"}, "min_zones": 1},
    {"id": "FR-CDG", "lat": 49.0097, "lng": 2.5479, "country": "FR", "backend": "geopf", "status": {"prohibited"}, "min_zones": 1},
    {"id": "FR-Lyon", "lat": 45.764, "lng": 4.8357, "country": "FR", "backend": "geopf", "status": {"prohibited", "restricted", "conditional", "limited"}, "min_zones": 0},
    {"id": "FR-Marseille", "lat": 43.2965, "lng": 5.3698, "country": "FR", "backend": "geopf", "status": "any", "min_zones": 0},
    {"id": "FR-Strasbourg", "lat": 48.5734, "lng": 7.7521, "country": "FR", "backend": "geopf", "status": "any", "min_zones": 0},
    {"id": "FR-rural-centre", "lat": 46.8, "lng": 1.5, "country": "FR", "backend": "geopf", "status": "any", "min_zones": 0},
    # --- Czechia ---
    {"id": "CZ-Prague", "lat": 50.0755, "lng": 14.4378, "country": "CZ", "backend": "aimgis", "status": "any", "min_zones": 0},
    {"id": "CZ-PRG-airport", "lat": 50.1008, "lng": 14.26, "country": "CZ", "backend": "aimgis", "status": {"prohibited"}, "min_zones": 1},
    {"id": "CZ-Brno", "lat": 49.1951, "lng": 16.6068, "country": "CZ", "backend": "aimgis", "status": "any", "min_zones": 0},
    {"id": "CZ-rural-bohemia", "lat": 49.5, "lng": 14.0, "country": "CZ", "backend": "aimgis", "status": "any", "min_zones": 0},
    # --- Poland ---
    {"id": "PL-Warsaw", "lat": 52.2297, "lng": 21.0122, "country": "PL", "backend": "pansa", "status": "any", "min_zones": 0},
    {"id": "PL-WAW-airport", "lat": 52.1657, "lng": 20.9671, "country": "PL", "backend": "pansa", "status": {"prohibited", "restricted"}, "min_zones": 1},
    {"id": "PL-Krakow", "lat": 50.0647, "lng": 19.945, "country": "PL", "backend": "pansa", "status": "any", "min_zones": 0},
    {"id": "PL-rural-mazovia", "lat": 52.5, "lng": 20.0, "country": "PL", "backend": "pansa", "status": "any", "min_zones": 0},
    # --- Borders ---
    {"id": "BORDER-Kehl-DE", "lat": 48.573, "lng": 7.815, "country": "DE", "backend": "dipul", "status": "any", "min_zones": 0},
    {"id": "BORDER-Saarbrucken-DE", "lat": 49.235, "lng": 6.996, "country": "DE", "backend": "dipul", "status": "any", "min_zones": 0},
    {"id": "BORDER-Metz-FR", "lat": 49.119, "lng": 6.176, "country": "FR", "backend": "geopf", "status": "any", "min_zones": 0},
    {"id": "BORDER-Gorlitz-DE", "lat": 51.152, "lng": 14.987, "country": "DE", "backend": "dipul", "status": "any", "min_zones": 0},
    {"id": "BORDER-Zgorzelec-PL", "lat": 51.149, "lng": 15.01, "country": "PL", "backend": "pansa", "status": "any", "min_zones": 0},
    {"id": "BORDER-Decin-CZ", "lat": 50.782, "lng": 14.215, "country": "CZ", "backend": "aimgis", "status": "any", "min_zones": 0},
    {"id": "BORDER-BadSchandau-DE", "lat": 50.917, "lng": 14.155, "country": "DE", "backend": "dipul", "status": "any", "min_zones": 0},
    {"id": "BORDER-Hendaye-FR", "lat": 43.36, "lng": -1.77, "country": "FR", "backend": "geopf", "status": "any", "min_zones": 0},
    {"id": "BORDER-Irun-ES", "lat": 43.338, "lng": -1.789, "country": "ES", "backend": {"servais", "postgis", "memory"}, "status": "any", "min_zones": 0},
    # --- Sweden ---
    {"id": "SE-Stockholm", "lat": 59.3293, "lng": 18.0686, "country": "SE", "backend": "lfv", "status": "any", "min_zones": 0},
    {"id": "SE-ARN-airport", "lat": 59.6519, "lng": 17.9186, "country": "SE", "backend": "lfv", "status": {"prohibited", "restricted"}, "min_zones": 1},
    {"id": "SE-Malmo", "lat": 55.605, "lng": 13.0038, "country": "SE", "backend": "lfv", "status": "any", "min_zones": 0},
    {"id": "BORDER-Malmo-SE", "lat": 55.605, "lng": 13.0038, "country": "SE", "backend": "lfv", "status": "any", "min_zones": 0},
    {"id": "BORDER-Copenhagen-DK", "lat": 55.6761, "lng": 12.5683, "country": "DK", "backend": "dronezoner", "status": "any", "min_zones": 0},
    # --- Ireland ---
    {"id": "IE-Dublin", "lat": 53.3498, "lng": -6.2603, "country": "IE", "backend": "iaa", "status": "any", "min_zones": 0},
    {"id": "IE-DUB-airport", "lat": 53.4264, "lng": -6.2499, "country": "IE", "backend": "iaa", "status": {"prohibited", "restricted"}, "min_zones": 1},
    {"id": "IE-Cork", "lat": 51.8985, "lng": -8.4756, "country": "IE", "backend": "iaa", "status": "any", "min_zones": 0},
    # --- Latvia ---
    {"id": "LV-Riga", "lat": 56.9496, "lng": 24.1052, "country": "LV", "backend": "lgs", "status": "any", "min_zones": 0},
    {"id": "LV-RIX-airport", "lat": 56.9236, "lng": 23.9711, "country": "LV", "backend": "lgs", "status": {"prohibited", "restricted"}, "min_zones": 1},
    # --- Lithuania ---
    {"id": "LT-Vilnius", "lat": 54.6872, "lng": 25.2797, "country": "LT", "backend": "anslt", "status": "any", "min_zones": 0},
    {"id": "LT-VNO-airport", "lat": 54.6341, "lng": 25.2858, "country": "LT", "backend": "anslt", "status": {"prohibited", "restricted", "limited"}, "min_zones": 1},
    # --- Estonia ---
    {"id": "EE-Tallinn", "lat": 59.437, "lng": 24.7536, "country": "EE", "backend": "eans", "status": "any", "min_zones": 0},
    {"id": "EE-TLL-airport", "lat": 59.4133, "lng": 24.8328, "country": "EE", "backend": "eans", "status": {"prohibited", "restricted", "limited"}, "min_zones": 1},
    # --- Slovakia ---
    {"id": "SK-Bratislava", "lat": 48.1486, "lng": 17.1077, "country": "SK", "backend": "nsat", "status": "any", "min_zones": 0},
    {"id": "SK-BTS-airport", "lat": 48.1702, "lng": 17.2127, "country": "SK", "backend": "nsat", "status": {"prohibited", "restricted"}, "min_zones": 1},
    # --- Slovenia ---
    {"id": "SI-Ljubljana", "lat": 46.0569, "lng": 14.5058, "country": "SI", "backend": "caasi", "status": "any", "min_zones": 0},
    {"id": "SI-LJU-airport", "lat": 46.2237, "lng": 14.4576, "country": "SI", "backend": "caasi", "status": {"prohibited", "restricted"}, "min_zones": 1},
]

BBOXES = [
    {"id": "bbox-ES-Madrid", "west": -3.8, "south": 40.35, "east": -3.6, "north": 40.48, "backend": {"postgis", "servais", "memory"}, "min_features": 1},
    {"id": "bbox-DE-Berlin", "west": 13.3, "south": 52.45, "east": 13.5, "north": 52.55, "backend": {"dipul"}, "min_features": 1},
    {"id": "bbox-FR-Paris", "west": 2.25, "south": 48.80, "east": 2.45, "north": 48.90, "backend": {"geopf"}, "min_features": 1},
    {"id": "bbox-CZ-Prague", "west": 14.3, "south": 50.0, "east": 14.55, "north": 50.15, "backend": {"aimgis"}, "min_features": 1},
    {"id": "bbox-PL-Warsaw", "west": 20.9, "south": 52.15, "east": 21.1, "north": 52.3, "backend": {"pansa"}, "min_features": 1},
    {"id": "bbox-SE-Stockholm", "west": 17.9, "south": 59.25, "east": 18.2, "north": 59.4, "backend": {"lfv"}, "min_features": 1},
    {"id": "bbox-IE-Dublin", "west": -6.35, "south": 53.28, "east": -6.15, "north": 53.42, "backend": {"iaa"}, "min_features": 1},
    {"id": "bbox-LV-Riga", "west": 24.0, "south": 56.9, "east": 24.2, "north": 57.0, "backend": {"lgs"}, "min_features": 1},
    {"id": "bbox-LT-Vilnius", "west": 25.15, "south": 54.6, "east": 25.4, "north": 54.75, "backend": {"anslt"}, "min_features": 1},
    {"id": "bbox-EE-Tallinn", "west": 24.6, "south": 59.35, "east": 24.9, "north": 59.5, "backend": {"eans"}, "min_features": 1},
    {"id": "bbox-SK-Bratislava", "west": 16.95, "south": 48.05, "east": 17.25, "north": 48.25, "backend": {"nsat"}, "min_features": 1},
    {"id": "bbox-SI-Ljubljana", "west": 14.4, "south": 45.98, "east": 14.6, "north": 46.15, "backend": {"caasi"}, "min_features": 1},
    # Viewport center is France (Strasbourg) — single country, not multi-provider fan-out.
    {"id": "bbox-DE-FR-Strasbourg", "west": 7.7, "south": 48.52, "east": 7.85, "north": 48.62, "backend": {"geopf"}, "min_features": 1},
]

RESOLVE_CASES = [
    ("Paris", 48.8566, 2.3522, "FR"),
    ("Berlin", 52.52, 13.405, "DE"),
    ("Madrid", 40.4168, -3.7038, "ES"),
    ("Prague", 50.0755, 14.4378, "CZ"),
    ("Warsaw", 52.2297, 21.0122, "PL"),
    ("Strasbourg", 48.5734, 7.7521, "FR"),
    ("Kehl", 48.573, 7.815, "DE"),
    ("Saarbrucken", 49.235, 6.996, "DE"),
    ("Metz", 49.119, 6.176, "FR"),
    ("Freiburg", 47.999, 7.842, "DE"),
    ("Irun", 43.338, -1.789, "ES"),
    ("Hendaye", 43.36, -1.77, "FR"),
    ("SanSebastian", 43.3183, -1.9812, "ES"),
    ("Hondarribia", 43.362, -1.792, "ES"),
    ("StJeanDeLuz", 43.388, -1.663, "FR"),
    ("Bilbao", 43.263, -2.935, "ES"),
    ("Bordeaux", 44.8378, -0.5792, "FR"),
    ("Pamplona", 42.8125, -1.6458, "ES"),
    ("Perpignan", 42.6887, 2.8948, "FR"),
    ("Figueres", 42.2671, 2.9613, "ES"),
    ("Decin", 50.782, 14.215, "CZ"),
    ("BadSchandau", 50.917, 14.155, "DE"),
    ("Gorlitz", 51.152, 14.987, "DE"),
    ("Zgorzelec", 51.149, 15.01, "PL"),
    ("Stockholm", 59.3293, 18.0686, "SE"),
    ("Malmo", 55.605, 13.0038, "SE"),
    ("Copenhagen", 55.6761, 12.5683, "DK"),
    ("Dublin", 53.3498, -6.2603, "IE"),
    ("Cork", 51.8985, -8.4756, "IE"),
    ("Riga", 56.9496, 24.1052, "LV"),
    ("Vilnius", 54.6872, 25.2797, "LT"),
    ("Tallinn", 59.437, 24.7536, "EE"),
    ("Bratislava", 48.1486, 17.1077, "SK"),
    ("Ljubljana", 46.0569, 14.5058, "SI"),
    ("outside", 60.0, 10.0, None),
]


def get_json(url: str, timeout: float = 45.0) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def status_url(lat: float, lng: float) -> str:
    q = urllib.parse.urlencode({**PARAMS, "lat": lat, "lng": lng})
    return f"{BASE}/api/airspace/status?{q}"


def bbox_url(b: dict) -> str:
    q = urllib.parse.urlencode(
        {
            **PARAMS,
            "west": b["west"],
            "south": b["south"],
            "east": b["east"],
            "north": b["north"],
        }
    )
    return f"{BASE}/api/zones/bbox?{q}"


def norm_status(s: str | None) -> str:
    return (s or "").strip().lower()


def check_status(case: dict, data: dict) -> list[str]:
    errs: list[str] = []
    meta = data.get("meta") or {}
    country = meta.get("country")
    backend = meta.get("backend")
    status = norm_status(data.get("status"))
    zones = data.get("zones") or []
    provider_err = meta.get("providerError")

    if provider_err:
        errs.append(f"providerError={provider_err}")

    if case.get("country") and country != case["country"]:
        errs.append(f"country={country!r} want {case['country']!r}")

    want_be = case.get("backend")
    if want_be:
        allowed = want_be if isinstance(want_be, set) else {want_be}
        if backend not in allowed:
            errs.append(f"backend={backend!r} want {sorted(allowed)}")

    want_st = case.get("status")
    if want_st and want_st != "any":
        if isinstance(want_st, set):
            if status not in want_st:
                errs.append(f"status={status!r} want one of {sorted(want_st)}")
        elif status != want_st:
            errs.append(f"status={status!r} want {want_st!r}")

    if len(zones) < case.get("min_zones", 0):
        errs.append(f"zones={len(zones)} want>={case['min_zones']}")

    # zone country tags should not contradict resolved country (when present)
    for z in zones:
        zc = (z.get("country") or "").upper()
        if zc and case.get("country") and zc not in {case["country"], case["country"] + "X"}:
            # allow ISO3 later; map common
            iso3 = {"ES": "ESP", "DE": "DEU", "FR": "FRA", "CZ": "CZE", "PL": "POL"}
            if zc not in {case["country"], iso3.get(case["country"], "")}:
                errs.append(f"zone country={zc!r} vs {case['country']}")
                break

    return errs


def check_bbox(case: dict, data: dict) -> list[str]:
    errs: list[str] = []
    meta = data.get("meta") or {}
    backend = meta.get("backend") or data.get("backend")
    feats = data.get("features") or []
    if data.get("type") != "FeatureCollection" and "features" not in data:
        errs.append(f"unexpected shape keys={list(data)[:8]}")
    want_be = case.get("backend")
    if want_be:
        allowed = want_be if isinstance(want_be, set) else {want_be}
        if backend not in allowed:
            errs.append(f"backend={backend!r} want {sorted(allowed)}")
    if len(feats) < case.get("min_features", 0):
        errs.append(f"features={len(feats)} want>={case['min_features']}")
    return errs


def run_resolve() -> list[tuple[str, bool, str]]:
    mw = Path(__file__).resolve().parents[2] / "CanIFly-middleware" / "dist" / "geo" / "countries.js"
    # Use node to import ESM
    script = """
import { resolveCountry } from %s;
const cases = %s;
for (const [name, lat, lng, want] of cases) {
  const got = resolveCountry(lat, lng);
  const ok = got === want;
  console.log(JSON.stringify({name, want, got, ok}));
}
""" % (
        json.dumps(str(mw)),
        json.dumps([[n, la, ln, w] for n, la, ln, w in RESOLVE_CASES]),
    )
    import subprocess

    # write temp mjs that imports via file URL
    import tempfile

    cases_json = json.dumps([[n, la, ln, w] for n, la, ln, w in RESOLVE_CASES])
    code = f"""
import {{ resolveCountry }} from {json.dumps('file://' + str(mw))};
const cases = {cases_json};
for (const [name, lat, lng, want] of cases) {{
  const got = resolveCountry(lat, lng);
  console.log(JSON.stringify({{ name, want, got, ok: got === want }}));
}}
"""
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
        f.write(code)
        path = f.name
    out = subprocess.check_output(["node", path], text=True)
    rows = []
    for line in out.strip().splitlines():
        r = json.loads(line)
        rows.append((r["name"], r["ok"], f"want={r['want']} got={r['got']}"))
    return rows


def main() -> int:
    print("=== health ===")
    try:
        h = get_json(f"{BASE}/health", timeout=10)
        print(json.dumps(h))
        if not h.get("ok"):
            print("FAIL health")
            return 2
        if not h.get("pansaConfigured"):
            print("WARN PANSA key missing — PL may fail")
    except Exception as e:
        print("FAIL health", e)
        return 2

    print("\n=== resolveCountry (middleware) ===")
    resolve_rows = run_resolve()
    resolve_fail = 0
    for name, ok, detail in resolve_rows:
        mark = "OK " if ok else "FAIL"
        if not ok:
            resolve_fail += 1
        print(f"  {mark} {name}: {detail}")

    print("\n=== airspace status ===")
    status_results = []

    def fetch_status(case):
        t0 = time.time()
        try:
            data = get_json(status_url(case["lat"], case["lng"]))
            ms = int((time.time() - t0) * 1000)
            return case, data, ms, None
        except Exception as e:
            return case, None, 0, str(e)

    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(fetch_status, c) for c in CASES]
        for fut in as_completed(futs):
            status_results.append(fut.result())

    status_results.sort(key=lambda x: x[0]["id"])
    status_fail = 0
    for case, data, ms, err in status_results:
        if err:
            status_fail += 1
            print(f"  FAIL {case['id']}: error {err}")
            continue
        assert data is not None
        errs = check_status(case, data)
        meta = data.get("meta") or {}
        line = (
            f"{case['id']}: status={data.get('status')} country={meta.get('country')} "
            f"backend={meta.get('backend')} zones={len(data.get('zones') or [])} {ms}ms"
        )
        if errs:
            status_fail += 1
            print(f"  FAIL {line}")
            for e in errs:
                print(f"       - {e}")
        else:
            print(f"  OK   {line}")

    print("\n=== zones bbox ===")
    bbox_fail = 0
    for b in BBOXES:
        t0 = time.time()
        try:
            data = get_json(bbox_url(b), timeout=60)
            ms = int((time.time() - t0) * 1000)
            errs = check_bbox(b, data)
            meta = data.get("meta") or {}
            n = len(data.get("features") or [])
            line = f"{b['id']}: backend={meta.get('backend')} features={n} {ms}ms"
            if errs:
                bbox_fail += 1
                print(f"  FAIL {line}")
                for e in errs:
                    print(f"       - {e}")
            else:
                print(f"  OK   {line}")
        except Exception as e:
            bbox_fail += 1
            print(f"  FAIL {b['id']}: {e}")

    print("\n=== summary ===")
    print(
        f"resolve: {len(resolve_rows) - resolve_fail}/{len(resolve_rows)}  "
        f"status: {len(CASES) - status_fail}/{len(CASES)}  "
        f"bbox: {len(BBOXES) - bbox_fail}/{len(BBOXES)}"
    )
    total_fail = resolve_fail + status_fail + bbox_fail
    print("PASS" if total_fail == 0 else f"FAIL ({total_fail} failures)")
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())

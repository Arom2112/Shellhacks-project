#!/usr/bin/env python3
"""
snap_potholes.py — Snap SafeRoute MIA pothole markers from 311 address
locations (parcels/rooftops) onto the nearest road.

Why: Miami-Dade 311 pothole reports are geocoded to the report's street
address, so markers land on houses instead of the road. This script sends
every point through Google's Roads API (snapToRoads) once and rewrites the
coordinates to the nearest road point.

Usage:
    # 1. Enable the "Roads API" in the same Google Cloud project that
    #    already has the Routes API enabled (APIs & Services > Enable APIs).
    # 2. From your repo clone:
    GOOGLE_API_KEY=your_key_here python3 snap_potholes.py \
        --patch-app-js js/app.js \
        --update-json assets/data/pothole_points.json

    # Dry run (no API calls, validates batching):
    python3 snap_potholes.py --dry-run

The API key is read ONLY from the GOOGLE_API_KEY environment variable.
It is never printed, logged, or written to any file.

Outputs (in the current directory):
    pothole_points_snapped.json  - same [lat, lng, 1, "POTHOLE", address]
                                    format, with snapped coordinates.
    potholes_embed_snippet.js     - JS array literal, paste-ready for the
                                    EMBED.potholes array in js/app.js
                                    (used automatically by --patch-app-js).
"""

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO_RAW_JSON = ("https://raw.githubusercontent.com/Arom2112/Shellhacks-project"
                 "/main/assets/data/pothole_points.json")
ROADS_URL = "https://roads.googleapis.com/v1/snapToRoads"
BATCH = 100            # snapToRoads max per request
SLEEP_S = 0.25         # politeness delay between requests


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_source(input_path):
    if input_path:
        with open(input_path, encoding="utf-8") as f:
            return json.load(f)
    print(f"Downloading source data from {REPO_RAW_JSON} ...")
    with urllib.request.urlopen(REPO_RAW_JSON, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def snap_batch(points, api_key):
    """points: list of (lat, lng). Returns {index_in_batch: (lat, lng)}."""
    path = "|".join(f"{lat},{lng}" for lat, lng in points)
    # interpolate=false -> one snapped point per input point, no filler points
    url = (f"{ROADS_URL}?interpolate=false&key={api_key}&path="
           + urllib.parse.quote(path, safe="|,"))
    req = urllib.request.Request(url, headers={"User-Agent": "saferoute-snap/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise SystemExit(f"Roads API HTTP {e.code}: {detail}\n"
                         "Hint: enable the 'Roads API' in your Google Cloud project.")
    out = {}
    for sp in body.get("snappedPoints", []):
        loc = sp["location"]
        out[sp["originalIndex"]] = (loc["latitude"], loc["longitude"])
    if "warningMessage" in body:
        print("  API warning:", body["warningMessage"][:200])
    return out


def patch_app_js(app_js_path, new_records):
    """Replace the EMBED potholes array in js/app.js via bracket matching."""
    with open(app_js_path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r'(["\']?)potholes\1\s*:', text)
    if not m:
        raise SystemExit("Could not find the 'potholes' key in " + app_js_path)
    i = m.end()
    while i < len(text) and text[i] in " \t\r\n":
        i += 1
    if i >= len(text) or text[i] != "[":
        raise SystemExit("Found 'potholes:' but no array literal follows it.")
    depth, j = 0, i
    in_str, esc = False, False
    while j < len(text):
        ch = text[j]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    break
        j += 1
    if depth != 0:
        raise SystemExit("Unbalanced brackets while locating the potholes array.")
    old_array_src = text[i:j + 1]
    try:
        old_records = json.loads(old_array_src)
    except json.JSONDecodeError:
        old_records = None
    if old_records is not None and len(old_records) != len(new_records):
        print(f"WARNING: embedded array has {len(old_records)} records but the "
              f"snapped data has {len(new_records)}. Patching anyway — "
              "double-check the diff before committing.")
    backup = app_js_path + ".bak"
    shutil.copy2(app_js_path, backup)
    new_array_src = json.dumps(new_records, separators=(",", ":"))
    patched = text[:i] + new_array_src + text[j + 1:]
    with open(app_js_path, "w", encoding="utf-8") as f:
        f.write(patched)
    print(f"Patched {app_js_path} (backup: {backup})")


def main():
    ap = argparse.ArgumentParser(description="Snap pothole points to nearest roads.")
    ap.add_argument("--input", default=None,
                    help="Local pothole_points.json (default: download from GitHub).")
    ap.add_argument("--api-key", default=os.environ.get("GOOGLE_API_KEY"),
                    help="Google API key (default: $GOOGLE_API_KEY).")
    ap.add_argument("--max-shift-m", type=float, default=150.0,
                    help="If a snapped point moved more than this, keep the "
                         "original and flag it (default: 150 m).")
    ap.add_argument("--patch-app-js", default=None, metavar="PATH",
                    help="Patch the EMBED.potholes array in js/app.js in place.")
    ap.add_argument("--update-json", default=None, metavar="PATH",
                    help="Overwrite a pothole JSON data file in place.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Validate batching only; make no API calls.")
    args = ap.parse_args()

    records = load_source(args.input)
    print(f"Loaded {len(records)} pothole records.")
    if args.dry_run:
        nb = (len(records) + BATCH - 1) // BATCH
        print(f"DRY RUN: would send {nb} snapToRoads requests "
              f"({BATCH} points each, last batch {len(records) % BATCH or BATCH}).")
        return

    if not args.api_key:
        raise SystemExit("Set GOOGLE_API_KEY in your environment first:\n"
                         "  GOOGLE_API_KEY=your_key_here python3 snap_potholes.py ...")

    snapped, unsnapped_idx, far_idx = {}, [], []
    shifts = []
    nbatches = (len(records) + BATCH - 1) // BATCH
    for b in range(nbatches):
        chunk = records[b * BATCH:(b + 1) * BATCH]
        pts = [(r[0], r[1]) for r in chunk]
        print(f"Snapping batch {b + 1}/{nbatches} ...")
        res = snap_batch(pts, args.api_key)
        for k, (lat, lng) in enumerate(chunk):
            gi = b * BATCH + k
            if k in res:
                slat, slng = res[k]
                d = haversine_m(lat, lng, slat, slng)
                if d <= args.max_shift_m:
                    snapped[gi] = (slat, slng)
                    shifts.append(d)
                else:
                    far_idx.append(gi)  # snapped too far: keep original
            else:
                unsnapped_idx.append(gi)  # API couldn't snap: keep original
        time.sleep(SLEEP_S)

    new_records = []
    for gi, r in enumerate(records):
        if gi in snapped:
            new_records.append([snapped[gi][0], snapped[gi][1]] + r[2:])
        else:
            new_records.append(r)

    with open("pothole_points_snapped.json", "w", encoding="utf-8") as f:
        json.dump(new_records, f, separators=(",", ":"))
    with open("potholes_embed_snippet.js", "w", encoding="utf-8") as f:
        f.write("// Paste this array as the value of EMBED.potholes in js/app.js\n")
        f.write("potholes: " + json.dumps(new_records, separators=(",", ":")) + "\n")

    shifts.sort()
    summary = {
        "total": len(records),
        "snapped_to_road": len(snapped),
        "kept_original_unsnappable": len(unsnapped_idx),
        "kept_original_shift_too_far": len(far_idx),
        "median_shift_m": round(shifts[len(shifts) // 2], 1) if shifts else 0,
        "max_shift_m": round(shifts[-1], 1) if shifts else 0,
    }
    print("\nResult:")
    print(json.dumps(summary, indent=2))
    print("Wrote pothole_points_snapped.json and potholes_embed_snippet.js")

    if args.update_json:
        backup = args.update_json + ".bak"
        shutil.copy2(args.update_json, backup)
        with open(args.update_json, "w", encoding="utf-8") as f:
            json.dump(new_records, f, separators=(",", ":"))
        print(f"Updated {args.update_json} (backup: {backup})")
    if args.patch_app_js:
        patch_app_js(args.patch_app_js, new_records)
    if not args.update_json and not args.patch_app_js:
        print("\nNothing patched. To apply: re-run with --patch-app-js js/app.js "
              "and/or --update-json assets/data/pothole_points.json")


if __name__ == "__main__":
    main()

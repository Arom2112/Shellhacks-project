#!/usr/bin/env python3
"""
probe_congestion.py — Prove time-of-day congestion with measured data.

Calls the Google Routes API (already used by the app for ETAs) for the same
corridor at several departure times and records:

    duration       — with predictive/live traffic
    staticDuration — free-flow estimate

The ratio duration / staticDuration is the MEASURED congestion factor.
No guessing, no model priors — this is Google's traffic model speaking.

This is the honest replacement for hand-waved "Friday 5pm is congested"
claims, and the numbers can be fed straight into the Gemini briefing
prompt so the AI narrates measured data instead of vibes.

Usage:
    GOOGLE_API_KEY=... python3 probe_congestion.py
    GOOGLE_API_KEY=... python3 probe_congestion.py --dry-run   # no API calls

Requirements: Google Cloud project with Routes API *and* Geocoding API
enabled (geocoding is only needed for "addr:..." corridors).

Output: congestion_profiles.json + a pitch-ready summary table.

Scope note: this measures corridor-level congestion (enough to prove the
5pm-Friday claim and to power honest demo numbers). Per-grid-cell time
profiles would need segment-level flow data (TomTom Traffic Flow API) —
that's the post-hackathon step.
"""

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
ET = timezone(timedelta(hours=-4), "ET")  # EDT; fine for the demo window

# (label, origin, destination). "addr:..." is geocoded with the same key;
# otherwise use (lat, lng) tuples.
CORRIDORS = [
    ("FIU -> South Beach",
     "addr:Florida International University, Miami, FL",
     "addr:Ocean Drive and 5th Street, Miami Beach, FL"),
    ("Brickell -> Doral",
     "addr:Brickell Avenue and SE 8th Street, Miami, FL",
     "addr:NW 107th Avenue and NW 12th Street, Doral, FL"),
    ("MIA Airport -> Wynwood",
     "addr:Miami International Airport",
     "addr:Wynwood Walls, Miami, FL"),
]


def next_weekday(weekday, hour, minute=0):
    """Next datetime for weekday (Mon=0..Sun=6) at hour:minute ET."""
    now = datetime.now(ET)
    days_ahead = (weekday - now.weekday()) % 7
    dt = (now + timedelta(days=days_ahead)).replace(
        hour=hour, minute=minute, second=0, microsecond=0)
    if dt <= now:
        dt += timedelta(days=7)
    return dt


def probe_times():
    now = datetime.now(ET)
    return [
        ("Right now", None),
        ("Mon 8am (AM rush)", next_weekday(0, 8)),
        ("Mon 12pm (midday)", next_weekday(0, 12)),
        ("Mon 6pm (PM rush)", next_weekday(0, 18)),
        ("Fri 5pm (Fri rush)", next_weekday(4, 17)),
        ("Fri 8pm (Fri evening)", next_weekday(4, 20)),
        ("Sat 10am (weekend)", next_weekday(5, 10)),
    ]


def geocode(api_key, address):
    url = f"{GEOCODE_URL}?address={urllib.parse.quote(address)}&key={api_key}"
    try:
        d = json.load(urllib.request.urlopen(url, timeout=30))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Geocoding failed HTTP {e.code}: enable the Geocoding API.")
    if d.get("status") != "OK" or not d.get("results"):
        raise SystemExit(f"Geocode failed for {address!r}: {d.get('status')}")
    loc = d["results"][0]["geometry"]["location"]
    return (loc["lat"], loc["lng"])


def resolve_point(api_key, spec):
    if isinstance(spec, str) and spec.startswith("addr:"):
        return geocode(api_key, spec[5:])
    return spec


def compute_route(api_key, origin, dest, departure_dt):
    body = {
        "origin": {"location": {"latLng": {"latitude": origin[0],
                                           "longitude": origin[1]}}},
        "destination": {"location": {"latLng": {"latitude": dest[0],
                                                "longitude": dest[1]}}},
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "computeAlternativeRoutes": False,
        "units": "METRIC",
    }
    if departure_dt is not None:
        body["departureTime"] = departure_dt.isoformat()
    req = urllib.request.Request(
        ROUTES_URL, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "X-Goog-Api-Key": api_key,
                 "X-Goog-FieldMask":
                     "routes.duration,routes.staticDuration,routes.distanceMeters"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise SystemExit(
            f"Routes API HTTP {e.code}: {detail}\n"
            "Hint: enable the Routes API + billing on your Google Cloud project.")
    routes = d.get("routes", [])
    if not routes:
        raise SystemExit("Routes API returned no routes.")
    r0 = routes[0]
    def secs(s): return int(s.rstrip("s")) if s else None
    return {"duration_s": secs(r0.get("duration")),
            "static_s": secs(r0.get("staticDuration")),
            "distance_m": r0.get("distanceMeters")}


def main():
    ap = argparse.ArgumentParser(description="Measure corridor congestion.")
    ap.add_argument("--api-key", default=None,
                    help="Google API key (default: $GOOGLE_API_KEY)")
    ap.add_argument("--out", default="congestion_profiles.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    api_key = args.api_key or __import__("os").environ.get("GOOGLE_API_KEY")

    probes = probe_times()
    print(f"Corridors: {len(CORRIDORS)}, probe times: {len(probes)}")
    if args.dry_run:
        for label, o, d in CORRIDORS:
            print(f"  {label}: {o} -> {d}")
        for plabel, dt in probes:
            print(f"  probe '{plabel}'"
                  + (f" at {dt.isoformat()}" if dt else " (live traffic)"))
        print(f"DRY RUN: would make {len(CORRIDORS) * len(probes)} Routes calls.")
        return
    if not api_key:
        sys.exit("Set GOOGLE_API_KEY first.")

    print("Resolving corridor endpoints ...")
    resolved = [(label, resolve_point(api_key, o), resolve_point(api_key, d))
                for label, o, d in CORRIDORS]

    out = {"generated_at": datetime.now(ET).isoformat(),
           "source": "Google Routes API: duration (traffic-aware) vs "
                     "staticDuration (free-flow)",
           "corridors": {}}
    for label, origin, dest in resolved:
        print(f"\n{label}")
        rows = []
        for plabel, dt in probes:
            res = compute_route(api_key, origin, dest, dt)
            cong = (res["duration_s"] / res["static_s"]
                    if res["duration_s"] and res["static_s"] else None)
            rows.append({"label": plabel,
                         "departure": dt.isoformat() if dt else "now",
                         "duration_s": res["duration_s"],
                         "static_s": res["static_s"],
                         "congestion": round(cong, 2) if cong else None})
            dmin = (res["duration_s"] or 0) / 60
            smin = (res["static_s"] or 0) / 60
            print(f"  {plabel:22s} {dmin:5.0f} min vs {smin:4.0f} min free-flow"
                  f"  (x{cong:.2f})" if cong else "")
            time.sleep(0.3)
        out["corridors"][label] = {
            "origin": {"lat": origin[0], "lng": origin[1]},
            "destination": {"lat": dest[0], "lng": dest[1]},
            "probes": rows}

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"\nWrote {args.out}")
    print("\nPitch lines (measured, quotable):")
    for label, c in out["corridors"].items():
        ps = {p["label"]: p for p in c["probes"]}
        fri = ps.get("Fri 5pm (Fri rush)") or {}
        sat = ps.get("Sat 10am (weekend)") or {}
        if fri.get("congestion"):
            print(f"  {label}: Friday 5pm runs {fri['congestion']}x free-flow "
                  f"({fri['duration_s']/60:.0f} vs {fri['static_s']/60:.0f} min).")


if __name__ == "__main__":
    main()

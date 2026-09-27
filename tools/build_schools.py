#!/usr/bin/env python3
"""
build_schools.py — Give SafeRoute MIA real school-zone data and make the
map highlight ALL school zones as purple circles.

What it does:
  1. Downloads every Miami-Dade County public school site (451 points)
     from the county's official ArcGIS open-data layer.
  2. Downloads grid_array.json and precomputes, for each school, the
     "r:c" grid cell used by the 1.75x school-window risk multiplier.
  3. Writes assets-ready school_zones.json:
        {"cells": ["r:c", ...], "schools": [[lat, lng], ...], "n_schools": N}
  4. --patch-app-js js/app.js
        Replaces the placeholder EMBED.schools object with the real data,
        and rewrites refreshSchoolLayer() so ALL school zones render as
        purple circles whenever the layer toggle is on (previously only
        route-intersecting zones showed, and only during school windows).
        The 1.75x risk multiplier itself stays gated on school windows
        (weekdays 7-9a & 2-4p) — that is the honest modeling, unchanged.

Usage (from your repo clone):
    python3 build_schools.py --patch-app-js js/app.js --update-json assets/data/school_zones.json

No API keys needed. Backups (*.bak) are written before any patch.
"""

import argparse
import json
import re
import shutil
import urllib.request

ARCGIS_BASE = ("https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services"
               "/SchoolSite_gdb/FeatureServer/0/query")
GRID_URL = ("https://raw.githubusercontent.com/Arom2112/Shellhacks-project"
            "/main/assets/data/grid_array.json")


def fetch_schools():
    """All M-DCPS public school sites as [(name, type, lat, lng)]."""
    schools, offset = [], 0
    while True:
        q = (f"{ARCGIS_BASE}?where=1%3D1&outFields=NAME,TYPE&returnGeometry=true"
             f"&outSR=4326&f=json&resultOffset={offset}&resultRecordCount=1000")
        d = json.load(urllib.request.urlopen(q, timeout=60))
        feats = d.get("features", [])
        if not feats:
            break
        for f in feats:
            g, a = f.get("geometry") or {}, f.get("attributes") or {}
            if "x" in g and "y" in g:
                schools.append((a.get("NAME"), a.get("TYPE"),
                                round(g["y"], 6), round(g["x"], 6)))
        print(f"  fetched {len(feats)} (total {len(schools)})")
        if len(feats) < 1000:
            break
        offset += 1000
    return schools


def fetch_grid_meta(grid_path):
    if grid_path:
        with open(grid_path, encoding="utf-8") as f:
            d = json.load(f)
    else:
        print("Downloading grid metadata ...")
        d = json.load(urllib.request.urlopen(GRID_URL, timeout=120))
    return d  # keys: rows, cols, cell, lat_min, lon_min


def cell_rc(lat, lon, meta):
    r = int((lat - meta["lat_min"]) / meta["cell"])
    c = int((lon - meta["lon_min"]) / meta["cell"])
    if 0 <= r < meta["rows"] and 0 <= c < meta["cols"]:
        return f"{r}:{c}"
    return None


OLD_LAYER_FN = '''function refreshSchoolLayer(routeSet) {
  if (schoolLayer) map.removeLayer(schoolLayer);
  schoolLayer = L.layerGroup();
  const shownRoutes = routeSet || routes;
  if (!schoolOn || !inSchoolWindow() || !shownRoutes.length) return;

  const relevant = schoolPts.filter(school => shownRoutes.some(rt =>
    distanceToRouteM(school, rt.geometry.coordinates) <= 250
  ));
  const zones = mergeSchoolZones(relevant);
  zones.forEach(zone => {
    L.circle([zone.lat, zone.lon], {radius:zone.radius, color:"#7b1fa2", weight:1.5,
      fillColor:"#7b1fa2", fillOpacity:0.13, renderer:schoolRenderer})
      .bindTooltip(`School calm zone · ${zone.members.length} school${zone.members.length === 1 ? "" : "s"} on displayed routes`, {sticky:true})
      .addTo(schoolLayer);
  });
  schoolLayer.addTo(map);
}'''

NEW_LAYER_FN = '''function refreshSchoolLayer(routeSet) {
  if (schoolLayer) map.removeLayer(schoolLayer);
  schoolLayer = L.layerGroup();
  if (!schoolOn || !schoolPts.length) return;

  // All school zones are always highlighted as purple circles. The 1.75x
  // risk multiplier in schoolMult() stays gated on school windows
  // (weekdays 7-9a & 2-4p); display and risk weighting are independent.
  const zones = mergeSchoolZones(schoolPts);
  zones.forEach(zone => {
    L.circle([zone.lat, zone.lon], {radius:zone.radius, color:"#7b1fa2", weight:1.5,
      fillColor:"#7b1fa2", fillOpacity:0.13, renderer:schoolRenderer})
      .bindTooltip(`School zone · ${zone.members.length} school${zone.members.length === 1 ? "" : "s"}`, {sticky:true})
      .addTo(schoolLayer);
  });
  schoolLayer.addTo(map);
}'''


def replace_embed_value(text, key, new_src):
    """Replace the value of `key:` inside the EMBED literal (array or object)."""
    m = re.search(r'(["\']?)' + re.escape(key) + r'\1\s*:', text)
    if not m:
        raise SystemExit(f"Could not find the '{key}' key in app.js")
    i = m.end()
    while i < len(text) and text[i] in " \t\r\n":
        i += 1
    if i >= len(text) or text[i] not in "[{":
        raise SystemExit(f"Found '{key}:' but no array/object literal follows.")
    open_ch, close_ch = text[i], "]" if text[i] == "[" else "}"
    depth, j, in_str, esc = 0, i, False, False
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
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    break
        j += 1
    if depth != 0:
        raise SystemExit(f"Unbalanced brackets while locating '{key}'.")
    return text[:i] + new_src + text[j + 1:]


def main():
    ap = argparse.ArgumentParser(description="Build real school-zone data.")
    ap.add_argument("--patch-app-js", default=None, metavar="PATH",
                    help="Patch EMBED.schools + refreshSchoolLayer in js/app.js")
    ap.add_argument("--update-json", default=None, metavar="PATH",
                    help="Write school_zones.json to this path")
    ap.add_argument("--grid", default=None, help="Local grid_array.json")
    ap.add_argument("--dry-run", action="store_true",
                    help="Fetch data and report, change nothing")
    args = ap.parse_args()

    print("Fetching Miami-Dade public schools ...")
    schools = fetch_schools()
    print(f"Total school sites: {len(schools)}")
    meta = fetch_grid_meta(args.grid)

    cells, pts = set(), []
    for _name, _type, lat, lng in schools:
        rc = cell_rc(lat, lng, meta)
        if rc:
            cells.add(rc)
        pts.append([lat, lng])
    data = {"cells": sorted(cells), "schools": pts, "n_schools": len(pts)}
    print(f"Grid cells with schools: {len(cells)}")

    with open("school_zones.json", "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print("Wrote school_zones.json")

    if args.dry_run:
        print("DRY RUN: no files patched.")
        return

    if args.update_json:
        import os
        if os.path.exists(args.update_json):
            shutil.copy2(args.update_json, args.update_json + ".bak")
        with open(args.update_json, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"Updated {args.update_json}")

    if args.patch_app_js:
        with open(args.patch_app_js, encoding="utf-8") as f:
            text = f.read()
        # 1) real data into EMBED.schools
        new_val = json.dumps(data, separators=(",", ":"))
        patched = replace_embed_value(text, "schools", new_val)
        # 2) all-zones display logic
        if patched.count(OLD_LAYER_FN) != 1:
            raise SystemExit(
                "refreshSchoolLayer source not found exactly once — app.js may "
                "have changed. Patch the EMBED data manually and ask Pep.")
        patched = patched.replace(OLD_LAYER_FN, NEW_LAYER_FN)
        shutil.copy2(args.patch_app_js, args.patch_app_js + ".bak")
        with open(args.patch_app_js, "w", encoding="utf-8") as f:
            f.write(patched)
        print(f"Patched {args.patch_app_js} (data + layer logic)")


if __name__ == "__main__":
    main()

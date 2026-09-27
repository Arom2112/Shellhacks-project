# Waymo Smooth — Comfort-aware routing for Miami-Dade

We score every road by comfort using public data, so riders — and robotaxis —
can pick the smoothest route, not just the fastest.
Built for the Waymo transportation-data track at ShellHacks 2026 (FIU).

**Live demo:** https://arom2112.github.io/Shellhacks-project/

## How it works

`route cost = time + hazard + discomfort`

- **Rough-ride heatmap** — estimated from public crash history (2016–2018),
  311 pothole reports (2023 snapshot), and school-zone activity windows.
- **Pothole clusters** — 1,525 municipal reports, clustered and mapped.
- **School zones** — 451 Miami-Dade public school sites from the county's
  official open-data layer; 1.75× risk weight on weekdays 7–9 AM & 2–4 PM.
- **Live layer** — TomTom traffic incidents re-score routes in real time;
  Google Routes provides traffic-aware ETAs; Gemini writes a plain-English
  trip briefing.
- **Measured congestion** — `tools/probe_congestion.py` queries the Google
  Routes API across corridors and times instead of assuming rush-hour
  patterns. Example: Brickell → Doral runs 1.88× free-flow on Fridays at
  5 PM (38 vs 20 min).

## Honest limitations

- Comfort is estimated from proxy data — ride vibration is not directly measured.
- Crash data ends in 2018; pothole data is a 2023 snapshot; reported potholes
  may already be repaired.
- Weights (including the 1.75× school multiplier) are prototype assumptions,
  not calibrated values.
- This is a public-data proxy model. A production version would calibrate
  continuously against vehicle IMUs and updated municipal feeds.
- Does not guarantee safety.

## Run it

Static site — open `index.html` or visit the demo link. For the live features,
paste API keys into the Demo API keys box (session-only, never committed):

- **TomTom** key (developer.tomtom.com) → live incident markers + LIVE badge
- **Google** key (Routes + Geocoding + Generative Language APIs enabled)
  → traffic-aware ETAs, congestion probing, Gemini briefs

## Tools

- `tools/build_schools.py` — fetches Miami-Dade County's official public-school
  sites and patches the app's school-zone layer. No API key needed.
- `tools/snap_potholes.py` — snaps pothole reports to the nearest road via the
  Google Roads API. Needs `GOOGLE_API_KEY`.
- `tools/probe_congestion.py` — measures corridor congestion (traffic-aware
  duration vs free-flow) across days and times; writes
  `congestion_profiles.json`. Needs `GOOGLE_API_KEY`.

## Team

- **Sebastian Mora** — [@Arom2112](https://github.com/Arom2112) — role (Backend / Tester)
- **Anthony Miller** — [@AnthonyJM916](https://github.com/AnthonyJM916) — role (API's / Frontend)
- **Lawrence Capistrano** — [@lawrencecapistrano37](https://github.com/lawrencecapistrano37) — role (Strategy / Ideas / Presentation)
- **Anthony Miller** — [@AnthonyJM916](https://github.com/AnthonyJM916) — role (Presentation / Narrative / Frontend)

## Special thanks

- **Shaina Sukhu** - for the brainstorming sessions and for bringing us together as a BC community at ShellHacks.

Built at ShellHacks 2026, Florida International University.

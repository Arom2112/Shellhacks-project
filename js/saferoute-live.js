/* ============================================================================
 * SafeRoute MIA — Live Traffic + AI Briefing (drop-in module)
 * ----------------------------------------------------------------------------
 * What it does:
 *   1. LIVE TRAFFIC — pulls real-time incidents (crashes, jams, closures,
 *      road works) from the TomTom Traffic API for the area around your
 *      routes, then adds a "live penalty" to each route's hazard score.
 *   2. AI BRIEFING — sends the safest-vs-fastest comparison to the Gemini API
 *      and gets back a plain-English briefing for the user.
 *
 * How to use: include this file with a <script> tag BEFORE your main script,
 * then follow LIVE-INTEGRATION.md (3 small paste-inside edits).
 *
 * Keys: pass them at runtime via SafeRouteLive.setKeys(). For the hackathon
 * demo, reading them from <input> fields (like the existing Google key input)
 * is fine. For anything real, put a tiny proxy on your backend (see the
 * INTEGRATION guide) and never ship keys in client JS.
 * ========================================================================== */
(function (global) {
  "use strict";

  var Live = {
    tomtomKey: "",
    geminiKey: "",
    geminiModel: "gemini-2.0-flash", // change if Google renames it
    cacheMinutes: 5,                 // incident cache lifetime
    matchRadiusM: 200,              // incident counts if within 200 m of route

    _incidentCache: { at: 0, bboxKey: "", data: [] },
    _autoTimer: null,

    /* ------------------------------- setup ------------------------------ */
    setKeys: function (keys) {
      keys = keys || {};
      if (keys.tomtom) this.tomtomKey = String(keys.tomtom).trim();
      if (keys.gemini) this.geminiKey = String(keys.gemini).trim();
      return this;
    },

    /* --------------------------- traffic: fetch -------------------------- */
    // bbox: "minLon,minLat,maxLon,maxLat"
    bboxForRoutes: function (routes, padDeg) {
      padDeg = padDeg == null ? 0.02 : padDeg; // ~2 km padding
      var minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
      routes.forEach(function (r) {
        (r.geometry.coordinates || []).forEach(function (pt) {
          if (pt[0] < minLon) minLon = pt[0];
          if (pt[0] > maxLon) maxLon = pt[0];
          if (pt[1] < minLat) minLat = pt[1];
          if (pt[1] > maxLat) maxLat = pt[1];
        });
      });
      return [minLon - padDeg, minLat - padDeg, maxLon + padDeg, maxLat + padDeg]
        .map(function (n) { return n.toFixed(5); }).join(",");
    },

    // Returns normalized incidents: [{id, category, categoryName, delay,
    // delayName, description, lat, lon, line: [[lon,lat],...] | null}]
    fetchIncidents: function (bbox) {
      var self = this;
      var now = Date.now();
      var fresh = (now - self._incidentCache.at) < self.cacheMinutes * 60 * 1000 &&
                  self._incidentCache.bboxKey === bbox;
      if (fresh) return Promise.resolve(self._incidentCache.data);
      if (!self.tomtomKey) return Promise.reject(new Error("TomTom key missing"));

      var fields = "{incidents{type,geometry{type,coordinates}," +
        "properties{id,iconCategory,magnitudeOfDelay,events{description},from,to}}}";
      var url = "https://api.tomtom.com/traffic/services/5/incidentDetails/s3/" +
        bbox + "/10/json?key=" + encodeURIComponent(self.tomtomKey) +
        "&fields=" + encodeURIComponent(fields) + "&language=en-US";

      return fetch(url).then(function (res) {
        if (!res.ok) throw new Error("TomTom incidents HTTP " + res.status);
        return res.json();
      }).then(function (payload) {
        var list = ((payload.incidents || {}).incidents) || payload.incidents || [];
        // TomTom nests incidents under payload.incidents.incidents in v5
        if (!Array.isArray(list)) list = [];
        var out = list.map(function (inc) { return self._normalizeIncident(inc); })
                      .filter(Boolean);
        self._incidentCache = { at: now, bboxKey: bbox, data: out };
        return out;
      });
    },

    _normalizeIncident: function (inc) {
      var props = inc.properties || {};
      var geom = inc.geometry || {};
      var coords = geom.coordinates || [];
      var lat = null, lon = null, line = null;
      if (geom.type === "Point" && coords.length >= 2) {
        lon = coords[0]; lat = coords[1];
      } else if ((geom.type === "LineString" || geom.type === "MultiPoint") && coords.length) {
        var flat = geom.type === "LineString" ? coords : coords;
        line = flat.filter(function (p) { return p && p.length >= 2; });
        if (line.length) {
          var mid = line[Math.floor(line.length / 2)];
          lon = mid[0]; lat = mid[1];
        }
      }
      if (lat == null) return null;
      var events = props.events || [];
      return {
        id: props.id || ("inc-" + Math.round(lat * 1e5) + "-" + Math.round(lon * 1e5)),
        category: props.iconCategory == null ? 0 : props.iconCategory,
        categoryName: Live.CATEGORY_NAMES[props.iconCategory] || "Traffic event",
        delay: props.magnitudeOfDelay == null ? 0 : props.magnitudeOfDelay,
        delayName: Live.DELAY_NAMES[props.magnitudeOfDelay] || "unknown delay",
        description: (events[0] && events[0].description) || "",
        lat: lat, lon: lon, line: line
      };
    },

    CATEGORY_NAMES: {
      0: "Traffic event", 1: "Accident", 2: "Fog", 3: "Dangerous conditions",
      4: "Rain", 5: "Ice", 6: "Traffic jam", 7: "Lane closed", 8: "Road closed",
      9: "Road works", 10: "Wind", 11: "Flooding", 12: "Detour", 13: "Cluster"
    },
    DELAY_NAMES: { 0: "unknown delay", 1: "minor delay", 2: "moderate delay", 3: "major delay", 4: "delay" },

    // Base penalty per incident category — tuned to sit alongside the static
    // hazard weights (fatal crash = 25). Tune freely.
    CATEGORY_WEIGHT: { 1: 20, 8: 20, 7: 12, 3: 10, 11: 12, 6: 8, 9: 6, 12: 6 },
    DELAY_MULT: { 0: 1.25, 1: 1, 2: 1.75, 3: 2.5, 4: 1.25 },

    /* --------------------------- traffic: score -------------------------- */
    _distPtSegM: function (px, py, ax, ay, bx, by) {
      // equirectangular approximation, fine for city-scale distances
      var R = 6371000, rad = Math.PI / 180;
      var mx = Math.cos(((py + ay + by) / 3) * rad);
      function toXY(lon, lat) { return [lon * rad * R * mx, lat * rad * R]; }
      var P = toXY(px, py), A = toXY(ax, ay), B = toXY(bx, by);
      var dx = B[0] - A[0], dy = B[1] - A[1];
      var t = dx || dy ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy) : 0;
      t = Math.max(0, Math.min(1, t));
      var cx = A[0] + t * dx, cy = A[1] + t * dy;
      return Math.hypot(P[0] - cx, P[1] - cy);
    },

    _distToRouteM: function (lon, lat, coords) {
      var best = Infinity;
      for (var i = 0; i + 1 < coords.length; i++) {
        var d = this._distPtSegM(lon, lat, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
        if (d < best) best = d;
      }
      return best;
    },

    // Adds live incident pressure to a route. Returns {penalty, hits}.
    scoreRouteLive: function (routeCoords, incidents, radiusM) {
      radiusM = radiusM || this.matchRadiusM;
      var self = this, penalty = 0, hits = [];
      (incidents || []).forEach(function (inc) {
        var d = self._distToRouteM(inc.lon, inc.lat, routeCoords);
        if (d <= radiusM) {
          var w = self.CATEGORY_WEIGHT[inc.category] || 5;
          var m = self.DELAY_MULT[inc.delay] || 1;
          var p = Math.round(w * m);
          penalty += p;
          hits.push({ incident: inc, distM: Math.round(d), penalty: p });
        }
      });
      hits.sort(function (a, b) { return b.penalty - a.penalty; });
      return { penalty: penalty, hits: hits };
    },

    /* --------------------------- traffic: map UI ------------------------- */
    // Draws incident markers. Pass your Leaflet L + map. Returns the layer
    // group — push it into your routeLayers array so clearRoutes() removes it.
    renderIncidentMarkers: function (L, map, incidents) {
      var group = L.layerGroup();
      (incidents || []).forEach(function (inc) {
        var color = inc.category === 1 || inc.category === 8 ? "#d43d2a" :
                    inc.category === 6 ? "#e8912d" : "#6b7a90";
        var marker = L.circleMarker([inc.lat, inc.lon], {
          radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95
        });
        var popup = document.createElement("div");
        var title = document.createElement("b");
        title.textContent = inc.categoryName;
        popup.appendChild(title);
        popup.appendChild(document.createTextNode(" — " + inc.delayName));
        if (inc.description) {
          popup.appendChild(document.createElement("br"));
          popup.appendChild(document.createTextNode(inc.description));
        }
        popup.appendChild(document.createElement("br"));
        var source = document.createElement("span");
        source.style.opacity = ".65";
        source.textContent = "Live via TomTom";
        popup.appendChild(source);
        marker.bindPopup(popup);
        marker.addTo(group);
      });
      group.addTo(map);
      return group;
    },

    // Updates (or creates) a "LIVE" badge element. Add <span id="liveBadge">
    // wherever you want it (see INTEGRATION guide).
    updateLiveBadge: function (incidents) {
      var el = document.getElementById("liveBadge");
      if (!el) return;
      var t = new Date();
      var hh = String(t.getHours()).padStart(2, "0"), mm = String(t.getMinutes()).padStart(2, "0");
      el.innerHTML = '<span class="live-dot"></span>LIVE TRAFFIC · ' +
        incidents.length + ' incidents · updated ' + hh + ':' + mm;
      el.classList.add("on");
    },

    /* ------------------------- auto-refresh loop ------------------------- */
    // Re-polls incidents every N minutes and calls onUpdate(incidents).
    // Your handler decides what to do (re-score, re-render). Returns stop fn.
    startAutoRefresh: function (onUpdate, minutes) {
      var self = this;
      self.stopAutoRefresh();
      self._autoTimer = setInterval(function () {
        self._incidentCache.at = 0; // force fresh pull
        var evt = new CustomEvent("saferoute:refresh-live");
        document.dispatchEvent(evt);
        if (onUpdate) onUpdate(evt);
      }, (minutes || self.cacheMinutes) * 60 * 1000);
      return function () { self.stopAutoRefresh(); };
    },
    stopAutoRefresh: function () {
      if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
    },

    /* ------------------------------ AI brief ----------------------------- */
    // Builds a rider-friendly briefing from the comparison. Returns text.
    briefComparison: function (opts) {
      var self = this;
      if (!self.geminiKey) return Promise.reject(new Error("Gemini key missing"));
      opts = opts || {};
      var s = opts.safest || {}, f = opts.fastest || {};
      function fmt(r) {
        return "- duration: " + Math.round((r.duration || 0) / 60) + " min, " +
          "distance: " + ((r.distance || 0) / 1609.34).toFixed(1) + " mi, " +
          "hazard score: " + Math.round(r.hazard || 0) +
          (r.livePenalty ? " (incl. +" + r.livePenalty + " live traffic)" : "") +
          (r.liveHits && r.liveHits.length ? ", live incidents on route: " +
            r.liveHits.slice(0, 3).map(function (h) {
              return h.incident.categoryName + " (" + h.incident.delayName + ")";
            }).join("; ") : ", no live incidents on route");
      }
      var prompt =
        "You are the safety copilot for SafeRoute MIA, a Miami driving-safety app. " +
        "Two route options were scored using historical crash data, 311 pothole reports, " +
        "and LIVE traffic incidents from TomTom. Write a 2-3 sentence briefing for the driver " +
        "comparing them, then one short line recommending which to take and why. " +
        "Be concrete (name the incident types). No fluff, no disclaimers.\n\n" +
        "SAFEST ROUTE:\n" + fmt(s) + "\n\nFASTEST ROUTE:\n" + fmt(f) +
        (s === f || (s.hazard === f.hazard && s.duration === f.duration)
          ? "\n\nNote: the safest and fastest route are the same."
          : "");

      var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(self.geminiModel) + ":generateContent?key=" +
        encodeURIComponent(self.geminiKey);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 220 }
        })
      }).then(function (res) {
        if (!res.ok) throw new Error("Gemini HTTP " + res.status);
        return res.json();
      }).then(function (data) {
        var t = data && data.candidates && data.candidates[0] &&
                data.candidates[0].content && data.candidates[0].content.parts &&
                data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        if (!t) throw new Error("Gemini returned no text");
        return t.trim();
      });
    },

    // Wraps briefing text in a card matching the demo's route-card style.
    briefingCardHTML: function (text) {
      var safe = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      return '<div class="route-card ai-brief">' +
        '<span class="route-head"><span class="route-name">AI Safety Brief</span>' +
        '<span class="badges"><span class="badge ai">GEMINI</span></span></span>' +
        '<span class="route-meta ai-text">' + safe + "</span></div>";
    }
  };

  global.SafeRouteLive = Live;
})(window);

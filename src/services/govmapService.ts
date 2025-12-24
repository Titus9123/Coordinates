import { GOVMAP_BASE_URL, DEBUG_GEO } from "../constants";

export interface GovmapResult {
  lat: number;
  lon: number;
  source: "govmap";
}

/**
 * Geocoding real usando GovMap (REST API).
 * In development, uses local proxy with POST JSON to avoid encoding issues.
 * In production, uses direct GovMap API.
 * Intenta devolver WGS84 (lat/lon) gracias a outSR=4326.
 */
export async function geocodeWithGovmap(
  normalizedAddress: string
): Promise<GovmapResult | null> {
  if (!normalizedAddress) return null;

  const trimmedAddress = normalizedAddress.trim();
  if (!trimmedAddress) return null;

  // In development, use local proxy with POST JSON
  if (import.meta.env.DEV) {
    return geocodeWithProxy(trimmedAddress);
  }

  // In production, use direct GovMap API
  const url =
    `${GOVMAP_BASE_URL}?` +
    `SingleLine=${encodeURIComponent(trimmedAddress)}` +
    `&f=json` +
    `&outFields=*` +
    `&lang=HE` +
    `&maxLocations=1` +
    `&outSR=4326`;

  try {
    // Add timeout to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorBody = await resp.clone().text().catch(() => "");
      console.error("GovMap HTTP error", {
        status: resp.status,
        statusText: resp.statusText,
        url,
        errorBody: errorBody || "(empty)",
      });
      return null;
    }

    const data = await resp.json();

    if (
      !data ||
      !Array.isArray(data.candidates) ||
      data.candidates.length === 0
    ) {
      return null;
    }

    const best = data.candidates[0];
    const loc = best.location;
    if (!loc || typeof loc.x !== "number" || typeof loc.y !== "number") {
      return null;
    }

    const lon = loc.x; // WGS84 porque pedimos outSR=4326
    const lat = loc.y;

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return null;
    }

    return {
      lat,
      lon,
      source: "govmap",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("GovMap geocoding timeout (8s)");
    } else {
      console.error("GovMap geocoding error:", err);
    }
    return null;
  }
}

/**
 * Geocoding using local dev proxy with POST JSON (encoding-safe for Hebrew).
 * Falls back to GET if POST fails.
 */
async function geocodeWithProxy(
  normalizedAddress: string
): Promise<GovmapResult | null> {
  const proxyUrl = "/api/govmap/geocode";
  let method = "POST";

  try {
    // Try POST first (encoding-safe)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let resp = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: normalizedAddress }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // If POST fails, fallback to GET
    if (!resp.ok) {
      method = "GET";
      const getUrl = `${proxyUrl}?q=${encodeURIComponent(normalizedAddress)}`;
      const getController = new AbortController();
      const getTimeoutId = setTimeout(() => getController.abort(), 8000);

      resp = await fetch(getUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal: getController.signal,
      });

      clearTimeout(getTimeoutId);
    }

    if (!resp.ok) {
      if (DEBUG_GEO) {
        console.log(`GOVMAP_CALL: ${method} failed, status=${resp.status}, queryLength=${normalizedAddress.length}`);
      }
      return null;
    }

    const data = await resp.json();

    // Handle proxy response format: { results: [{ Lat, Lon, ... }] }
    if (data && Array.isArray(data.results) && data.results.length > 0) {
      const best = data.results[0];
      if (
        typeof best.Lat === "number" &&
        typeof best.Lon === "number" &&
        !Number.isNaN(best.Lat) &&
        !Number.isNaN(best.Lon)
      ) {
        if (DEBUG_GEO) {
          console.log(`GOVMAP_CALL: ${method} succeeded, queryLength=${normalizedAddress.length}, resultsCount=${data.results.length}`);
        }
        return {
          lat: best.Lat,
          lon: best.Lon,
          source: "govmap",
        };
      }
    }

    if (DEBUG_GEO) {
      console.log(`GOVMAP_CALL: ${method} returned empty results, queryLength=${normalizedAddress.length}`);
    }
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Try GET fallback on timeout
      try {
        const getUrl = `${proxyUrl}?q=${encodeURIComponent(normalizedAddress)}`;
        const resp = await fetch(getUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (resp.ok) {
          const data = await resp.json();
          if (data && Array.isArray(data.results) && data.results.length > 0) {
            const best = data.results[0];
            if (
              typeof best.Lat === "number" &&
              typeof best.Lon === "number" &&
              !Number.isNaN(best.Lat) &&
              !Number.isNaN(best.Lon)
            ) {
              if (DEBUG_GEO) {
                console.log(`GOVMAP_CALL: GET fallback succeeded, queryLength=${normalizedAddress.length}, resultsCount=${data.results.length}`);
              }
              return {
                lat: best.Lat,
                lon: best.Lon,
                source: "govmap",
              };
            }
          }
        }
      } catch (fallbackErr) {
        // Ignore fallback errors
      }
    }
    if (DEBUG_GEO) {
      console.log(`GOVMAP_CALL: All attempts failed, queryLength=${normalizedAddress.length}`);
    }
    return null;
  }
}

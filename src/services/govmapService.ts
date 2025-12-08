export interface GovmapResult {
  lat: number;
  lon: number;
  source: "govmap";
}

/**
 * Geocoding real usando GovMap (REST API).
 * Intenta devolver WGS84 (lat/lon) gracias a outSR=4326.
 */
export async function geocodeWithGovmap(
  normalizedAddress: string
): Promise<GovmapResult | null> {
  if (!normalizedAddress) return null;

  const endpoint =
    "https://govmap.gov.il/arcgis/rest/services/Location/FindLocation/GeocodeServer/findAddressCandidates";

  const url =
    `${endpoint}?` +
    `SingleLine=${encodeURIComponent(normalizedAddress)}` +
    `&f=json` +
    `&outFields=*` +
    `&lang=HE` +
    `&maxLocations=1` +
    `&outSR=4326`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      console.error("GovMap HTTP error", resp.status);
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
    console.error("GovMap geocoding error:", err);
    return null;
  }
}

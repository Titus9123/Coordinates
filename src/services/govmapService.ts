export interface GovmapResult {
  lat: number;
  lon: number;
  source: "govmap";
}

export async function geocodeWithGovmap(
  normalizedAddress: string
): Promise<GovmapResult | null> {
  // For now, return null or a stub.
  // Later this can use the global window.govmap API if available.
  // Usage of normalizedAddress to suppress unused variable warning
  if (!normalizedAddress) return null;
  return null;
}
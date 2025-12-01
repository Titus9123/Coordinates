export function getAddressFromRow(data: Record<string, any>): string {
  // Heuristic to find relevant columns
  const keys = Object.keys(data);
  
  const streetKey = keys.find(k => /רחוב|street/i.test(k));
  const numberKey = keys.find(k => /בית|מספר|number|house/i.test(k) && !/phone|טלפון/i.test(k));
  const cityKey = keys.find(k => /עיר|city|יישוב/i.test(k));
  const neighborhoodKey = keys.find(k => /שכונה|neighborhood/i.test(k));

  let addressParts: string[] = [];

  if (streetKey && data[streetKey]) addressParts.push(String(data[streetKey]));
  if (numberKey && data[numberKey]) addressParts.push(String(data[numberKey]));
  if (neighborhoodKey && data[neighborhoodKey]) addressParts.push(String(data[neighborhoodKey]));
  
  // Default to Netivot if no city is found or if it's explicitly Netivot
  if (cityKey && data[cityKey]) {
    addressParts.push(String(data[cityKey]));
  } else {
    // If city is missing, we assume Netivot for the context of this app
    addressParts.push("נתיבות");
  }

  return addressParts.join(" ");
}

export function normalizeAddress(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  // Cleanup: remove extra spaces, unify punctuation
  let normalized = raw.trim().replace(/\s+/g, " ").replace(/,+/g, ",");

  // Basic validation heuristics
  
  // Check if it has at least a street name and a number
  // Pattern: Hebrew/Chars followed by digits
  const hasNumber = /\d+/.test(normalized);
  const tokenCount = normalized.split(" ").length;

  // Very loose filtering:
  // Must have at least 2 words (e.g. "Street 5") and contain a digit.
  // Exception: "CityName" alone is invalid.
  
  if (!hasNumber || tokenCount < 2) {
      return null;
  }

  return normalized;
}
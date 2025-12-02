// ---------------------------------------------
// Helpers
// ---------------------------------------------

/**
 * Encuentra la key original en el objeto `data` usando una función
 * de predicado sobre la versión normalizada (trim + lowercase).
 */
function findKeyByPattern(
  data: Record<string, any>,
  matcher: (canonical: string) => boolean
): string | undefined {
  for (const key of Object.keys(data)) {
    const canonical = key.trim().toLowerCase();
    if (matcher(canonical)) {
      return key;
    }
  }
  return undefined;
}

/**
 * Aplica reemplazos simples basados en patrones conocidos.
 * Esto es específico para Netivot y sus barrios.
 */
function applyReplacementDictionary(value: string): string {
  let result = value;

  const replacements: Array<[RegExp, string]> = [
    // Variantes de "מערב נתיבות"
    [/\bמערב[-\s]*נתיבות\b/g, "נתיבות"],
    [/\bנתיבות[-\s]*מערב\b/g, "נתיבות"],

    // Barrios de Netivot (mantener nombre pero asegurar ciudad luego)
    [/\bקרית מנחם\b/g, "קרית מנחם"],
    [/\bקריית מנחם\b/g, "קרית מנחם"],
    [/\bשכו'? ?החורש\b/g, "שכונת החורש"],
    [/\bהחורש\b/g, "שכונת החורש"],
    [/\bנווה נוי\b/g, "נווה נוי"],
    [/\bנווה שרון\b/g, "נווה שרון"],

    // Errores comunes de transliteración / escritura (ejemplos)
    [/\bתילתן\b/g, "תלתן"],
  ];

  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Limpia prefijos redundantes como "רחוב" o "רח'".
 */
function stripStreetPrefixes(value: string): string {
  return value.replace(/^\s*(רחוב|רח'|רח)\s+/g, "");
}

/**
 * Normaliza espacios y comas.
 */
function normalizeWhitespaceAndCommas(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/,+/g, ",")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

// ---------------------------------------------
// Address extraction from row (fixed & clean)
// ---------------------------------------------
export function getAddressFromRow(data: Record<string, any>): string {
  // Encontrar las keys reales usando el objeto original (no lowercase)
  const streetKey = findKeyByPattern(data, k =>
    /(רחוב|רח'|כתובת|street)/i.test(k)
  );

  const numberKey = findKeyByPattern(
    data,
    k => /(מספר|בית|num|number|house)/i.test(k) && !/(טלפון|phone)/i.test(k)
  );

  const cityKey = findKeyByPattern(data, k => /(עיר|city)/i.test(k));

  const neighborhoodKey = findKeyByPattern(data, k =>
    /(שכונה|neighborhood)/i.test(k)
  );

  const parts: string[] = [];

  if (streetKey && data[streetKey]) {
    parts.push(String(data[streetKey]).trim());
  }

  if (numberKey && data[numberKey]) {
    parts.push(String(data[numberKey]).trim());
  }

  if (neighborhoodKey && data[neighborhoodKey]) {
    parts.push(String(data[neighborhoodKey]).trim());
  }

  // City fallback logic
  if (cityKey && data[cityKey]) {
    parts.push(String(data[cityKey]).trim());
  } else {
    // Por defecto asumimos Netivot si no se especifica ciudad
    parts.push("נתיבות");
  }

  // Unir en una sola cadena y hacer una primera limpieza básica
  const rawAddress = parts.join(" ").trim();

  return normalizeAddress(rawAddress) ?? rawAddress;
}

// ---------------------------------------------
// Address normalization (Netivot-focused logic)
// ---------------------------------------------
export function normalizeAddress(raw: string): string | null {
  if (!raw) return null;

  // 1) Limpieza básica
  let normalized = raw.trim();
  if (!normalized) return null;

  normalized = normalizeWhitespaceAndCommas(normalized);

  // 2) Aplicar diccionario de reemplazos conocidos (barrios, variantes, etc.)
  normalized = applyReplacementDictionary(normalized);

  // 3) Quitar prefijos de calle redundantes
  normalized = stripStreetPrefixes(normalized);

  // 4) Asegurar presencia de "נתיבות" cuando hay barrios de Netivot
  const hasNetivot = /נתיבות/.test(normalized);
  const hasNetivotNeighborhood = /(נווה נוי|נווה שרון|קרית מנחם|קריית מנחם|שכונת החורש)/.test(
    normalized
  );

  if (!hasNetivot && hasNetivotNeighborhood) {
    normalized = `${normalized} נתיבות`;
  }

  // 5) Evitar duplicados tipo "נתיבות נתיבות"
  normalized = normalized.replace(/\b(נתיבות)(?:\s+\1)+\b/g, "נתיבות");

  // 6) Forzar formato "רחוב מספר, נתיבות" cuando hay número y Netivot
  const hasNumber = /\d+/.test(normalized);

  if (hasNumber && /נתיבות/.test(normalized)) {
    // Ej: "שליו 2 נתיבות" -> "שליו 2, נתיבות"
    normalized = normalized.replace(
      /^(.+?\d+)\s+(נתיבות.*)$/,
      (_match, addrPart, cityPart) => {
        return `${String(addrPart).trim()}, ${String(cityPart).trim()}`;
      }
    );
  }

  // 7) Detección de direcciones incompletas
  //    Regla dura del negocio:
  //    - Si es solo ciudad ("נתיבות") o solo nombre de calle sin número,
  //      NO geocodificar → devolver null para que la app marque
  //      "חסרה כתובת מלאה" y deje lat/lon vacíos.

  const hebrewOnly = /^[\u0590-\u05FF\s'"-]+$/;

  if (hebrewOnly.test(normalized) && !hasNumber) {
    // Ejemplos: "נתיבות", "הרב צבאן", "קרית מנחם נתיבות"
    return null;
  }

  // 8) Si no hay ningún token útil, consideramos que no hay dirección
  const tokenCount = normalized.split(" ").filter(Boolean).length;
  if (tokenCount === 0) {
    return null;
  }

  return normalized;
}

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
 * Esto es específico para Netivot y sus variantes de escritura.
 *
 * Importante: aquí NO agregamos barrios, solo corregimos cosas como
 * errores de escritura de calles u orden de palabras.
 */
function applyReplacementDictionary(value: string): string {
  let result = value;

  const replacements: Array<[RegExp, string]> = [
    // Variantes de "מערב נתיבות" -> solo ciudad
    [/\bמערב[-\s]*נתיבות\b/g, "נתיבות"],
    [/\bנתיבות[-\s]*מערב\b/g, "נתיבות"],

    // Errores comunes de escritura de calles
    [/\bתילתן\b/g, "תלתן"],
  ];

  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Unified street name normalization function.
 * 
 * This function normalizes street names for consistent matching across:
 * - GIS lookup (gisService.ts)
 * - Batch processing (normalizeAddress / extractStreetAndNumber)
 * - UI street search (GISService.searchStreets)
 * - Nominatim query building (hybridGeocoder.ts, geocoding.ts)
 * 
 * Rules applied in order:
 * 1. Trim and collapse whitespace
 * 2. Replace punctuation separators with spaces
 * 3. Remove quotes and apostrophes
 * 4. Normalize Hebrew abbreviation prefixes
 * 5. Remove leading street prefixes (only at start)
 * 6. Final trim and collapse whitespace
 * 
 * Does NOT lowercase Hebrew text (only latin characters if present).
 * Does NOT add fuzzy logic or synonym maps.
 */
export function normalizeStreetText(input: string): string {
  if (!input) return "";
  
  // Step 1: Trim and collapse whitespace
  let normalized = input.trim().replace(/\s+/g, " ");
  
  // Step 2: Replace punctuation separators with spaces
  // Convert "-", "–", "—", "/", "\" into spaces
  normalized = normalized.replace(/[-–—\/\\]/g, " ");
  
  // Step 3: Remove quotes and apostrophes: ", ', ׳, ״
  normalized = normalized.replace(/["'׳״]/g, "");
  
  // Step 4: Normalize Hebrew abbreviation prefixes at the start of tokens
  // Replace "רח'" with "רחוב"
  normalized = normalized.replace(/\bרח'/g, "רחוב");
  // Replace "שכ'" with "שכונת"
  normalized = normalized.replace(/\bשכ'/g, "שכונת");
  
  // Step 5: Remove leading street prefixes only when they appear as standalone tokens at the beginning
  // If the string starts with "רחוב " remove that token
  normalized = normalized.replace(/^רחוב\s+/g, "");
  // If it starts with "רח " remove that token
  normalized = normalized.replace(/^רח\s+/g, "");
  
  // Step 6: Final trim and collapse whitespace again
  normalized = normalized.replace(/\s+/g, " ").trim();
  
  // Step 7: Lowercase latin characters only (do NOT lowercase Hebrew)
  // Split into characters, lowercase only latin (a-z, A-Z), keep Hebrew as-is
  normalized = normalized.replace(/[a-zA-Z]/g, (char) => char.toLowerCase());
  
  return normalized;
}

/**
 * Limpia prefijos redundantes como "רחוב" o "רח'".
 * 
 * NOTE: This function is kept for backward compatibility with normalizeAddress().
 * For new code, use normalizeStreetText() instead.
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

/**
 * Lista agresiva de patrones de barrios / zonas de נתיבות
 * que deben ser ELIMINADOS de la parte de dirección antes del geocoding.
 *
 * La ciudad "נתיבות" NO se elimina nunca aquí.
 */
const NEIGHBORHOOD_PATTERNS: RegExp[] = [
  // נווה נוי
  /\bנווה נוי\b/g,
  /\bנווה[-\s]*נוי\b/g,
  /\bנוה נוי\b/g,
  /\bנ"י\b/g,

  // נווה שרון
  /\bנווה שרון\b/g,
  /\bנווה[-\s]*שרון\b/g,
  /\bנוה שרון\b/g,
  /\bשכונת נווה שרון\b/g,
  /\bנ"ש\b/g,

  // קרית מנחם
  /\bקרית מנחם\b/g,
  /\bקריית מנחם\b/g,
  /\bקרית[-\s]*מנחם\b/g,
  /\bקמ\b/g,

  // מערב נתיבות / השכונה המערבית
  /\bמערב נתיבות\b/g,
  /\bנתיבות מערב\b/g,
  /\bמערב[-\s]*נתיבות\b/g,
  /\bהשכונה המערבית\b/g,
  /\bשכונה מערבית\b/g,
  /\bש"מ\b/g,

  // החורש
  /\bשכונת החורש\b/g,
  /\bשכו'? ?החורש\b/g,
  /\bשכ'? ?החורש\b/g,
  /\bהחורשה\b/g,
  // "החורש" o "חורש" como barrio (no como calle)
  /\bהחורש\b/g,
  /\bחורש\b/g,

  // נטעים
  /\bנטעים נתיבות\b/g,
  /\bאזור נטעים\b/g,
  /\bשכונת נטעים\b/g,
  /\bנטעים[-\s]*נתיבות\b/g,
  /\bנטעים\b/g,

  // נווה אביב
  /\bנווה אביב\b/g,
  /\bנוה אביב\b/g,
  /\bשכונת נווה אביב\b/g,
  /\bאביב נתיבות\b/g,

  // יוספטל
  /\bיוספטל דרום\b/g,
  /\bשכונת יוספטל\b/g,
  /\bיוספטל\b/g,
  /\bש"י\b/g,

  // גבעת בית ואן
  /\bגבעת בית ואן\b/g,
  /\bבית ואן\b/g,
  /\bגבעת בון\b/g,

  // רמות יורם
  /\bרמות יורם\b/g,
  /\bשכונת רמות יורם\b/g,
  /\bיורם\b/g,
];

/**
 * Elimina nombres de barrios conocidos de Netivot de la parte de dirección.
 * La ciudad "נתיבות" se maneja por separado y NUNCA se elimina aquí.
 */
function stripNeighborhoodTokens(value: string): string {
  let result = value;

  for (const pattern of NEIGHBORHOOD_PATTERNS) {
    result = result.replace(pattern, " ");
  }

  return normalizeWhitespaceAndCommas(result);
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

  // A PROPÓSITO ignoramos el barrio en la dirección que se manda
  // a geocoding. Solo nos interesa: calle + número + נתיבות.
  // Si en el Excel hay columna de barrio, se puede usar en UI, pero no aquí.
  // const neighborhoodKey = findKeyByPattern(data, k =>
  //   /(שכונה|neighborhood)/i.test(k)
  // );

  const parts: string[] = [];

  if (streetKey && data[streetKey]) {
    parts.push(String(data[streetKey]).trim());
  }

  if (numberKey && data[numberKey]) {
    parts.push(String(data[numberKey]).trim());
  }

  // Ignoramos explícitamente el barrio en la cadena base:
  // if (neighborhoodKey && data[neighborhoodKey]) {
  //   parts.push(String(data[neighborhoodKey]).trim());
  // }

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

  // 2) Aplicar diccionario de reemplazos conocidos (variantes, etc.)
  normalized = applyReplacementDictionary(normalized);

  // 3) Quitar prefijos de calle redundantes
  normalized = stripStreetPrefixes(normalized);

  // 4) Si no aparece "נתיבות", no aplicamos lógica especial de Netivot.
  // Esto evita romper direcciones de otras ciudades.
  if (!/נתיבות/.test(normalized)) {
    return normalized;
  }

  // 5) Tomamos SIEMPRE la ÚLTIMA ocurrencia de "נתיבות" como ciudad.
  const lastIndex = normalized.lastIndexOf("נתיבות");
  if (lastIndex === -1) {
    return normalized;
  }

  let addressPart = normalized.slice(0, lastIndex).trim();
  const cityPart = "נתיבות";

  // 6) Eliminar tokens de barrios CONOCIDOS de la parte de dirección.
  // Queremos solo: calle + número.
  addressPart = stripNeighborhoodTokens(addressPart);

  // 7) Limpiar comas y espacios redundantes otra vez
  addressPart = normalizeWhitespaceAndCommas(addressPart);
  addressPart = addressPart.replace(/[,\s]+$/, "");

  // 7.1) Manejar rangos de número de casa del tipo "9-11", "11-9", "6-8".
  // Convertimos el rango a su punto medio para geocoding.
  const rangeMatch = addressPart.match(/^(.+?)\s+(\d+)\s*-\s*(\d+)\s*$/);
  if (rangeMatch) {
    const streetBase = rangeMatch[1].trim();
    const start = parseInt(rangeMatch[2], 10);
    const end = parseInt(rangeMatch[3], 10);

    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      const middle = Math.round((start + end) / 2);
      addressPart = `${streetBase} ${middle}`;
    }
  }

  // 7.2) Quitar sufijos de departamento tipo "13/1", "13 / 01" al final.
  // Nos quedamos solo con el número principal de la casa.
  addressPart = addressPart.replace(/(\d+)\s*\/\s*\d+\s*$/, "$1");

  // 8) Mantener solo hasta el ÚLTIMO número encontrado.
  // Esto corta cualquier texto basura después del número
  // (ej: "חיל הנדסה 18 נטעים").
  const upToLastNumberMatch = addressPart.match(/^(.*\d+)/);
  if (upToLastNumberMatch) {
    addressPart = upToLastNumberMatch[1].trim();
  }

  // 9) Extraer calle y número.
  // Formato esperado: "<calle> <número>"
  const streetNumberMatch = addressPart.match(/^(.+?)\s+(\d+)\s*$/);
  if (!streetNumberMatch) {
    // No hay número → dirección incompleta.
    // La app, al recibir null, debe marcar "חסרה כתובת מלאה" y dejar lat/lon vacíos.
    return null;
  }

  const streetRaw = streetNumberMatch[1].trim();
  const houseNumber = streetNumberMatch[2].trim();

  if (!streetRaw || !houseNumber) {
    return null;
  }

  // Normalize street name using unified normalizeStreetText() for consistency
  const street = normalizeStreetText(streetRaw);

  // 10) Construir el formato FINAL para geocoding:
  // SOLO calle + número + Netivot (como definimos).
  const finalAddress = `${street} ${houseNumber}, ${cityPart}`;

  return finalAddress;
}

// ---------------------------------------------
// New helper: extract street & number for UI
// ---------------------------------------------

/**
 * Extrae calle y número de una dirección (normalizada o cruda).
 *
 * Ejemplos:
 *  "התאנה 2, נתיבות"        -> { street: "התאנה", number: "2" }
 *  "נווה נוי, ערבה 4, נתיבות" -> { street: "ערבה",   number: "4" }
 *  "הרב מזוז 8"              -> { street: "הרב מזוז", number: "8" }
 *  "הרב צבאן"                -> { street: "הרב צבאן", number: null }
 */
export function extractStreetAndNumber(
  rawAddress: string
): { street: string; number: string | null } {
  if (!rawAddress) {
    return { street: "", number: null };
  }

  // 1) Normalizar espacios y comas
  let value = normalizeWhitespaceAndCommas(rawAddress);

  // 2) Quitar ciudad al final tipo ", נתיבות" o variantes similares
  value = value.replace(/,\s*נתיבות.*$/g, "").trim();

  // 3) Si hay varias partes separadas por coma, nos quedamos con la última
  // relevante (normalmente "רחוב מספר", después del barrio).
  const partsByComma = value.split(",");
  let mainPart = partsByComma[partsByComma.length - 1].trim();
  if (!mainPart && partsByComma.length > 1) {
    // fallback: si la última está vacía por algún motivo, usar la anterior
    mainPart = partsByComma[partsByComma.length - 2].trim();
  }

  // 4) Quitar prefijos de calle (רחוב, רח', רח)
  mainPart = stripStreetPrefixes(mainPart);

  // 5) Eliminar tokens de barrios conocidos si se colaron aquí
  mainPart = stripNeighborhoodTokens(mainPart);

  // 6) Normalizar otra vez por si quedó algo raro
  mainPart = normalizeWhitespaceAndCommas(mainPart);

  if (!mainPart) {
    return { street: "", number: null };
  }

  // 7) Dividir por espacios y analizar el último token
  const tokens = mainPart.split(/\s+/);
  const last = tokens[tokens.length - 1];

  // Números tipo "12" o "12א"
  const numberRegex = /^\d+[א-ת]?$/

  if (numberRegex.test(last)) {
    const streetNameRaw = tokens.slice(0, -1).join(" ").trim();
    const number = last.trim();
    if (!streetNameRaw) {
      // Caso raro: solo número, lo tratamos como sin calle
      return { street: "", number: number };
    }
    // Use normalizeStreetText() for consistent street name normalization
    const streetName = normalizeStreetText(streetNameRaw);
    return { street: streetName, number };
  }

  // 8) Si no hay número claro, devolvemos todo como calle (normalized)
  return { street: normalizeStreetText(mainPart), number: null };
}

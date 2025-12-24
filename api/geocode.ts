// api/geocode.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Minimal geocoding proxy to bypass browser CORS.
 * Supports:
 * - provider=govmap | nominatim | auto
 * - q=<query>
 *
 * Security:
 * - basic input validation
 * - short timeout
 * - small cache (in-memory)
 * - simple IP rate limiting (best-effort)
 */

type Provider = "govmap" | "nominatim" | "auto";

const GOVMAP_URL =
  "https://govmap.gov.il/arcgis/rest/services/Location/FindLocation/GeocodeServer/findAddressCandidates";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// --- tiny in-memory cache (best effort) ---
const CACHE_TTL_MS = 60_000; // 60s
const cache = new Map<string, { expires: number; body: any }>();

// --- best-effort rate limit ---
const WINDOW_MS = 60_000; // 60s
const MAX_REQ_PER_WINDOW = 60;
const hits = new Map<string, { reset: number; count: number }>();

function getClientIp(req: VercelRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return (req.socket?.remoteAddress || "unknown").toString();
}

function rateLimit(ip: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { reset: now + WINDOW_MS, count: 1 });
    return { ok: true, retryAfterSec: 0 };
  }
  rec.count += 1;
  if (rec.count > MAX_REQ_PER_WINDOW) {
    const retryAfterSec = Math.max(1, Math.ceil((rec.reset - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true, retryAfterSec: 0 };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        body: json ?? text,
      };
    }
    return { ok: true, status: res.status, body: json };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS for your own frontend (safe because it's your domain endpoint)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterSec: rl.retryAfterSec });
  }

  const providerRaw = String(req.query.provider || "auto").toLowerCase();
  const provider: Provider =
    providerRaw === "govmap" || providerRaw === "nominatim" || providerRaw === "auto"
      ? (providerRaw as Provider)
      : "auto";

  const q = String(req.query.q || "").trim();
  if (!q || q.length < 2) return res.status(400).json({ error: "Missing/invalid q" });
  if (q.length > 200) return res.status(400).json({ error: "q too long" });

  const cacheKey = `${provider}:${q}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now) return res.status(200).json(cached.body);

  // --- provider implementations ---
  const lang = String(req.query.lang || "he").toLowerCase() === "en" ? "EN" : "HE";

  if (provider === "govmap" || provider === "auto") {
    const u = new URL(GOVMAP_URL);
    u.searchParams.set("SingleLine", q);
    u.searchParams.set("f", "json");
    u.searchParams.set("outFields", "*");
    u.searchParams.set("lang", lang);
    u.searchParams.set("maxLocations", "1");
    u.searchParams.set("outSR", "4326");

    const resp = await fetchJson(
      u.toString(),
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          // keep UA simple; govmap doesn't require special UA
        },
      },
      8000
    );

    if (resp.ok) {
      const body = { provider: "govmap", data: resp.body };
      cache.set(cacheKey, { expires: now + CACHE_TTL_MS, body });
      return res.status(200).json(body);
    }

    if (provider === "govmap") {
      return res.status(502).json({ provider: "govmap", error: resp });
    }
    // provider=auto → fall through to nominatim
  }

  // Nominatim: must send a valid User-Agent/Referer-ish headers
  const u2 = new URL(NOMINATIM_URL);
  u2.searchParams.set("q", q);
  u2.searchParams.set("format", "json");
  u2.searchParams.set("limit", "1");
  u2.searchParams.set("addressdetails", "1");
  u2.searchParams.set("accept-language", "he");
  u2.searchParams.set("countrycodes", "il");

  const resp2 = await fetchJson(
    u2.toString(),
    {
      method: "GET",
      headers: {
        "Accept": "application/json",
        // IMPORTANT for Nominatim
        "User-Agent": "coordinates-netivot-fixer/1.0 (contact: github.com/Titus9123/Coordinates)",
      },
    },
    8000
  );

  if (resp2.ok) {
    const body = { provider: "nominatim", data: resp2.body };
    cache.set(cacheKey, { expires: now + CACHE_TTL_MS, body });
    return res.status(200).json(body);
  }

  return res.status(502).json({ provider: "nominatim", error: resp2 });
}

import "dotenv/config";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";

const USER_AGENT = "MyPetsDiscoveryBot/1.0 (+https://mypets.lat)";
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

function isPrivateIp(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  }
  return true;
}

async function assertPublicHost(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are allowed");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("Local hosts are not allowed");
  if (net.isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new Error("Private IPs are not allowed");
    return;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error("Host resolves to a private or invalid address");
}

async function safeFetch(input: URL, init: RequestInit = {}) {
  let current = new URL(input);
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    await assertPublicHost(current);
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect without location");
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

function rulesForUserAgent(robots: string, userAgent: string) {
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[] } | null = null;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || current.disallow.length || current.allow.length) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && key === "disallow") current.disallow.push(value);
    else if (current && key === "allow") current.allow.push(value);
  }
  const exact = groups.filter((group) => group.agents.includes(userAgent.toLowerCase()));
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  return exact.length ? exact : wildcard;
}

async function robotsAllows(url: URL) {
  const robotsUrl = new URL("/robots.txt", url.origin);
  try {
    const { response } = await safeFetch(robotsUrl, { headers: { accept: "text/plain,*/*;q=0.1" } });
    if (response.status === 404) return true;
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) return true;
    const text = await response.text();
    const groups = rulesForUserAgent(text, "mypetsdiscoverybot");
    if (!groups.length) return true;
    const path = `${url.pathname}${url.search}`;
    let winner: { allowed: boolean; length: number } | null = null;
    for (const group of groups) {
      for (const rule of group.disallow) {
        if (!rule || !path.startsWith(rule)) continue;
        if (!winner || rule.length > winner.length) winner = { allowed: false, length: rule.length };
      }
      for (const rule of group.allow) {
        if (!rule || !path.startsWith(rule)) continue;
        if (!winner || rule.length >= winner.length) winner = { allowed: true, length: rule.length };
      }
    }
    return winner?.allowed ?? true;
  } catch {
    return true;
  }
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function meta(html: string, key: string, property = false) {
  const attr = property ? "property" : "name";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1].trim());
  }
  return null;
}

function titleOf(html: string) {
  const ogTitle = meta(html, "og:title", true);
  if (ogTitle) return ogTitle;
  const documentTitle = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "");
  return documentTitle || null;
}

function absoluteHref(raw: string, base: URL) {
  try {
    const url = new URL(decodeHtml(raw), base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const SOCIAL_HOSTS: Array<{ platform: string; hosts: string[] }> = [
  { platform: "INSTAGRAM", hosts: ["instagram.com", "www.instagram.com"] },
  { platform: "FACEBOOK", hosts: ["facebook.com", "www.facebook.com", "m.facebook.com"] },
  { platform: "TIKTOK", hosts: ["tiktok.com", "www.tiktok.com"] },
  { platform: "YOUTUBE", hosts: ["youtube.com", "www.youtube.com", "youtu.be"] },
  { platform: "THREADS", hosts: ["threads.com", "www.threads.com", "threads.net", "www.threads.net"] },
];

function extractLinks(html: string, base: URL) {
  const hrefs = Array.from(html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)).map((match) => match[1]!);
  const social = new Map<string, { platform: string; profileUrl: string }>();
  let contactUrl: string | null = null;
  let contactEmail: string | null = null;

  for (const raw of hrefs) {
    if (/^mailto:/i.test(raw) && !contactEmail) {
      const email = raw.slice(7).split(/[?&#]/)[0]?.trim();
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) contactEmail = email.toLowerCase();
      continue;
    }
    const absolute = absoluteHref(raw, base);
    if (!absolute) continue;
    const url = new URL(absolute);
    for (const provider of SOCIAL_HOSTS) {
      if (provider.hosts.includes(url.hostname.toLowerCase())) social.set(`${provider.platform}:${url.toString()}`, { platform: provider.platform, profileUrl: url.toString() });
    }
    if (!contactUrl && url.origin === base.origin && /\b(contact|contato|contactos|contacto|fale-conosco|sobre|about)\b/i.test(url.pathname)) contactUrl = url.toString();
  }

  return { socialLinks: Array.from(social.values()).slice(0, 20), contactUrl, contactEmail };
}

async function readHtml(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) throw new Error(`Unsupported content type: ${contentType}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("Page is too large");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error("Page is too large");
  return buffer.toString("utf8");
}

function arg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl || rawUrl.startsWith("--")) throw new Error("Usage: discovery-crawler <url> [--country=PT|BR] [--city=City]");
  const input = new URL(rawUrl);
  await assertPublicHost(input);
  if (!(await robotsAllows(input))) throw new Error("robots.txt does not allow MyPets discovery crawling for this URL");

  const { response, finalUrl } = await safeFetch(input);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await readHtml(response);
  const title = titleOf(html);
  const summary = meta(html, "description") ?? meta(html, "og:description", true);
  const links = extractLinks(html, finalUrl);
  const sourceHash = crypto.createHash("sha256").update(html).digest("hex");
  const apiBase = (process.env.MYPETS_API_URL ?? "https://api.mypets.lat/v1").replace(/\/$/, "");
  const token = process.env.DISCOVERY_INGEST_TOKEN;
  if (!token || token.length < 16) throw new Error("DISCOVERY_INGEST_TOKEN is required");
  const country = arg("country");
  if (country && country !== "PT" && country !== "BR") throw new Error("country must be PT or BR");

  const evidence = [
    { sourceUrl: finalUrl.toString(), evidenceType: "PAGE_METADATA", title, excerpt: summary?.slice(0, 1200) ?? null, metadata: {} },
    ...links.socialLinks.map((link) => ({ sourceUrl: link.profileUrl, evidenceType: "SOCIAL_LINK", title: link.platform, excerpt: null, metadata: {} })),
    ...(links.contactUrl || links.contactEmail ? [{ sourceUrl: links.contactUrl ?? finalUrl.toString(), evidenceType: "CONTACT", title: "Public contact", excerpt: links.contactEmail, metadata: {} }] : []),
  ];

  const ingest = await fetch(`${apiBase}/internal/discovery/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-discovery-token": token },
    body: JSON.stringify({
      sourceUrl: finalUrl.toString(),
      sourceType: "WEBSITE",
      title,
      summary: summary?.slice(0, 1500) ?? null,
      country,
      city: arg("city"),
      contactUrl: links.contactUrl,
      contactEmail: links.contactEmail,
      sourceHash,
      socialLinks: links.socialLinks,
      evidence,
      metadata: { crawler: "mypets-discovery-v1", canonicalInput: input.toString() },
    }),
  });
  const body = await ingest.text();
  if (!ingest.ok) throw new Error(`Ingest failed ${ingest.status}: ${body}`);
  console.log(body);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

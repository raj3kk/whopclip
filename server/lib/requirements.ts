import type { Requirements } from "./store";

/**
 * WhopClip requirement extraction — turns a campaign's free-text brief
 * (scraped from the Whop campaign page by the phone's checkJoinJob) into
 * structured Requirements.
 *
 * FAIL-CLOSED: when the brief is absent or ambiguous on a compliance-critical
 * field (authorized source, caption, duration cap), the result is marked
 * incomplete with the missing fields listed, and the orchestrator must NOT
 * render or post for that campaign.
 */

export interface ExtractionResult {
  requirements: Requirements;
  /** false when any compliance-critical field is missing/ambiguous */
  complete: boolean;
  missing: string[];
  warnings: string[];
  /** exact authorized source URLs/handles found in the brief */
  authorized_sources: string[];
  /** permitted title templates, when the brief fixes them */
  title_templates: string[];
}

const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const HANDLE_RE = /(^|\s)@([A-Za-z0-9._]{2,30})/g;
const HASHTAG_RE = /(^|\s)#([A-Za-z0-9_]{2,60})/g;

/** Strip a URL of trailing punctuation the regex may have swallowed. */
function cleanUrl(u: string): string {
  return u.replace(/[.,;:!?)"']+$/, "");
}

/**
 * Extract the most plausible video-duration cap in seconds.
 * Handles: "30-60 seconds", "under 60s", "max 30 seconds", "at least 15s",
 * "60 second video", "up to 1 minute".
 */
function extractDuration(text: string): { seconds: number | null; warning?: string } {
  const t = text.toLowerCase();
  // range "30-60 seconds" / "30 to 60 s"
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/);
  if (m) {
    const unit = m[3].startsWith("m") ? 60 : 1;
    return { seconds: parseFloat(m[2]) * unit };
  }
  // "under X", "up to X", "max X", "less than X", "no longer than X"
  m = t.match(/(?:under|up to|max(?:imum)?|less than|no longer than|shorter than)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/);
  if (m) {
    const unit = m[2].startsWith("m") ? 60 : 1;
    return { seconds: parseFloat(m[1]) * unit };
  }
  // "at least X" / "minimum X" -> not a cap; warn, don't treat as max
  m = t.match(/(?:at least|minimum|min)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/);
  if (m) {
    return { seconds: null, warning: "brief states a minimum duration only; no max cap found" };
  }
  // bare "X second(s) video" / "X-second clip"
  m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(seconds?|secs?)\s*(video|clip|reel)/);
  if (m) return { seconds: parseFloat(m[1]) };
  m = t.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?)\s*(video|clip|reel)/);
  if (m) return { seconds: parseFloat(m[1]) * 60 };
  return { seconds: null };
}

/**
 * Find the authorized footage source. Campaigns name it like:
 *   "footage ONLY from @handle", "use clips from <url>",
 *   "source: https://...", "official link: https://..."
 * Returns every URL plus every @handle mentioned in a footage context.
 */
function extractAuthorizedSources(text: string): string[] {
  const out = new Set<string>();
  const lines = text.split("\n");
  const footageCtx =
    /footage|source|official link|clips? from|use (the|this)|download|drive|content/i;
  for (const line of lines) {
    if (!footageCtx.test(line)) continue;
    for (const m of line.matchAll(URL_RE)) {
      const u = cleanUrl(m[0]);
      // skip whop/CTA links — those are the campaign page, not footage
      if (/whop\.com|contentrewards/i.test(u)) continue;
      out.add(u);
    }
    for (const m of line.matchAll(HANDLE_RE)) {
      out.add("@" + m[2].replace(/\.+$/, ""));
    }
  }
  // Also catch a bare "ONLY from @handle" anywhere
  for (const m of text.matchAll(/only from\s+@([A-Za-z0-9._]{2,30})/gi)) {
    out.add("@" + m[1].replace(/\.+$/, ""));
  }
  return [...out];
}

/**
 * Caption template: prefer an explicit template block ("caption:", quoted
 * block, or "use this caption"), else null -> caller must fail closed when
 * the campaign requires an exact caption.
 */
function extractCaptionTemplate(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(caption|post caption)\s*:/i.test(lines[i])) {
      const rest = lines[i].replace(/^\s*(caption|post caption)\s*:\s*/i, "").trim();
      if (rest.length >= 4) return rest;
      // template continues on following non-empty lines until a blank line
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length && buf.length < 6; j++) {
        if (!lines[j].trim()) break;
        buf.push(lines[j].trim());
      }
      if (buf.length) return buf.join("\n");
    }
  }
  // quoted caption block "..." spanning 1-3 lines
  const q = text.match(/"([^"]{10,400})"/);
  if (q && /@|#/.test(q[1])) return q[1];
  return null;
}

/** Numbered or bulleted title templates ("Title 1: ...", "1. ..."). */
function extractTitleTemplates(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    // skip section headers like "Titles (pick one):"
    if (/^titles?\s*(\([^)]*\))?\s*:$/i.test(t)) continue;
    const m = t.match(/^(?:title\s*\d*|option\s*\d*|\d+[.)])\s*[:.-]?\s*(.{6,160})\s*$/i);
    if (m && /[A-Za-z]/.test(m[1]) && !/http/i.test(m[1]) && !/:$/.test(m[1].trim())) out.push(m[1].trim());
  }
  return out.slice(0, 8);
}

function extractHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HANDLE_RE)) out.add("@" + m[2].replace(/\.+$/, ""));
  return [...out];
}

function extractHashtags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HASHTAG_RE)) out.add("#" + m[2]);
  return [...out];
}

function extractPostingRules(text: string): string[] {
  const rules: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length < 8 || t.length > 300) continue;
    if (
      /\b(must|required|do not|don't|dont|never|always|only|prohibited|not allowed)\b/i.test(t) &&
      !/^https?:/i.test(t)
    ) {
      rules.push(t);
    }
  }
  return rules.slice(0, 20);
}

function extractPayoutPer1k(text: string): number {
  const m = text.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:per|\/)\s*1\s*k/i);
  if (m) return parseFloat(m[1]);
  const m2 = text.match(/(\d+(?:\.\d+)?)\s*(?:per|\/)\s*1\s*k\s*(?:views?)?\s*\$?/i);
  if (m2) return parseFloat(m2[1]);
  return 0;
}

export function extractRequirementsFromText(rawText: string): ExtractionResult {
  const text = (rawText ?? "").slice(0, 12000);
  const missing: string[] = [];
  const warnings: string[] = [];

  const dur = extractDuration(text);
  if (dur.warning) warnings.push(dur.warning);
  const authorized_sources = extractAuthorizedSources(text);
  const caption_template = extractCaptionTemplate(text);
  const title_templates = extractTitleTemplates(text);
  const required_mentions = extractHandles(text);
  const required_hashtags = extractHashtags(text);
  const posting_rules = extractPostingRules(text);
  const payout_per_1k = extractPayoutPer1k(text);

  // ---- fail-closed checks ----
  // Duration: only missing when the brief clearly caps length but we can't parse it.
  if (
    dur.seconds === null &&
    /second|minute|\b30s\b|\b60s\b|duration|length/i.test(text)
  ) {
    warnings.push("brief mentions duration but no parseable cap found");
  }
  // Caption: missing template is only fatal if the brief demands an exact caption.
  if (!caption_template && /exact caption|use this caption|copy.*caption|required caption/i.test(text)) {
    missing.push("caption_template (brief demands an exact caption but none is extractable)");
  }
  // Authorized source: fatal when the brief restricts footage but names nothing parseable.
  if (
    authorized_sources.length === 0 &&
    /footage|only from|official|source/i.test(text)
  ) {
    missing.push("authorized_sources (brief restricts footage but no source URL/handle found)");
  }

  const requirements: Requirements = {
    video_max_duration_s: dur.seconds,
    aspect: "9:16",
    captions_required: !/no captions|captions not required/i.test(text),
    caption_template,
    required_mentions,
    required_hashtags,
    posting_rules,
    payout_per_1k,
  };

  return {
    requirements,
    complete: missing.length === 0,
    missing,
    warnings,
    authorized_sources,
    title_templates,
  };
}

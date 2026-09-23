// Deterministic detectors. A "block" hit is proof: the query never leaves the deployment and is
// never shown to Jev. A "flag" hit is suspicion: Jev still decides, but the outcome is capped at
// review so a human always sees it.

import { looksEncoded, type Normalized } from "./normalize";

export type Category =
  | "credential"
  | "payment_card"
  | "bank_account"
  | "government_id"
  | "date_of_birth"
  | "deployment_secret"
  | "contact_detail"
  | "hidden_payload";

export type Hit = {
  category: Category;
  detector: string;
  severity: "block" | "flag";
  /** The matched text in `Normalized.text`, when the match came from it (used for redaction). */
  match?: string;
};

export type DetectorConfig = {
  /** Literal strings that must never leave, e.g. the account id or internal hostnames. */
  blockedTerms: string[];
  /** Hostname suffixes that are private, e.g. "surprisingly.ltd". */
  privateDomains: string[];
  /** Hosts under a private domain that are public anyway, e.g. the deployment's own origin. */
  publicHosts: string[];
};

export const EMPTY_CONFIG: DetectorConfig = { blockedTerms: [], privateDomains: [], publicHosts: [] };

const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ["openrouter_key", /\bsk-or-(?:v\d-)?[A-Za-z0-9]{20,}/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ["litellm_key", /\bsk-[A-Za-z0-9]{16,}/],
  ["aws_access_key", /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe_key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bPRIVATE KEY-----/],
  ["url_credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ["connection_string", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/\S+/i],
  ["password_assignment", /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i],
];

const DATE_PATTERNS = [
  /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
];
const DOB_CONTEXT = /\b(?:d\.?o\.?b|date of birth|born|birth ?day|birth ?date)\b/i;
const BANK_CONTEXT = /\b(?:sort ?code|account|acct|a\/c|bank|iban|bic|swift|routing)\b/i;

export function detect(n: Normalized, config: DetectorConfig = EMPTY_CONFIG): Hit[] {
  let hits: Hit[] = [];
  let add = (h: Hit) => { if (!hits.some(x => x.detector === h.detector && x.match === h.match)) hits.push(h); };

  for (let source of [n.text, ...n.decoded]) {
    let fromText = source === n.text;
    for (let [id, re] of CREDENTIAL_PATTERNS) {
      let m = source.match(re);
      if (m) add({ category: "credential", detector: id, severity: "block", match: fromText ? m[0] : undefined });
    }
    for (let token of source.match(/[A-Za-z0-9_+=-]{24,}/g) ?? []) {
      if (looksEncoded(token) && shannon(token) >= 4.0) {
        add({ category: "credential", detector: "high_entropy_token", severity: "block", match: fromText ? token : undefined });
      }
    }
  }

  let views = [n.digits, ...n.decoded.map(d => d.toLowerCase())];
  for (let view of views) {
    for (let run of view.match(/\d{13,19}/g) ?? []) {
      if (luhn(run) && !/^(\d)\1+$/.test(run)) add({ category: "payment_card", detector: "luhn_card", severity: "block" });
    }
  }

  for (let source of [n.text, ...n.decoded]) {
    let compact = source.toUpperCase().replace(/[\s-]/g, "");
    for (let m of compact.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,30}/g) ?? []) {
      if (ibanValid(m)) add({ category: "bank_account", detector: "iban", severity: "block" });
    }
  }

  // UK banking: a sort code shape in the text, or any run of 6+ digits once banking words appear.
  if (/\b\d{2}[-\s]\d{2}[-\s]\d{2}\b/.test(n.text) && (BANK_CONTEXT.test(n.text) || /\d{8}/.test(n.digits))) {
    add({ category: "bank_account", detector: "uk_sort_code", severity: "block", match: n.text.match(/\b\d{2}[-\s]\d{2}[-\s]\d{2}\b/)![0] });
  }
  for (let view of [n.text, ...n.decoded]) {
    if (BANK_CONTEXT.test(view)) {
      let digits = view === n.text ? n.digits : view;
      if (/\d{6,}/.test(digits)) add({ category: "bank_account", detector: "bank_number_in_context", severity: "block" });
    }
  }

  for (let source of [n.text, ...n.decoded]) {
    let ni = source.match(/\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/i);
    if (ni) add({ category: "government_id", detector: "uk_ni_number", severity: "block", match: source === n.text ? ni[0] : undefined });
    let ssn = source.match(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/);
    if (ssn) add({ category: "government_id", detector: "us_ssn", severity: "block", match: source === n.text ? ssn[0] : undefined });
    let dl = source.match(/\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/);
    if (dl) add({ category: "government_id", detector: "uk_driving_licence", severity: "block", match: source === n.text ? dl[0] : undefined });
  }
  if (/\bnhs\b/i.test(n.text)) {
    for (let run of n.digits.match(/\d{10}/g) ?? []) {
      if (nhsValid(run)) add({ category: "government_id", detector: "nhs_number", severity: "block" });
    }
  }
  if (/\bpassport\b/i.test(n.text) && /\d{9}/.test(n.digits)) {
    add({ category: "government_id", detector: "passport_number", severity: "block" });
  }

  if (DOB_CONTEXT.test(n.text)) {
    for (let re of DATE_PATTERNS) {
      let m = n.text.match(re);
      if (m) add({ category: "date_of_birth", detector: "date_with_birth_context", severity: "block", match: m[0] });
    }
  }

  let lower = n.text.toLowerCase();
  for (let term of config.blockedTerms) {
    if (term && lower.includes(term.toLowerCase())) {
      add({ category: "deployment_secret", detector: "blocked_term", severity: "block", match: term });
    }
  }
  for (let host of lower.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/g) ?? []) {
    if (config.publicHosts.includes(host)) continue;
    if (config.privateDomains.some(d => host === d || host.endsWith("." + d))) {
      add({ category: "deployment_secret", detector: "private_host", severity: "block", match: host });
    }
  }

  let email = n.text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (email) add({ category: "contact_detail", detector: "email", severity: "flag", match: email[0] });
  if (/(?:\+44|\b0)7\d{9}\b|(?:\+44|\b0)[1-3]\d{8,9}\b|\+\d{10,15}\b/.test(n.digits)) {
    add({ category: "contact_detail", detector: "phone", severity: "flag" });
  }
  let postcode = n.text.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
  if (postcode && /\d[A-Z]{2}$/i.test(postcode[0]) && /[A-Z]/.test(postcode[0])) {
    add({ category: "contact_detail", detector: "uk_postcode", severity: "flag", match: postcode[0] });
  }

  if (n.decoded.length > 0) add({ category: "hidden_payload", detector: "decoded_text", severity: "flag" });
  for (let blob of n.opaqueBlobs) add({ category: "hidden_payload", detector: "opaque_blob", severity: "flag", match: blob });

  return hits;
}

/** Replace every text-level match with its category label. */
export function redact(text: string, hits: Hit[]): string {
  let out = text;
  for (let h of hits) {
    if (h.match) out = out.split(h.match).join(`[${h.category.toUpperCase()}]`);
  }
  // A hit found only in a derived view (digits, decoded) has no text span; hide the digits.
  if (hits.some(h => h.severity === "block" && !h.match)) out = out.replace(/\d/g, "#");
  return out;
}

export function shannon(s: string): number {
  let counts = new Map<string, number>();
  for (let c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (let n of counts.values()) { let p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function ibanValid(iban: string): boolean {
  let rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = rearranged.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (let ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

export function nhsValid(n: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(n[i]) * (10 - i);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  return check !== 10 && check === Number(n[9]);
}

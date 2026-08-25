export interface RedactionResult {
  value: string;
  count: number;
}

interface Rule {
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_RULES: Rule[] = [
  {
    pattern: /\/(?:Users|home)\/[^/\s]+\/[^\s"'<>]*/g,
    replacement: "[REDACTED:LOCAL_PATH]",
  },
  {
    pattern: /\b[A-Za-z]:\\Users\\[^\\\s]+\\[^\s"'<>]*/g,
    replacement: "[REDACTED:LOCAL_PATH]",
  },
  {
    pattern: /(authorization\s*[:=]\s*bearer\s+)[a-z0-9._~+/=-]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /((?:auth[_-]?token|api[_-]?key|private[_-]?key|secret|seed(?:[_-]?phrase)?)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /([?&](?:api[_-]?key|token|auth)\s*=)[^&#\s]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: "[REDACTED:JWT]",
  },
  {
    pattern: /\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g,
    replacement: "[REDACTED:KEY_BYTES]",
  },
  {
    pattern: /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g,
    replacement: "[REDACTED:BASE58]",
  },
];

function replaceAndCount(input: string, rule: Rule): RedactionResult {
  let count = 0;
  const value = input.replace(rule.pattern, (...args: unknown[]) => {
    count += 1;
    let replacement = rule.replacement;
    for (let index = 1; index <= 9; index += 1) {
      const capture = args[index];
      replacement = replacement.replaceAll("$" + index, typeof capture === "string" ? capture : "");
    }
    return replacement;
  });
  return { value, count };
}

export function redactText(input: string, customPatterns: string[] = []): RedactionResult {
  let value = input;
  let count = 0;
  const customRules = customPatterns.map((pattern) => ({
    pattern: new RegExp(pattern, "gi"),
    replacement: "[REDACTED:CUSTOM]",
  }));
  for (const rule of [...DEFAULT_RULES, ...customRules]) {
    const result = replaceAndCount(value, rule);
    value = result.value;
    count += result.count;
  }
  return { value, count };
}

export function redactJsonValue<T>(value: T, customPatterns: string[] = []): { value: T; count: number } {
  let count = 0;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      const result = redactText(entry, customPatterns);
      count += result.count;
      return result.value;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === "object" && entry !== null) {
      return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, visit(nested)]));
    }
    return entry;
  };
  return { value: visit(value) as T, count };
}

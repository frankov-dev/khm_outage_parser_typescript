const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: "\u00A0",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  laquo: "«",
  raquo: "»",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  minus: "−",
  shy: "\u00AD",
  thinsp: "\u2009",
  ensp: "\u2002",
  emsp: "\u2003",
};

const ENTITY_PATTERN = /&(?:#x([0-9a-fA-F]+)|#(\d+)|([A-Za-z][A-Za-z0-9]*));/g;

function lookupNamed(name: string): string | undefined {
  if (Object.hasOwn(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name];
  const lower = name.toLowerCase();
  if (Object.hasOwn(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
  return undefined;
}

/** Decodes numeric and the common named HTML entities. Unknown entities are left untouched. */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(
    ENTITY_PATTERN,
    (match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined || dec !== undefined) {
        const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
        if (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff) {
          return String.fromCodePoint(cp);
        }
        return match;
      }
      return name !== undefined ? (lookupNamed(name) ?? match) : match;
    },
  );
}

/** Strips BOM / zero-width space and turns newlines, tabs and NBSP into plain spaces. */
export function cleanTextChunk(raw: string): string {
  return raw.replace(/[\uFEFF\u200B]/g, "").replace(/[\r\n\t\u00A0]+/g, " ");
}

/** Full single-line normalisation: clean, collapse repeated spaces and trim. */
export function normalizeLine(raw: string): string {
  return cleanTextChunk(raw).replace(/ {2,}/g, " ").trim();
}

export type DateBoundary = "start" | "end";

export interface ParsedDateRange {
  startDate: Date | null;
  endDate: Date | null;
  isCurrent: boolean;
}

const PRESENT_PATTERN =
  /^(present|current|ongoing|now|today|aujourd['’]hui|aujourdhui|actuel|actuelle|en cours)$/i;
const SINCE_PATTERN = /^(?:since|depuis)\s+(.+)$/i;
const COMPACT_RANGE_PATTERN =
  /^([A-Za-z\u00c0-\u017f]+\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4}|\d{1,2}[\/-]\d{4}|\d{4})\s*[-\u2013\u2014]\s*([A-Za-z\u00c0-\u017f]+\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4}|\d{1,2}[\/-]\d{4}|\d{4}|present|current|ongoing|aujourd['’]hui|aujourdhui|en cours)$/i;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  janvier: 1,
  feb: 2,
  february: 2,
  fev: 2,
  fevr: 2,
  fevrier: 2,
  mar: 3,
  march: 3,
  mars: 3,
  apr: 4,
  april: 4,
  avr: 4,
  avril: 4,
  may: 5,
  mai: 5,
  jun: 6,
  june: 6,
  juin: 6,
  jul: 7,
  july: 7,
  juillet: 7,
  aug: 8,
  august: 8,
  aou: 8,
  aout: 8,
  sep: 9,
  sept: 9,
  september: 9,
  septembre: 9,
  oct: 10,
  october: 10,
  octobre: 10,
  nov: 11,
  november: 11,
  novembre: 11,
  dec: 12,
  december: 12,
  decembre: 12,
};

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeMojibake(value: string): string {
  let normalized = value || "";
  try {
    normalized = decodeURIComponent(escape(normalized));
  } catch {
    // Keep original text if decode fails.
  }

  return normalized
    .replace(/\u00e2\u20ac\u201c|\u00e2\u20ac\u201d|\u00e2\u02c6\u2019/g, "-")
    .replace(/\u00e2\u20ac\u2122|\u00e2\u20ac\u02dc/g, "'")
    .replace(/\u00e2\u20ac\u0153|\u00e2\u20ac/g, '"');
}

function normalizeText(value: string): string {
  return stripAccents(normalizeMojibake(value || ""))
    .replace(/[.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPresentToken(value: string): boolean {
  return PRESENT_PATTERN.test(normalizeText(value));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toSafeUtcDate(year: number, month: number, day: number): Date | null {
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt;
}

function normalizeYear(year: number): number {
  if (year < 100) {
    return year >= 70 ? 1900 + year : 2000 + year;
  }
  return year;
}

function parseAtomicDate(
  rawValue: unknown,
  boundary: DateBoundary,
): Date | null {
  if (!rawValue && rawValue !== 0) {
    return null;
  }

  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    return new Date(rawValue.getTime());
  }

  let normalizedRaw = normalizeText(String(rawValue));
  if (!normalizedRaw || isPresentToken(normalizedRaw)) {
    return null;
  }

  // Strip leading 'depuis' or 'since' in case it was passed down from a dashed range split
  normalizedRaw = normalizedRaw.replace(/^(?:depuis|since)\s+/i, "");
  // Also strip common French leading prepositions used in ranges, e.g. "De 27/07/2023"
  normalizedRaw = normalizedRaw.replace(/^(?:de|du|des|d['’])\s+/i, "");

  // YYYY-MM-DD / YYYY/MM/DD
  const iso = normalizedRaw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (iso) {
    return toSafeUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // DD/MM/YYYY or MM/DD/YYYY
  const shortDate = normalizedRaw.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/,
  );
  if (shortDate) {
    const first = Number(shortDate[1]);
    const second = Number(shortDate[2]);
    const year = normalizeYear(Number(shortDate[3]));

    let day = first;
    let month = second;

    if (first <= 12 && second > 12) {
      // MM/DD/YYYY
      day = second;
      month = first;
    } else if (first <= 12 && second <= 12) {
      // Ambiguous: prefer DD/MM for FR-heavy inputs.
      day = first;
      month = second;
    }

    return toSafeUtcDate(year, month, day);
  }

  // MM/YYYY
  const monthYearNumeric = normalizedRaw.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (monthYearNumeric) {
    const month = Number(monthYearNumeric[1]);
    const year = Number(monthYearNumeric[2]);
    const day = boundary === "end" ? daysInMonth(year, month) : 1;
    return toSafeUtcDate(year, month, day);
  }

  // Month Day, Year
  const monthDayYear = normalizedRaw.match(
    /^([A-Za-z\u00c0-\u017f]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/i,
  );
  if (monthDayYear) {
    const month = MONTHS[normalizeText(monthDayYear[1]).toLowerCase()];
    if (!month) {
      return null;
    }
    return toSafeUtcDate(
      Number(monthDayYear[3]),
      month,
      Number(monthDayYear[2]),
    );
  }

  // Day Month Year
  const dayMonthYear = normalizedRaw.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z\u00c0-\u017f]+)\s+(\d{4})$/i,
  );
  if (dayMonthYear) {
    const month = MONTHS[normalizeText(dayMonthYear[2]).toLowerCase()];
    if (!month) {
      return null;
    }
    return toSafeUtcDate(
      Number(dayMonthYear[3]),
      month,
      Number(dayMonthYear[1]),
    );
  }

  // Month Year
  const monthYearText = normalizedRaw.match(
    /^([A-Za-z\u00c0-\u017f]+)\s+(\d{4})$/i,
  );
  if (monthYearText) {
    const month = MONTHS[normalizeText(monthYearText[1]).toLowerCase()];
    if (!month) {
      return null;
    }
    const year = Number(monthYearText[2]);
    const day = boundary === "end" ? daysInMonth(year, month) : 1;
    return toSafeUtcDate(year, month, day);
  }

  // Year
  const yearOnly = normalizedRaw.match(/^(19|20)\d{2}$/);
  if (yearOnly) {
    const year = Number(normalizedRaw);
    const month = boundary === "end" ? 12 : 1;
    const day = boundary === "end" ? 31 : 1;
    return toSafeUtcDate(year, month, day);
  }

  return null;
}

function splitDateRange(value: string): [string, string] | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const compact = normalized.match(COMPACT_RANGE_PATTERN);
  if (compact) {
    return [normalizeText(compact[1]), normalizeText(compact[2])];
  }

  const textual = normalized.match(
    /^(.+?)\s+(?:to|au|a|\u00e0|jusqu['\u2019]?\s*[a\u00e0\ufffd]?)\s+(.+)$/i,
  );
  if (textual) {
    return [normalizeText(textual[1]), normalizeText(textual[2])];
  }

  const dashed = normalized.match(/^(.+?)\s[-\u2013\u2014]\s(.+)$/);
  if (dashed) {
    return [normalizeText(dashed[1]), normalizeText(dashed[2])];
  }

  const since = normalized.match(SINCE_PATTERN);
  if (since) {
    return [normalizeText(since[1]), "present"];
  }

  return null;
}

export function normalizeFlexibleDate(
  value: unknown,
  boundary: DateBoundary = "start",
): Date | null {
  return parseAtomicDate(value, boundary);
}

export function parseFlexibleDateRange(value: unknown): ParsedDateRange {
  if (!value && value !== 0) {
    return { startDate: null, endDate: null, isCurrent: false };
  }

  const raw = normalizeText(String(value));
  if (!raw) {
    return { startDate: null, endDate: null, isCurrent: false };
  }

  if (isPresentToken(raw)) {
    return { startDate: null, endDate: null, isCurrent: true };
  }

  const parts = splitDateRange(raw);
  if (parts) {
    const [left, right] = parts;
    const startDate = parseAtomicDate(left, "start");
    const isCurrent = isPresentToken(right);
    const endDate = isCurrent ? null : parseAtomicDate(right, "end");
    return { startDate, endDate, isCurrent };
  }

  return {
    startDate: parseAtomicDate(raw, "start"),
    endDate: null,
    isCurrent: false,
  };
}

export function formatIsoDate(date: Date | null | undefined): string | null {
  if (!date) {
    return null;
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

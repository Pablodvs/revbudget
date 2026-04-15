export const DEFAULT_TIMEZONE = 'Europe/Madrid';

export function formatCents(amount: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
  }).format(amount / 100);
}

function tzOffsetAt(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const lookup: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') lookup[p.type] = Number(p.value);
  }
  const hour = lookup.hour === 24 ? 0 : (lookup.hour ?? 0);
  const asUtc = Date.UTC(
    lookup.year ?? 1970,
    (lookup.month ?? 1) - 1,
    lookup.day ?? 1,
    hour,
    lookup.minute ?? 0,
    lookup.second ?? 0,
  );
  return asUtc - date.getTime();
}

function zonedMonthStartToUtc(year: number, month1: number, tz: string): Date {
  const guess = new Date(Date.UTC(year, month1 - 1, 1, 0, 0, 0));
  const offset = tzOffsetAt(guess, tz);
  return new Date(guess.getTime() - offset);
}

export function zonedYearMonth(now: Date, tz: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const lookup: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') lookup[p.type] = Number(p.value);
  }
  return { year: lookup.year ?? 1970, month: lookup.month ?? 1 };
}

export function currentMonth(now: Date = new Date(), tz: string = DEFAULT_TIMEZONE): string {
  const { year, month } = zonedYearMonth(now, tz);
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseMonth(month: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  return { year, month: m };
}

export function monthBounds(
  month: string,
  tz: string = DEFAULT_TIMEZONE,
): { startISO: string; endISO: string } | null {
  const parsed = parseMonth(month);
  if (!parsed) return null;
  const start = zonedMonthStartToUtc(parsed.year, parsed.month, tz);
  const nextYear = parsed.month === 12 ? parsed.year + 1 : parsed.year;
  const nextMonth = parsed.month === 12 ? 1 : parsed.month + 1;
  const end = zonedMonthStartToUtc(nextYear, nextMonth, tz);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export function shiftMonth(month: string, delta: number): string {
  const parsed = parseMonth(month);
  if (!parsed) return month;
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1 + delta, 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function toZonedYearMonth(isoUtc: string, tz: string = DEFAULT_TIMEZONE): string {
  const { year, month } = zonedYearMonth(new Date(isoUtc), tz);
  return `${year}-${String(month).padStart(2, '0')}`;
}

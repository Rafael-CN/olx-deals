import { SellerInfo } from '../../core/types.js';

/**
 * Text parsing for olx.com.br, kept apart from the browser so it can be tested
 * against captured page text instead of a live page.
 *
 * Everything here reads *visible words* rather than markup. That is a deliberate
 * trade: the Brazilian ad page ships build-hashed class names, so a label like
 * "Vendas concluídas" is the most durable handle available. It also means a
 * wording change on OLX's side degrades a field to undefined rather than
 * breaking the run.
 */

export const MONTHS_PT_BR = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const MONTHS_ABBR_PT_BR = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

const digitsIn = (text: string | undefined): number | undefined => {
  if (!text) return undefined;
  const match = text.match(/\d+/);
  return match ? parseInt(match[0], 10) : undefined;
};

/** "5,0" and "4.5" both appear depending on locale formatting. */
const decimalIn = (text: string | undefined): number | undefined => {
  if (!text) return undefined;
  const match = text.match(/^(\d)[.,](\d)$/);
  return match ? Number(`${match[1]}.${match[2]}`) : undefined;
};

/**
 * "Na OLX desde agosto de 2024" names no day, so the first of the month is the
 * most precise reading the page supports.
 */
export const parseMemberSince = (text: string): Date | undefined => {
  const match = text.match(/desde\s+(\p{L}+)\s+de\s+(\d{4})/u);
  if (!match?.[1] || !match[2]) return undefined;

  const month = MONTHS_PT_BR.indexOf(match[1].toLowerCase());
  if (month < 0) return undefined;

  return new Date(Date.UTC(Number(match[2]), month, 1));
};

const KNOWN_CHANNELS = ['E-mail', 'Telefone', 'Facebook', 'Google', 'CPF', 'Endereço'];

/**
 * The seller card carries the reputation signals a triage run actually needs —
 * rating, sales completed against sales cancelled, account age — none of which
 * is in the page's structured data. Its labels are unique on an ad page, so they
 * are located by name and the value is read from the neighbouring line.
 *
 * `lines` is the page's visible text, trimmed, with blanks dropped.
 */
export const parseSellerFromLines = (lines: readonly string[]): SellerInfo | undefined => {
  const at = (index: number): string | undefined => lines[index];
  const indexOfLine = (predicate: (line: string) => boolean) => lines.findIndex(predicate);

  const sinceIndex = indexOfLine(line => /^Na OLX desde/i.test(line));
  const verifiedIndex = indexOfLine(line => /^Informações verificadas$/i.test(line));

  /**
   * The value of a "N label" pair, where a zero-padded count precedes its label
   * ("00" / "Vendas concluídas"). The previous line must be nothing but digits,
   * so a number appearing in neighbouring prose cannot be read as a count.
   */
  const countBefore = (label: RegExp, unit?: RegExp): number | undefined => {
    const index = indexOfLine(line => label.test(line));
    if (index <= 0) return undefined;
    const previous = at(index - 1);
    if (!previous) return undefined;
    // Bare counts render as "00"; the dispatch figure renders as "03dias", so a
    // caller that expects a unit says which one rather than loosening this to
    // "any line containing a digit".
    const shape = unit ? new RegExp(String.raw`^(\d+)\s*` + `(?:${unit.source})$`, 'i') : /^(\d+)$/;
    const match = previous.match(shape);
    return match?.[1] ? parseInt(match[1], 10) : undefined;
  };

  const reviewsIndex = indexOfLine(line => /^Acessar\s+\d+\s+avalia/i.test(line));
  // Said in words rather than as a zero, so it has to be recognised as such or
  // a brand-new seller looks the same as one whose rating failed to parse.
  const hasNoReviews = indexOfLine(line => /ainda não possui avalia/i.test(line)) >= 0;
  const reviewCount = reviewsIndex >= 0 ? digitsIn(at(reviewsIndex)) : hasNoReviews ? 0 : undefined;
  // The rating sits immediately above its "Acessar N avaliações" link.
  const rating = reviewsIndex > 0 ? decimalIn(at(reviewsIndex - 1)) : undefined;

  let name: string | undefined;
  let online: boolean | undefined;
  if (sinceIndex > 0) {
    online = /^online$/i.test(at(sinceIndex - 1) ?? '');
    // Walk back past the presence badge to the card's first line, which is the
    // seller's name. Anything that looks like a label is not a name.
    for (let i = sinceIndex - 1; i >= 0 && i >= sinceIndex - 4; i -= 1) {
      const candidate = at(i);
      if (!candidate) continue;
      // Presence badges sit between the name and the join date, and which one
      // renders depends on whether the seller is currently online.
      if (/^(online|offline)$/i.test(candidate)) continue;
      if (/^(Último|Ultimo) acesso/i.test(candidate)) continue;
      // Reaching page furniture means the name was not where it should be.
      if (/^(publicidade|Denunciar|Compartilhar|Copiar)$/i.test(candidate)) break;
      name = candidate;
      break;
    }
  }

  const verifiedChannels =
    verifiedIndex >= 0
      ? lines
          .slice(verifiedIndex + 1, verifiedIndex + 8)
          .filter(line =>
            KNOWN_CHANNELS.some(channel => channel.toLowerCase() === line.toLowerCase())
          )
      : [];

  const seller: SellerInfo = {
    name,
    verified: verifiedIndex >= 0 ? true : undefined,
    memberSince: sinceIndex >= 0 ? parseMemberSince(at(sinceIndex) ?? '') : undefined,
    rating,
    reviewCount,
    salesCompleted: countBefore(/^Vendas conclu/i),
    salesCancelled: countBefore(/^Vendas cancel/i),
    dispatchDays: countBefore(/^Tempo médio de despacho/i, /dias?/),
    verifiedChannels: verifiedChannels.length > 0 ? verifiedChannels : undefined,
    online,
  };

  // Every field optional means "nothing found at all" is possible; say so rather
  // than returning an object of undefineds that reads like a real seller.
  return Object.values(seller).some(value => value !== undefined) ? seller : undefined;
};

/**
 * Card dates are relative and locale-worded: "Hoje, 21:26", "Ontem, 12:58",
 * "21/08 às 21:26", "12 de ago". `now` is injected so this stays pure and so a
 * collection run can date every card in a page against one clock.
 *
 * A bare day/month carries no year — the ad is assumed to be from the last
 * twelve months, which is the only reading that does not put fresh ads in the
 * future.
 */
export const parseCardDate = (text: string, now: Date): Date | undefined => {
  const clean = text.trim();
  if (!clean) return undefined;

  const time = clean.match(/(\d{1,2}):(\d{2})/);
  const hours = time?.[1] ? Number(time[1]) : 0;
  const minutes = time?.[2] ? Number(time[2]) : 0;

  const atLocalTime = (year: number, month: number, day: number) =>
    new Date(year, month, day, hours, minutes, 0, 0);

  if (/^hoje/i.test(clean)) {
    return atLocalTime(now.getFullYear(), now.getMonth(), now.getDate());
  }

  if (/^ontem/i.test(clean)) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return atLocalTime(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
  }

  const dayMonth = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dayMonth?.[1] && dayMonth[2]) {
    const day = Number(dayMonth[1]);
    const month = Number(dayMonth[2]) - 1;
    if (dayMonth[3]) {
      const raw = Number(dayMonth[3]);
      return atLocalTime(raw < 100 ? 2000 + raw : raw, month, day);
    }
    return withinLastYear(now, month, day, hours, minutes);
  }

  const written = clean.match(/^(\d{1,2})\s+de\s+(\p{L}+)/u);
  if (written?.[1] && written[2]) {
    const label = written[2].toLowerCase();
    const month =
      MONTHS_PT_BR.indexOf(label) >= 0
        ? MONTHS_PT_BR.indexOf(label)
        : MONTHS_ABBR_PT_BR.indexOf(label.slice(0, 3));
    if (month >= 0) return withinLastYear(now, month, Number(written[1]), hours, minutes);
  }

  return undefined;
};

/**
 * Picks the year that puts a day/month in the past without going back more than
 * a year — OLX only omits the year for recent ads.
 */
const withinLastYear = (
  now: Date,
  month: number,
  day: number,
  hours: number,
  minutes: number
): Date => {
  const thisYear = new Date(now.getFullYear(), month, day, hours, minutes, 0, 0);
  if (thisYear.getTime() <= now.getTime() + 60 * 60 * 1000) return thisYear;
  return new Date(now.getFullYear() - 1, month, day, hours, minutes, 0, 0);
};

/** Descriptions arrive with their line breaks still encoded as <br> tags. */
export const stripHtml = (html: string): string | undefined => {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
  return text || undefined;
};

/**
 * JSON-LD states the price as a bare amount ("1000"). Rendering it the way the
 * site does keeps it readable, and integral amounts stay free of the ",00" that
 * OLX itself never shows.
 */
export const formatBrl = (amount: string | number): string | undefined => {
  const value = Number(amount);
  if (amount === '' || amount === null || Number.isNaN(value)) return undefined;

  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);

  return `R$ ${formatted}`;
};

/** "R$ 1.234,50" -> 1234.5. Returns undefined for prices OLX did not state. */
export const parseBrl = (price: string | undefined): number | undefined => {
  if (!price) return undefined;
  const digits = price.replace(/[^\d,.-]/g, '');
  if (!digits) return undefined;
  // Brazilian formatting: dots group thousands, the comma is the decimal mark.
  const normalised = digits.replace(/\./g, '').replace(',', '.');
  const value = Number(normalised);
  return Number.isFinite(value) ? value : undefined;
};

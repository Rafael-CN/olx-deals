import { describe, it, expect } from 'vitest';
import { parseBrl, parseCardDate, parseMemberSince, parseSellerFromLines } from './br-parsers.js';

/**
 * Captured verbatim from a live ad page, seller card included. Keeping the real
 * text means these tests fail when OLX rewords the page — which is exactly when
 * the parsers need attention.
 */
const REAL_SELLER_CARD = [
  'Copiar',
  'publicidade',
  'ROGERSANTOS',
  'Último acesso há 24 min',
  'Na OLX desde janeiro de 2019',
  'Parque Amador, Esteio - RS',
  'Acessar perfil do anunciante',
  'Histórico de vendas',
  'Este anunciante ainda não possui avaliações',
  '00',
  'Vendas concluídas',
  '01',
  'Vendas canceladas',
  'Informações verificadas',
  'E-mail',
  'Telefone',
  'Facebook',
  'Dicas de segurança',
];

const RATED_SELLER_CARD = [
  'Gustavo Antony',
  'online',
  'Na OLX desde agosto de 2024',
  'Vila Zefira, São Paulo - SP',
  'Acessar perfil do anunciante',
  'Histórico de vendas',
  '5,0',
  'Acessar 4 avaliações',
  '04',
  'Vendas concluídas',
  '01',
  'Vendas canceladas',
  '03dias',
  'Tempo médio de despacho',
  'Informações verificadas',
  'E-mail',
  'Telefone',
];

describe('parseSellerFromLines', () => {
  it('reads a real seller card, skipping the last-access badge to find the name', () => {
    const seller = parseSellerFromLines(REAL_SELLER_CARD);

    expect(seller?.name).toBe('ROGERSANTOS');
    expect(seller?.memberSince?.toISOString()).toBe('2019-01-01T00:00:00.000Z');
    expect(seller?.salesCompleted).toBe(0);
    expect(seller?.salesCancelled).toBe(1);
    expect(seller?.verified).toBe(true);
    expect(seller?.verifiedChannels).toEqual(['E-mail', 'Telefone', 'Facebook']);
    expect(seller?.online).toBe(false);
  });

  it('tells "no reviews yet" apart from "the rating did not parse"', () => {
    expect(parseSellerFromLines(REAL_SELLER_CARD)?.reviewCount).toBe(0);
    expect(parseSellerFromLines(REAL_SELLER_CARD)?.rating).toBeUndefined();
  });

  it('reads the rating and sales history of an established seller', () => {
    const seller = parseSellerFromLines(RATED_SELLER_CARD);

    expect(seller?.name).toBe('Gustavo Antony');
    expect(seller?.online).toBe(true);
    expect(seller?.rating).toBe(5);
    expect(seller?.reviewCount).toBe(4);
    expect(seller?.salesCompleted).toBe(4);
    expect(seller?.salesCancelled).toBe(1);
    expect(seller?.dispatchDays).toBe(3);
  });

  it('will not read a number out of neighbouring prose as a count', () => {
    const seller = parseSellerFromLines([
      'Alguem',
      'Na OLX desde março de 2020',
      'Compre 2 e leve 3',
      'Vendas concluídas',
    ]);
    expect(seller?.salesCompleted).toBeUndefined();
  });

  it('returns nothing when the page has no seller card at all', () => {
    expect(parseSellerFromLines(['Ir para o rodapé', 'publicidade'])).toBeUndefined();
  });
});

describe('parseMemberSince', () => {
  it('reads the month and year, dating the account to the first of the month', () => {
    expect(parseMemberSince('Na OLX desde agosto de 2024')?.toISOString()).toBe(
      '2024-08-01T00:00:00.000Z'
    );
  });

  it('gives up on an unrecognised month rather than guessing', () => {
    expect(parseMemberSince('Na OLX desde smarch de 2024')).toBeUndefined();
  });
});

describe('parseCardDate', () => {
  const now = new Date(2026, 7, 26, 14, 30);

  it('resolves the relative wordings OLX uses on cards', () => {
    expect(parseCardDate('Hoje, 21:26', now)).toEqual(new Date(2026, 7, 26, 21, 26));
    expect(parseCardDate('Ontem, 12:58', now)).toEqual(new Date(2026, 7, 25, 12, 58));
  });

  it('reads a day/month without a year as the most recent such date', () => {
    expect(parseCardDate('21/08 às 21:26', now)).toEqual(new Date(2026, 7, 21, 21, 26));
    // December has not happened yet this year, so it must be last year's.
    expect(parseCardDate('15/12', now)).toEqual(new Date(2025, 11, 15, 0, 0));
  });

  it('reads a written month, abbreviated or not', () => {
    expect(parseCardDate('12 de ago', now)).toEqual(new Date(2026, 7, 12));
    expect(parseCardDate('3 de janeiro', now)).toEqual(new Date(2026, 0, 3));
  });

  it('returns nothing for text it does not recognise', () => {
    expect(parseCardDate('', now)).toBeUndefined();
    expect(parseCardDate('em breve', now)).toBeUndefined();
  });
});

describe('parseBrl', () => {
  it('reads Brazilian formatting, where the dot groups and the comma decimates', () => {
    expect(parseBrl('R$ 1.234')).toBe(1234);
    expect(parseBrl('R$ 6.999')).toBe(6999);
    expect(parseBrl('R$ 1.234,50')).toBe(1234.5);
    expect(parseBrl('R$ 950')).toBe(950);
  });

  it('returns nothing for an ad with no price', () => {
    expect(parseBrl(undefined)).toBeUndefined();
    expect(parseBrl('')).toBeUndefined();
    expect(parseBrl('Preço a combinar')).toBeUndefined();
  });
});

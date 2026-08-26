import { describe, it, expect } from 'vitest';
import { findDefects, severityOfCondition } from './defects.js';
import { DEFAULT_DEFECT_LEXICON } from '../config/profile.js';

describe('findDefects', () => {
  it('reads the real description that made the R$ 950 S22 Ultra cheap', () => {
    // Verbatim from the ad this project first found: a good price with a real
    // defect stated plainly in the middle of the text.
    const finding = findDefects(
      'Samsung Galaxy S22 Ultra Cor Vinho\nMemória: 256GB\n' +
        'Impecável em desempenho e fotos, muito potente, mas com detalhes de uso refletidos no preço.\n' +
        'Tela: Possui uma linha verde vertical (conforme fotos).\n' +
        'Traseira: Possui um trinco no vidro traseiro, que não afeta o uso.'
    );

    expect(finding.severity).toBe('major');
    expect(finding.hits.map(hit => hit.term)).toEqual(
      expect.arrayContaining(['linha verde', 'trinco'])
    );
  });

  it('does not punish a seller for listing what is NOT wrong', () => {
    const finding = findDefects('iPhone 12 impecável. Sem trincos, sem linha verde, nenhum risco.');

    expect(finding.severity).toBe('none');
    expect(finding.hits).toHaveLength(0);
    expect(finding.negated.map(hit => hit.term)).toEqual(
      expect.arrayContaining(['trinco', 'linha verde'])
    );
  });

  it('does not let a negator reach across a full stop', () => {
    // "sem carregador" must not cancel the cracked screen of the previous clause.
    const finding = findDefects('A tela está trincada. Sem carregador e sem caixa.');
    expect(finding.severity).toBe('major');
    expect(finding.hits.map(hit => hit.term)).toContain('trincada');
  });

  it('folds accents and case, because ads are typed on phones', () => {
    expect(findDefects('NÃO LIGA').severity).toBe('broken');
    expect(findDefects('nao liga').severity).toBe('broken');
    expect(findDefects('Oxidação na placa').severity).toBe('major');
  });

  it('ranks broken above major above minor', () => {
    expect(findDefects('só riscos leves').severity).toBe('minor');
    expect(findDefects('riscos leves e tela trincada').severity).toBe('major');
    expect(findDefects('riscos, trincado e não liga').severity).toBe('broken');
  });

  it('separates ads that are not selling the product at all', () => {
    const wanted = findDefects('Procuro iPhone 13 para comprar');
    expect(wanted.notForSale.length).toBeGreaterThan(0);

    const accessory = findDefects('Apenas a capa do S22 Ultra, original');
    expect(accessory.notForSale.length).toBeGreaterThan(0);
  });

  it('keeps the matched context, so a verdict can be argued with', () => {
    const finding = findDefects('Aparelho ótimo, apenas uma linha verde na tela lateral.');
    expect(finding.hits[0]?.context).toContain('linha verde');
  });

  it('reports nothing for a clean description', () => {
    const finding = findDefects('Galaxy S22 Ultra 256GB, completo na caixa, nota fiscal.');
    expect(finding.severity).toBe('none');
    expect(finding.hits).toHaveLength(0);
  });

  it('honours a caller-supplied lexicon', () => {
    const lexicon = { ...DEFAULT_DEFECT_LEXICON, major: ['aro torto'], minor: [], broken: [] };
    expect(findDefects('roda com aro torto', lexicon).severity).toBe('major');
    // A term the caller dropped no longer counts against the ad.
    expect(findDefects('tela com linha verde', lexicon).severity).toBe('none');
  });
});

describe('severityOfCondition', () => {
  it('maps OLX own condition values onto the damage scale', () => {
    expect(severityOfCondition('Novo')).toBe('none');
    expect(severityOfCondition('Usado - Excelente')).toBe('none');
    expect(severityOfCondition('Usado - Bom')).toBe('minor');
    expect(severityOfCondition('Usado - Ruim')).toBe('major');
    expect(severityOfCondition('Não funciona')).toBe('broken');
    expect(severityOfCondition(undefined)).toBe('none');
  });
});

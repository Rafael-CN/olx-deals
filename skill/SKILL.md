---
name: garimpo-olx
description: Coleta em massa e triagem de anúncios da OLX Brasil (olx.com.br) via CLI `garimpo`, incluindo caça a "jóias" — o mesmo produto muito abaixo do preço mediano dele na própria OLX, sem defeito e de vendedor confiável. Acione quando o pedido envolver procurar, comparar, monitorar ou garimpar anúncios na OLX brasileira; varrer um produto por estado ou por todo o Brasil; achar o mais barato, uma pechincha, uma "jóia" ou um preço fora da curva; filtrar anúncios por defeito, condição, fotos, recência ou qualidade do vendedor; ou coletar centenas/milhares de anúncios para triagem. Triggers "OLX", "olx.com.br", "anúncio", "garimpo", "garimpar", "pechincha", "jóia", "achar barato", "quanto custa usado". NÃO use para outros marketplaces (Mercado Livre, Enjoei, Facebook Marketplace) nem para as OLX europeias.
---

# Garimpo OLX

CLI de coleta e triagem em massa da olx.com.br. Um comando varre o país, filtra
por etapas configuráveis e ranqueia achados contra o preço mediano do próprio
produto na OLX.

## Antes de qualquer coisa: os limites que mandam no desenho

Estes não são detalhes de implementação, são o que decide se uma coleta funciona.
Foram todos medidos contra o site, não deduzidos.

1. **Teto de 5.000 por consulta.** A OLX pagina no máximo 100 páginas de 50. A
   página 101 devolve a 100 de novo, sem erro. `q=iphone` no Brasil reporta mais
   de 100 mil resultados — nenhuma consulta única alcança isso. O `plan` fatia a
   busca por estado, categoria e faixa de preço até cada pedaço caber.

2. **`sortBy` troca o conjunto, não a ordem.** Aplicar qualquer ordenação faz a
   OLX responder com outros anúncios: `s22 ultra` no RS dá 71 sem ordenação e 7
   com. Por isso a coleta usa sempre `relevance` (o conjunto mais amplo) e ordena
   localmente. **Não mude isso** para "ordenar por menor preço no servidor" — você
   estaria varrendo um corpus menor.

3. **Cloudflare bloqueia, e é o gargalo real.** Blocos de 403 chegam por IP e
   valem para todo o domínio, `www` incluído. Três coisas seguem disso:

   - **Uma "requisição" não é uma requisição.** Abrir uma página da OLX no
     browser dispara o documento, os chunks do Next, analytics, slots de anúncio
     e as chamadas de API da própria página — dezenas de hits, muitos para
     olx.com.br. Por isso o `garimpo` **não abre página**: busca só o documento
     (1 requisição) e renderiza num DOM com JS desligado e rotas abortadas.
   - **E busca com o próprio Chrome.** O fetch acontece *dentro* de uma página já
     parada na origem alvo, via `fetch()` do navegador — TLS do Chrome, headers do
     Chrome, cookies do Chrome. Buscar pelo Node mandaria um handshake diferente
     do cliente que ganhou os cookies: menos requisições, cada uma menos coerente.
     A âncora de cada origem é o `robots.txt` dela.
   - **Qual portão você escolhe decide o custo.** O HTML do anúncio traz vendas
     concluídas/canceladas e os selos de verificação, mas **não** traz nome, data
     de entrada na OLX nem nota — esses só existem depois de hidratar. Então:

     | Portão de vendedor | Custo |
     |---|---|
     | `maxCancelRate`, `minSalesCompleted`, `requireVerified`, `requireChannels` | 1 requisição por anúncio |
     | `minAccountAgeMonths`, `minRating`, `minReviewCount` | **~60 requisições** por anúncio |

     Medido: uma página hidratada faz ~60 hits no olx.com.br (documento, chunks do
     Next, analytics, slots, APIs da página). O nome do vendedor sai de graça do
     payload embutido; data de entrada e nota não estão em lugar nenhum do
     documento — vêm de chamada client-side.

     Se a prioridade é não tomar bloqueio, monte o portão só com os de cima.
     Medido, não deduzido.
   - O ritmo se adapta (sobe devagar limpo, corta pela metade no bloqueio,
     cooldown dobrando), o run **para** após bloqueios consecutivos, e o
     bloqueio é **lembrado entre invocações**: começar de novo cedo demais é
     recusado. Um 403 nunca é reportado como "zero resultados".

4. **Detalhe custa 50× mais que card.** Uma requisição traz 50 cards; traz *um*
   detalhe. Toda filtragem que dá pra fazer no card vem antes — o CLI já ordena
   as etapas por isso. Descrição, atributos e dados do vendedor só existem no
   detalhe, então filtro de defeito e de vendedor obrigam a buscar a página.

## Setup

Verifique uma vez por máquina:

```bash
garimpo --help
```

Se não existir, o repositório está em `~/Documents/Projetos/Claude/olx-mcp`
(o diretório ainda tem o nome antigo; o pacote é `garimpo-olx`):

```bash
cd ~/Documents/Projetos/Claude/olx-mcp && npm install && npm run build && npm link
```

Precisa de Node 22+ (usa `node:sqlite`) e Chromium do Playwright
(`npx playwright install chromium`). Se o Chromium empacotado falhar, passe
`--channel chrome` para usar o Chrome instalado.

## Fluxo

### Passo 1 — entreviste o usuário

**Sempre pergunte antes de coletar.** Uma varredura custa tempo e crédito com o
site; rodar com o filtro errado desperdiça as duas coisas. Use `AskUserQuestion`,
agrupando em no máximo 4 perguntas por chamada, e só pergunte o que muda o
resultado. Se o usuário já deu a informação, não repita.

**Rodada 1 — o que buscar** (sempre)

- *Produto*: termo de busca. Insista em ser específico ("Galaxy S22 Ultra 256GB",
  não "celular Samsung").
- *Abrangência*: um estado / alguns estados / todo o Brasil. Ofereça o estado do
  usuário como opção recomendada quando ele já tiver dito onde mora — coleta
  nacional custa 27× mais requisições.
- *Faixa de preço*: ajuda muito a fatiar e a cortar acessório. Se o usuário não
  souber, ofereça rodar sem faixa e descobrir a mediana primeiro.
- *Objetivo*: garimpo (jóia) / levantamento de mercado / monitorar preço.

**Rodada 2 — rigor da triagem** (sempre)

- *Defeito tolerado*: `none` (só impecável) / `minor` (risco, marca de uso) /
  `major` (aceita trincado, linha verde). Recomende `minor`.
- *Qualidade do vendedor*: ofereça níveis prontos em vez de números crus —
  "qualquer um" / "com histórico" (conta 3+ meses, cancela menos de 1/3) /
  "exigente" (verificado, nota 4+, 5+ vendas). Traduza para as flags.
- *Vendedor sem histórico*: passa ou reprova. Para compra caia em `fail`, para
  levantamento em `pass`.
- *Idade do anúncio* e *mínimo de fotos*, se importar.

**Rodada 3 — orçamento** (quando a abrangência for grande)

- *Quantos anúncios*: cards a coletar (`--max-cards`) e páginas de detalhe a ler
  (`--max-details`). Deixe claro o custo: detalhe é uma requisição por anúncio.
- *Quanto tempo*: `--max-minutes`. Uma varredura nacional respeitando o ritmo
  leva horas, não minutos.

**Rodada 4 — só no modo jóia**

- *Desconto mínimo* contra a mediana (`--min-discount`, padrão 0.3 = 30% abaixo).
- *Piso de plausibilidade*: abaixo de qual fração da mediana o anúncio deixa de
  ser barato e passa a ser suspeito (`implausibleBelowPct`, padrão 0.25).
  Explique que existe: a 10% da mediana não é pechincha, é golpe, erro de
  digitação, sinal de parcelamento ou capinha anunciada com o nome do aparelho.

### Passo 2 — monte os termos de casamento

Isto é o que separa uma varredura útil de uma inútil, e o usuário não vai pensar
nisso. A busca da OLX é fuzzy: `s22 ultra` traz S22 comum, S22+, S21 Ultra, S23
Ultra e capinha. Medido: dos 71 resultados no RS, **7** eram S22 Ultra.

Derive do produto e mostre ao usuário antes de rodar:

- `--require`: cada termo tem que aparecer no título. Use regex tolerante a
  espaço — `'s\s*22'` pega "s22" e "s 22".
- `--reject`: modelos vizinhos e acessórios — `'capa,capinha,pel[ií]cula,
  carregador,cabo,fone,s21,s23,plus'`.

Confirme a lista com o usuário. Um `--reject` largo demais some com anúncio bom.

### Passo 3 — profile em arquivo, não em flags

Escreva um JSON e passe com `--profile`. Uma varredura que vale rodar vale
guardar, e histórico de shell não é registro de nada. `garimpo template` imprime
um profile completo e comentável para partir dele — inclui o léxico de defeitos
inteiro, que é a parte que mais vale ajustar por produto.

```bash
garimpo template > /tmp/perfil.json
```

### Passo 4 — rode

Um passo só (planeja, coleta, tria, lê detalhes, re-tria, ranqueia):

```bash
garimpo hunt --profile /tmp/perfil.json --top 10
```

Em fases, que é o certo para coleta grande — colete tudo primeiro, leia detalhes
depois, em invocações separadas:

```bash
garimpo plan    --profile /tmp/perfil.json
garimpo collect --profile /tmp/perfil.json --run <id>
garimpo enrich  --profile /tmp/perfil.json --run <id> --max-details 100
garimpo gems    --run <id>
```

Comece com `plan`: ele diz quantas fatias e quantos anúncios estão alcançáveis
gastando uma requisição por fatia. Mostre esse número ao usuário antes de
autorizar uma coleta grande.

### Passo 5 — leia resultados sem estourar o contexto

**Regra dura: nunca imprima linhas cruas.** Milhares de anúncios não cabem numa
conversa — é por isso que existe CLI e banco em disco em vez de tool call. Leia
sempre agregado:

```bash
garimpo report --run <id> --top 15         # funil, preços, melhores achados
garimpo report --run <id> --json --top 20  # o mesmo, estruturado
```

O `report` já traz o que interessa: quantos anúncios caíram em cada etapa, por
quê (agrupado), a faixa de preço e os melhores achados com o motivo de cada um.
Se precisar de algo que ele não dá, consulte o SQLite em
`<data-dir>/garimpo.db` com uma query agregada — nunca um `SELECT *`.

Ao relatar, cite o funil. "5 de 57 passaram, 43 caíram por título sem 's22'" diz
ao usuário se o filtro está trabalhando ou comendo o corpus inteiro.

## Modo jóia

O que conta como jóia:

- A referência é a **mediana dos anúncios limpos** — só os que passaram a
  triagem. Incluir os quebrados derruba a mediana e faz a pechincha real parecer
  preço normal, que é exatamente o contrário do que se quer.
- Mediana e MAD, não média e desvio padrão. Preço de usado é assimétrico e
  salgado de anúncio de R$ 1 ("chama no zap"); média e desvio padrão são
  arrastados pelas duas caudas.
- Jóia mora numa **faixa**: bem abaixo da mediana, mas acima do piso de
  plausibilidade. Abaixo do piso o veredito é `suspect`, aparece no relatório mas
  nunca no topo.
- Qualidade e vendedor entram **multiplicando**, não somando. Nenhum desconto é
  grande o bastante para redimir aparelho quebrado de vendedor que cancela tudo.
- Vereditos: `gem` (age agora), `watch` (bom, abaixo do score de alerta),
  `suspect` (barato demais para ser verdade), `rejected` (preço normal).

Com menos de `minReferenceSize` comparáveis o CLI **se recusa** a chamar
qualquer coisa de jóia. Não contorne baixando o número: sem saber o preço do
produto não existe desconto, e um "achado" sobre 3 anúncios é ruído.

## Não tomar bloqueio

Se a prioridade é nunca ser bloqueado, mesmo custando horas:

```bash
garimpo hunt --profile /tmp/perfil.json --gentle
```

`--gentle` é ~2 rpm, uma página por vez, 8s de jitter, pausa de 5 min a cada 60
requisições, e 10 min de silêncio no primeiro 403. Uma varredura estadual leva
horas assim — que é exatamente a troca pedida.

Outras alavancas, em ordem de efeito:

- **Não peça detalhe do que você vai descartar.** O filtro de card é grátis
  comparado à página do anúncio. `--require`/`--reject` bem feitos cortam 80-90%
  antes de qualquer detalhe.
- **Não releia o que já leu.** `--refresh-after-days 7` (padrão) faz um garimpo
  repetido custar quase nada.
- **Sem etapa `seller`, nenhum anúncio custa JavaScript.** Se qualidade de
  vendedor não é decisiva pra você, tire a etapa e o run inteiro fica em 1
  requisição por anúncio.
- **Fatie e espalhe.** `--max-minutes 45` + retomar depois é mais seguro que uma
  varredura longa contínua: limite de taxa é por janela, e uma pausa real conta
  mais que um gotejar lento.
- `--pause-every` / `--pause-for` para gaps longos dentro do próprio run.
- **Rode de madrugada.** `--window 02:00-07:00` só trabalha nessas horas (aceita
  virar a meia-noite). Site sob carga policia tráfego mais do que site vazio, e
  uma varredura noturna é mais barata para os dois lados.
- **Veja o custo antes de gastar.** `garimpo plan` imprime a estimativa de
  requisições e de tempo. Mostre ao usuário antes de autorizar coleta grande.

**Nunca:** trocar de IP/proxy, randomizar fingerprint, resolver captcha. Isso é
evasão, não boa vizinhança — e é o que transforma um limite temporário de taxa em
bloqueio de verdade. Se a OLX disser não, a resposta é voltar depois.

## Quando bloquear

Um 403 não é falha do código. O `garimpo` desacelera, para depois de bloqueios
consecutivos e salva tudo. Diga ao usuário o que foi coletado e retome depois:

```bash
garimpo enrich --profile /tmp/perfil.json --run <id> --rpm 3
```

O resume é por fatia e por página: uma fatia bloqueada na página 40 de 100 volta
da 41. Se bloquear repetido, espere de verdade (dezenas de minutos), baixe o
`--rpm`, e considere `--no-block-assets` — o CLI descarta imagem por padrão para
economizar requisição, mas navegador que nunca carrega foto também parece menos
com navegador.

**Não sonde o limite de propósito.** É abusar do site e o número não é estável.

## Honestidade sobre cobertura

- Fatia que a OLX diz ter mais de 5.000 anúncios e não pôde ser dividida sai
  marcada como `truncated`, e o `plan` avisa nas notas. Repasse isso: coleta
  parcial reportada como completa é pior que coleta parcial.
- **Anúncio sem preço não aparece em nenhuma faixa de preço.** Onde uma fatia
  precisou ser dividida por preço, esses anúncios ficam inalcançáveis. O `plan`
  avisa. Isso é limitação conhecida, não bug.
- Vazão de detalhe é o gargalo e depende do humor do Cloudflare com seu IP no
  dia. Não prometa "mil anúncios lidos hoje" sem ter medido no dia.

## Referência de flags

Rode `garimpo --help`. As que mais importam:

| Flag | Para quê |
|---|---|
| `--profile <path>` | profile JSON; toda flag sobrescreve |
| `--states sp,rj` | UFs (vazio = 27) |
| `--categories celulares` | slug de categoria da OLX |
| `--require` / `--reject` | casamento de título (regex) |
| `--tolerate none\|minor\|major` | pior defeito aceito |
| `--seller-*` | nota, vendas, taxa de cancelamento, idade da conta, verificado |
| `--seller-unknown pass\|fail` | vendedor sem histórico |
| `--max-cards` / `--max-details` / `--max-requests` / `--max-minutes` | orçamento |
| `--gentle` | preset "não quero tomar bloqueio": ~2 rpm, 1 página por vez |
| `--rpm` / `--max-rpm` / `--cooldown` | ritmo inicial; adapta sozinho |
| `--pause-every` / `--pause-for` | gaps longos ociosos entre rajadas |
| `--window 02:00-07:00` | só trabalha nessas horas (aceita virar meia-noite) |
| `--refresh-after-days` | não relê página de anúncio mais nova que isso |
| `--force` | começa mesmo com cooldown de bloqueio pendente |
| `--min-discount` / `--min-z` / `--min-reference` | rigor do garimpo |
| `--run <id>` | retomar |
| `--json` | saída estruturada |

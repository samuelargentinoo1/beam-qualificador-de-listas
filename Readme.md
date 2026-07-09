# Beam — Qualificador de Listas (v1)

Ferramenta interna **BeamBrocker + Babuya** que automatiza o processo de montagem de listas de prospecção
(doc: *Processo de montagem de lista BeamBrocker+Babuya*): captura no Google Maps → limpeza → cruzamento
de dados (site ✚ CNPJ/QSA ✚ Instagram) → lista final + CSV pronto para importar no Pipedrive.

## Como usar

```bash
npm start
```

Abra **http://localhost:3010**, digite na barra de pesquisa (ex.: `imobiliárias de São José do Rio Preto`),
confira a UF e clique em **Gerar 60 leads**. Acompanhe o funil ao vivo; ao final, baixe os arquivos.

> Requisitos: Node 18+ e Google Chrome instalado (a ferramenta usa o Chrome via Playwright).
> Para ver o navegador trabalhando: `HEADFUL=1 npm start`.

## O que a ferramenta entrega

Só entram na lista final leads **"prontos"** (regra da casa: *só lead com site e com dados cruzados*):

1. **Site acessível** — abrimos o site oficial; se não abre, descarta.
2. **Instagram confirmado no site** — só aceitamos o @ que o próprio site aponta (nunca chute de busca).
3. **Decisor real** — sócio-administrador extraído do QSA (cnpj.biz), com dupla checagem:
   a cidade do CNPJ tem que bater e o nome tem que bater com a razão social.
4. **Regras de limpeza do processo** — corta <10 avaliações, sem telefone, sem site, corretor solo,
   duplicados; franquias/redes entram marcadas com `F - `.

## Mecanismo anti-repetido (ledger)

Cada praça (segmento + cidade) tem um registro em `data/ledger.json` com tudo que já foi **entregue**
e **descartado**. Ao gerar de novo a mesma praça (ex.: pedir Rio Preto hoje e de novo amanhã), a ferramenta
**pula automaticamente** esses leads e busca só novos — inclusive ampliando a busca por zonas
(centro/norte/sul/leste/oeste) até bater a meta de 60 ou esgotar a praça.

## Arquivos gerados (por lista)

`listas/lista de prospeccao - AAAA - MM/#N-<segmento>-<cidade>-.../`

| Arquivo | Conteúdo |
|---|---|
| `#N-lista-bruta-…csv` | tudo que veio do Maps |
| `#N-lista-limpa-…csv` | aprovados na limpeza |
| `#N-lista-final-…csv` | **leads qualificados** (dados cruzados) |
| `#N-pipedrive-import-…csv` | pronto p/ importar (14 colunas, Deal R$ 3.000, etapa Prospecto) |
| `#N-descartes-…csv` | quem caiu e por quê (transparência do funil) |

## Identidade visual

As cores/logo estão em `public/styles.css` (bloco `:root` no topo) e no SVG do header em
`public/index.html`. Troque pelas cores oficiais da Beam quando tiver o manual da marca.

## Estrutura

```
server.js          ← servidor local (Express) + API
lib/scrape.js      ← captura no Google Maps
lib/clean.js       ← regras de limpeza do processo
lib/enrich.js      ← cruzamento: site + CNPJ/QSA (cnpj.biz) + Instagram
lib/ledger.js      ← anti-repetido por praça
lib/exporter.js    ← CSVs finais + Pipedrive
lib/runner.js      ← orquestra o pipeline
public/            ← interface (barra de pesquisa, progresso, Minhas listas)
data/              ← ledger.json, lists.json (histórico), meta.json
```

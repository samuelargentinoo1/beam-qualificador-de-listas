# Beam — Qualificador de Listas (v1)

Ferramenta interna **BeamBrocker + Babuya** que automatiza o processo de montagem de listas de prospecção
(doc: *Processo de montagem de lista BeamBrocker+Babuya*): captura no Google Maps → limpeza → cruzamento
de dados (site ✚ CNPJ/QSA ✚ Instagram) → lista final + CSV pronto para importar no Pipedrive.

## Como usar (no computador — jeito fácil)

**Duplo clique em `Iniciar Ferramenta.command`** — instala o que precisar, liga tudo e abre
**http://localhost:3010**. Para desligar: `Parar Ferramenta.command`. (Via terminal: `npm start`.)

Na tela: digite na barra (ex.: `imobiliárias de Curitiba`), confira a UF e clique **Gerar 60 leads**.
Durante a geração uma janela do Chrome fica aberta trabalhando — se aparecer captcha, resolva nela.

> Requisitos: Node 18+ e Google Chrome. A geração roda **no seu computador** de propósito:
> IP residencial + janela do Chrome passam pelos bloqueios anti-robô que derrubam servidores na nuvem.

## Painel na nuvem (Vercel + Supabase)

O mesmo repositório vira um **painel acessível de qualquer lugar**: a Vercel serve a interface e as APIs,
o Supabase guarda fila/histórico/leads, e o **worker no seu computador** executa as gerações.

```
painel (Vercel) → fila (Supabase) → worker no seu Mac → leads voltam pro Supabase → download no painel
```

Configuração (1x):
1. **Supabase** → SQL Editor → cole o conteúdo de `supabase-schema.sql` → Run.
2. **Cadastre os SDRs** (login individual — veja a seção abaixo).
3. **No computador/VPS**: copie `.env.example` para `.env`, preencha com URL e service_role do
   Supabase, e rode o `Iniciar Ferramenta.command` — o worker liga junto e fica vigiando a fila.

### Login individual → responsável no Moskit

Cada pessoa entra no painel com **usuário e senha próprios**. O pedido de lista grava quem
pediu, e ao terminar os leads sobem pro Moskit com **essa pessoa** como responsável
(empresa + contato + negócio). Não existe mais senha única do painel.

**Como criar os acessos:** na primeira vez que o painel abre sem nenhum usuário, ele mostra a
tela de **Primeiro acesso** — você monta o seu login ali mesmo, usando a *chave de instalação*
(o valor de `APP_PASSWORD` no `.env`, que era a senha antiga do painel). Depois disso, a aba
**Equipe** cadastra o resto do time: usuário, senha e a pessoa correspondente no Moskit.
Nada de SQL nem de mexer no servidor.

Os usuários podem vir de **três fontes**, nesta ordem de prioridade:

| Fonte | Onde | Observação |
|---|---|---|
| tabela `usuarios` | Supabase | manda quando existe (rode o `supabase-schema.sql`) |
| `data/usuarios.json` | servidor | criado pelo painel (primeiro acesso + aba Equipe) |
| `PAINEL_USUARIOS` | `.env` | `login:senha:Nome:idNoMoskit`, separados por vírgula |

O painel grava na tabela quando ela existe; senão, no arquivo. Se um dia você criar a tabela,
ela assume sozinha — sem trocar código.

Dar acesso a alguém direto pela tabela (SQL Editor do Supabase):

```sql
insert into usuarios (login, senha, nome, moskit_user_id) values ('julia', 'SENHA-AQUI', 'Julia', 155073);
```

- `login`: minúsculo, sem espaço — é o que a pessoa digita.
- `moskit_user_id`: id do usuário no Moskit. Pra listar todos: `node scripts/moskit-usuarios.js`.
- Alguém saiu do time: `update usuarios set ativo = false where login = 'fulano';`
- Link mágico pra mandar pra pessoa (entra sozinho): `https://qualificador.beambroker.com.br/#u=julia&k=SENHA`

`MOSKIT_RESPONSIBLE_ID` no `.env` virou só o **padrão de segurança**: é usado quando o pedido
não tem usuário (geração local sem login) ou quando o `moskit_user_id` cadastrado não existe /
está inativo na conta — nesse caso o log da geração avisa.

Pedidos feitos no painel ficam **na fila** até o computador com o worker estar ligado.
No painel da nuvem, os downloads disponíveis são a **Lista Final** e o **CSV Pipedrive**
(gerados direto do banco); os demais arquivos (bruta/limpa/descartes) ficam no computador.

## O que a ferramenta entrega

Só entram na lista final leads **"prontos"** (regra da casa: *só lead com site e com dados cruzados*):

1. **Site acessível** — abrimos o site oficial; se não abre, descarta.
2. **Instagram confirmado no site** — só aceitamos o @ que o próprio site aponta (nunca chute de busca).
3. **Decisor real** — sócio-administrador extraído do QSA (cnpj.biz), com dupla checagem:
   a cidade do CNPJ tem que bater e o nome tem que bater com a razão social.
4. **Regras de limpeza do processo** — corta <10 avaliações, sem telefone, sem site, corretor solo,
   **construtora** (fora do público-alvo), duplicados; franquias/redes entram marcadas com `F - `.

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

# Registo de Grávidas — documentação técnica

Aplicação de registo de grávidas que substitui um Excel partilhado. É um **único `index.html` autocontido** (Vite + TypeScript + `vite-plugin-singlefile`), aberto via `file://` no Microsoft Edge ou no Chrome, a partir de uma pasta do OneDrive for Business sincronizada em cada PC. Não precisa de servidor, instalação, registo de aplicações nem internet: a única infraestrutura é a pasta partilhada.

As instruções para os utilizadores finais estão em [static/LEIA-ME.html](static/LEIA-ME.html), que é copiado para a pasta final.

---

## 1. Build e testes

Requisitos: Node.js ≥ 20 e npm. O `.npmrc` ativa `legacy-peer-deps` (o `vite-plugin-singlefile` ainda declara um intervalo de *peers* anterior ao Vite 8).

```bash
npm ci                          # dependências (SheetJS vem do CDN oficial, ver package.json)
npm run build                   # typecheck + vite build + monta RegistoGravidas/
npm test                        # testes unitários (Vitest)
npx playwright install chromium # só na primeira vez
npm run test:e2e                # build + testes E2E (Playwright, Chromium, file://)
npm run test:all                # tudo
```

`npm run build` gera:

```
RegistoGravidas/          ← copiar esta pasta para o OneDrive
  index.html              (~450 KB, tudo embutido: código, CSS, SheetJS)
  LEIA-ME.html
  data/config.json
  data/events/            (vazia)
  data/snapshots/         (vazia)
```

O script [scripts/package.mjs](scripts/package.mjs) recusa o build se o `index.html` referenciar recursos externos, se faltar a CSP, ou se aparecer qualquer `.xlsx` ou ficheiro de dados na pasta final. O fixture `tests/fixtures/registo_gravidas_ANONIMIZADO.xlsx` só é usado nos testes.

O `index.html` tem uma Content-Security-Policy com `connect-src 'none'` e `default-src 'none'`: o browser bloqueia qualquer pedido de rede.

## 2. Estrutura do código

```
src/
  core/                  lógica pura, sem DOM (100% testável em Node)
    types.ts             modelo de dados, campos, listas por omissão
    hlc.ts               hybrid logical clock
    events.ts            criação, validação/migração e nomes de ficheiro dos eventos
    merge.ts             merge determinístico: LWW por campo + deteção de conflitos
    snapshot.ts          snapshots ("Consolidar") e reconstrução do estado
    records.ts           vistas: filtros, ordenação, "A contactar", índice de SNS
    dates.ts             datas de calendário, IG, janela do curso, séries do Excel
    validation.ts        validação do formulário e normalização (telefone, SNS, escolhas)
    csv.ts, zip.ts       exportação CSV (Excel PT) e ZIP "stored" para descargas múltiplas
    fileFilter.ts        ficheiros a ignorar (.crswap, .tmp, temporários do OneDrive…)
  storage/
    fsTypes.ts           subconjunto da File System Access API usado (implementado pelos mocks)
    fsa.ts               modo completo: listar, gravar (só ficheiros novos), probe, arquivo
    compat.ts            modo compatível: <input webkitdirectory> e descargas
    reader.ts            leitura comum aos dois modos, cache por caminho, relatório de ignorados
    pending.ts           fila local de eventos ainda não confirmados na pasta
    capabilities.ts      deteção de capacidades
    idb.ts, kv.ts        IndexedDB (handle da pasta) e localStorage
  import/excel.ts        importação do Excel (SheetJS)
  app/controller.ts      orquestração: modos, leitura periódica, gravação, snapshots
  ui/                    interface (DOM puro, sem framework), CSS
static/                  LEIA-ME.html e config.json da pasta final
tests/unit/              Vitest
tests/e2e/               Playwright
tests/helpers/           mock da File System Access API em memória, simulador de PCs
```

## 3. Formato dos dados na pasta

```
RegistoGravidas/
  index.html
  LEIA-ME.html
  data/config.json
  data/events/AAAA/MM/<ISO-UTC>_<deviceId>_<uuid>.json
  data/snapshots/snapshot_<ISO-UTC>_<deviceId>.json
  data/archive/events/AAAA/MM/…        (eventos arquivados — não são lidos)
  data/.probe/                          (teste de escrita; fica vazia)
```

**Regra:** a aplicação só **cria ficheiros novos** com nomes únicos. Nunca modifica nem apaga ficheiros de outros. As exceções são três, todas sobre ficheiros próprios ou ações explícitas:

1. o ficheiro de teste `data/.probe/<deviceId>`, escrito e apagado no arranque;
2. a recuperação de uma gravação própria interrompida: um ficheiro vazio ou truncado com o nome do próprio evento é completado. O nome contém o `deviceId` e um uuid, por isso não pode ser de outra pessoa; um ficheiro com outro conteúdo nunca é tocado;
3. a opção explícita "Mover para data/archive" (só no modo completo), que copia, relê para confirmar e só depois remove o original.

### Nome dos ficheiros

`<ISO-UTC>` é o `ts` do evento em ISO 8601 UTC, com `:` e `.` trocados por `-`, porque `:` não é válido em nomes de ficheiro no Windows:

```
2026-10-03T12:34:56.789Z  →  2026-10-03T12-34-56-789Z
data/events/2026/10/2026-10-03T12-34-56-789Z_pc4kq7m2xz9a_6f1c…-….json
```

O `deviceId` é gerado na primeira utilização de cada browser: `pc` + 10 caracteres `[a-z0-9]`, sem `_` (que separa os campos). Fica no `localStorage`.

A leitura percorre `data/events` recursivamente e decide o tipo pelo conteúdo. Um evento colocado diretamente em `data/events/` (sem subpasta), ou um snapshot guardado por engano em `data/events/`, é aceite na mesma — o que dá margem no modo compatível.

### Evento (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "id": "6f1c2a9e-4b7d-4c1e-9a0f-2d3b4c5e6f70",
  "ts": "2026-10-03T12:34:56.789Z",
  "hlc": "001791030896789-000000",
  "author": "Ana Teste",
  "deviceId": "pc4kq7m2xz9a",
  "recordId": "0b7e…",
  "type": "update",
  "changes": { "Telefone": { "from": "912345678", "to": "913333333" } },
  "baseRev": "001791030850000-000002"
}
```

| Campo | Significado |
|---|---|
| `id` | uuid v4 do evento (também no nome do ficheiro). Duplicados (mesmo `id`) são ignorados. |
| `ts` | data/hora física do PC, só informativa. |
| `hlc` | hybrid logical clock: `<ms desde 1970, 15 dígitos>-<contador, 6 dígitos>`. Ordena por comparação de texto. |
| `author` | nome indicado na aplicação. |
| `recordId` | uuid do registo. |
| `type` | `create` · `update` · `archive` · `restore` · `resolve` |
| `changes` | `{ campo: { from, to } }`. Todos os valores são texto; `""` = vazio; `from` é `null` num `create`. |
| `baseRev` | maior `hlc` do registo visto por quem editou (`null` num `create`). |

Campos (`changes`): `Nome`, `NumeroSNS`, `DataNascimento`, `Email`, `Telefone`, `UnidadeFuncional`, `MedicoAssistente`, `DUM`, `DPP`, `ProvenienciaContacto`, `Contactada` (`Sim`/`Não`/`""`), `DataContacto`, `Observacoes`, `Estado` (`Ativa`/`Concluída`/`Desistiu`/`Arquivada`), `AvisosImportacao` (texto para revisão, apagado ao marcar "Revisto"). As datas são `AAAA-MM-DD`. A idade gestacional e a janela do curso são calculadas e não se guardam. `archive`/`restore` são alterações ao `Estado` com um tipo próprio, para o histórico.

**Versões do esquema.** Um evento com `schemaVersion` maior do que o suportado é ignorado, com o motivo "atualize o index.html" no Diagnóstico. Eventos antigos são migrados ao ler: sem `schemaVersion` → v0; sem `hlc` → derivado de `ts`; sem `baseRev` → assume-se que o autor viu tudo o que é anterior ao próprio evento (só LWW, sem conflito). Valores numéricos/booleanos passam a texto e chaves como `__proto__` são descartadas. Para mudar o formato no futuro: incrementar `SCHEMA_VERSION` em [src/core/types.ts](src/core/types.ts) e acrescentar a migração em `normalizeEvent` ([src/core/events.ts](src/core/events.ts)). Os PCs com o `index.html` antigo passam a ignorar (e a listar) os eventos novos em vez de os interpretarem mal.

### Snapshot

```json
{ "schemaVersion": 1, "kind": "snapshot", "id": "…", "ts": "…", "hlc": "…", "author": "…", "deviceId": "…",
  "eventCount": 1234, "eventIds": ["…"], "records": { "<recordId>": { "fields": { … }, "history": [ … ], … } } }
```

`records` guarda o estado de merge completo: por campo, o valor vencedor e as "cabeças" concorrentes, mais o histórico. Assim, os eventos tardios aplicados por cima produzem exatamente o mesmo resultado que aplicar tudo de raiz (há testes para isto). Um snapshot truncado (`eventCount` ≠ n.º de `eventIds`) ou inválido é ignorado.

**Estado atual** = união de **todos** os snapshots válidos + eventos cujo `id` não está em nenhum deles. No caso normal os snapshots formam uma cadeia, e a união é igual ao último snapshot válido, como pedido. A união evita perder dados se um PC que esteve offline consolidar a partir de um estado antigo depois de outro já ter arquivado eventos.

**Arquivo:** são elegíveis os eventos incluídos num snapshot com mais de 90 dias.

### config.json

```json
{ "UnidadeFuncional": ["UCSP Loures", …], "ProvenienciaContacto": ["Plataforma", "Email", "Telefone", "Unidade de Saúde"] }
```

É relido sempre que muda. Se faltar ou for inválido, usam-se as listas por omissão (com aviso). Valores fora da lista continuam a ser aceites e aparecem como "(fora da lista)".

## 4. Merge e conflitos

- **Valor de cada campo:** last-writer-wins pela ordem `(hlc, deviceId, id)`.
- **HLC:** cada evento local recebe um `hlc` maior do que todos os já emitidos ou vistos neste PC. Uma edição feita depois de ver outra ordena sempre depois dela, mesmo com o relógio do PC atrasado ou adiantado, ou se recuar. O último `hlc` fica no `localStorage`.
- **Conflito:** para cada campo mantêm-se as "cabeças", ou seja, as alterações que nenhuma outra viu. A alteração X *viu* Y quando `X.baseRev >= Y.hlc`. Duas ou mais cabeças com valores diferentes significam conflito. É uma generalização do caso da especificação ("duas alterações ao mesmo campo a partir do mesmo `baseRev`"), que também apanha casos com 3 PCs ou com `baseRev` diferentes que não se viram mutuamente. Alterações concorrentes a campos diferentes não são conflito.
- **Resolução:** um evento `resolve` com `baseRev` = `rev` atual (≥ todas as cabeças) substitui-as.
- **Propriedades testadas:** o resultado não depende da ordem de chegada (testado com 25 permutações), os duplicados são ignorados, e snapshot + eventos tardios = recomputação total. A relação "viu" é transitiva porque `hlc > baseRev` em cada evento (imposto ao ler).
- **Limitação conhecida:** o `baseRev` é só um `hlc`. Se dois PCs gerarem exatamente o mesmo `hlc` (mesmo milissegundo e mesmo contador) e um terceiro editar a partir desse valor, a edição "parece ter visto" ambos. Exige edições ao mesmo registo no mesmo milissegundo em PCs diferentes. Nesse caso o valor continua determinístico (LWW); só não fica marcado como conflito.

## 5. Modos e deteção de capacidades

No arranque detetam-se `window.showDirectoryPicker`, `<input webkitdirectory>`, IndexedDB em `file://` e `localStorage`. Ao escolher a pasta faz-se o teste de escrita efetiva (`data/.probe/<deviceId>`: escrever, reler, apagar).

| Situação | Modo |
|---|---|
| API disponível e teste de escrita OK | **Completo**: lê e grava na pasta; leitura incremental a cada 20 s e ao focar a janela. |
| API disponível, escrita recusada (política, permissões) | **Compatível com leitura automática**: lê pelo handle; grava por descarga. |
| API ausente ou bloqueada (`SecurityError`…) | **Compatível**: lê com `<input webkitdirectory>` (botão "Atualizar" = selecionar de novo); grava por descarga. |

- O `FileSystemDirectoryHandle` fica no IndexedDB. Na sessão seguinte, `queryPermission` → se for `prompt`, mostra o botão "Continuar com a pasta «…»" (um clique → `requestPermission`). Se o handle não se puder guardar ou restaurar, a pasta é pedida em cada sessão (indicado no Diagnóstico).
- **Descargas (modo compatível):** um evento → um `.json` com o nome final. Vários eventos (importação, "descarregar todos") → um `.zip` com a estrutura `AAAA/MM/…`, para extrair em `data\events`. Cada descarga mostra o caminho de destino exato.
- **Fila de pendentes:** cada evento descarregado fica no `localStorage` até aparecer numa leitura da pasta. Os pendentes entram no estado mostrado com a marca "Por confirmar", geram um aviso persistente (com "Descarregar de novo") e sobrevivem ao fecho do browser. No modo completo, os pendentes (de uma falha de escrita anterior) são gravados diretamente na leitura seguinte.
- Os dois modos usam exatamente o mesmo formato e coexistem na mesma pasta (testado E2E).

### Garantias contra perda de dados

- O formulário só fecha depois de a gravação ser confirmada: o ficheiro é relido e comparado.
- Se a escrita falhar, aparece um diálogo com "Tentar de novo" (o **mesmo** evento, por isso a operação é idempotente), "Guardar por descarga" ou "Cancelar" (o formulário fica intacto). Sair com alterações por gravar pede confirmação.
- Ficheiros a meio da sincronização (JSON incompleto, tamanho 0), `.crswap`, `.tmp`, `~$…` e ocultos do OneDrive são ignorados e tentados de novo na leitura seguinte. Ficam listados, com o motivo, no Diagnóstico.
- A cache é por caminho e só guarda leituras bem-sucedidas (eventos e snapshots são imutáveis). Na leitura periódica só se abrem ficheiros novos.

## 6. Dados guardados localmente (por perfil do browser)

| Onde | O quê |
|---|---|
| `localStorage` `rg.author` | nome do utilizador |
| `localStorage` `rg.deviceId` | identificador do PC/browser |
| `localStorage` `rg.hlc` | último hlc (monotonia do relógio) |
| `localStorage` `rg.lastVisit` | marca "última visita": só um hlc, sem dados pessoais |
| `localStorage` `rg.pending` | eventos descarregados ainda não confirmados. **Contêm dados pessoais** até serem confirmados; é necessário para não perder dados. |
| IndexedDB `registo-gravidas` | o handle da pasta (modo completo) |

A exportação CSV (`;`, UTF-8 com BOM, datas dd/mm/aaaa, proteção contra injeção de fórmulas) vai para Transferências e contém dados pessoais. O LEIA-ME avisa disto.

## 7. Importação do Excel

[src/import/excel.ts](src/import/excel.ts) usa o SheetJS 0.20.3, embutido no bundle e instalado a partir do CDN oficial da SheetJS (a versão do registo npm, 0.18.5, tem vulnerabilidades conhecidas).

- Folha "Grávidas 2026" (com tolerância a acentos e maiúsculas); cabeçalho na linha 3, com procura nas 20 primeiras linhas se tiver mudado. As colunas são associadas pelo nome, sem acentos e com `trim` (por isso `"DUM "` funciona). `Semanas de Gravidez`, `Coluna1` e `Curso` são ignoradas.
- Datas por número de série (sistema 1900 com o falso 29/02/1900, ou 1904 se o livro o indicar), por `Date` ou por texto dd/mm/aaaa. SNS e telefone numéricos passam a texto; `+351`/`00351` são removidos.
- As escolhas são normalizadas contra o `config.json` ignorando acentos e maiúsculas (`Unidade de Saude` → `Unidade de Saúde`). Valores fora da lista são importados e assinalados em `AvisosImportacao` (badge "Rever", filtro "Só para rever").
- `contactada`: `Sim`/`Não`/vazio. Linhas vazias (só com a fórmula do Curso) são ignoradas. A DPP em falta é calculada (DUM + 280).
- **Duplicados:** por SNS contra todos os registos existentes (incluindo arquivados e pendentes) e dentro do próprio ficheiro. Sem SNS, compara-se nome + DUM. O plano é recalculado no momento de importar.

## 8. Testes

**Unitários (Vitest, 74 testes)** — `tests/unit/`:
- `merge.test.ts`: dois PCs em concorrência (mesmo campo → conflito; campos diferentes → sem conflito), resolução, 3 PCs, relógios desacertados ±10 min, relógio a recuar, 25 permutações de ordem de chegada, duplicados, alteração antes da criação, `schemaVersion` antiga.
- `snapshot.test.ts`: snapshot + eventos tardios (incluindo um PC offline 3 dias) = recomputação total, só snapshot (eventos arquivados), snapshots divergentes, corrompidos ou truncados.
- `events.test.ts`: formato e nome dos ficheiros, ficheiros corrompidos ou incompletos, migração, HLC, filtro de ficheiros temporários.
- `storage.test.ts`: **mock da File System Access API** ([tests/helpers/memfs.ts](tests/helpers/memfs.ts), com simulação de `.crswap`, só de leitura e falhas de escrita) e **mock do fallback** (`webkitRelativePath` + descargas). Cobre a deteção de modo, o probe, a escrita sem sobreposição, a cache incremental, as cópias de conflito do OneDrive, a recuperação de gravações interrompidas, a falha de I/O sem perda, a fila de pendentes, os ZIP, a coexistência dos dois modos, a permissão "prompt", o handle não persistível, consolidar e arquivar, e "novo/alterado desde a última visita".
- `dates.test.ts`, `validation.test.ts`, `import.test.ts`: cálculos de datas (IG, DPP, janela, hora de verão, séries do Excel), validação, filtros, "A contactar", CSV e ZIP, e importação **com o fixture** `tests/fixtures/registo_gravidas_ANONIMIZADO.xlsx` e com livros sintéticos.

**E2E (Playwright, Chromium, `file://`, 9 testes)** — `tests/e2e/`. Cada teste usa uma cópia nova de `RegistoGravidas/` numa pasta temporária, com a data fixada (`page.clock`).
- *Modo completo:* o seletor de pastas nativo não é automatizável, por isso injeta-se um `showDirectoryPicker` cujo handle executa as operações **no disco real**, via `page.exposeFunction`. Cenários: primeira utilização, validação, criar, editar, histórico, arquivar, ficheiros em disco e Diagnóstico; importar o fixture, duplicados, pesquisa, filtros, ordenação, CSV, "A contactar", consolidar e recarregar; dois PCs (dois contextos) com conflito e resolução.
- *Modo compatível:* `showDirectoryPicker` removido; usa-se o `<input webkitdirectory>` real (`setFiles` com a pasta) e descargas reais. Cenários: ler, gravar por descarga, instruções com o caminho, pendente, confirmação após mover o ficheiro, ficheiros ignorados no Diagnóstico; importação em ZIP e pendentes após recarregar; API presente mas escrita recusada → compatível automático; coexistência com um PC em modo completo sobre a mesma pasta.
- *Acessibilidade:* axe-core (WCAG 2.1 A/AA) em todos os ecrãs principais, incluindo o formulário com erros, e navegação por teclado (link "Saltar para o conteúdo", foco estável durante as leituras periódicas).

Todos os dados de teste são fictícios.

## 9. Limitações e riscos conhecidos

- **Não foi testado no ambiente de destino** (Windows, Edge com políticas da organização, OneDrive real). Por isso a app deteta capacidades em runtime e degrada para o modo compatível. O ecrã Diagnóstico e o botão "Copiar diagnóstico" servem para recolher informação no terreno.
- O E2E do modo completo usa um handle simulado (sobre o disco real), não o seletor nativo. Também não exercita a persistência real do handle no IndexedDB: o mock não sobrevive à clonagem, o que testa o caminho "pedir a pasta em cada sessão".
- Políticas do Edge como `FileSystemWriteBlockedForUrls`/`DefaultFileSystemWriteGuardSetting` levam ao modo compatível. Se também `webkitdirectory`/descargas estiverem bloqueados, a app não consegue funcionar e o Diagnóstico mostra-o.
- Com o "Ficheiros a pedido" do OneDrive, ficheiros só na nuvem podem falhar a leitura. O LEIA-ME pede "Manter sempre neste dispositivo", e as falhas são tentadas de novo.
- Os dados locais (`localStorage`/IndexedDB) são por perfil do browser: um utilizador noutro PC é outro `deviceId`.
- Ver também a limitação do `baseRev` com hlc idênticos (secção 4).
- Num teste E2E (coexistência dos modos) houve 3 falhas intermitentes logo após uma alteração; não se reproduziram em mais de 15 execuções seguidas. O teste mostra agora o estado da página se a descarga não ocorrer.

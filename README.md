# 📚 Estudos

Organizador de estudos para provas. Funciona no celular e no computador, com o mesmo progresso em todos os aparelhos.

- **Matérias com data de prova**: contagem regressiva e quantas **aulas por dia** faltam para fechar o conteúdo a tempo
- **Aulas**: marque **Estudei** e **Flashcards** com um toque; a porcentagem de cada matéria é calculada sozinha
- **Importar aulas colando texto**: uma aula por linha (aceita listas com `-`, `*` ou `•`)
- **Última revisão**: a aba *Hoje* mostra as aulas **esfriando** (7 dias ou mais sem revisar)
- **Deck de flashcards** por matéria (link ou nome do deck do Anki)
- **Dúvidas** por aula, com status pendente ou resolvida e uma aba só com as pendentes
- **Sincronização** via Cloudflare Workers + KV, protegida por senha. Funciona offline e sobe as mudanças quando a conexão volta
- **Backup**: exporte e importe um arquivo JSON

## Como publicar no Cloudflare (uma vez só)

Pré-requisito: [Node.js](https://nodejs.org) 20 ou mais recente.

```bash
git clone https://github.com/ShifT3301/estudos.git
cd estudos
npm install
npx wrangler login                        # abre o navegador para entrar na sua conta Cloudflare
npx wrangler kv namespace create STATE    # cria o banco; copie o "id" que aparecer
```

Abra `wrangler.jsonc` e troque `COLE_AQUI_O_ID_DO_KV` pelo id copiado. Depois:

```bash
npx wrangler secret put APP_TOKEN    # digite uma senha longa; é ela que você usa nos aparelhos
npm run deploy                       # publica e mostra a URL, ex.: https://estudos-app.SEU-USUARIO.workers.dev
```

Abra a URL em cada aparelho, toque em **⚙️**, digite a mesma senha e toque em **Salvar e sincronizar**. No celular, use "Adicionar à tela de início" para abrir como app.

### Deploy automático (opcional)

No painel do Cloudflare, em **Workers & Pages → estudos-app → Settings → Builds**, conecte este repositório. A partir daí, cada `git push` na `main` publica sozinho. O id do KV fica no `wrangler.jsonc`, e a senha continua guardada como *secret* no Cloudflare, fora do Git.

## Desenvolvimento

```bash
npm run dev    # servidor local em http://localhost:8787
npm test       # testes da lógica e da API
```

Para o `npm run dev`, crie um arquivo `.dev.vars` (já está no `.gitignore`) com `APP_TOKEN=uma-senha-local`.

## Como funciona

| Arquivo | O que faz |
|---|---|
| `public/index.html` | Interface e estilos |
| `public/app.js` | Telas, ações e sincronização |
| `public/logic.js` | Cálculos: progresso, ritmo até a prova, aulas esfriando e junção de dados entre aparelhos |
| `src/worker.mjs` | API `GET/PUT /api/state` que guarda tudo numa chave do KV |

Cada aula e cada matéria registram quando foram editadas. Se você mexer em dois aparelhos ao mesmo tempo, o app junta as mudanças item por item (vence a edição mais recente), e itens excluídos não voltam.

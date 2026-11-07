# 📚 Estudos

Organizador de estudos para provas. Funciona no celular e no computador, com contas de usuário: cada pessoa entra com o seu usuário e senha e vê só o próprio progresso.

- **Matérias com data de prova**: contagem regressiva e quantas **aulas por dia** faltam para fechar o conteúdo a tempo
- **Aulas**: marque **Estudei** e **Flashcards** com um toque; a porcentagem de cada matéria é calculada sozinha
- **Importar aulas colando texto**: uma aula por linha (aceita listas com `-`, `*` ou `•`)
- **Última revisão**: a aba *Hoje* mostra as aulas **esfriando** (7 dias ou mais sem revisar)
- **Deck de flashcards** por matéria (link ou nome do deck do Anki)
- **Dúvidas** por aula, com status pendente ou resolvida e uma aba só com as pendentes
- **Contas**: cadastro só com **código de convite** (você passa o código para os amigos); senhas guardadas com hash (PBKDF2), limite de tentativas erradas
- **Sincronização** via Cloudflare Workers + D1. Funciona offline e sobe as mudanças quando a conexão volta
- **Backup**: exporte e importe um arquivo JSON

## Como publicar no Cloudflare (uma vez só)

Pré-requisitos: [Node.js](https://nodejs.org) 20+ e [Git](https://git-scm.com). Os comandos abaixo vão no **terminal** (PowerShell ou Prompt de Comando no Windows), não dentro do `node`. Se o PowerShell bloquear o `npm`, rode antes `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

```bash
cd ~/Documents                      # evite pastas do sistema, como C:\Windows\System32
git clone https://github.com/ShifT3301/estudos.git
cd estudos
npm install
npx wrangler login                  # abre o navegador para entrar na sua conta Cloudflare
npx wrangler secret put INVITE_CODE # o código de convite que seus amigos vão usar para criar conta
npm run deploy                      # cria o banco D1 sozinho e publica; mostra a URL do app
```

Abra a URL, toque em **⚙️ → Criar conta**, digite usuário, senha e o código de convite. Para convidar amigos, mande a URL e o código. No celular, use "Adicionar à tela de início" para abrir como app.

> O banco D1 é criado no primeiro `npm run deploy` (o Wrangler grava o `database_id` no seu `wrangler.jsonc` local). As tabelas são criadas sozinhas na primeira requisição.

### Atualizar depois de mudanças no código

```bash
git checkout -- wrangler.jsonc   # só se o Wrangler tiver alterado o arquivo localmente
git pull
npm run deploy
```

Para trocar o código de convite, rode `npx wrangler secret put INVITE_CODE` de novo (quem já tem conta não é afetado). Sem `INVITE_CODE`, o cadastro fica fechado.

### Deploy automático (opcional)

No painel do Cloudflare, em **Workers & Pages → estudos-app → Settings → Builds**, conecte este repositório. A partir daí, cada `git push` na `main` publica sozinho. O convite continua guardado como *secret* no Cloudflare, fora do Git.

## Desenvolvimento

```bash
npm run dev    # servidor local em http://localhost:8787 (com D1 local)
npm test       # testes da lógica e da API
```

Para o `npm run dev`, crie um arquivo `.dev.vars` (já está no `.gitignore`) com `INVITE_CODE=convite-local`.

## Como funciona

| Arquivo | O que faz |
|---|---|
| `public/index.html` | Interface e estilos |
| `public/app.js` | Telas, ações, login e sincronização |
| `public/logic.js` | Cálculos: progresso, ritmo até a prova, aulas esfriando e junção de dados entre aparelhos |
| `src/worker.mjs` | API de contas (`/api/register`, `/api/login`, `/api/logout`) e `GET/PUT /api/state` no D1 |

**Segurança:** a senha nunca é guardada, só um hash com salt individual. A sessão usa um token aleatório (90 dias) e o banco guarda só o hash dele. Depois de 8 senhas erradas para o mesmo usuário (ou 40 do mesmo IP), o login é bloqueado por 15 minutos. Ao **sair**, os dados são apagados daquele aparelho (continuam na conta).

**Sincronização:** cada aula e cada matéria registram quando foram editadas. Se você mexer em dois aparelhos ao mesmo tempo, o app junta as mudanças item por item (vence a edição mais recente), e itens excluídos não voltam. O servidor só grava se ninguém mudou os dados desde a última leitura (gravação condicional).

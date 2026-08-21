# Painel Toque Natural Celeiro — documentação técnica

Este repositório contém o **painel gerencial** das lojas Toque Natural Celeiro (Ouro Verde,
Itaipulândia e Toledo) e a **automação** que sincroniza a planilha de finanças com o banco de dados.

> Para o **manual de uso do painel** (o que cada botão/seção faz), veja **[MANUAL.md](MANUAL.md)**.

---

## 1. Como tudo se conecta (arquitetura)

```
Planilha Google Drive              GitHub Actions (a cada 3h)            Supabase (Postgres)            Painel (site)
"Finanças Toque Natural.xlsx"  ─►  robô lê a planilha e grava       ─►  guarda os dados       ─►  mostra tudo, com login
      (fonte dos dados)             (arquivos index.mjs/parse.mjs)        (com segurança/RLS)        (index.html no Pages)
```

- **Você lança os dados na planilha** normalmente.
- A cada **3 horas**, o GitHub Actions roda sozinho, lê a planilha e atualiza o Supabase.
- O **painel** (site) lê do Supabase e mostra os números. Cada pessoa entra com **login**.

---

## 2. Endereços importantes

| O quê | Onde |
|---|---|
| **Painel (site)** | https://anderpittol-beep.github.io/toque-natural-painel/ |
| **Repositório (código)** | https://github.com/anderpittol-beep/toque-natural-painel |
| **Projeto Supabase** | https://supabase.com/dashboard/project/stnpxedsjvoxdgpysyzw |
| **Planilha (Drive)** | "Finanças Toque Natural.xlsx" (id `1RsdYiCFjzlEJkX1E8J3z_IZ0FFmyAIQs`) |
| **Projeto Google Cloud** | `toque-natural` (conta de serviço do robô) |

---

## 3. Árvore de arquivos (o que é cada coisa)

```
toque-natural-painel/
├── index.html                     ← O PAINEL inteiro (site). É isto que o Pages publica.
├── index.mjs                      ← Robô do sync: orquestra baixar+parsear+gravar
├── drive.mjs                      ← Robô do sync: baixa a planilha do Google Drive
├── parse.mjs                      ← Robô do sync: lê as abas da planilha (financeiro, despesas, estoque...)
├── package.json                   ← Lista as bibliotecas que o robô usa
└── .github/workflows/sync.yml     ← O AGENDAMENTO (roda o robô a cada 3h)
```

> Observação: `index.mjs`, `drive.mjs`, `parse.mjs` e `package.json` ficam na **raiz** só por
> simplicidade de publicação. Eles não atrapalham o painel.

---

## 4. Segredos e variáveis (no GitHub)

Ficam em **Settings → Secrets and variables → Actions** do repositório.

**Secrets** (valores sensíveis, criptografados — nunca aparecem no código):
- `SUPABASE_URL` — endereço do projeto Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — chave secreta do Supabase (Settings → API Keys → *Secret keys*)
- `GOOGLE_CREDENTIALS` — o conteúdo do arquivo `.json` da conta de serviço do Google

**Variables** (valores não sensíveis):
- `PLANILHA_FILE_ID` = `1RsdYiCFjzlEJkX1E8J3z_IZ0FFmyAIQs`
- `DESPESAS_ABA` = `Despesas de Ago`  *(muda a cada mês — veja Manutenção)*
- `COMPETENCIA` = `Ago/26`  *(muda a cada mês)*
- `ANO` = `2026`

---

## 5. Conta de serviço do Google (o "robô")

- E-mail do robô: `sync-planilha@toque-natural.iam.gserviceaccount.com`
- A **planilha está compartilhada** com esse e-mail (como Editor) — é assim que o robô consegue lê-la.
- A chave `.json` desse robô foi baixada uma vez e colada no secret `GOOGLE_CREDENTIALS`.
  Guarde o arquivo `.json` em local seguro; **se ele vazar**, apague a chave no Google Cloud
  (IAM → Contas de serviço → sync-planilha → Chaves) e gere outra.

---

## 6. Login e usuários (Supabase Auth)

- Usuários ficam em **Supabase → Authentication → Users**.
- Para **criar** um usuário: *Add user → Send invitation* (a pessoa recebe e-mail e cria a senha
  na tela do painel) **ou** *Create new user* (você define a senha).
- Para marcar alguém como **Sócio Proprietário** (vê salários), rode no **SQL Editor**:
  ```sql
  update public.profiles set papel='socia' where nome='email-da-pessoa@...';
  ```
  Quem não for marcado fica como colaboradora automaticamente.
- Se a pessoa esquecer a senha: no painel, link **"Esqueci / definir minha senha"**; ou no
  Supabase, no usuário → *Send password recovery*.

---

## 7. Manutenção mensal (importante!)

Quando **virar o mês**, atualize 2 variáveis no GitHub
(Settings → Secrets and variables → Actions → aba **Variables**):
- `DESPESAS_ABA` → o nome da nova aba, ex.: `Despesas de Set`
- `COMPETENCIA` → a nova competência, ex.: `Set/26`

Só isso. (O robô continua rodando sozinho.)

---

## 8. Rodar o sync na hora (sem esperar as 3h)

GitHub → aba **Actions** → **Sync planilha -> Supabase** → botão **Run workflow** → **Run workflow**.
Em ~30s ele roda. Verde = deu certo. Vermelho = veja o log clicando no run.

---

## 9. Editar o painel (index.html)

O painel é um único arquivo `index.html`. Para alterar:
1. Edite o `index.html` (localmente ou pelo editor do GitHub).
2. Suba a nova versão (Add file → Upload files → escolha o index.html → Commit).
3. O GitHub Pages republica sozinho em ~1 min.

Config do Supabase no painel: no topo do `index.html`, bloco `window.TN_CONFIG`
(URL + *publishable key* — a chave pública, segura para o navegador).

---

## 10. Solução de problemas

- **Sync falhou (vermelho) com erro de "WebSocket / Node.js 20"**: a biblioteca do Supabase
  precisa ficar **fixada** em `package.json` como `"@supabase/supabase-js": "2.45.0"` (sem o `^`).
  Versões novas exigem Node 22.
- **Sync roda mas o painel não muda**: confira se as *Variables* `DESPESAS_ABA`/`COMPETENCIA`
  apontam para o mês certo, e se a planilha está compartilhada com o e-mail do robô.
- **Ao colar SQL no Supabase, o comando "vira português" e dá erro**: é o **tradutor do navegador**.
  Desligue a tradução do site (ícone de tradução na barra de endereço → "Nunca traduzir supabase.com").
- **E-mail de convite/redefinição não chega**: o Supabase grátis limita e-mails por hora; tente
  mais tarde, ou reenvie pelo usuário (*Send password recovery*).
- **O painel mostra dados de exemplo**: as seções Produtos, Margem, Validade, CRM/Clientes e
  Patrimônio não vêm da planilha — são preenchidas **dentro do painel** pela equipe, ou podem
  ser mapeadas de novas abas no futuro.

# Integração Rhyno → Hunter (Supabase)

A Rhyno **não tem webhook** de fila para parceiros. O Hunter **consulta** a API pública da Rhyno
(`https://open-api.thecoolrhyno.com`) e grava o resultado no Supabase. A Rhyno é a fonte; o Hunter só lê.

```
RHYNO (API pública)  ◄── consulta ── Edge Function `rhyno-sync`  ── grava ──►  Supabase (queue, pix, rhyno_*)
                                          ▲                                            │
                        painel Admin (a cada 15 s, ou botão ATUALIZAR)                 ▼
                        pg_cron a cada 1 min (opcional)                      Painel Admin ► Roleta / Ranking
```

## O que está neste pacote

| Arquivo | O que é |
| --- | --- |
| `index.html` | O site. Já falava com o Supabase; só o link do botão "IR PARA RHYNO" foi preenchido. |
| `supabase/functions/rhyno-sync/index.ts` | A Edge Function que consulta a Rhyno. **É o arquivo que faltava.** |
| `supabase/migrations/20260923_rhyno_integration.sql` | Tabelas, RLS, tempo real e o agendador opcional. Idempotente. |

## Contrato da Rhyno (confirmado no código da Rhyno em 23/09/2026)

Base de produção: `https://open-api.thecoolrhyno.com` · Swagger: `https://open-api.thecoolrhyno.com/docs`

1. `POST /v1/auth/token` — body `{ "grant_type": "client_credentials", "client_id": "...", "client_secret": "..." }`
   → `{ "access_token": "...", "token_type": "Bearer", "expires_in": 3600, "scopes": ["queue-tickets:read"] }`
2. `GET /v1/queue-tickets` (Bearer) — filas ativas do Xand:
   ```json
   { "events": [ { "id": "uuid", "name": "Fila do Xand", "description": null, "minValue": 10,
                   "maxEntries": 50, "maxPerUser": 5, "occupiedEntries": 12, "availableEntries": 38,
                   "groupId": null, "groupName": null,
                   "fields": [ { "id": "uuid", "fieldKey": "field_1", "label": "NICKNAME DA TWITCH", "required": true } ] } ] }
   ```
3. `GET /v1/queue-tickets/{eventId}?limit=1000` (Bearer) — o evento acima mais `entries`:
   ```json
   { "...": "campos do evento",
     "entries": [ { "id": "uuid", "username": "fulano", "message": null, "amount": 10, "quantity": 1,
                    "fieldValues": [ { "label": "NICKNAME DA TWITCH", "value": "fulano_tv", "sensitive": false },
                                     { "label": "SLOT",               "value": "Gates of Olympus", "sensitive": false },
                                     { "label": "CHAVE PIX:",         "value": "fulano@email.com", "sensitive": true } ],
                    "createdAt": "2026-09-23T21:00:00.000Z" } ] }
   ```
   - Só entradas **ativas** (pagas e ainda na fila), em ordem de chegada. `limit` padrão 50, máximo 1000.
   - Valores dos campos vêm **sem máscara**; `sensitive: true` marca a chave Pix.
   - A credencial é presa a **um** criador (o Xand): a API só devolve as filas dele.
   - **Rate limit: 60 requisições/min por credencial** (o token não conta). `429` traz `Retry-After`.
     Cada consulta gasta 2 requisições; painel aberto (a cada 15 s) + cron (1 min) ≈ 10/min. Folga.
   - Sem credencial/escopo: `401`/`403`. Evento de outro criador ou desativado: `404`.

## Como a função mapeia cada entrada (`source: RHYNO`)

- **id** da linha em `queue` = id da entrada na Rhyno → rodar N vezes não duplica.
- **Nick**: campo cujo rótulo casa com "nickname da twitch" / "nick" / "twitch"; se faltar, `username` da Rhyno.
- **Jogo**: rótulo "slot" / "jogo"; se faltar, fica "(não informado)" e o painel mostra "N sem jogo".
- **Pix**: rótulo "chave pix" / "pix" → vai **só** para a tabela `pix` (nunca para a fila pública nem ranking);
  se faltar, o painel mostra "N sem Pix" e o admin pode informar na tela.
- **Valor** = `amount` · **bônus** = `amount` (mesma regra do cadastro manual; senão o bônus da rinha) · **×N** = `quantity`.
- Ordem = `createdAt` da Rhyno. Rótulos comparados sem acento/maiúscula e ignorando ":" no fim.
  Se o Xand renomear os campos: `FIELD_ALIASES` no início de `index.ts`.
- Quem o admin sorteou ou removeu vai para `rhyno_seen` e **não volta** na próxima consulta.
- Quem sai da fila da Rhyno (estorno) **não é removido** do Hunter (decisão atual). Para mudar:
  `supabase secrets set RHYNO_REMOVE_MISSING=true`.

## Publicar (passo a passo)

Requer a [CLI do Supabase](https://supabase.com/docs/guides/cli) logada no projeto `cwtnaoqhbxjvctwfavhn`.

```bash
# 1) Tabelas + RLS + tempo real (ou cole o SQL no SQL Editor do painel do Supabase)
supabase db push            # ou: SQL Editor → colar supabase/migrations/20260923_rhyno_integration.sql

# 2) Segredos da Rhyno (NUNCA no HTML, no GitHub ou em chat)
supabase secrets set RHYNO_CLIENT_ID=<cole o Client ID>
supabase secrets set RHYNO_CLIENT_SECRET=<cole o Client Secret completo>
# opcionais: RHYNO_API_BASE (padrão https://open-api.thecoolrhyno.com) · RHYNO_REMOVE_MISSING=true

# 3) Publicar a função
supabase functions deploy rhyno-sync
```

Depois: Admin → **FILA DA RHYNO** → escolha o evento → **ATUALIZAR**. O painel mostra
"✔ Conectado · <evento> · N na fila da Rhyno" ou o erro por extenso (credencial recusada, sem escopo,
evento desativado, limite de requisições…).

Para a fila continuar atualizando com o painel fechado, siga o bloco **OPCIONAL** no fim do SQL
(pg_cron + pg_net + Vault, a cada 1 min).

## Quem pode disparar a consulta

A função só roda para **admin logado** (`is_admin()` verdadeiro na sessão que chamou) ou para o agendador
(service_role). Qualquer outra chamada recebe `403`. Isso evita que um visitante gaste o rate limit da Rhyno.

## O que a Rhyno precisa fornecer / o Xand precisa fazer

1. **Rhyno**: criar a credencial (ApiPartner + ApiCredential) com escopo `queue-tickets:read` vinculada à conta
   do Xand (`@xandfps`) e passar `client_id` + `client_secret` **só** para quem vai rodar `supabase secrets set`.
2. **Xand**: na fila dele na Rhyno, ter os campos personalizados **NICKNAME DA TWITCH**, **SLOT** e **CHAVE PIX**
   (marcado como sensível). Outros nomes funcionam se contiverem "nick"/"twitch", "slot"/"jogo" e "pix".
3. **Site**: o botão "IR PARA RHYNO" aponta para `https://thecoolrhyno.com/xandfps/queue`
   (`RHYNO_FILA_LINK` no `index.html`).

## Segurança do Pix

- A chave Pix fica **só** em `pix` (RLS: apenas admin lê). O site público não lê `queue` nem `pix`.
- O login do admin é Supabase Auth: entre no painel do Supabase → Authentication → crie o usuário e insira o
  `user_id` dele em `public.admins`. Sem isso, o painel diz "Esta conta não tem permissão de admin".
- A chave `anon` pode ficar no HTML; a `service_role` **nunca** (ela só vive nos secrets/Vault do Supabase).

## Testar sem publicar

```bash
supabase functions serve rhyno-sync --env-file ./supabase/.env.local   # com RHYNO_CLIENT_ID/SECRET no arquivo
curl -X POST http://localhost:54321/functions/v1/rhyno-sync -H "Authorization: Bearer <SERVICE_ROLE_KEY local>"
```
A resposta é `{ "ok": true, "eventName": "...", "entries": N, "pixMissing": 0, "slotMissing": 0 }` ou `{ "ok": false, "message": "..." }`.

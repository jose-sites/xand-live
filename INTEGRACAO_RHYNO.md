# Integração Rhyno → Hunter

A Rhyno **não tem webhook** para a fila: o Hunter consulta a API dela (`open-api.thecoolrhyno.com`).

```
RHYNO (API)  ◄── consulta a cada 1 min (agendada) ou na hora (painel aberto / botão) ── Cloud Functions
                                                                                            │ functions/src/sync.js
                                                                                            ▼
                                                        Firebase: queue/{id}  +  adminPrivate/pix/{id}
                                                                                            ▼
                                                                            Painel Admin (ordem de chegada) ► Roleta
```

## Como funciona
1. `POST /v1/auth/token` (client_credentials) → token de 1h, guardado em memória e renovado sozinho.
2. `GET /v1/queue-tickets` → lista de eventos; gravada em `adminPrivate/rhynoEvents` para o Admin escolher.
3. `GET /v1/queue-tickets/{eventId}` → entradas ativas do evento escolhido.
4. Cada entrada vira participante (`source: RHYNO`), id = id da entrada (não duplica). Ordem = `createdAt` da Rhyno.
   - Nick: campo "NICKNAME DA TWITCH" (se faltar, usa o `username` da Rhyno)
   - Jogo: campo "SLOT" · Pix: campo "CHAVE PIX:" · Valor: `amount` · quantidade `quantity` (mostrada como ×N)
   - Se o Xand renomear os campos: edite `FIELD_ALIASES` em `functions/src/rhyno.mapping.js`.
5. Pix vai só para `adminPrivate/pix/{id}`, nunca para a fila pública nem para o ranking.

## Publicar (passo a passo)
Requer: acesso ao projeto Firebase **rinha-do-flex** e plano **Blaze**.
```
cd functions && npm install
firebase functions:secrets:set RHYNO_CLIENT_ID        (cole o Client ID quando pedir)
firebase functions:secrets:set RHYNO_CLIENT_SECRET    (cole o Client Secret completo)
firebase deploy --only functions
```
Depois: entre no Admin → "FILA DA RHYNO" → escolha o evento. O painel mostra "✔ Conectado" ou o erro.
Nunca coloque Client ID/Secret no HTML, no GitHub ou em chats.

## Ainda não confirmado (não havia exemplo real de resposta)
- O formato exato de `GET /v1/queue-tickets` (o código aceita lista direta ou dentro de `events`/`data`/`items`/`results`).
- O endereço base (assumido: `https://open-api.thecoolrhyno.com`; para mudar, variável `RHYNO_API_BASE`).
- Se as credenciais têm permissão para ler filas. Se não, o painel mostrará "Sem permissão…".
Qualquer divergência aparece como mensagem de erro no painel; com um exemplo real de resposta eu ajusto.

## Decisões
- Quem sai da fila da Rhyno **não é removido** automaticamente do Hunter.
- Consultas: a cada 1 min (Scheduler) + a cada 15 s com o painel aberto e evento escolhido.
- Sem endpoint HTTP público: o painel só grava um pedido de atualização no banco.

## ⚠️ Segurança do Pix
O login do Admin ainda é conferido no navegador. Para proteger `queue/` e `adminPrivate/` de verdade:
migrar o login para Firebase Authentication e só então publicar `firebase/database.rules.json`
(publicar antes derruba o painel). O site público não lê `queue/` nem `adminPrivate/`.

## Testes
`cd functions && node test/participants.test.js` (banco e API da Rhyno simulados).

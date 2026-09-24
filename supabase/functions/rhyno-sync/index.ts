// supabase/functions/rhyno-sync/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// RHYNO → HUNTER
// Consulta a fila do Xand na API pública da Rhyno e grava no Supabase.
// É o ÚNICO lugar que conhece as credenciais da Rhyno (ficam em secrets, nunca no HTML).
//
// Quem chama:
//   • o painel Admin, via supabase.functions.invoke('rhyno-sync')  → exige sessão de admin (is_admin());
//   • o agendador (pg_cron → net.http_post) com a service_role key → a cada 1 min (opcional, ver SQL).
//
// Contrato da Rhyno — CONFIRMADO no código-fonte da Rhyno em 23/09/2026 (não é suposição):
//   POST {BASE}/v1/auth/token
//        body { grant_type: "client_credentials", client_id, client_secret }
//        → { access_token, token_type: "Bearer", expires_in: 3600, scopes: ["queue-tickets:read"] }
//   GET  {BASE}/v1/queue-tickets                          (Bearer)
//        → { events: [ { id, name, description, minValue, maxEntries, maxPerUser,
//                        occupiedEntries, availableEntries, groupId, groupName,
//                        fields: [ { id, fieldKey, label, required } ] } ] }
//   GET  {BASE}/v1/queue-tickets/{eventId}?limit=1000     (Bearer)
//        → o evento acima + entries: [ { id, username, message, amount, quantity,
//                                        fieldValues: [ { label, value, sensitive } ], createdAt } ]
//        Só entradas ATIVAS (pagas e ainda na fila), em ordem de chegada (createdAt asc).
//        Valores dos campos vêm SEM máscara; `sensitive: true` marca a chave Pix.
//   BASE de produção: https://open-api.thecoolrhyno.com  (Swagger em /docs)
//   Rate limit: 60 requisições/min por credencial (o token não conta). 429 → esperar `Retry-After`.
//   A credencial é presa a UM criador (o Xand): a API só devolve as filas dele.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type RhynoEvent = {
  id: string;
  name: string;
  occupiedEntries: number | null;
  groupName?: string | null;
};
type RhynoFieldValue = { label: string; value: string; sensitive: boolean };
type RhynoEntry = {
  id: string;
  username: string;
  message: string | null;
  amount: number;
  quantity: number;
  fieldValues: RhynoFieldValue[];
  createdAt: string;
};

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const CFG = {
  base: env("RHYNO_API_BASE", "https://open-api.thecoolrhyno.com").replace(/\/+$/, ""),
  clientId: env("RHYNO_CLIENT_ID"),
  clientSecret: env("RHYNO_CLIENT_SECRET"),
  // true → quem sumiu da lista ATIVA da Rhyno (estorno/cancelamento) sai da fila do Hunter também.
  // Decisão atual do Hunter: false (não remove sozinho).
  removeMissing: env("RHYNO_REMOVE_MISSING", "false") === "true",
  entryLimit: 1000, // máximo aceito pela Rhyno
  supabaseUrl: env("SUPABASE_URL"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  anonKey: env("SUPABASE_ANON_KEY"),
};

// Rótulos dos campos personalizados da fila do Xand na Rhyno.
// Comparação sem acento, minúscula, sem ":" no fim. Primeiro tenta igualdade, depois "contém".
// Se o Xand renomear os campos na Rhyno, ajuste aqui.
const FIELD_ALIASES = {
  nick: ["nickname da twitch", "nick da twitch", "nick twitch", "nickname twitch", "nick", "nickname", "twitch"],
  slot: ["slot", "jogo", "game"],
  pix: ["chave pix", "pix"],
};

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s:]+$/g, "")
    .trim();

function pickField(entry: RhynoEntry, aliases: string[]): string | null {
  const fvs = (entry.fieldValues ?? []).map((f) => ({
    label: norm(f.label),
    value: String(f.value ?? "").trim(),
  }));
  for (const a of aliases) {
    const hit = fvs.find((f) => f.label === a && f.value);
    if (hit) return hit.value;
  }
  for (const a of aliases) {
    const hit = fvs.find((f) => f.label.includes(a) && f.value);
    if (hit) return hit.value;
  }
  return null;
}

const hora = (ts: number) =>
  new Date(ts).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour12: false });

// ── Token da Rhyno (cache em memória até perto de expirar) ──
let tokenCache: { value: string | null; expiresAt: number } = { value: null, expiresAt: 0 };

async function getToken(): Promise<string> {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const res = await fetch(CFG.base + "/v1/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
    }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("A Rhyno recusou o Client ID/Secret. Confira os secrets RHYNO_CLIENT_ID e RHYNO_CLIENT_SECRET.");
  }
  if (!res.ok) throw new Error(`Rhyno: falha ao obter token (HTTP ${res.status}).`);
  const body = await res.json();
  if (!body.access_token) throw new Error("Rhyno: resposta do token sem access_token.");
  const token = String(body.access_token);
  tokenCache = { value: token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return token;
}

async function rhynoGet<T>(path: string, retry = true): Promise<T> {
  const token = await getToken();
  const res = await fetch(CFG.base + path, {
    headers: { authorization: "Bearer " + token, accept: "application/json" },
  });
  if (res.status === 401 && retry) {
    tokenCache = { value: null, expiresAt: 0 }; // token venceu/revogado: pega outro e tenta uma vez
    return rhynoGet<T>(path, false);
  }
  if (res.status === 403) {
    throw new Error("A credencial não tem permissão para ler filas (escopo queue-tickets:read). Peça à Rhyno.");
  }
  if (res.status === 404) {
    throw new Error("A Rhyno não encontrou esse evento (foi desativado ou não é do Xand). Escolha outro no painel.");
  }
  if (res.status === 429) {
    const wait = res.headers.get("retry-after") ?? "60";
    throw new Error(`Limite de requisições da Rhyno atingido (60/min). Tente de novo em ${wait}s.`);
  }
  if (!res.ok) throw new Error(`Rhyno: HTTP ${res.status} em ${path}.`);
  return (await res.json()) as T;
}

// ── Supabase ──
async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error("Supabase: " + error.message);
  return data;
}

type Status = {
  ok: boolean;
  message?: string | null;
  event_name?: string | null;
  entries?: number;
  pix_missing?: number;
  slot_missing?: number;
};
async function setStatus(db: SupabaseClient, s: Status) {
  await must(
    db.from("rhyno_status").upsert({
      id: 1,
      ok: s.ok,
      message: s.message ?? null,
      event_name: s.event_name ?? null,
      entries: s.entries ?? 0,
      pix_missing: s.pix_missing ?? 0,
      slot_missing: s.slot_missing ?? 0,
      at: new Date().toISOString(),
    }),
  );
}

// Só admin logado (is_admin()) ou o agendador (service_role) podem disparar a consulta.
async function callerAllowed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === CFG.serviceKey) return true;
  const asCaller = createClient(CFG.supabaseUrl, CFG.anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await asCaller.rpc("is_admin");
  return !error && data === true;
}

// ── Uma rodada de sincronização ──
async function syncOnce(db: SupabaseClient) {
  // 1) Eventos (filas) ativos do Xand → rhyno_events (o painel escolhe por aqui)
  const { events } = await rhynoGet<{ events: RhynoEvent[] }>("/v1/queue-tickets");
  const now = new Date().toISOString();
  const listed = new Set(events.map((e) => e.id));
  if (events.length) {
    await must(
      db.from("rhyno_events").upsert(
        events.map((e) => ({
          id: e.id,
          name: e.groupName ? `${e.groupName} · ${e.name}` : e.name,
          occupied: e.occupiedEntries ?? 0,
          updated_at: now,
        })),
      ),
    );
  }
  const known = await must(db.from("rhyno_events").select("id"));
  const gone = (known ?? []).map((r: { id: string }) => r.id).filter((id) => !listed.has(id));
  if (gone.length) await must(db.from("rhyno_events").delete().in("id", gone));

  // 2) Qual evento o admin escolheu?
  const cfg = await must(db.from("rhyno_config").select("event_id").eq("id", 1).maybeSingle());
  const eventId: string | null = cfg?.event_id ?? null;
  if (!eventId) {
    const msg = events.length
      ? "Escolha o evento da fila no painel (FILA DA RHYNO → Escolha o evento…)."
      : "O Xand não tem nenhuma fila ativa na Rhyno agora.";
    await setStatus(db, { ok: true, message: msg, entries: 0 });
    return { ok: true, message: msg, events: events.length };
  }
  const ev = events.find((e) => e.id === eventId);
  if (!ev) throw new Error("O evento escolhido não está mais ativo na Rhyno. Escolha outro no painel.");

  // 3) Entradas ativas do evento
  const detail = await rhynoGet<RhynoEvent & { entries: RhynoEntry[] }>(
    `/v1/queue-tickets/${encodeURIComponent(eventId)}?limit=${CFG.entryLimit}`,
  );
  const entries = detail.entries ?? [];

  // 4) Estado atual do Hunter
  const [seenRows, queueRows, pixRows, rinha] = await Promise.all([
    must(db.from("rhyno_seen").select("external_id")),
    must(db.from("queue").select("id,external_id").eq("source", "RHYNO")),
    must(db.from("pix").select("id")),
    must(db.from("rinha_state").select("bonus").eq("id", 1).maybeSingle()),
  ]);
  const seen = new Set((seenRows ?? []).map((r: { external_id: string }) => String(r.external_id)));
  const havePix = new Set((pixRows ?? []).map((r: { id: string }) => String(r.id)));
  const defaultBonus = rinha?.bonus ?? null;

  // 5) Rhyno → participante (mesmo formato que admAddCall() grava no index.html)
  const queueUpserts: Record<string, unknown>[] = [];
  const pixUpserts: { id: string; pix: string }[] = [];
  const active = new Set<string>();
  let pixMissing = 0;
  let slotMissing = 0;

  for (const en of entries) {
    active.add(en.id);
    if (seen.has(en.id)) continue; // admin já sorteou/removeu: não volta para a fila
    const nick = pickField(en, FIELD_ALIASES.nick) ?? ((en.username || "").trim() || "(sem nick)");
    const slot = pickField(en, FIELD_ALIASES.slot);
    const pix = pickField(en, FIELD_ALIASES.pix);
    if (!slot) slotMissing++;
    if (pix) pixUpserts.push({ id: en.id, pix });
    else if (!havePix.has(en.id)) pixMissing++; // o admin pode informar na tela ("SEM PIX")
    const ts = Date.parse(en.createdAt) || Date.now();
    const amount = typeof en.amount === "number" && Number.isFinite(en.amount) ? en.amount : null;
    queueUpserts.push({
      id: en.id, // id da entrada na Rhyno: rodar N vezes não duplica
      nick,
      slot: slot ?? "(não informado)",
      prov: "Rhyno",
      source: "RHYNO",
      external_id: en.id,
      valor: amount,
      bonus: amount ?? defaultBonus, // mesma regra do cadastro manual: valor informado, senão o bônus da rinha
      platform: "rhyno",
      quantity: Math.max(1, Math.trunc(Number(en.quantity ?? 1))),
      participated_at: ts,
      time: hora(ts),
      ts,
      added_by_admin: false,
    });
  }

  // Pix antes da fila, para já estar lá quando a lista atualizar. Só sobrescreve quando a Rhyno tem o valor.
  if (pixUpserts.length) await must(db.from("pix").upsert(pixUpserts));
  if (queueUpserts.length) await must(db.from("queue").upsert(queueUpserts));

  // 6) Opcional: quem saiu da lista ATIVA da Rhyno sai daqui também
  if (CFG.removeMissing) {
    const stale = (queueRows ?? [])
      .filter((r: { external_id: string | null }) => r.external_id && !active.has(String(r.external_id)))
      .map((r: { id: string }) => r.id);
    if (stale.length) {
      await must(db.from("queue").delete().in("id", stale));
      await must(db.from("pix").delete().in("id", stale));
    }
  }

  await setStatus(db, {
    ok: true,
    event_name: ev.name,
    entries: entries.length,
    pix_missing: pixMissing,
    slot_missing: slotMissing,
  });
  return { ok: true, eventId, eventName: ev.name, entries: entries.length, pixMissing, slotMissing };
}

// ── HTTP ──
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return json({ ok: false, message: "Só admin pode atualizar a fila da Rhyno." }, 403);
  }

  const db = createClient(CFG.supabaseUrl, CFG.serviceKey, { auth: { persistSession: false } });
  try {
    if (!CFG.clientId || !CFG.clientSecret) {
      throw new Error(
        "Credenciais da Rhyno não configuradas. Rode: supabase secrets set RHYNO_CLIENT_ID=... RHYNO_CLIENT_SECRET=...",
      );
    }
    return json(await syncOnce(db));
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    console.error("[rhyno-sync]", message);
    await setStatus(db, { ok: false, message }).catch(() => {});
    // 200 de propósito: o painel lê a mensagem em rhyno_status e mostra "✖ Erro: …"
    return json({ ok: false, message });
  }
});

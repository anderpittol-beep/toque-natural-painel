// Envia mensagem pelo WhatsApp da loja, via Evolution API.
// Só responde a usuário autenticado do painel; a chave da Evolution fica aqui,
// nunca no navegador. Grava a mensagem enviada para ela aparecer na conversa.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EVO_URL = (Deno.env.get("EVOLUTION_URL") ?? "").replace(/\/$/, "");
const EVO_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const responde = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!EVO_URL || !EVO_KEY) {
    return responde({ erro: "envio ainda não configurado: falta EVOLUTION_URL ou EVOLUTION_API_KEY" }, 503);
  }

  /* quem chama precisa estar logado no painel */
  const auth = req.headers.get("Authorization") ?? "";
  const comUsuario = createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: { user } } = await comUsuario.auth.getUser();
  if (!user) return responde({ erro: "não autenticado" }, 401);

  let corpo: any;
  try { corpo = await req.json(); } catch { return responde({ erro: "json inválido" }, 400); }
  const loja = String(corpo.loja ?? "");
  const telefone = String(corpo.telefone ?? "").replace(/\D/g, "");
  const texto = String(corpo.texto ?? "").trim();
  if (!loja || !telefone || !texto) return responde({ erro: "informe loja, telefone e texto" }, 400);
  if (texto.length > 900) return responde({ erro: "mensagem muito longa" }, 400);

  const db = createClient(URL_SB, SERVICE, { auth: { persistSession: false } });

  const { data: inst } = await db.from("wa_instancias")
    .select("instancia, status").eq("loja", loja).maybeSingle();
  if (!inst?.instancia) return responde({ erro: "loja sem WhatsApp configurado" }, 404);
  if (inst.status !== "open") return responde({ erro: "o WhatsApp desta loja não está conectado" }, 409);

  const r = await fetch(`${EVO_URL}/message/sendText/${inst.instancia}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVO_KEY },
    body: JSON.stringify({ number: telefone, text: texto }),
  });
  const resposta = await r.json().catch(() => ({}));
  if (!r.ok) return responde({ erro: "a Evolution recusou o envio", detalhe: resposta }, 502);

  /* espelha na conversa para quem olha o painel ver o que foi dito */
  const { data: conv } = await db.from("wa_conversas")
    .select("id").eq("loja", loja).eq("telefone", telefone).maybeSingle();
  if (conv?.id) {
    await db.from("wa_mensagens").insert({
      conversa_id: conv.id, loja, direcao: "enviada", autor: "painel",
      texto, tipo: "texto", id_externo: resposta?.key?.id ?? null,
      msg_em: new Date().toISOString(),
    });
    await db.from("wa_conversas").update({
      ultima_msg: texto, ultima_em: new Date().toISOString(),
    }).eq("id", conv.id);
  }
  return responde({ ok: true });
});

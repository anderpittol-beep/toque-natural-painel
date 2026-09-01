// Recebe os eventos da Evolution API (WhatsApp das lojas) e grava no Supabase.
// A Evolution chama esta função a cada mensagem; o painel lê por Realtime.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const TOKEN = Deno.env.get("WA_WEBHOOK_TOKEN") ?? "";
const soDigitos = (s: string) => (s || "").replace(/\D/g, "");

/* O texto vem em um campo diferente para cada tipo de mensagem */
function textoDa(msg: Record<string, any> | undefined) {
  if (!msg) return { texto: "[mensagem]", tipo: "outro" };
  if (msg.conversation) return { texto: msg.conversation, tipo: "texto" };
  if (msg.extendedTextMessage?.text) return { texto: msg.extendedTextMessage.text, tipo: "texto" };
  if (msg.imageMessage) return { texto: msg.imageMessage.caption || "[imagem]", tipo: "imagem" };
  if (msg.videoMessage) return { texto: msg.videoMessage.caption || "[vídeo]", tipo: "video" };
  if (msg.audioMessage) return { texto: "[áudio]", tipo: "audio" };
  if (msg.documentMessage) return { texto: msg.documentMessage.fileName || "[documento]", tipo: "documento" };
  if (msg.stickerMessage) return { texto: "[figurinha]", tipo: "figurinha" };
  if (msg.locationMessage) return { texto: "[localização]", tipo: "local" };
  return { texto: "[mensagem]", tipo: "outro" };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (TOKEN && url.searchParams.get("token") !== TOKEN) {
    return new Response("nao autorizado", { status: 401 });
  }
  let corpo: any;
  try { corpo = await req.json(); } catch { return new Response("json invalido", { status: 400 }); }

  const evento = String(corpo.event ?? "").toLowerCase();
  const instancia = corpo.instance ?? corpo.instanceName ?? "";

  const { data: inst } = await db.from("wa_instancias")
    .select("loja").eq("instancia", instancia).maybeSingle();
  if (!inst?.loja) return new Response("instancia desconhecida: " + instancia, { status: 202 });
  const loja = inst.loja;

  /* conexão do aparelho: mantém o status visível no painel */
  if (evento === "connection.update") {
    const estado = corpo.data?.state ?? corpo.data?.connection ?? null;
    await db.from("wa_instancias").update({
      status: estado,
      conectado_em: estado === "open" ? new Date().toISOString() : null,
    }).eq("instancia", instancia);
    return new Response("ok");
  }

  if (evento !== "messages.upsert") return new Response("ignorado", { status: 202 });

  const bruto = corpo.data ?? {};
  for (const m of (Array.isArray(bruto) ? bruto : [bruto])) {
    const jid = m?.key?.remoteJid ?? "";
    /* grupos e status não viram conversa de atendimento */
    if (!jid || jid.endsWith("@g.us") || jid.startsWith("status@")) continue;

    const telefone = soDigitos(jid.split("@")[0]);
    if (!telefone) continue;
    const daLoja = !!m.key?.fromMe;
    const { texto, tipo } = textoDa(m.message);
    const quando = m.messageTimestamp
      ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString();
    const nome = daLoja ? null : (m.pushName || null);

    const { data: existente } = await db.from("wa_conversas")
      .select("id, nao_lidas, nome").eq("loja", loja).eq("telefone", telefone).maybeSingle();

    let conversaId = existente?.id;
    if (!conversaId) {
      const { data: nova } = await db.from("wa_conversas").insert({
        loja, telefone, nome, ultima_msg: texto, ultima_em: quando,
        nao_lidas: daLoja ? 0 : 1, status: "aberta",
      }).select("id").single();
      conversaId = nova?.id;
    } else {
      await db.from("wa_conversas").update({
        ultima_msg: texto, ultima_em: quando,
        nome: existente?.nome ?? nome,
        nao_lidas: daLoja ? 0 : (existente?.nao_lidas ?? 0) + 1,
      }).eq("id", conversaId);
    }
    if (!conversaId) continue;

    /* id_externo evita duplicar quando a Evolution reenvia o mesmo evento */
    const { error: erroMsg } = await db.from("wa_mensagens").upsert({
      conversa_id: conversaId, loja,
      direcao: daLoja ? "enviada" : "recebida",
      autor: daLoja ? "loja" : (nome || telefone),
      texto, tipo, id_externo: m.key?.id ?? null, msg_em: quando,
    }, { onConflict: "id_externo", ignoreDuplicates: true });
    if (erroMsg) console.error("falha ao gravar mensagem:", erroMsg.message, { loja, telefone });
  }
  return new Response("ok");
});

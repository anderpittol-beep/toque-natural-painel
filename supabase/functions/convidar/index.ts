// Acesso ao painel: envia o convite inicial ou zera a senha de quem já tem login.
//
// A chave de administrador nunca sai daqui: o navegador só manda o e-mail e o
// próprio token de quem está logado. A função confere se esse alguém é sócio
// antes de mexer em qualquer login.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const destino = Deno.env.get('TN_REDIRECT_URL') ??
    'https://anderpittol-beep.github.io/toque-natural-painel/';

  // 1) quem está chamando?
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Faça login novamente.' }, 401);

  const comoUsuario = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error: erroUser } = await comoUsuario.auth.getUser();
  if (erroUser || !user) return json({ error: 'Sessão inválida.' }, 401);

  // 2) só sócio mexe em acesso
  const { data: perfil } = await comoUsuario
    .from('profiles').select('papel').eq('id', user.id).maybeSingle();
  if (!perfil || perfil.papel !== 'socia') {
    return json({ error: 'Apenas o perfil Sócio pode alterar acessos.' }, 403);
  }

  // 3) o e-mail precisa estar no cadastro da equipe — é ele que define o perfil
  let email = '';
  let acao = 'convite';
  try {
    const body = await req.json();
    email = String(body?.email ?? '').trim().toLowerCase();
    acao = String(body?.acao ?? 'convite');
  } catch {
    return json({ error: 'Informe o e-mail.' }, 400);
  }
  if (!email || !email.includes('@')) return json({ error: 'E-mail inválido.' }, 400);
  if (acao !== 'convite' && acao !== 'reset') return json({ error: 'Ação desconhecida.' }, 400);

  const admin = createClient(url, service, { auth: { persistSession: false } });

  const { data: pessoa } = await admin
    .from('equipe').select('nome, cargo').ilike('email', email).maybeSingle();
  if (!pessoa) {
    return json({ error: 'Cadastre a pessoa na equipe com esse e-mail antes.' }, 400);
  }

  const { data: lista } = await admin.auth.admin.listUsers();
  const existe = lista?.users?.find((u) => (u.email ?? '').toLowerCase() === email);

  // 4a) zerar a senha de quem já tem login
  if (acao === 'reset') {
    if (!existe) {
      return json({ error: 'Essa pessoa ainda não tem acesso. Envie o convite primeiro.' }, 400);
    }
    const { error } = await comoUsuario.auth.resetPasswordForEmail(email, {
      redirectTo: destino,
    });
    if (error) return json({ error: error.message }, 400);
    return json({
      ok: true,
      mensagem: `E-mail de redefinição enviado para ${email}. A senha atual continua valendo até ela criar a nova.`,
    });
  }

  // 4b) convite de primeiro acesso
  if (existe) {
    return json({ ok: true, jaExistia: true, mensagem: 'Essa pessoa já tem acesso.' });
  }

  const { error: erroConvite } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: destino,
    data: { nome: pessoa.nome, cargo: pessoa.cargo },
  });
  if (erroConvite) return json({ error: erroConvite.message }, 400);

  return json({
    ok: true,
    mensagem: `Convite enviado para ${email}. O perfil será ${
      ['Sócio', 'Sócia'].includes(pessoa.cargo) ? 'Sócio' : 'Colaboradora'
    }.`,
  });
});

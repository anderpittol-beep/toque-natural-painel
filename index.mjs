// Orquestra: baixa a planilha do Drive, parseia as abas e faz upsert no Supabase.
// Rode com:  node index.mjs   (via GitHub Actions ou local com .env carregado)
import { createClient } from '@supabase/supabase-js';
import { baixarPlanilha } from './drive.mjs';
import { lerWorkbook, parseFinanceiro, parseDespesas, parseEstoque } from './parse.mjs';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GOOGLE_CREDENTIALS,
  PLANILHA_FILE_ID = '1RsdYiCFjzlEJkX1E8J3z_IZ0FFmyAIQs',
  ANO = '2026',
} = process.env;

function need(name, v) { if (!v) { console.error(`Faltando variável de ambiente: ${name}`); process.exit(1); } }
need('SUPABASE_URL', SUPABASE_URL);
need('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
need('GOOGLE_CREDENTIALS', GOOGLE_CREDENTIALS);

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function delWhere(tabela, coluna, valor) {
  const { error } = await db.from(tabela).delete().eq(coluna, valor);
  if (error) throw new Error(`delete ${tabela}: ${error.message}`);
}
async function delAll(tabela) {
  const { error } = await db.from(tabela).delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) throw new Error(`delete all ${tabela}: ${error.message}`);
}
async function insert(tabela, linhas) {
  if (!linhas.length) return 0;
  const { error } = await db.from(tabela).insert(linhas);
  if (error) throw new Error(`insert ${tabela}: ${error.message}`);
  return linhas.length;
}
async function upsert(tabela, linhas, onConflict) {
  if (!linhas.length) return 0;
  const { error } = await db.from(tabela).upsert(linhas, { onConflict });
  if (error) throw new Error(`upsert ${tabela}: ${error.message}`);
  return linhas.length;
}

// Competência a partir da qual as despesas fixas são mantidas pelo painel
const CORTE_FIXAS = { ano: 2026, mes: 9 };   // Set/2026
const MES_NUM = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };
function fixasNoPainel(competencia) {
  const m = String(competencia || '').match(/^\s*([A-Za-zçÇ]{3})[^\/]*\/\s*(\d{2,4})/);
  if (!m) return false;
  const mes = MES_NUM[m[1].toLowerCase()];
  let ano = Number(m[2]); if (ano < 100) ano += 2000;
  if (!mes || !ano) return false;
  return ano > CORTE_FIXAS.ano || (ano === CORTE_FIXAS.ano && mes >= CORTE_FIXAS.mes);
}

async function main() {
  console.log('→ Baixando planilha do Drive...');
  const buffer = await baixarPlanilha(PLANILHA_FILE_ID, GOOGLE_CREDENTIALS);
  const wb = lerWorkbook(buffer);

  console.log('→ Parseando abas...');
  const financeiro = parseFinanceiro(wb, Number(ANO));
  const estoque = parseEstoque(wb);
  console.log(`   financeiro_mensal: ${financeiro.length}`);
  console.log(`   estoque:           ${estoque.length}`);

  // financeiro: upsert por (ano,mes,loja)
  await upsert('financeiro_mensal', financeiro, 'ano,mes,loja');

  /* Cada mês tem sua própria aba de despesas na planilha ("Despesas de jul",
     "Despesas de Ago"...). Sincronizamos todas: antes só a do mês corrente ia
     para o banco, e os meses anteriores ficavam sem detalhamento. */
  const MES_ABA = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };
  const ABREV = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const abasDespesa = wb.SheetNames
    .map(nome => {
      const m = String(nome).match(/^\s*despesas\s+de\s+([a-zç]{3})/i);
      if (!m) return null;
      const mes = MES_ABA[m[1].toLowerCase()];
      return mes ? { nome, mes, competencia: ABREV[mes] + '/' + String(ANO).slice(2) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.mes - b.mes);

  console.log(`→ Abas de despesa encontradas: ${abasDespesa.map(a => a.nome).join(', ') || 'nenhuma'}`);

  for (const aba of abasDespesa) {
    const { despesasFixas, folha, boletos, comprasNf } = parseDespesas(wb, aba.nome, aba.competencia);
    if (fixasNoPainel(aba.competencia)) {
      console.log(`   ${aba.competencia}: gerido no painel a partir de Set/2026 — sync ignorado`);
      continue;
    }
    console.log(`   ${aba.competencia}: fixas ${despesasFixas.length}, folha ${folha.length}, boletos ${boletos.length}, compras ${comprasNf.length}`);

    // substitui a competência inteira, uma de cada vez (não mexe nas outras)
    await delWhere('despesas_fixas', 'competencia', aba.competencia);
    await insert('despesas_fixas', despesasFixas);

    await delWhere('folha', 'competencia', aba.competencia);
    await insert('folha', folha);

    await delWhere('boletos', 'competencia', aba.competencia);
    await insert('boletos', boletos);

    // compras da planilha: apaga só o mês desta aba, senão os outros meses somem
    const { error: eDel } = await db.from('compras_nf')
      .delete().eq('origem', 'planilha').eq('ano', Number(ANO)).eq('mes', aba.mes);
    if (eDel) throw new Error(`delete compras_nf ${aba.competencia}: ${eDel.message}`);
    await insert('compras_nf', comprasNf);
  }

  // estoque: snapshot completo
  await delAll('estoque_inventario');
  await insert('estoque_inventario', estoque);

  // carimbo de última atualização
  const agora = new Date();
  const fmt = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  await db.from('sync_meta').upsert(
    { chave: 'last_update', valor: fmt, atualizado_em: agora.toISOString() },
    { onConflict: 'chave' }
  );

  console.log(`✓ Sync concluído em ${fmt}`);
}

main().catch((e) => { console.error('✗ Erro no sync:', e.message); process.exit(1); });

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
  DESPESAS_ABA = 'Despesas de Ago',
  COMPETENCIA = 'Ago/26',
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
  const { despesasFixas, folha, boletos, comprasNf } = parseDespesas(wb, DESPESAS_ABA, COMPETENCIA);
  const estoque = parseEstoque(wb);

  console.log(`   financeiro_mensal: ${financeiro.length}`);
  console.log(`   despesas_fixas:    ${despesasFixas.length}`);
  console.log(`   folha:             ${folha.length}`);
  console.log(`   boletos:           ${boletos.length}`);
  console.log(`   compras_nf:        ${comprasNf.length}`);
  console.log(`   estoque:           ${estoque.length}`);

  // financeiro: upsert por (ano,mes,loja)
  await upsert('financeiro_mensal', financeiro, 'ano,mes,loja');

  // despesas/folha/boletos: substitui a competência inteira (evita órfãos)
  // A partir de Set/2026 as despesas fixas passam a ser gerenciadas no painel
  // (com recorrência e edição própria), então o sync deixa de sobrescrevê-las.
  if (fixasNoPainel(COMPETENCIA)) {
    console.log('   despesas_fixas:    geridas no painel a partir de Set/2026 — sync ignorado');
  } else {
    await delWhere('despesas_fixas', 'competencia', COMPETENCIA);
    await insert('despesas_fixas', despesasFixas);
  }
  if (fixasNoPainel(COMPETENCIA)) {
    console.log('   folha:             gerida no painel a partir de Set/2026 — sync ignorado');
  } else {
    await delWhere('folha', 'competencia', COMPETENCIA);
    await insert('folha', folha);
  }
  if (fixasNoPainel(COMPETENCIA)) {
    console.log('   boletos/compras:   geridos no painel a partir de Set/2026 — sync ignorado');
  } else {
    await delWhere('boletos', 'competencia', COMPETENCIA);
    await insert('boletos', boletos);
    // compras da planilha (nota cheia por dia) alimentam compras_nf
    const { error: eDel } = await db.from('compras_nf').delete().eq('origem','planilha').eq('ano', Number(ANO));
    if (eDel) throw new Error(`delete compras_nf: ${eDel.message}`);
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

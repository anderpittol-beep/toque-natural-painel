// Parseia as abas da planilha "Finanças Toque Natural" para objetos prontos
// para upsert no Supabase. Espelha a lógica já validada do painel.
import * as XLSX from 'xlsx';

const LOJAS = ['Ouro Verde', 'Toledo', 'Itaipulândia'];
const COLAB_POR_LOJA = { 'Ouro Verde': 'Eloisa', 'Itaipulândia': 'Tainara', 'Toledo': 'Mayara' };

const MESES = {
  jan: 1, janeiro: 1, fev: 2, fevereiro: 2, 'mar': 3, 'março': 3, marco: 3,
  abr: 4, abril: 4, mai: 5, maio: 5, jun: 6, junho: 6, jul: 7, julho: 7,
  ago: 8, agosto: 8, set: 9, setembro: 9, out: 10, outubro: 10,
  nov: 11, novembro: 11, dez: 12, dezembro: 12,
};

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());

export function lerWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer' });
}

function rows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Aba não encontrada: ${sheetName}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

// ---------- Aba "2026" -> financeiro_mensal ----------
export function parseFinanceiro(wb, ano = 2026) {
  const data = rows(wb, '2026');
  const out = [];
  for (const r of data) {
    const mesNome = txt(r[6]).toLowerCase();
    const mes = MESES[mesNome];
    if (!mes) continue;
    const blocos = [
      { loja: 'Ouro Verde',   receita: num(r[7]),  despesa: num(r[8])  },
      { loja: 'Toledo',       receita: num(r[10]), despesa: num(r[11]) },
      { loja: 'Itaipulândia', receita: num(r[13]), despesa: num(r[14]) },
    ];
    for (const b of blocos) {
      // só meses com receita E despesa preenchidas (> 0)
      if (b.receita && b.despesa) {
        out.push({ ano, mes, loja: b.loja, receita: b.receita, despesa: b.despesa });
      }
    }
  }
  return out;
}

// ---------- Aba "Despesas de Ago" -> despesas_fixas + folha + boletos ----------
const DESC_FOLHA = {
  'Salario Andreia/Vanessa': { papel: 'Sócia', campo: 'salario' },
  'Imposto colaborador Andreia/Vanessa': { papel: 'Sócia', campo: 'encargo' },
  'Salario Colaboradores': { papel: 'Colaboradora', campo: 'salario' },
  'Imposto colaboradores': { papel: 'Colaboradora', campo: 'encargo' },
};

export function parseDespesas(wb, abaNome, competencia) {
  const data = rows(wb, abaNome);
  const despesasFixas = [];
  const folhaAcc = {}; // loja -> {socia:{salario,encargo}, colab:{salario,encargo}}
  for (const l of LOJAS) folhaAcc[l] = { socia: { salario: 0, encargo: 0 }, colab: { salario: 0, encargo: 0 } };

  const boletos = [];

  for (const r of data) {
    const desc = txt(r[1]);
    if (desc && desc.toLowerCase() !== 'total') {
      const valores = { 'Ouro Verde': num(r[2]), 'Toledo': num(r[3]), 'Itaipulândia': num(r[4]) };
      const folhaMap = DESC_FOLHA[desc];
      if (folhaMap) {
        for (const loja of LOJAS) {
          const v = valores[loja];
          if (v != null) {
            const alvo = folhaMap.papel === 'Sócia' ? folhaAcc[loja].socia : folhaAcc[loja].colab;
            alvo[folhaMap.campo] += v;
          }
        }
      } else {
        for (const loja of LOJAS) {
          const v = valores[loja];
          if (v != null && v !== 0) {
            despesasFixas.push({ competencia, loja, descricao: desc, valor: v, venc: null });
          }
        }
      }
    }
    // Totais de compras (col6='Total') e boletos (col11='Total')
    if (txt(r[6]).toLowerCase() === 'total') {
      const comp = { 'Ouro Verde': num(r[7]), 'Toledo': num(r[8]), 'Itaipulândia': num(r[9]) };
      for (const loja of LOJAS) if (comp[loja] != null) {
        boletos.push({ competencia, loja, descricao: 'Compras/NF do mês (total)', valor: comp[loja], status: 'Pago' });
      }
    }
    if (txt(r[11]).toLowerCase() === 'total') {
      const bol = { 'Ouro Verde': num(r[12]), 'Toledo': num(r[13]), 'Itaipulândia': num(r[14]) };
      for (const loja of LOJAS) if (bol[loja] != null && bol[loja] !== 0) {
        boletos.push({ competencia, loja, descricao: 'Boletos a pagar (total)', valor: bol[loja], status: 'Pendente' });
      }
    }
  }

  const folha = [];
  for (const loja of LOJAS) {
    const s = folhaAcc[loja].socia, c = folhaAcc[loja].colab;
    if (s.salario || s.encargo) folha.push({ competencia, pessoa: 'Sócias (Andreia/Vanessa)', papel: 'Sócia', loja, salario: s.salario, comissao: 0, encargo: s.encargo });
    if (c.salario || c.encargo) folha.push({ competencia, pessoa: COLAB_POR_LOJA[loja], papel: 'Colaboradora', loja, salario: c.salario, comissao: 0, encargo: c.encargo });
  }

  return { despesasFixas, folha, boletos };
}

// ---------- Aba "ESTOQUE" -> estoque_inventario ----------
export function parseEstoque(wb) {
  const data = rows(wb, 'ESTOQUE');
  const out = [];
  const pular = new Set(['inventario estoque', 'produto', 'total', '']);
  for (const r of data) {
    const produto = txt(r[0]);
    if (pular.has(produto.toLowerCase())) continue;
    const qtdTotal = num(r[3]);
    const precoPago = num(r[4]);
    // linha de produto real precisa de nome e algum número
    if (!produto || (qtdTotal == null && precoPago == null)) continue;
    out.push({
      produto,
      qtd_estoque: num(r[1]) ?? 0,
      qtd_pode: num(r[2]) ?? 0,
      qtd_total: qtdTotal ?? 0,
      preco_pago: precoPago ?? 0,
      valor_total: num(r[5]) ?? 0,
    });
  }
  return out;
}

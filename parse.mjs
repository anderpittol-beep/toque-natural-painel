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
  // O !ref (dimensão) do arquivo Excel pode estar truncado e cortar colunas à direita.
  // Recalcula o range cobrindo TODAS as células, sempre começando na coluna A (índice 0),
  // para os índices de coluna (r[6], r[11]...) baterem certo.
  let maxR = 0, maxC = 0;
  for (const k of Object.keys(ws)) {
    if (k[0] === '!') continue;
    const c = XLSX.utils.decode_cell(k);
    if (c.r > maxR) maxR = c.r;
    if (c.c > maxC) maxC = c.c;
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

// ---------- Aba "2026" -> financeiro_mensal ----------
const MES_ABBR = { 1:'jan', 2:'fev', 3:'mar', 4:'abr', 5:'mai', 6:'jun', 7:'jul', 8:'ago', 9:'set', 10:'out', 11:'nov', 12:'dez' };

// Despesa TOTAL do mês por loja (fixas + folha + compras), lida da aba "Despesas de <mês>".
// Usada para completar a despesa quando na aba "2026" só a receita foi lançada.
function despesaDoMesPorLoja(wb, mes) {
  const abbr = MES_ABBR[mes];
  if (!abbr) return null;
  const alvo = 'despesas de ' + abbr;
  const nome = Object.keys(wb.Sheets).find(n => n.toLowerCase().trim() === alvo);
  if (!nome) return null;
  const data = rows(wb, nome);
  const acc = { 'Ouro Verde': 0, 'Toledo': 0, 'Itaipulândia': 0 };
  let temAlgo = false;
  for (const r of data) {
    const desc = txt(r[1]);
    // toda linha de despesa fixa/folha (col1 = descrição, col2/3/4 = lojas), menos a linha "Total"
    if (desc && desc.toLowerCase() !== 'total') {
      const v = { 'Ouro Verde': num(r[2]), 'Toledo': num(r[3]), 'Itaipulândia': num(r[4]) };
      for (const loja of LOJAS) if (v[loja] != null) { acc[loja] += v[loja]; temAlgo = true; }
    }
    // compras/NF do mês (col6 = "Total", col7/8/9 = lojas)
    if (txt(r[6]).toLowerCase() === 'total') {
      const c = { 'Ouro Verde': num(r[7]), 'Toledo': num(r[8]), 'Itaipulândia': num(r[9]) };
      for (const loja of LOJAS) if (c[loja] != null) { acc[loja] += c[loja]; temAlgo = true; }
    }
  }
  return temAlgo ? acc : null;
}

// Receita REALIZADA do mês, lida da aba "Projeção de <mês>".
// Nessa aba, as colunas "Realidade" (E/G/I) trazem o lançado por dia; os dias que
// ainda não aconteceram ficam preenchidos por FÓRMULA (média dos dias anteriores).
// Somamos apenas as células digitadas — assim o mês corrente não entra inflado por projeção.
const COL_REALIDADE = { 'Ouro Verde': 4, 'Toledo': 6, 'Itaipulândia': 8 }; // E, G, I (0-based)

function abaProjecao(wb, mes) {
  const abbr = MES_ABBR[mes];
  if (!abbr) return null;
  return Object.keys(wb.Sheets).find(n => {
    const l = n.toLowerCase();
    return l.includes('proje') && l.includes(abbr);
  }) || null;
}

function receitaRealizada(wb, mes) {
  const nome = abaProjecao(wb, mes);
  if (!nome) return null;
  const ws = wb.Sheets[nome];
  if (!ws) return null;
  const acc = { 'Ouro Verde': 0, 'Toledo': 0, 'Itaipulândia': 0 };
  let temReal = false, temProjecao = false, ultimoDia = 0;
  for (let r = 2; r < 60; r++) {              // linha 3 em diante (0-based)
    const diaCell = ws[XLSX.utils.encode_cell({ r, c: 2 })];   // coluna C = dia do mês
    const dia = (diaCell && typeof diaCell.v === 'number') ? diaCell.v : null;
    if (dia === null) continue;               // cabeçalho ou linha "Total" -> ignora
    for (const loja of LOJAS) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: COL_REALIDADE[loja] })];
      if (!cell || typeof cell.v !== 'number') continue;
      if (cell.f) { temProjecao = true; continue; }   // fórmula no dia = valor projetado
      acc[loja] += cell.v;
      temReal = true;
      if (dia > ultimoDia) ultimoDia = dia;
    }
  }
  if (!temReal) return null;
  return { acc, parcial: temProjecao, ultimoDia };
}

export function parseFinanceiro(wb, ano = 2026) {
  const data = rows(wb, '2026');
  const out = [];
  const despCache = {};
  const getDesp = (mes, loja) => {
    if (!(mes in despCache)) despCache[mes] = despesaDoMesPorLoja(wb, mes);
    return despCache[mes] ? despCache[mes][loja] : null;
  };
  for (const r of data) {
    const mesNome = txt(r[6]).toLowerCase();
    const mes = MESES[mesNome];
    if (!mes) continue;
    const blocos = [
      { loja: 'Ouro Verde',   receita: num(r[7]),  despesa: num(r[8])  },
      { loja: 'Toledo',       receita: num(r[10]), despesa: num(r[11]) },
      { loja: 'Itaipulândia', receita: num(r[13]), despesa: num(r[14]) },
    ];
    // mês em andamento: troca a receita projetada pela realizada até hoje
    const real = receitaRealizada(wb, mes);
    const parcialAte = (real && real.parcial && real.ultimoDia)
      ? String(real.ultimoDia).padStart(2, '0') + '/' + String(mes).padStart(2, '0') + '/' + ano
      : null;
    for (const b of blocos) {
      if (real && real.parcial && real.acc[b.loja] > 0) b.receita = Math.round(real.acc[b.loja] * 100) / 100;
      if (!b.receita) continue;
      let despesa = b.despesa;
      // se a despesa não foi lançada na aba 2026, calcula pela aba "Despesas de <mês>"
      if (despesa == null || despesa === 0) {
        const d = getDesp(mes, b.loja);
        if (d != null && d > 0) despesa = Math.round(d * 100) / 100;
      }
      // só grava meses completos (receita E despesa válidas > 0)
      if (despesa && despesa > 0) {
        out.push({ ano, mes, loja: b.loja, receita: b.receita, despesa, parcial_ate: parcialAte });
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
  const comprasNf = [];
  // competência "Ago/26" -> ano/mês, para montar as datas de cada lançamento
  const cm = String(competencia||'').match(/^\s*([A-Za-zçÇ]{3})[^\/]*\/\s*(\d{2,4})/);
  const mes = cm ? MESES[cm[1].toLowerCase()] : null;
  let ano = cm ? Number(cm[2]) : null; if (ano != null && ano < 100) ano += 2000;
  const iso = d => (ano && mes) ? `${ano}-${String(mes).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null;
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const venceu = d => { const dt = (ano && mes) ? new Date(ano, mes-1, d) : null; return dt ? dt <= hoje : false; };

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
            despesasFixas.push({ competencia, ano, mes, loja, descricao: desc, valor: v, venc: null, origem: 'planilha' });
          }
        }
      }
    }
    // Compras por dia (col6 = dia, col7/8/9 = lojas) -> nota cheia, regime de competência
    const diaComp = num(r[6]);
    if (diaComp && diaComp >= 1 && diaComp <= 31) {
      const comp = { 'Ouro Verde': num(r[7]), 'Toledo': num(r[8]), 'Itaipulândia': num(r[9]) };
      for (const loja of LOJAS) if (comp[loja]) {
        comprasNf.push({ data: iso(diaComp), ano, mes, loja, fornecedor: 'Compras do dia (planilha)',
                         descricao: 'Compras/NF', valor: comp[loja], parcelas: 1, origem: 'planilha' });
      }
    }
    // Boletos por dia (col11 = dia, col12/13/14 = lojas) -> regime de caixa.
    // Já vencidos contam como pagos; os que ainda vão vencer ficam em aberto.
    const diaBol = num(r[11]);
    if (diaBol && diaBol >= 1 && diaBol <= 31) {
      const bol = { 'Ouro Verde': num(r[12]), 'Toledo': num(r[13]), 'Itaipulândia': num(r[14]) };
      for (const loja of LOJAS) if (bol[loja]) {
        boletos.push({ competencia, ano, mes, data_pgto: iso(diaBol), loja,
                       descricao: 'Boleto ' + String(diaBol).padStart(2,'0') + '/' + String(mes).padStart(2,'0'),
                       valor: bol[loja], status: venceu(diaBol) ? 'Pago' : 'Pendente', origem: 'planilha' });
      }
    }
  }

  const folha = [];
  for (const loja of LOJAS) {
    const s = folhaAcc[loja].socia, c = folhaAcc[loja].colab;
    if (s.salario || s.encargo) folha.push({ competencia, ano, mes, pessoa: 'Sócias (Andreia/Vanessa)', papel: 'Sócia', loja, salario: s.salario, comissao: 0, encargo: s.encargo, origem: 'planilha' });
    if (c.salario || c.encargo) folha.push({ competencia, ano, mes, pessoa: COLAB_POR_LOJA[loja], papel: 'Colaboradora', loja, salario: c.salario, comissao: 0, encargo: c.encargo, origem: 'planilha' });
  }

  return { despesasFixas, folha, boletos, comprasNf };
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

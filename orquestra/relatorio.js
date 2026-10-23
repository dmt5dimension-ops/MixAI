// Relatório de uso por agente: quem resolveu o quê e quanto subiu da escada do modelo local para Codex/Claude.
// Só lê (sem-cota.json, casos/casos.jsonl, grafo.json) e imprime; não altera nada.
const fs = require('node:fs');
const path = require('node:path');

const pasta = __dirname;
const ARQUIVOS = {
  semCota: path.join(pasta, 'sem-cota.json'),
  casos: path.join(pasta, 'casos', 'casos.jsonl'),
  falhas: path.join(pasta, 'falhas', 'falhas.jsonl'),
  grafo: path.join(pasta, 'grafo.json'),
};
const agentes = ['claude', 'codex', 'local'];

function lerJson(arquivo, padrao) {
  if (!fs.existsSync(arquivo)) return padrao;
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (erro) {
    if (erro instanceof SyntaxError) return padrao;
    throw erro;
  }
}

// Linha quebrada é ignorada: o relatório não pode cair por causa de um registro ruim.
function lerLinhas(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  const saida = [];
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try { saida.push(JSON.parse(linha)); } catch (erro) { if (!(erro instanceof SyntaxError)) throw erro; }
  }
  return saida;
}

const zerado = () => Object.fromEntries(agentes.map((a) => [a, 0]));

function montar({ semCota = {}, casos = [], falhas = [], grafo = { tarefas: {} } } = {}, agora = new Date()) {
  const casosPor = zerado();
  for (const c of casos) if (agentes.includes(c.resolvidoPor)) casosPor[c.resolvidoPor]++;
  const total = casosPor.local + casosPor.codex + casosPor.claude;
  const subiram = casosPor.codex + casosPor.claude;
  const falhasPor = zerado();
  for (const f of falhas) if (agentes.includes(f.resolvidoPor)) falhasPor[f.resolvidoPor]++;

  const tarefasPor = zerado();
  const porEstado = {};
  for (const t of Object.values(grafo.tarefas || {})) {
    porEstado[t.estado] = (porEstado[t.estado] || 0) + 1;
    if (t.estado === 'feita' && agentes.includes(t.agente)) tarefasPor[t.agente]++;
  }

  const pausados = {};
  for (const a of agentes) {
    if (semCota[a] && new Date(semCota[a]).getTime() > agora.getTime()) pausados[a] = semCota[a];
  }

  return {
    casos: { total, porAgente: casosPor, subiram, percentualSubiu: total ? Math.round((subiram / total) * 100) : 0 },
    falhasResolvidas: falhasPor,
    tarefasFeitas: tarefasPor,
    tarefasPorEstado: porEstado,
    pausados,
  };
}

function emTexto(r) {
  const l = [];
  l.push(`Casos resolvidos: ${r.casos.total} (local ${r.casos.porAgente.local}, codex ${r.casos.porAgente.codex}, claude ${r.casos.porAgente.claude})`);
  l.push(`Subiram para Codex/Claude: ${r.casos.subiram} (${r.casos.percentualSubiu}%)`);
  l.push(`Falhas registradas resolvidas por: codex ${r.falhasResolvidas.codex}, claude ${r.falhasResolvidas.claude}, local ${r.falhasResolvidas.local}`);
  l.push(`Tarefas feitas no grafo: codex ${r.tarefasFeitas.codex}, claude ${r.tarefasFeitas.claude}, local ${r.tarefasFeitas.local}`);
  const estados = Object.entries(r.tarefasPorEstado).map(([e, n]) => `${e} ${n}`).join(', ');
  l.push(`Tarefas por estado: ${estados || 'nenhuma'}`);
  const p = Object.entries(r.pausados).map(([a, ate]) => `${a} até ${ate}`).join(', ');
  l.push(p ? `Sem cota agora: ${p}` : 'Ninguém está sem cota.');
  return l.join('\n');
}

function relatorio(arquivos = ARQUIVOS, agora = new Date()) {
  return montar({
    semCota: lerJson(arquivos.semCota, {}),
    casos: lerLinhas(arquivos.casos),
    falhas: lerLinhas(arquivos.falhas),
    grafo: lerJson(arquivos.grafo, { tarefas: {} }),
  }, agora);
}

if (require.main === module) {
  const r = relatorio();
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : emTexto(r));
}

module.exports = { montar, emTexto, relatorio, lerLinhas };

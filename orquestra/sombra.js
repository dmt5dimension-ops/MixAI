// Fases 1 e 2 do pipeline do Qwen (docs/pesquisa/pipeline-progressivo-qwen.md).
// Fase 1 (sombra): o Qwen tenta tarefas verificáveis, mas a resposta NÃO vale; só registramos se acertou, por tipo de tarefa.
// Fase 2 (liberação): só o tipo em que o Qwen acertou o suficiente nas últimas tentativas fica liberado para trabalho de verdade.
// O Qwen nunca decide o tipo nem a liberação: o tipo vem do plano (escrito pelo planejador) e a liberação é só conta.
const fs = require('node:fs');
const path = require('node:path');

const pasta = __dirname;
const ARQUIVOS = {
  sombra: path.join(pasta, 'sombra', 'sombra.jsonl'),
  liberados: path.join(pasta, 'tipos-liberados.json'),
};
const PADRAO = { janela: 20, minimo: 20, corte: 0.9 };
const MODELO_PADRAO = 'mixai-local'; // registro antigo, sem campo modelo, é do Qwen

function lerRegistros(arquivo = ARQUIVOS.sombra) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function registrar(arquivo, registro) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.appendFileSync(arquivo, JSON.stringify(registro) + '\n');
}

function validar(tarefas) {
  if (!Array.isArray(tarefas) || !tarefas.length) throw new Error('plano vazio: lista de tarefas esperada');
  const ids = new Set();
  for (const t of tarefas) {
    for (const campo of ['id', 'tipo', 'entrada']) {
      if (typeof t?.[campo] !== 'string' || !t[campo].trim()) throw new Error(`tarefa sem "${campo}": ${JSON.stringify(t)}`);
    }
    if (ids.has(t.id)) throw new Error(`id repetido: ${t.id}`);
    ids.add(t.id);
  }
}

// Para rodar de verdade cada tarefa precisa trazer o comando que confere a resposta; sem ele o Qwen seria chamado e marcado
// como errado só por falta de verificador. Por isso o plano inteiro é recusado antes de qualquer chamada ao modelo.
function exigirVerificar(tarefas) {
  const sem = tarefas.filter((t) => typeof t?.verificar !== 'string' || !t.verificar.trim()).map((t) => t?.id ?? '?');
  if (sem.length) throw new Error(`tarefa sem comando "verificar" (o modelo não foi chamado): ${sem.join(', ')}`);
}

// `local(prompt)` e `verificar(tarefa, saida)` são injetados; `verificar` devolve { ok, motivo }.
async function rodarSombra({ tarefas, local, verificar, modelo = MODELO_PADRAO, arquivo = ARQUIVOS.sombra, agora = () => new Date().toISOString() }) {
  if (typeof modelo !== 'string' || !modelo.trim()) throw new Error('modelo sem nome');
  validar(tarefas);
  const resultados = [];
  for (const t of tarefas) {
    let saida = null;
    let erro = null;
    try { saida = await local(t.entrada); } catch (e) { erro = String(e?.message || e).slice(0, 300); }
    let registro;
    if (erro !== null || typeof saida !== 'string' || !saida.trim()) {
      // Sem resposta (memória, placa, erro): não conta contra o Qwen, igual à escada.
      registro = { id: t.id, tipo: t.tipo, modelo, semResposta: true, erro, data: agora() };
    } else {
      const v = await verificar(t, saida);
      registro = { id: t.id, tipo: t.tipo, modelo, acertou: v.ok === true, motivo: v.ok ? '' : String(v.motivo || '').slice(0, 300), data: agora() };
    }
    registrar(arquivo, registro);
    resultados.push(registro);
  }
  return resultados;
}

// Só conta tentativa com resposta. `ultimas` = as `janela` mais recentes do tipo.
function relatorio(registros, { janela = PADRAO.janela, modelo = MODELO_PADRAO } = {}) {
  const porTipo = {};
  for (const r of registros) {
    if (r.semResposta || (r.modelo || MODELO_PADRAO) !== modelo) continue;
    (porTipo[r.tipo] = porTipo[r.tipo] || []).push(r.acertou === true);
  }
  const saida = {};
  for (const [tipo, lista] of Object.entries(porTipo)) {
    const ultimas = lista.slice(-janela);
    const acertos = ultimas.filter(Boolean).length;
    saida[tipo] = { total: lista.length, amostra: ultimas.length, acertos, taxa: acertos / ultimas.length };
  }
  return saida;
}

// Liberado = amostra completa (>= minimo) e taxa >= corte. Tipo sem dados nunca fica liberado.
function liberados(registros, opcoes = {}) {
  const { janela, minimo, corte, modelo } = { ...PADRAO, modelo: MODELO_PADRAO, ...opcoes };
  const rel = relatorio(registros, { janela, modelo });
  const tabela = {};
  for (const [tipo, r] of Object.entries(rel)) {
    tabela[tipo] = { liberado: r.amostra >= minimo && r.taxa >= corte, taxa: r.taxa, amostra: r.amostra, minimo, corte };
  }
  return tabela;
}

function modelosDe(registros) {
  return [...new Set(registros.map((r) => r.modelo || MODELO_PADRAO))].sort();
}

// Tabela tipo x modelo (acerto nas últimas tentativas), para ver qual modelo local serve para qual tipo.
// Atenção: as taxas só são comparáveis se os modelos rodaram o mesmo plano e os mesmos casos.
function comparar(registros, opcoes = {}) {
  const saida = {};
  for (const modelo of modelosDe(registros)) {
    for (const [tipo, r] of Object.entries(relatorio(registros, { ...opcoes, modelo }))) {
      (saida[tipo] = saida[tipo] || {})[modelo] = { acertos: r.acertos, amostra: r.amostra, taxa: r.taxa };
    }
  }
  return saida;
}

// Um arquivo só, com a tabela de cada modelo: { "<modelo>": { "<tipo>": {...} } }
function liberadosDeTodos(registros, opcoes = {}) {
  const todos = {};
  for (const modelo of modelosDe(registros)) todos[modelo] = liberados(registros, { ...opcoes, modelo });
  return todos;
}

function gravarLiberados(arquivo, tabela) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tabela, null, 2) + '\n');
  fs.renameSync(tmp, arquivo);
}

// A escada consulta isto antes de mandar uma tarefa ao Qwen: tipo desconhecido ou arquivo ausente = não liberado.
function tipoLiberado(tipo, modelo = MODELO_PADRAO, arquivo = ARQUIVOS.liberados) {
  if (!fs.existsSync(arquivo)) return false;
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8'))[modelo]?.[tipo]?.liberado === true; } catch { return false; }
}

function opcao(argumentos, nome) {
  const i = argumentos.indexOf(nome);
  return i >= 0 ? argumentos[i + 1] : undefined;
}

async function principal(argumentos) {
  const [comando, alvo] = argumentos;
  const modelo = opcao(argumentos, '--modelo');
  if (comando === 'relatorio') {
    const registros = lerRegistros();
    const modelos = modelo ? [modelo] : modelosDe(registros);
    if (!modelos.length) { console.log('Sem tentativas registradas ainda.'); return 0; }
    for (const m of modelos) {
      console.log(`[${m}]`);
      for (const [tipo, r] of Object.entries(relatorio(registros, { modelo: m }))) console.log(`  ${tipo}: ${r.acertos}/${r.amostra} nas últimas tentativas (${Math.round(r.taxa * 100)}%), ${r.total} no total`);
    }
    return 0;
  }
  if (comando === 'comparar') {
    for (const [tipo, porModelo] of Object.entries(comparar(lerRegistros()))) {
      console.log(`${tipo}: ${Object.entries(porModelo).map(([m, r]) => `${m} ${Math.round(r.taxa * 100)}% (${r.amostra})`).join(' | ')}`);
    }
    return 0;
  }
  if (comando === 'liberar') {
    const tabela = liberadosDeTodos(lerRegistros());
    gravarLiberados(ARQUIVOS.liberados, tabela);
    for (const [m, tipos] of Object.entries(tabela)) {
      for (const [tipo, t] of Object.entries(tipos)) console.log(`[${m}] ${tipo}: ${t.liberado ? 'LIBERADO' : 'não liberado'} (${t.amostra} tentativas, ${Math.round(t.taxa * 100)}%)`);
    }
    return 0;
  }
  if (comando === 'rodar' && alvo) {
    if (modelo && modelo !== MODELO_PADRAO && !opcao(argumentos, '--comando')) throw new Error(`modelo "${modelo}" precisa de --comando (só o ${MODELO_PADRAO} tem comando padrão)`);
    const escada = require('./escada.js');
    const tarefas = JSON.parse(fs.readFileSync(path.resolve(alvo), 'utf8'));
    validar(tarefas);
    exigirVerificar(tarefas);
    // Por padrão o Qwen (rodar-local.js). Outro modelo local: --modelo <nome> --comando "<comando que lê a tarefa e responde>".
    const comando_ = opcao(argumentos, '--comando') || `node "${path.join(pasta, '..', 'local', 'rodar-local.js')}"`;
    const chamarLocal = escada.chamarComando(comando_);
    const rs = await rodarSombra({
      tarefas,
      modelo: modelo || MODELO_PADRAO,
      local: (p) => chamarLocal(p),
      verificar: (t, saida) => (t.verificar ? escada.verificadorPorComando(t.verificar)(saida) : Promise.resolve({ ok: false, motivo: 'tarefa sem comando verificar' })),
    });
    console.log(`${rs.filter((r) => r.acertou).length} certas, ${rs.filter((r) => r.acertou === false).length} erradas, ${rs.filter((r) => r.semResposta).length} sem resposta.`);
    return 0;
  }
  console.error('Uso: node orquestra/sombra.js rodar <plano.json> [--modelo <nome> --comando "<cmd>"] | relatorio [--modelo <nome>] | comparar | liberar');
  return 1;
}

if (require.main === module) principal(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });

module.exports = { exigirVerificar, rodarSombra, relatorio, liberados, liberadosDeTodos, comparar, modelosDe, gravarLiberados, tipoLiberado, lerRegistros, validar, ARQUIVOS, PADRAO, MODELO_PADRAO };

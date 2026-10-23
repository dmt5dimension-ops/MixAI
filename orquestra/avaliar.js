// Mede o Qwen local (ou outro agente) nos exemplos de validação separados por orquestra/treino.js.
// Rodar antes e depois de um treino mostra se o modelo melhorou. O agente é injetável; na linha de comando
// ele é um comando que lê a tarefa na entrada padrão e responde na saída padrão (como local/rodar-local.js).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ARQUIVO_VALIDACAO = path.join(__dirname, 'casos', 'validacao.jsonl');

// Compara ignorando espaço sobrando e quebra de linha do Windows; o resto tem que ser igual.
function normalizar(texto) {
  return String(texto ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

function lerValidacao(arquivo = ARQUIVO_VALIDACAO) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    const [u, a] = JSON.parse(l).messages;
    return { entrada: u.content, esperado: a.content };
  });
}

async function avaliar(exemplos, agente, { limite } = {}) {
  const lista = limite ? exemplos.slice(0, limite) : exemplos;
  const erros = [];
  let acertos = 0;
  for (const ex of lista) {
    let saida = null;
    let falha = null;
    try { saida = await agente(ex.entrada); } catch (e) { falha = e.message; }
    if (falha === null && normalizar(saida) === normalizar(ex.esperado)) acertos++;
    else erros.push({ entrada: ex.entrada, esperado: ex.esperado, obtido: saida, erro: falha });
  }
  const total = lista.length;
  return { total, acertos, taxa: total ? acertos / total : null, erros };
}

function agentePorComando(comando, tempoMaxMs = 600000) {
  return (prompt) => new Promise((ok, no) => {
    const filho = spawn(comando, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    const t = setTimeout(() => { filho.kill(); no(new Error('tempo máximo do agente')); }, tempoMaxMs);
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { erro += d; });
    filho.on('error', (e) => { clearTimeout(t); no(e); });
    filho.on('close', (codigo) => {
      clearTimeout(t);
      if (codigo === 0) ok(saida); else no(new Error(`agente saiu com ${codigo}: ${erro.trim().slice(0, 200)}`));
    });
    filho.stdin.on('error', () => {});
    filho.stdin.end(prompt);
  });
}

async function principal(argumentos) {
  const i = argumentos.indexOf('--comando');
  const il = argumentos.indexOf('--limite');
  if (argumentos[0] !== 'rodar' || i < 0 || !argumentos[i + 1]) {
    console.error('Uso: node orquestra/avaliar.js rodar --comando "<comando>" [--limite N] [--arquivo validacao.jsonl]');
    return 1;
  }
  const ia = argumentos.indexOf('--arquivo');
  const exemplos = lerValidacao(ia >= 0 ? path.resolve(argumentos[ia + 1]) : ARQUIVO_VALIDACAO);
  if (!exemplos.length) { console.error('Sem exemplos de validação. Rode antes: node orquestra/treino.js preparar'); return 2; }
  const r = await avaliar(exemplos, agentePorComando(argumentos[i + 1]), { limite: il >= 0 ? Number(argumentos[il + 1]) : undefined });
  console.log(`${r.acertos} de ${r.total} certos (${Math.round(r.taxa * 100)}%).`);
  for (const e of r.erros) console.log(`ERROU: ${e.entrada.slice(0, 80).replace(/\s+/g, ' ')}`);
  return 0;
}

if (require.main === module) principal(process.argv.slice(2)).then((c) => process.exit(c));

module.exports = { avaliar, lerValidacao, normalizar, agentePorComando };

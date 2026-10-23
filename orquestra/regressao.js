// Regressão para os ACERTOS: toda tarefa em que um aluno acertou (ou que o modelo grande resolveu) vira um caso permanente
// { entrada, verificar, saidaCerta }. Só entra se o comando de verificação realmente aprova a resposta certa agora.
// O teste permanente (tests/regressao-acertos.test.js) confere sempre que a resposta certa passa e que uma resposta
// adulterada reprova, então um verificador que passou a aceitar qualquer coisa também é pego.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');
const ARQUIVO = path.join(__dirname, 'regressao', 'acertos.jsonl');

// Identidade do caso: o que a tarefa É (tipo, pedido, verificador e resposta certa), não o rótulo `id`. O gerador de planos repete
// os mesmos ids entre sementes ("data-iso-001"), então só o id não distingue casos diferentes; o mesmo caso repetido tem a mesma chave.
function chaveDe(c) {
  return crypto.createHash('sha256').update(JSON.stringify([c.tipo, c.entrada, c.verificar, c.saidaCerta])).digest('hex').slice(0, 16);
}

function lerAcertos(arquivo = ARQUIVO) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function rodarVerificador(comando, resposta, cwd = RAIZ) {
  const r = spawnSync(comando, { shell: true, cwd, input: resposta, encoding: 'utf8', timeout: 15000 });
  return r.status === 0;
}

// O comando não pode depender de arquivo temporário (some depois): caso assim não serve como regressão permanente.
function dependeDeTemporario(comando) {
  return comando.includes(os.tmpdir());
}

function registrar(tarefa, saidaCerta, { arquivo = ARQUIVO, modelo, data = new Date().toISOString(), cwd = RAIZ } = {}) {
  for (const campo of ['id', 'tipo', 'entrada', 'verificar']) {
    if (typeof tarefa?.[campo] !== 'string' || !tarefa[campo].trim()) return { ok: false, motivo: `tarefa sem "${campo}"` };
  }
  if (typeof saidaCerta !== 'string' || !saidaCerta.trim()) return { ok: false, motivo: 'sem resposta certa' };
  if (dependeDeTemporario(tarefa.verificar)) return { ok: false, motivo: 'o verificador usa arquivo temporário' };
  const existentes = lerAcertos(arquivo);
  const chave = chaveDe({ tipo: tarefa.tipo, entrada: tarefa.entrada, verificar: tarefa.verificar, saidaCerta });
  if (existentes.some((c) => chaveDe(c) === chave)) return { ok: false, motivo: `já existe o caso "${tarefa.id}" (mesmo pedido, verificador e resposta)` };
  // mesmo id de outro caso diferente (outra semente): mantém os dois, com o id do novo diferenciado
  const id = existentes.some((c) => c.id === tarefa.id) ? `${tarefa.id}-${chave.slice(0, 6)}` : tarefa.id;
  if (!rodarVerificador(tarefa.verificar, saidaCerta, cwd)) return { ok: false, motivo: 'o verificador não aprova a resposta dada' };
  if (rodarVerificador(tarefa.verificar, saidaCerta + '\n#adulterada#', cwd)) return { ok: false, motivo: 'o verificador aprova até resposta adulterada (não confere nada)' };
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.appendFileSync(arquivo, JSON.stringify({ id, tipo: tarefa.tipo, entrada: tarefa.entrada, verificar: tarefa.verificar, saidaCerta, ...(modelo ? { modelo } : {}), data }) + '\n');
  return { ok: true, motivo: '' };
}

// Usa a `referencia` do plano da sombra (orquestra/sombra-plano) como resposta certa.
function importarDoPlano(plano, opcoes = {}) {
  const resultado = { registrados: 0, recusados: [] };
  for (const t of plano) {
    const r = registrar(t, t.referencia, opcoes);
    if (r.ok) resultado.registrados++; else resultado.recusados.push({ id: t.id, motivo: r.motivo });
  }
  return resultado;
}

function principal(argumentos) {
  const [comando, alvo] = argumentos;
  if (comando === 'importar' && alvo) {
    const r = importarDoPlano(JSON.parse(fs.readFileSync(path.resolve(alvo), 'utf8')));
    console.log(`${r.registrados} casos registrados, ${r.recusados.length} recusados.`);
    for (const x of r.recusados) console.log(`  ${x.id}: ${x.motivo}`);
    return 0;
  }
  if (comando === 'listar') {
    const c = lerAcertos();
    console.log(`${c.length} casos de acerto.`);
    return 0;
  }
  console.error('Uso: node orquestra/regressao.js importar <plano.json> | listar');
  return 1;
}

if (require.main === module) process.exit(principal(process.argv.slice(2)));

module.exports = { chaveDe, registrar, importarDoPlano, lerAcertos, rodarVerificador, dependeDeTemporario, ARQUIVO };

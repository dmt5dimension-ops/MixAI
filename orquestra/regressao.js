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

// `spawnSync(..., { timeout })` mata só o shell, não os filhos do verificador. Por isso o verificador roda dentro de um
// processo ajudante que o dispara, espera o prazo e, se estourar, derruba a ÁRVORE inteira (matarArvore, igual ao avaliar.js).
const AJUDANTE = `
const { spawn } = require('node:child_process');
const { matarArvore } = require(process.argv[1]);
const [comando, cwd, prazo] = [process.argv[2], process.argv[3], Number(process.argv[4])];
const filho = spawn(comando, { shell: true, cwd, stdio: ['inherit', 'ignore', 'ignore'], detached: process.platform !== 'win32' });
const t = setTimeout(() => { matarArvore(filho); process.exit(124); }, prazo);
filho.on('error', () => { clearTimeout(t); process.exit(1); });
filho.on('close', (codigo) => { clearTimeout(t); process.exit(codigo === 0 ? 0 : 1); });
`;

function rodarVerificador(comando, resposta, cwd = RAIZ, prazoMs = 15000) {
  const r = spawnSync(process.execPath, ['-e', AJUDANTE, path.join(__dirname, 'avaliar.js'), comando, cwd, String(prazoMs)],
    { input: resposta, encoding: 'utf8', timeout: prazoMs + 10000, windowsHide: true });
  return r.status === 0;
}

// O comando não pode depender de arquivo temporário (some depois): caso assim não serve como regressão permanente.
// Compara sem diferença de separador (\\ ou /) e, no Windows, sem diferença de caixa; confere também o caminho real da pasta.
function dependeDeTemporario(comando, { plataforma = process.platform, tmp = os.tmpdir() } = {}) {
  const norma = (x) => { const t = String(x).replace(/\\/g, '/'); return plataforma === 'win32' ? t.toLowerCase() : t; };
  const pastas = new Set([norma(tmp)]);
  try { pastas.add(norma(fs.realpathSync(tmp))); } catch { /* pasta inexistente */ }
  const texto = norma(comando);
  return [...pastas].some((pasta) => pasta && texto.includes(pasta.replace(/\/+$/, '')));
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

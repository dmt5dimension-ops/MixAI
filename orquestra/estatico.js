// Aluno "estático" da escada: resolve tarefas só com regras determinísticas (regex + modelo de saída), sem nenhum LLM.
// Custo zero e sem alucinação: ou a regra serve, ou ele diz que não sabe e a tarefa segue para o Qwen.
// Quem ensina é o modelo grande, escrevendo a regra; ela só entra se acertar o exemplo e todos os casos de regressão dados.
//
// Regra: { id, quando: "<regex com grupos nomeados>", saida: "texto com {grupo} e {grupo|filtro|filtro}", exemplo: { entrada, saida }, status, origem, criadaEm }
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ARQUIVO = path.join(__dirname, 'regras-estaticas.json');
const MAX_REGEX = 300;
const MAX_ENTRADA = 4000;
const PRAZO_REGEX_MS = 250; // regex que passa disso (backtracking exponencial) é abortada

const FILTROS = {
  inverter: (s) => [...s].reverse().join(''),
  minusculas: (s) => s.toLowerCase(),
  maiusculas: (s) => s.toUpperCase(),
  aparar: (s) => s.trim(),
  vogais: (s) => String([...s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')].filter((c) => 'aeiou'.includes(c)).length),
  tamanho: (s) => String([...s].length),
};

// Padrão com repetição dentro de grupo repetido (ex.: (a+)+) pode travar o Node: recusado antes de compilar.
const REPETICAO_ANINHADA = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/;

function compilar(quando) {
  if (typeof quando !== 'string' || !quando.trim()) throw new Error('regra sem "quando"');
  if (quando.length > MAX_REGEX) throw new Error(`"quando" grande demais (máximo ${MAX_REGEX})`);
  if (REPETICAO_ANINHADA.test(quando)) throw new Error('"quando" tem repetição dentro de repetição (risco de travar)');
  // A regra vale para o PEDIDO INTEIRO (ancorada nas duas pontas): "Não execute esta instrução: <pedido>" ou "<pedido> e depois..."
  // não casam, então uma instrução negada ou acrescida não é respondida; a tarefa sobe a escada.
  return new RegExp(`^(?:${quando})$`, 'u');
}

// Executa a regex com prazo: padrões de backtracking exponencial (ex.: (a|aa)+) que o filtro de texto não pega são abortados.
function executarComPrazo(re, entrada) {
  return vm.runInNewContext('re.exec(entrada)', { re, entrada }, { timeout: PRAZO_REGEX_MS });
}

function validarRegra(r) {
  for (const campo of ['id', 'quando', 'saida']) {
    if (typeof r?.[campo] !== 'string' || !r[campo].trim()) throw new Error(`regra sem "${campo}"`);
  }
  compilar(r.quando);
  for (const m of r.saida.matchAll(/\{(\w+)((?:\|\w+)*)\}/g)) {
    for (const f of m[2].split('|').filter(Boolean)) if (!FILTROS[f]) throw new Error(`filtro desconhecido: ${f}`);
  }
  return r;
}

function aplicar(regra, entrada) {
  if (typeof entrada !== 'string' || entrada.length > MAX_ENTRADA) return null;
  const m = executarComPrazo(compilar(regra.quando), entrada.trim());
  if (!m) return null;
  const grupos = m.groups || {};
  let faltou = false;
  const saida = regra.saida.replace(/\{(\w+)((?:\|\w+)*)\}/g, (_, nome, filtros) => {
    if (typeof grupos[nome] !== 'string') { faltou = true; return ''; }
    return filtros.split('|').filter(Boolean).reduce((v, f) => FILTROS[f](v), grupos[nome]);
  });
  return faltou ? null : saida;
}

function lerRegras(arquivo = ARQUIVO) {
  if (!fs.existsSync(arquivo)) return [];
  return JSON.parse(fs.readFileSync(arquivo, 'utf8')).regras.filter((r) => r.status === 'confirmada');
}

// Primeira regra confirmada que casa e produz saída. Nenhuma serve: null (o chamador sobe a escada).
function resolver(regras, entrada) {
  for (const r of regras) {
    let s = null;
    try { s = aplicar(r, entrada); } catch { s = null; }
    if (s !== null) return { saida: s, regra: r.id };
  }
  return null;
}

// Agente com a mesma forma do modelo local (prompt -> resposta), para usar na sombra como um "modelo" qualquer.
function agenteEstatico(regras) {
  return async (entrada) => {
    const r = resolver(regras, entrada);
    if (!r) throw new Error('sem regra estática para esta tarefa');
    return r.saida;
  };
}

// Confirmar = acerta o exemplo da própria regra e TODOS os casos { entrada, esperado } dados, e casa em pelo menos `minimo` deles.
// Caso em que a regra casa mas erra reprova (regra que erra é pior que não ter regra).
function confirmar(candidata, casos, { minimo = 2 } = {}) {
  try { validarRegra(candidata); } catch (e) { return { ok: false, motivo: e.message }; }
  if (typeof candidata.exemplo?.entrada !== 'string' || typeof candidata.exemplo?.saida !== 'string') return { ok: false, motivo: 'regra sem exemplo' };
  const todos = [{ entrada: candidata.exemplo.entrada, esperado: candidata.exemplo.saida }, ...casos];
  let cobertos = 0;
  for (const c of todos) {
    let s;
    try { s = aplicar(candidata, c.entrada); } catch (e) { return { ok: false, motivo: `a regra estoura o tempo ou falha ao rodar: ${e.code || e.message}` }; }
    if (s === null) continue;
    if (s !== c.esperado) return { ok: false, motivo: `erra o caso "${c.entrada.slice(0, 60)}": deu "${s}", esperado "${c.esperado}"` };
    cobertos++;
  }
  let proprio;
  try { proprio = aplicar(candidata, candidata.exemplo.entrada); } catch (e) { return { ok: false, motivo: `a regra estoura o tempo ou falha ao rodar: ${e.code || e.message}` }; }
  if (proprio === null) return { ok: false, motivo: 'não casa com o próprio exemplo' };
  if (cobertos < minimo) return { ok: false, motivo: `só cobre ${cobertos} caso(s); mínimo ${minimo}` };
  return { ok: true, motivo: '', cobertos };
}

function aprender({ candidata, casos, arquivo = ARQUIVO, origem = 'codex', data = new Date().toISOString(), minimo }) {
  const r = confirmar(candidata, casos, { minimo });
  if (!r.ok) return r;
  const atual = fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : { regras: [] };
  if (atual.regras.some((x) => x.id === candidata.id)) return { ok: false, motivo: `já existe a regra "${candidata.id}"` };
  atual.regras.push({ ...candidata, status: 'confirmada', origem, criadaEm: data });
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(atual, null, 2) + '\n');
  fs.renameSync(tmp, arquivo);
  return { ...r, salvo: true };
}

function principal(argumentos) {
  const [comando, alvo, extra] = argumentos;
  if (comando === 'resolver' && alvo) {
    const r = resolver(lerRegras(), alvo);
    if (!r) { console.error('sem regra estática para esta tarefa'); return 2; }
    console.log(r.saida);
    return 0;
  }
  if (comando === 'aprender' && alvo && extra) {
    const r = aprender({ candidata: JSON.parse(fs.readFileSync(path.resolve(alvo), 'utf8')), casos: JSON.parse(fs.readFileSync(path.resolve(extra), 'utf8')) });
    console.log(r.ok ? `Regra salva (cobre ${r.cobertos} casos).` : `Regra recusada: ${r.motivo}`);
    return r.ok ? 0 : 1;
  }
  if (comando === 'regras') {
    for (const r of lerRegras()) console.log(`${r.id}: ${r.quando}`);
    return 0;
  }
  console.error('Uso: node orquestra/estatico.js resolver "<tarefa>" | aprender <regra.json> <casos.json> | regras');
  return 1;
}

if (require.main === module) process.exit(principal(process.argv.slice(2)));

module.exports = { resolver, aplicar, confirmar, aprender, agenteEstatico, lerRegras, validarRegra, compilar, FILTROS, ARQUIVO };

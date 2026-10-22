// Grafo persistente de tarefas: quem depende de quem, em que estado está cada uma e quem a executa.
// Fica em orquestra/grafo.json (versionado no git). O supervisor e a escada leem e gravam o mesmo arquivo.
const fs = require('node:fs');
const path = require('node:path');

const padrao = path.join(__dirname, 'grafo.json');
const agentes = ['claude', 'codex', 'local'];
const limitePadrao = 3;

const novo = () => ({ versao: 1, tarefas: {} });
const copia = (g) => JSON.parse(JSON.stringify(g));
// Caminho comparável: barras normais, sem ./ nem barra final, minúsculas (o Windows não diferencia) e curinga vira a pasta antes dele.
const normaliza = (p) => {
  let c = path.posix.normalize(String(p).replace(/\\/g, '/')).toLowerCase().replace(/^\.\//, '').replace(/\/+$/, '');
  const i = c.search(/[*?[]/);
  if (i >= 0) c = c.slice(0, i).replace(/\/?[^/]*$/, '');
  return c === '.' ? '' : c;
};
const sobrepoe = (a, b) => a === b || a === '' || b === '' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const lista = (g) => Object.values(g.tarefas);

function carregar(arquivo = padrao) {
  if (!fs.existsSync(arquivo)) return novo();
  try {
    const g = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (g?.versao !== 1 || typeof g.tarefas !== 'object' || g.tarefas === null) throw new Error('formato');
    return g;
  } catch (erro) {
    throw new Error(`grafo corrompido em ${arquivo} (${erro.message}); o arquivo não foi alterado`);
  }
}

// Gravação atômica, mas sem trava: para alterar um grafo que outros também usam, chame `atualizar`.
function salvar(arquivo, g) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const temp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(g, null, 2) + '\n');
  fs.renameSync(temp, arquivo);
}

function esperar(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (erro) { return erro.code === 'EPERM'; }
}

// Lê, muda e grava o grafo com o arquivo trancado, para o supervisor e a escada não se atropelarem.
// A trava é um arquivo `.lock` criado com 'wx' (só um processo consegue), com `pid:código` dentro.
// Trava de dono VIVO nunca é tirada, por mais tempo que demore (a mudança é feita sem pausa e não dá para
// "renovar" no meio dela); só cai a trava de dono que morreu, ou, se o conteúdo não for de um processo,
// a que passou de `velhaMs`. Quem remove a trava velha segura a `.limpeza`, então só um processo por vez
// mexe nela, e o dono morto não pode soltá-la nem recriá-la no meio da conferência.
// Antes de gravar, confere que a trava ainda é sua; se não for, não grava.
function atualizar(arquivo, mudanca, { esperaMs = 10000, velhaMs = 60000 } = {}) {
  const trava = `${arquivo}.lock`;
  const limpeza = `${arquivo}.limpeza`;
  const dono = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const limite = Date.now() + esperaMs;
  const idade = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return null; } };
  const ler = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const criar = (f) => {
    try { fs.writeFileSync(f, dono, { flag: 'wx' }); return true; } catch (erro) {
      if (erro.code === 'EEXIST') return false;
      throw erro;
    }
  };
  const velha = (f) => {
    const texto = ler(f);
    if (texto === null) return false;
    const pid = /^(\d+):/.exec(texto);
    if (pid) return !processoVivo(Number(pid[1]));
    const i = idade(f);
    return i !== null && i > velhaMs;
  };
  while (!criar(trava)) {
    if (Date.now() > limite) throw new Error(`grafo travado por outro processo (${trava}); se ninguém está usando, apague esse arquivo`);
    if (velha(trava)) {
      if (idade(limpeza) > 10000) { try { fs.rmSync(limpeza); } catch { /* outro tirou */ } }
      if (criar(limpeza)) {
        try {
          if (velha(trava)) fs.rmSync(trava, { force: true });
        } finally {
          fs.rmSync(limpeza, { force: true });
        }
        continue;
      }
    }
    esperar(25);
  }
  try {
    const novoGrafo = mudanca(carregar(arquivo));
    const erros = validar(novoGrafo);
    if (erros.length) throw new Error(`grafo inválido: ${erros.join('; ')}`);
    if (ler(trava) !== dono) throw new Error('o grafo perdeu a trava no meio da operação (outro processo a removeu); nada foi gravado, tente de novo');
    salvar(arquivo, novoGrafo);
    return novoGrafo;
  } finally {
    if (ler(trava) === dono) fs.rmSync(trava, { force: true });
  }
}

function pegar(g, id) {
  const t = g.tarefas[id];
  if (!t) throw new Error(`tarefa ${id} não existe`);
  return t;
}

function adicionar(g, dados, agora = new Date().toISOString()) {
  const id = dados.id;
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('a tarefa precisa de id (letras, números, ponto, hífen)');
  if (g.tarefas[id]) throw new Error(`tarefa ${id} já existe`);
  if (!dados.titulo) throw new Error(`tarefa ${id} precisa de título`);
  if (dados.agente != null && !agentes.includes(dados.agente)) throw new Error(`agente inválido: ${dados.agente} (use ${agentes.join(', ')})`);
  const depende = dados.depende || [];
  if (depende.includes(id)) throw new Error(`ciclo: ${id} depende de si mesma`);
  for (const d of depende) if (!g.tarefas[d]) throw new Error(`dependência ${d} não existe`);
  const novoGrafo = copia(g);
  novoGrafo.tarefas[id] = {
    id, titulo: dados.titulo, estado: 'pendente', depende, agente: dados.agente ?? null,
    escopo: dados.escopo || [], verificar: dados.verificar ?? null, tentativas: 0, atualizado: agora, resultado: null,
  };
  return novoGrafo;
}

const feita = (g, id) => g.tarefas[id]?.estado === 'feita';

function prontas(g) {
  return lista(g).filter((t) => t.estado === 'pendente' && t.depende.every((d) => feita(g, d)));
}

// Pendentes que nunca vão ficar prontas porque uma dependência (direta ou indireta) falhou de vez.
function travadas(g) {
  const bloqueada = (t, visto = new Set()) => t.depende.some((d) => {
    const dep = g.tarefas[d];
    if (!dep || visto.has(d)) return false;
    visto.add(d);
    return dep.estado === 'falhou' || (dep.estado === 'pendente' && bloqueada(dep, visto));
  });
  return lista(g).filter((t) => t.estado === 'pendente' && bloqueada(t));
}

function mudar(g, id, mudancas, agora) {
  const novoGrafo = copia(g);
  Object.assign(novoGrafo.tarefas[id], mudancas, { atualizado: agora });
  return novoGrafo;
}

function iniciar(g, id, agente, agora = new Date().toISOString()) {
  const t = pegar(g, id);
  if (!agentes.includes(agente)) throw new Error(`agente inválido: ${agente}`);
  if (!prontas(g).some((p) => p.id === id)) throw new Error(`tarefa ${id} não está pronta (estado ${t.estado}, dependências ${t.depende.join(', ') || 'nenhuma'})`);
  return mudar(g, id, { estado: 'em_andamento', agente }, agora);
}

function concluir(g, id, resultado = null, agora = new Date().toISOString()) {
  const t = pegar(g, id);
  if (t.estado !== 'em_andamento') throw new Error(`tarefa ${id} precisa estar em_andamento (está ${t.estado})`);
  return mudar(g, id, { estado: 'feita', resultado }, agora);
}

function falhar(g, id, motivo, agora = new Date().toISOString(), limite = limitePadrao) {
  const t = pegar(g, id);
  if (t.estado !== 'em_andamento') throw new Error(`tarefa ${id} precisa estar em_andamento (está ${t.estado})`);
  const tentativas = t.tentativas + 1;
  return mudar(g, id, { estado: tentativas >= limite ? 'falhou' : 'pendente', tentativas, resultado: motivo ?? null }, agora);
}

function validar(g) {
  const erros = [];
  for (const t of lista(g)) {
    for (const d of t.depende) if (!g.tarefas[d]) erros.push(`${t.id}: dependência ${d} não existe`);
  }
  const estado = {};
  const visita = (id, trilha) => {
    if (estado[id] === 2 || !g.tarefas[id]) return;
    if (estado[id] === 1) { erros.push(`ciclo: ${[...trilha.slice(trilha.indexOf(id)), id].join(' -> ')}`); return; }
    estado[id] = 1;
    for (const d of g.tarefas[id].depende) visita(d, [...trilha, id]);
    estado[id] = 2;
  };
  for (const id of Object.keys(g.tarefas)) visita(id, []);
  const andando = lista(g).filter((t) => t.estado === 'em_andamento');
  for (let i = 0; i < andando.length; i++) {
    for (let j = i + 1; j < andando.length; j++) {
      const a = andando[i].escopo.map(normaliza);
      const comum = andando[j].escopo.map(normaliza).find((p) => a.some((q) => sobrepoe(p, q)));
      if (comum !== undefined) erros.push(`escopo sobreposto (${comum || 'tudo'}): ${andando[i].id} e ${andando[j].id} estão em_andamento ao mesmo tempo`);
    }
  }
  return erros;
}

function resumo(g) {
  const contagem = {};
  for (const t of lista(g)) contagem[t.estado] = (contagem[t.estado] || 0) + 1;
  return contagem;
}

function opcao(args, nome) {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

function principal(args) {
  const arquivo = path.resolve(opcao(args, 'arquivo') || padrao);
  const virgulas = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const [cmd, ...resto] = args;
  const g = carregar(arquivo);
  if (cmd === 'add') {
    const agente = opcao(resto, 'agente');
    const depende = virgulas(opcao(resto, 'depende'));
    const escopo = virgulas(opcao(resto, 'escopo'));
    const verificar = opcao(resto, 'verificar');
    atualizar(arquivo, (x) => adicionar(x, { id: resto[0], titulo: resto.slice(1).join(' '), agente, depende, escopo, verificar }));
  } else if (cmd === 'iniciar' && resto.length === 2) {
    atualizar(arquivo, (x) => iniciar(x, resto[0], resto[1]));
  } else if (cmd === 'concluir' && resto.length >= 1) {
    atualizar(arquivo, (x) => concluir(x, resto[0], resto.slice(1).join(' ') || null));
  } else if (cmd === 'falhar' && resto.length >= 1) {
    atualizar(arquivo, (x) => falhar(x, resto[0], resto.slice(1).join(' ') || null));
  } else if (cmd === 'proximas') {
    for (const t of prontas(g)) console.log(`${t.id}  ${t.titulo}${t.agente ? `  (${t.agente})` : ''}`);
  } else if (cmd === 'status') {
    for (const [e, n] of Object.entries(resumo(g))) console.log(`${e}: ${n}`);
    for (const t of travadas(g)) console.log(`travada: ${t.id}`);
    for (const e of validar(g)) console.log(`erro: ${e}`);
  } else {
    console.error('Uso: node orquestra/grafo.js add <id> <título> [--agente a] [--depende x,y] [--escopo f,g] [--verificar cmd] | iniciar <id> <agente> | concluir <id> [resultado] | falhar <id> [motivo] | proximas | status [--arquivo f]');
    return 1;
  }
  return 0;
}

module.exports = { novo, carregar, salvar, atualizar, adicionar, prontas, travadas, iniciar, concluir, falhar, validar, resumo };

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (erro) {
    console.error(`Erro no grafo: ${erro.message}`);
    process.exitCode = 1;
  }
}

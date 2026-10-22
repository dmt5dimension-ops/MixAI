// Grafo persistente de tarefas: quem depende de quem, em que estado está cada uma e quem a executa.
// Fica em orquestra/grafo.json (versionado no git). O supervisor e a escada leem e gravam o mesmo arquivo.
const fs = require('node:fs');
const path = require('node:path');

const padrao = path.join(__dirname, 'grafo.json');
const agentes = ['claude', 'codex', 'local'];
const limitePadrao = 3;

const novo = () => ({ versao: 1, tarefas: {} });
const copia = (g) => JSON.parse(JSON.stringify(g));
const normaliza = (p) => path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '');
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

function salvar(arquivo, g) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const temp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(g, null, 2) + '\n');
  fs.renameSync(temp, arquivo);
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
      const comum = andando[j].escopo.map(normaliza).find((p) => a.includes(p));
      if (comum) erros.push(`escopo sobreposto em ${comum}: ${andando[i].id} e ${andando[j].id} estão em_andamento ao mesmo tempo`);
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
  const grava = (novoGrafo) => {
    const erros = validar(novoGrafo);
    if (erros.length) throw new Error(`grafo inválido: ${erros.join('; ')}`);
    salvar(arquivo, novoGrafo);
  };
  if (cmd === 'add') {
    const agente = opcao(resto, 'agente');
    const depende = virgulas(opcao(resto, 'depende'));
    const escopo = virgulas(opcao(resto, 'escopo'));
    const verificar = opcao(resto, 'verificar');
    grava(adicionar(g, { id: resto[0], titulo: resto.slice(1).join(' '), agente, depende, escopo, verificar }));
  } else if (cmd === 'iniciar' && resto.length === 2) {
    grava(iniciar(g, resto[0], resto[1]));
  } else if (cmd === 'concluir' && resto.length >= 1) {
    grava(concluir(g, resto[0], resto.slice(1).join(' ') || null));
  } else if (cmd === 'falhar' && resto.length >= 1) {
    grava(falhar(g, resto[0], resto.slice(1).join(' ') || null));
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

module.exports = { novo, carregar, salvar, adicionar, prontas, travadas, iniciar, concluir, falhar, validar, resumo };

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (erro) {
    console.error(`Erro no grafo: ${erro.message}`);
    process.exitCode = 1;
  }
}

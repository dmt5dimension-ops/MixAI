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

function esperar(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// No Windows, trocar de nome, apagar ou abrir um arquivo que outro processo está lendo no mesmo instante falha
// com EPERM/EBUSY/EACCES e passa um instante depois. Repete com espera crescente (10 ms, 20 ms... até 100 ms).
const transitorios = new Set(['EPERM', 'EBUSY', 'EACCES']);
function comRetentativa(fn, tentativas = 40) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (erro) {
      if (!transitorios.has(erro.code) || i >= tentativas) throw erro;
      esperar(Math.min(100, 10 * (i + 1)));
    }
  }
}

function carregar(arquivo = padrao) {
  if (!fs.existsSync(arquivo)) return novo();
  try {
    const g = JSON.parse(comRetentativa(() => fs.readFileSync(arquivo, 'utf8')));
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
  try {
    comRetentativa(() => fs.renameSync(temp, arquivo));
  } catch (erro) {
    fs.rmSync(temp, { force: true });
    throw erro;
  }
}

function processoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (erro) { return erro.code === 'EPERM'; }
}

// Lê, muda e grava o grafo com o arquivo trancado, para o supervisor e a escada não se atropelarem.
//
// A trava são arquivos numerados `<grafo>.lock.<geração>`, criados com 'wx' (só um processo consegue criar
// cada nome) e com `pid:código` dentro. Quem quer a trava olha a MAIOR geração: se ela está "livre" (o dono a
// soltou escrevendo `livre`) ou o dono morreu, cria a geração seguinte; senão espera. NINGUÉM apaga nem
// reescreve a trava de outro: a de dono morto não é removida, é superada por uma geração maior. Por isso não
// existe "conferir que está velha e depois apagar", que era onde uma trava nova de outro dono era derrubada.
// Dono vivo só é superado depois de `vivoMaxMs` (30 min; uma mudança leva milissegundos), por causa do número
// de processo reaproveitado depois de uma queda. Antes de gravar, confere que a trava ainda é sua e que não
// existe geração maior; se não for, não grava. Gerações antigas (mais de 20 atrás) são apagadas.
function atualizar(arquivo, mudanca, { esperaMs = 10000, velhaMs = 60000, vivoMaxMs = 30 * 60000 } = {}) {
  const pasta = path.dirname(arquivo);
  const prefixo = `${path.basename(arquivo)}.lock.`;
  const dono = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(pasta, { recursive: true });
  const nome = (n) => path.join(pasta, `${prefixo}${String(n).padStart(8, '0')}`);
  const geracoes = () => comRetentativa(() => fs.readdirSync(pasta))
    .filter((f) => f.startsWith(prefixo) && /^\d+$/.test(f.slice(prefixo.length)))
    .map((f) => Number(f.slice(prefixo.length))).sort((a, b) => a - b);
  const idade = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return null; } };
  const ler = (f) => { try { return comRetentativa(() => fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const criar = (f) => {
    try { fs.writeFileSync(f, dono, { flag: 'wx' }); return true; } catch (erro) {
      // EEXIST: o nome já existe. EPERM/EBUSY/EACCES: no Windows, arquivo ocupado por outro processo; tenta de novo.
      if (erro.code === 'EEXIST' || transitorios.has(erro.code)) return false;
      throw erro;
    }
  };
  // A geração está solta (livre, ou de dono que não vai mais voltar)?
  const solta = (n) => {
    const texto = ler(nome(n));
    if (texto === null) return true;
    if (texto === 'livre') return true;
    const pid = /^(\d+):/.exec(texto);
    if (pid) return !processoVivo(Number(pid[1])) || (idade(nome(n)) ?? 0) > vivoMaxMs;
    // Vazio (o dono acabou de criar e ainda não escreveu) ou texto estranho: só solta se ficou assim por muito tempo.
    return (idade(nome(n)) ?? 0) > velhaMs;
  };
  const limite = Date.now() + esperaMs;
  let minha = 0;
  for (;;) {
    const todas = geracoes();
    const maior = todas.length ? todas[todas.length - 1] : 0;
    if (maior === 0 || solta(maior)) {
      if (criar(nome(maior + 1))) { minha = maior + 1; break; }
      if (Date.now() > limite) throw new Error(`grafo travado: não consegui criar ${nome(maior + 1)}`);
      esperar(5);
      continue; // outro criou esta geração primeiro (ou o Windows está ocupado): olha de novo
    }
    if (Date.now() > limite) throw new Error(`grafo travado por outro processo (${nome(maior)}); se ninguém está usando, apague esse arquivo`);
    esperar(25);
  }
  try {
    for (const n of geracoes()) if (n < minha - 20) { try { fs.rmSync(nome(n), { force: true }); } catch { /* fica para a próxima */ } }
    const novoGrafo = mudanca(carregar(arquivo));
    const erros = validar(novoGrafo);
    if (erros.length) throw new Error(`grafo inválido: ${erros.join('; ')}`);
    const maisNova = geracoes().some((n) => n > minha);
    if (ler(nome(minha)) !== dono || maisNova) throw new Error('o grafo perdeu a trava no meio da operação (outro processo a superou); nada foi gravado, tente de novo');
    salvar(arquivo, novoGrafo);
    return novoGrafo;
  } finally {
    // Solta escrevendo `livre` na própria geração (só se ainda for sua). Não apaga: o arquivo é o marcador de qual
    // geração veio por último.
    if (ler(nome(minha)) === dono) { try { comRetentativa(() => fs.writeFileSync(nome(minha), 'livre')); } catch { /* o dono morre e a geração fica solta */ } }
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

// Trabalho pronto, esperando revisão (PR aberto): não mexe mais nos arquivos, então não entra na conta de escopo.
function revisar(g, id, resultado = null, agora = new Date().toISOString()) {
  const t = pegar(g, id);
  if (t.estado !== 'em_andamento') throw new Error(`tarefa ${id} precisa estar em_andamento (está ${t.estado})`);
  return mudar(g, id, { estado: 'em_revisao', resultado }, agora);
}

// A revisão pediu mudança: volta a mexer nos arquivos (e a contar no escopo).
function devolver(g, id, motivo = null, agora = new Date().toISOString()) {
  const t = pegar(g, id);
  if (t.estado !== 'em_revisao') throw new Error(`tarefa ${id} precisa estar em_revisao (está ${t.estado})`);
  const em_andamento = lista(g).filter((x) => x.estado === 'em_andamento');
  const conflito = em_andamento.find((x) => t.escopo.map(normaliza).some((p) => x.escopo.map(normaliza).some((q) => sobrepoe(p, q))));
  if (conflito) throw new Error(`tarefa ${id} não pode voltar a em_andamento: o escopo dela se sobrepõe ao de ${conflito.id}, que está em_andamento`);
  return mudar(g, id, { estado: 'em_andamento', resultado: motivo }, agora);
}

function concluir(g, id, resultado = null, agora = new Date().toISOString()) {
  const t = pegar(g, id);
  if (t.estado !== 'em_andamento' && t.estado !== 'em_revisao') throw new Error(`tarefa ${id} precisa estar em_andamento ou em_revisao (está ${t.estado})`);
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
  } else if (cmd === 'revisar' && resto.length >= 1) {
    atualizar(arquivo, (x) => revisar(x, resto[0], resto.slice(1).join(' ') || null));
  } else if (cmd === 'devolver' && resto.length >= 1) {
    atualizar(arquivo, (x) => devolver(x, resto[0], resto.slice(1).join(' ') || null));
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
    console.error('Uso: node orquestra/grafo.js add <id> <título> [--agente a] [--depende x,y] [--escopo f,g] [--verificar cmd] | iniciar <id> <agente> | revisar <id> [resultado] | devolver <id> [motivo] | concluir <id> [resultado] | falhar <id> [motivo] | proximas | status [--arquivo f]');
    return 1;
  }
  return 0;
}

module.exports = { novo, carregar, salvar, atualizar, comRetentativa, adicionar, prontas, travadas, iniciar, revisar, devolver, concluir, falhar, validar, resumo };

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (erro) {
    console.error(`Erro no grafo: ${erro.message}`);
    process.exitCode = 1;
  }
}

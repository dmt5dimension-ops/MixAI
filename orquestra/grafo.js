// Grafo persistente de tarefas: quem depende de quem, em que estado está cada uma e quem a executa.
// Fica em orquestra/grafo.json (versionado no git). Quem o usa hoje é o planejador (e o Codex), pela linha de comando; o vigia e a escada ainda não o chamam.
const fs = require('node:fs');
const path = require('node:path');

// Por padrão o grafo fica no repositório (cada worktree tem o seu). Para várias worktrees dividirem o mesmo grafo e a
// mesma trava, aponte MIXAI_GRAFO para um arquivo fora delas (as travas ficam ao lado dele) ou use --arquivo.
const padrao = process.env.MIXAI_GRAFO ? path.resolve(process.env.MIXAI_GRAFO) : path.join(__dirname, 'grafo.json');
const agentes = ['claude', 'codex', 'local'];
const limitePadrao = 3;

const novo = () => ({ versao: 1, tarefas: {} });
const copia = (g) => JSON.parse(JSON.stringify(g));
// Caminho comparável: barras normais, sem ./ nem barra final, minúsculas (o Windows não diferencia), curinga vira a pasta
// antes dele e caminho absoluto DENTRO do repositório vira relativo a ele (src/a.js e D:\MixAI\src\a.js são o mesmo arquivo).
const RAIZ_DO_REPO = path.resolve(__dirname, '..');
const barras = (p) => path.posix.normalize(String(p).replace(/\\/g, '/')).toLowerCase();
const normaliza = (p, raiz = RAIZ_DO_REPO) => {
  let c = barras(p).replace(/^\.\//, '').replace(/\/+$/, '');
  const r = barras(raiz).replace(/\/+$/, '');
  if (/^(?:[a-z]:)?\//.test(c)) { if (c === r) c = ''; else if (c.startsWith(`${r}/`)) c = c.slice(r.length + 1); }
  const i = c.search(/[*?[]/);
  if (i >= 0) c = c.slice(0, i).replace(/\/?[^/]*$/, '');
  return c === '.' ? '' : c;
};
const sobrepoe = (a, b) => a === b || a === '' || b === '' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const lista = (g) => Object.values(g.tarefas);
// Só propriedades próprias: `constructor`, `toString` etc. herdados do Object não são tarefas.
const tem = (g, id) => Object.hasOwn(g.tarefas, id);

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

const estadosValidos = ['pendente', 'em_andamento', 'em_revisao', 'feita', 'falhou'];
const listaDeTextos = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
// Forma de cada tarefa: o que `prontas`, `travadas` e `validar` assumem. Devolve o primeiro problema, ou null.
function formaInvalida(g) {
  for (const [chave, t] of Object.entries(g.tarefas)) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return `tarefa ${chave} não é um objeto`;
    if (t.id !== chave) return `tarefa ${chave} tem id ${JSON.stringify(t.id)}`;
    if (typeof t.titulo !== 'string' || !t.titulo) return `tarefa ${chave} sem título`;
    if (!estadosValidos.includes(t.estado)) return `tarefa ${chave} com estado inválido ${JSON.stringify(t.estado)}`;
    if (!listaDeTextos(t.depende)) return `tarefa ${chave}: depende precisa ser uma lista de ids`;
    if (!listaDeTextos(t.escopo)) return `tarefa ${chave}: escopo precisa ser uma lista de caminhos`;
    if (t.agente != null && !agentes.includes(t.agente)) return `tarefa ${chave} com agente inválido ${JSON.stringify(t.agente)}`;
    if (!Number.isInteger(t.tentativas) || t.tentativas < 0) return `tarefa ${chave}: tentativas inválidas`;
  }
  return null;
}

function carregar(arquivo = padrao) {
  // Só "não existe" (ENOENT) começa um grafo novo. Qualquer outra falha de leitura (acesso negado, pasta no lugar do
  // arquivo...) não pode virar "grafo vazio": quem chama `atualizar` gravaria um grafo novo por cima do verdadeiro.
  let texto;
  try { texto = comRetentativa(() => fs.readFileSync(arquivo, 'utf8')); } catch (erro) {
    if (erro.code === 'ENOENT') return novo();
    throw new Error(`não consegui ler o grafo em ${arquivo} (${erro.code || erro.message}); o arquivo não foi alterado`);
  }
  try {
    const g = JSON.parse(texto);
    if (g?.versao !== 1 || typeof g.tarefas !== 'object' || g.tarefas === null || Array.isArray(g.tarefas)) throw new Error('formato');
    const problema = formaInvalida(g);
    if (problema) throw new Error(problema);
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
// A trava de um dono vivo NUNCA é tomada, por mais velha que seja (tomar seria deixar dois processos gravando);
// se o número do processo foi reaproveitado depois de uma queda, a mensagem de erro diz qual arquivo apagar à
// mão. Se a trava não puder ser lida (erro que não seja "não existe"), conta como ocupada. Antes de gravar, confere que a trava ainda é sua e que não
// existe geração maior; se não for, não grava. Gerações antigas (mais de 20 atrás) são apagadas.
function atualizar(arquivo, mudanca, { esperaMs = 10000, velhaMs = 60000 } = {}) {
  const pasta = path.dirname(arquivo);
  const prefixo = `${path.basename(arquivo)}.lock.`;
  const dono = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(pasta, { recursive: true });
  const nome = (n) => path.join(pasta, `${prefixo}${String(n).padStart(8, '0')}`);
  const geracoes = () => comRetentativa(() => fs.readdirSync(pasta))
    .filter((f) => f.startsWith(prefixo) && /^\d+$/.test(f.slice(prefixo.length)))
    .map((f) => Number(f.slice(prefixo.length))).sort((a, b) => a - b);
  const idade = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return null; } };
  // null = o arquivo não existe; qualquer outro erro de leitura propaga e quem chama trata como trava ocupada.
  const ler = (f) => { try { return comRetentativa(() => fs.readFileSync(f, 'utf8')); } catch (erro) { if (erro.code === 'ENOENT') return null; throw erro; } };
  const lerOuErro = (f) => { try { return { texto: ler(f) }; } catch (erro) { return { erro }; } };
  const criar = (f) => {
    try { fs.writeFileSync(f, dono, { flag: 'wx' }); return true; } catch (erro) {
      // EEXIST: o nome já existe. EPERM/EBUSY/EACCES: no Windows, arquivo ocupado por outro processo; tenta de novo.
      if (erro.code === 'EEXIST' || transitorios.has(erro.code)) return false;
      throw erro;
    }
  };
  // A geração está solta (livre, ou de dono que não vai mais voltar)?
  const solta = (n) => {
    const { texto, erro } = lerOuErro(nome(n));
    if (erro) return false;
    if (texto === null) return true;
    if (texto === 'livre') return true;
    const pid = /^(\d+):/.exec(texto);
    if (pid) return !processoVivo(Number(pid[1]));
    // Vazio (o dono acabou de criar e ainda não escreveu) ou texto estranho: só solta se ficou assim por muito tempo.
    return (idade(nome(n)) ?? 0) > velhaMs;
  };
  const limite = Date.now() + esperaMs;
  let minha = 0;
  for (;;) {
    const todas = geracoes();
    const maior = todas.length ? todas[todas.length - 1] : 0;
    if (maior === 0 || solta(maior)) {
      if (criar(nome(maior + 1))) {
        // A lista pode ter ficado velha (a limpeza de outro processo apagou gerações no meio): se já existe uma geração
        // maior, a minha nasceu atrasada. Solta e olha de novo, em vez de falhar só no fim da operação.
        if (!geracoes().some((n) => n > maior + 1)) { minha = maior + 1; break; }
        try { comRetentativa(() => fs.writeFileSync(nome(maior + 1), 'livre')); } catch { /* fica com o dono; vira solta se ele morrer */ }
        continue;
      }
      if (Date.now() > limite) throw new Error(`grafo travado: não consegui criar ${nome(maior + 1)}`);
      esperar(5);
      continue; // outro criou esta geração primeiro (ou o Windows está ocupado): olha de novo
    }
    if (Date.now() > limite) throw new Error(`grafo travado por outro processo (${nome(maior)}); se ninguém está usando (por exemplo, o computador caiu), apague esse arquivo`);
    esperar(25);
  }
  let falhou = false;
  try {
    for (const n of geracoes()) if (n < minha - 20) { try { fs.rmSync(nome(n), { force: true }); } catch { /* fica para a próxima */ } }
    const novoGrafo = mudanca(carregar(arquivo));
    const bruto = !novoGrafo || novoGrafo.versao !== 1 || typeof novoGrafo.tarefas !== 'object' || novoGrafo.tarefas === null || Array.isArray(novoGrafo.tarefas);
    const forma = bruto ? 'formato do grafo' : formaInvalida(novoGrafo);
    if (forma) throw new Error(`grafo inválido: ${forma}; nada foi gravado`);
    const erros = validar(novoGrafo);
    if (erros.length) throw new Error(`grafo inválido: ${erros.join('; ')}`);
    const maisNova = geracoes().some((n) => n > minha);
    if (lerOuErro(nome(minha)).texto !== dono || maisNova) throw new Error('o grafo perdeu a trava no meio da operação (outro processo a superou); nada foi gravado, tente de novo');
    salvar(arquivo, novoGrafo);
    return novoGrafo;
  } catch (erro) {
    falhou = true;
    throw erro;
  } finally {
    // Solta escrevendo `livre` na própria geração (só se ainda for sua). NUNCA apaga a própria geração: apagar faria a
    // maior geração voltar a ser uma antiga e solta, e dois processos poderiam passar juntos pela checagem "não há
    // geração maior" e gravar ao mesmo tempo (uma atualização perdida). Se `livre` não puder ser escrito, a trava fica
    // presa enquanto este processo viver (depois vira solta, porque o dono morreu): avisa em vez de ignorar.
    // Se nem LER a própria geração der certo (erro de disco), não dá para conferir o dono, mas o nome só foi criado por
    // este processo (`wx`) e ninguém reescreve a geração de outro: tenta soltar do mesmo jeito e avisa se não conseguir.
    const atual = lerOuErro(nome(minha));
    if (atual.erro || atual.texto === dono) {
      let solta = false;
      try { comRetentativa(() => fs.writeFileSync(nome(minha), 'livre')); solta = true; } catch { /* abaixo */ }
      if (!solta) {
        const aviso = `não consegui soltar a trava ${nome(minha)}${falhou ? '' : ' (o grafo foi gravado)'}; apague esse arquivo se ninguém estiver usando o grafo`;
        if (falhou) console.error(aviso); else throw new Error(aviso);
      }
    }
  }
}

function pegar(g, id) {
  const t = tem(g, id) ? g.tarefas[id] : null;
  if (!t) throw new Error(`tarefa ${id} não existe`);
  return t;
}

function adicionar(g, dados, agora = new Date().toISOString()) {
  const id = dados.id;
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('a tarefa precisa de id (letras, números, ponto, hífen)');
  if (id === '__proto__') throw new Error('id inválido: __proto__');
  if (tem(g, id)) throw new Error(`tarefa ${id} já existe`);
  if (!dados.titulo) throw new Error(`tarefa ${id} precisa de título`);
  if (dados.agente != null && !agentes.includes(dados.agente)) throw new Error(`agente inválido: ${dados.agente} (use ${agentes.join(', ')})`);
  if (!Array.isArray(dados.escopo) || !dados.escopo.length || dados.escopo.some((e) => typeof e !== 'string' || !e.trim())) throw new Error(`tarefa ${id} precisa de escopo (lista de arquivos ou pastas que ela pode mudar)`);
  if (dados.depende != null && !listaDeTextos(dados.depende)) throw new Error(`tarefa ${id}: depende precisa ser uma lista de ids`);
  const depende = dados.depende || [];
  if (depende.includes(id)) throw new Error(`ciclo: ${id} depende de si mesma`);
  for (const d of depende) if (!tem(g, d)) throw new Error(`dependência ${d} não existe`);
  const novoGrafo = copia(g);
  novoGrafo.tarefas[id] = {
    id, titulo: dados.titulo, estado: 'pendente', depende, agente: dados.agente ?? null,
    escopo: dados.escopo, verificar: dados.verificar ?? null, tentativas: 0, atualizado: agora, resultado: null,
  };
  return novoGrafo;
}

const feita = (g, id) => tem(g, id) && g.tarefas[id].estado === 'feita';

function prontas(g) {
  return lista(g).filter((t) => t.estado === 'pendente' && t.depende.every((d) => feita(g, d)));
}

// Pendentes que nunca vão ficar prontas porque uma dependência (direta ou indireta) falhou de vez.
function travadas(g) {
  const bloqueada = (t, visto = new Set()) => t.depende.some((d) => {
    const dep = tem(g, d) ? g.tarefas[d] : null;
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
  const conflito = em_andamento.find((x) => t.escopo.map((p) => normaliza(p)).some((p) => x.escopo.map((p) => normaliza(p)).some((q) => sobrepoe(p, q))));
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
    for (const d of t.depende) if (!tem(g, d)) erros.push(`${t.id}: dependência ${d} não existe`);
    // Trabalho ativo (em_andamento ou em_revisao) só existe com as dependências `feita`.
    // O escopo de quem está ativo não pode ser vazio.
    if (t.estado === 'em_andamento' || t.estado === 'em_revisao') {
      for (const d of t.depende) if (tem(g, d) && g.tarefas[d].estado !== 'feita') erros.push(`${t.id} está ${t.estado} mas a dependência ${d} está ${g.tarefas[d].estado}`);
      if (!t.escopo.length) erros.push(`${t.id} está ${t.estado} sem escopo`);
    }
  }
  const estado = {};
  const visita = (id, trilha) => {
    if (estado[id] === 2 || !tem(g, id)) return;
    if (estado[id] === 1) { erros.push(`ciclo: ${[...trilha.slice(trilha.indexOf(id)), id].join(' -> ')}`); return; }
    estado[id] = 1;
    for (const d of g.tarefas[id].depende) visita(d, [...trilha, id]);
    estado[id] = 2;
  };
  for (const id of Object.keys(g.tarefas)) visita(id, []);
  const andando = lista(g).filter((t) => t.estado === 'em_andamento');
  for (let i = 0; i < andando.length; i++) {
    for (let j = i + 1; j < andando.length; j++) {
      const a = andando[i].escopo.map((p) => normaliza(p));
      const comum = andando[j].escopo.map((p) => normaliza(p)).find((p) => a.some((q) => sobrepoe(p, q)));
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

// Tira `--nome valor` da lista. Sem valor (fim da lista ou outra opção logo depois) é erro, não silêncio.
function opcao(args, nome) {
  const i = args.indexOf(`--${nome}`);
  if (i < 0) return undefined;
  const valor = args[i + 1];
  if (valor === undefined || valor.startsWith('--')) throw new Error(`a opção --${nome} precisa de um valor`);
  return args.splice(i, 2)[1];
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
    const erros = validar(g);
    for (const e of erros) console.log(`erro: ${e}`);
    if (erros.length) return 1;
  } else {
    console.error('Uso: node orquestra/grafo.js add <id> <título> [--agente a] [--depende x,y] [--escopo f,g] [--verificar cmd] | iniciar <id> <agente> | revisar <id> [resultado] | devolver <id> [motivo] | concluir <id> [resultado] | falhar <id> [motivo] | proximas | status [--arquivo f]');
    return 1;
  }
  return 0;
}

module.exports = { normaliza, novo, carregar, salvar, atualizar, comRetentativa, adicionar, prontas, travadas, iniciar, revisar, devolver, concluir, falhar, validar, resumo };

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (erro) {
    console.error(`Erro no grafo: ${erro.message}`);
    process.exitCode = 1;
  }
}

// Escada do modelo local: tarefa bem delimitada vai primeiro ao mixai-local.
// Se errar, sobe para Codex ou Claude; a solução vira regra com exemplo; o local tenta de novo com a regra.
// Se acertar, a regra fica salva para as próximas vezes. Todo caso resolvido é registrado para treino futuro (LoRA).
// Quem decide se a tarefa "cabe no local" é o Claude (o 7B erra ao julgar tamanho de tarefa).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { regrasDoModelo, MODELO_PADRAO } = require('./por-modelo.js');

const pasta = __dirname;
const ARQUIVOS = {
  regras: path.join(pasta, 'regras-locais.json'),
  casos: path.join(pasta, 'casos', 'casos.jsonl'),
  treino: path.join(pasta, 'casos', 'treino.jsonl'),
  falhas: path.join(pasta, 'falhas', 'falhas.jsonl'),
  pendentes: path.join(pasta, 'falhas', 'pendentes.jsonl'),
};

function lerRegras(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  try {
    const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    return Array.isArray(dados.regras) ? dados.regras : [];
  } catch (erro) {
    if (erro instanceof SyntaxError) throw new Error(`${arquivo} está com JSON inválido; conserte antes de continuar (nada foi apagado).`);
    throw erro;
  }
}

function salvarRegra(arquivo, regra) {
  const regras = lerRegras(arquivo);
  const ids = new Set(regras.map((r) => r.id));
  let id = regra.id;
  for (let n = 2; ids.has(id); n += 1) id = `${regra.id}-${n}`; // nunca sobrescreve regra existente
  regras.push({ ...regra, id });
  regra.id = id;
  let aviso;
  try {
    aviso = JSON.parse(fs.readFileSync(arquivo, 'utf8')).aviso;
  } catch (erro) {
    aviso = undefined;
  }
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify({ aviso, regras }, null, 2) + '\n');
}

// Sem `modelo` o aluno é o Qwen padrão (mixai-local), como em todos os registros antigos: regra ensinada só a outro aluno
// (`modelos: [...]` sem o mixai-local) nunca entra no prompt dele. Regra sem o campo `modelos` continua valendo para todos.
function regrasParaModelo(regras, modelo = MODELO_PADRAO) {
  return regrasDoModelo(regras, modelo);
}

// O nome do modelo é normalizado UMA vez (sem espaço nas pontas) antes de filtrar regra, gravar caso e salvar `modelos`,
// senão a regra aprendida para " qwen-x " nunca seria achada por "qwen-x".
function normalizarModelo(modelo) {
  if (modelo === undefined) return undefined;
  if (typeof modelo !== 'string' || !modelo.trim()) throw new Error('modelo sem nome');
  return modelo.trim();
}

// Degraus novos, ambos opt-in (sem as opções a escada é a de sempre):
// - `estatico`: lista de regras estáticas confirmadas (orquestra/estatico.js). Antes de qualquer LLM, o aluno estático tenta; só vale se o
//   VERIFICADOR aprovar a saída dele. Regra que casa e erra não vale nada: a tarefa segue para o Qwen como se ele não existisse.
// - `liberacao: { tipo, arquivo? }`: o Qwen só trabalha de verdade se o tipo estiver liberado para o modelo na tabela da sombra
//   (orquestra/sombra.js). Tipo não liberado, ou tabela ausente/ilegível, pula o Qwen e a tarefa sobe direto (a sombra continua medindo).
async function tentarEstatico(estatico, entrada, verificar) {
  if (!Array.isArray(estatico) || !estatico.length) return null;
  const r = require('./estatico.js').resolver(estatico, entrada);
  if (!r || typeof r.saida !== 'string' || !r.saida.trim()) return null;
  try { if ((await verificar(r.saida)).ok === true) return r; } catch { /* verificador falhou: não vale */ }
  return null;
}

function localLiberado(liberacao, modelo = MODELO_PADRAO) {
  if (!liberacao) return true;
  const { tipo, arquivo } = liberacao;
  if (typeof tipo !== 'string' || !tipo.trim()) return false;
  return arquivo ? require('./sombra.js').tipoLiberado(tipo, modelo, arquivo) : require('./sombra.js').tipoLiberado(tipo, modelo);
}

function escolherRegras(regras, entrada) {
  const texto = String(entrada).toLowerCase();
  return regras.filter((r) => r.status === 'confirmada' &&
    (r.palavras || []).some((p) => texto.includes(String(p).toLowerCase())));
}

function montarPrompt(entrada, regras) {
  const partes = [];
  if (regras.length) {
    partes.push('Siga estas regras da casa:');
    for (const r of regras) {
      partes.push(`- ${r.regra}\n  Exemplo: entrada "${r.exemplo.entrada}" -> saída "${r.exemplo.saida}"`);
    }
    partes.push('');
  }
  partes.push('Tarefa:', entrada, '', 'Responda só com o resultado, sem explicação.');
  return partes.join('\n');
}

function promptRegra(entrada, saidaErrada, saidaCerta) {
  return [
    'Um modelo pequeno errou esta tarefa. Escreva a REGRA curta (uma ou duas frases) que o faria acertar esta e tarefas parecidas.',
    `Tarefa: ${entrada}`,
    `Saída errada do modelo pequeno: ${saidaErrada}`,
    `Saída certa: ${saidaCerta}`,
    'Responda só com JSON: {"id":"nome-curto-com-hifens","palavras":["palavras que aparecem em tarefas desse tipo"],"regra":"...","exemplo":{"entrada":"...","saida":"..."}}',
  ].join('\n');
}

function lerRegraGerada(texto) {
  const m = String(texto).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]);
    if (!r.id || !r.regra || !Array.isArray(r.palavras) || r.palavras.length === 0 ||
        !r.exemplo || typeof r.exemplo.entrada !== 'string' || typeof r.exemplo.saida !== 'string') return null;
    return { id: String(r.id), palavras: r.palavras.map(String), regra: String(r.regra), exemplo: r.exemplo };
  } catch (erro) {
    if (erro instanceof SyntaxError) return null;
    throw erro;
  }
}

function registrarCaso(arquivo, caso) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.appendFileSync(arquivo, JSON.stringify(caso) + '\n');
}

function lerCasos(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// Par entrada/saída certa, sem a regra: o treino quer que o modelo aprenda a regra, não a leia.
function paraTreino(caso) {
  return { messages: [{ role: 'user', content: caso.entrada }, { role: 'assistant', content: caso.saida }] };
}

async function tentar(chamar, prompt) {
  try {
    const saida = await chamar(prompt);
    return typeof saida === 'string' ? saida.trim() : null;
  } catch (erro) {
    return null; // sem cota ou falha: o chamador tenta o próximo
  }
}

// O grande resolveu depois de o local errar: pede a regra, deixa o local tentar de novo com ela e só salva se ele acertar.
async function aprenderRegra({ entrada, saidaLocal, saida, nome, chamarSuperior, usadas, ok, agentes, arquivos, data, modelo }) {
  const candidata = lerRegraGerada(await tentar(chamarSuperior, promptRegra(entrada, saidaLocal, saida)));
  if (!candidata) return { regra: null, regraSalva: null };
  const segunda = await tentar(agentes.local, montarPrompt(entrada, [...usadas, { ...candidata, status: 'confirmada' }]));
  const funcionou = segunda !== null && (await ok(segunda));
  const regra = { ...candidata, status: funcionou ? 'confirmada' : 'descartada' };
  if (!funcionou) return { regra, regraSalva: null };
  const nova = { ...regra, criadaEm: data, origem: nome, ...(modelo ? { modelos: [modelo] } : {}) };
  salvarRegra(arquivos.regras, nova);
  return { regra: nova, regraSalva: nova.id };
}

async function resolver({ entrada, cabeNoLocal, verificar, agentes, arquivos = ARQUIVOS, modelo: modeloBruto, estatico, entradaEstatica, liberacao }) {
  const modelo = normalizarModelo(modeloBruto);
  if (typeof verificar !== 'function') throw new Error('Sem verificador não há como saber se a resposta está certa.');
  const ok = async (saida) => (await verificar(saida)).ok === true;
  const usadas = escolherRegras(regrasParaModelo(lerRegras(arquivos.regras), modelo), entrada);
  const ids = usadas.map((r) => r.id);
  const base = { entrada, data: new Date().toISOString(), ...(modelo ? { modelo } : {}) };
  let saidaLocal = null;

  const doEstatico = Array.isArray(estatico) && estatico.length ? await tentarEstatico(estatico, entradaEstatica ?? entrada, verificar) : null; // sem estático não ganha nem um turno a mais
  if (doEstatico) {
    registrarCaso(arquivos.casos, { ...base, regra: null, regrasUsadas: [], regraEstatica: doEstatico.regra, saida: doEstatico.saida, resolvidoPor: 'estatico' });
    return { ok: true, resolvidoPor: 'estatico', saida: doEstatico.saida, regrasUsadas: [], regraSalva: null };
  }
  if (cabeNoLocal && !localLiberado(liberacao, modelo)) cabeNoLocal = false; // tipo ainda não liberado: o Qwen não trabalha de verdade

  if (cabeNoLocal) {
    saidaLocal = await tentar(agentes.local, montarPrompt(entrada, usadas));
    if (saidaLocal !== null && (await ok(saidaLocal))) {
      registrarCaso(arquivos.casos, { ...base, regra: usadas[0] || null, regrasUsadas: ids, saida: saidaLocal, resolvidoPor: 'local' });
      return { ok: true, resolvidoPor: 'local', saida: saidaLocal, regrasUsadas: ids, regraSalva: null };
    }
  }

  let nome = null;
  let chamarSuperior = null;
  let saida = null;
  for (const s of agentes.superiores) {
    const tentativa = await tentar(s.chamar, montarPrompt(entrada, []));
    if (tentativa !== null && (await ok(tentativa))) {
      nome = s.nome;
      chamarSuperior = s.chamar;
      saida = tentativa;
      break;
    }
  }
  if (!nome) return { ok: false, resolvidoPor: null, saida: null, regrasUsadas: ids, regraSalva: null };

  let regra = null;
  let regraSalva = null;
  if (cabeNoLocal && saidaLocal !== null) {
    ({ regra, regraSalva } = await aprenderRegra({ entrada, saidaLocal, saida, nome, chamarSuperior, usadas, ok, agentes, arquivos, data: base.data, modelo }));
  }

  registrarCaso(arquivos.casos, { ...base, regra, regrasUsadas: ids, saida, resolvidoPor: nome });
  return { ok: true, resolvidoPor: nome, saida, regrasUsadas: ids, regraSalva };
}

// --- Matar o comando e tudo que ele criou -----------------------------------------------------------------------
// Windows: o comando roda dentro de um Job Object (`orquestra/job-windows.ps1`). O wrapper entra no job ANTES de
// iniciar o comando, então nenhum descendente nasce fora dele; o job tem KILL_ON_JOB_CLOSE e não permite escapar
// (sem BREAKAWAY): quando o wrapper morre, o Windows mata o grupo inteiro. Matar é só matar o wrapper pela alça que o
// próprio Node guarda, sem ler PID de ninguém (não existe PID reaproveitado, nem corrida entre ler e matar).
// O orquestrador com paralelismo só roda no Windows: fora dele `chamarComando` recusa e não executa nada.
const WRAPPER_JOB = path.join(__dirname, 'job-windows.ps1');
const CONFIRMAR_JOB = path.join(__dirname, 'job-confirmar-windows.ps1');
const argsDoWrapper = () => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER_JOB];

// Pede a morte de toda a árvore. Devolve true se o pedido foi aceito; quem confirma a morte é a conferência depois do
// 'close' (`orfaosVivos`).
function matarArvore(filho) {
  try { return filho.kill('SIGKILL') || filho.exitCode != null || filho.signalCode != null; } catch { return false; }
}

// Windows: pergunta ao próprio Job Object (por nome) se ainda há processo dentro, encerra o job e só dá por limpo quando
// ele não existe mais ou está vazio. Devolve [] (limpo), uma lista de tamanho = processos que sobraram, ou null
// (inconclusivo: o PowerShell falhou ou deu uma resposta que não é nenhuma das três). `executar` existe para os testes.
function confirmarJob(nome, executar = execFile) {
  return new Promise((resolve) => {
    try {
      executar('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CONFIRMAR_JOB, '-Nome', nome], { encoding: 'utf8', timeout: 20000, windowsHide: true }, (erro, stdout) => {
        if (erro) return resolve(null);
        const resposta = String(stdout).trim().split(/\r?\n/).pop();
        if (resposta === 'FECHADO' || resposta === 'VAZIO') return resolve([]);
        const m = /^VIVOS (\d+)$/.exec(resposta);
        resolve(m ? Array.from({ length: Number(m[1]) }, (_, i) => -(i + 1)) : null);
      });
    } catch { resolve(null); }
  });
}

// Depois que o shell fechou: sobrou algum descendente vivo (sem pipe, que o 'close' não enxerga)? Mata e confere.
// Devolve (uma promessa de) a lista dos que continuam vivos (vazia = limpo) ou null se não deu para conferir.
// Consulta o Job Object (por nome). Sem nome de job a conferência é inconclusiva (null).
async function orfaosVivos(filho, { executar = execFile } = {}) {
  return filho.jobNome ? confirmarJob(filho.jobNome, executar) : null;
}
const processoVivoNoSistema = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const PASTA_DE_PROMPTS = path.join(os.tmpdir(), 'mixai-prompts');
// Windows: pasta NOVA com nome aleatório, sem herdar permissões (icacls /inheritance:r) e só com o usuário atual
// ((OI)(CI)F), e a ACL é lida de volta: se aparecer qualquer outro grupo ou usuário, ou se o icacls falhar, recusa.
// `executar`, `usuario` e `dominio` existem para os testes.
function criarPastaPrivadaWindows(base = os.tmpdir(), { executar = execFileSync, usuario = process.env.USERNAME, dominio = process.env.USERDOMAIN } = {}) {
  if (!usuario) throw new Error('não sei o nome do usuário do Windows (USERNAME): não dá para criar a pasta privada dos prompts');
  const pasta = fs.mkdtempSync(path.join(base, 'mixai-prompts-'));
  try {
    executar('icacls', [pasta, '/inheritance:r', '/grant:r', `${usuario}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
    const saida = String(executar('icacls', [pasta], { encoding: 'utf8', windowsHide: true })).split(pasta).join(''); // tira o caminho (pode ter espaços)
    // Cada entrada é "<principal>:(permissões)"; só o usuário atual pode aparecer (com ou sem o domínio na frente).
    const permitidos = new Set([usuario.toLowerCase(), `${dominio ?? ''}\\${usuario}`.toLowerCase()]);
    const entradas = [...saida.matchAll(/^\s*(\S.*?):\(/gm)].map((m) => m[1].trim().toLowerCase());
    const alheias = entradas.filter((e) => !permitidos.has(e));
    if (!entradas.length || alheias.length) throw new Error(`a ACL da pasta dos prompts não é só do usuário (${alheias.join(', ') || 'não consegui ler a ACL'})`);
  } catch (e) {
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* sem o que apagar */ }
    throw new Error(`não consegui tornar privada a pasta dos prompts temporários: ${e.message}`);
  }
  return pasta;
}
let pastaPromptsDoProcesso = null;
// Uma pasta por processo no Windows (criada uma vez, apagada na saída); nos outros sistemas a pasta fixa precisa ser do dono.
function pastaDePromptsPadrao() {
  if (process.platform !== 'win32') return PASTA_DE_PROMPTS;
  if (!pastaPromptsDoProcesso) {
    pastaPromptsDoProcesso = criarPastaPrivadaWindows();
    process.once('exit', () => { try { fs.rmSync(pastaPromptsDoProcesso, { recursive: true, force: true }); } catch { /* fica para o sistema limpar */ } });
  }
  return pastaPromptsDoProcesso;
}
// Confere que a pasta é privada: no Windows ela já nasce com ACL só do usuário (acima); nos outros sistemas confere o dono e
// que grupo/outros não têm acesso.
function garantirPastaPrivada(pasta) {
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const st = fs.lstatSync(pasta);
  const eu = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!st.isDirectory() || st.isSymbolicLink() || (eu !== null && st.uid !== eu) || (st.mode & 0o077) !== 0) {
    throw new Error(`a pasta dos prompts temporários (${pasta}) não é privada (precisa ser uma pasta do dono, sem acesso para outros): apague-a e rode de novo`);
  }
}

// Processos de comando ainda sem a morte confirmada, por sinal de aborto (o sinal é da microtarefa): quando o lote desiste de
// esperar uma chamada pendente, ele sabe quais Jobs/PIDs reter. Saem daqui quando a chamada termina com a morte confirmada.
const ativosPorSinal = new WeakMap();
// Quem quiser saber quando um comando vai ganhar Job (fase 'antes', com o nome do Job já escolhido e ANTES de o processo nascer) e
// quando nasceu (fase 'depois', com o PID do wrapper). O lote grava a reserva nas duas fases; um ouvinte que lança impede o
// agente de rodar (fail-closed).
const ouvintesDeJob = new Set();
const aoNovoJob = (fn) => { ouvintesDeJob.add(fn); return () => ouvintesDeJob.delete(fn); };
const avisarJob = (evento) => { for (const ouvir of ouvintesDeJob) ouvir(evento); };
const ativosDoSinal = (signal) => (signal && ativosPorSinal.get(signal) ? [...ativosPorSinal.get(signal)].map((a) => ({ ...a })) : []);

function chamarComando(comando, { matar = matarArvore, orfaos = orfaosVivos, lancar = null, plataforma = process.platform, reintentoMs = 2000, tentativasDeMatar = 5, tempoMaximoMs = TEMPO_MAXIMO_MS, prazoDeFechamentoMs = 15000, maxSaidaBytes = 16 * 1024 * 1024, pastaPrompts = null } = {}) {
  // `signal` (opcional): ao ser abortado, mata o comando e tudo que ele criou. Usado pelo lote para reduzir agentes
  // locais quando o dono volta a usar o PC. A parada repete o pedido a cada `reintentoMs` até a chamada terminar:
  // pedido recusado `tentativasDeMatar` vezes, ou aceito mas sem o fim da chamada em `prazoDeFechamentoMs`, termina com
  // erro `naoConfirmado` (o processo pode continuar vivo e quem chamou, o lote, deve parar). Depois do 'close' a árvore
  // é conferida (`orfaos`); descendente vivo que não morre ou conferência impossível também é `naoConfirmado`.
  return (prompt, signal) => new Promise((resolve, reject) => {
    if (!lancar && plataforma !== 'win32') return reject(new Error('plataforma sem contenção garantida: o orquestrador com paralelismo só roda no Windows (Job Object); nada foi executado'));
    // Já abortado: nem arquivo nem processo são criados (nada pode rodar nem escrever).
    if (signal?.aborted) return reject(Object.assign(new Error('chamada abortada'), { abortada: true }));
    // O prompt vai por ARQUIVO como stdin (nada de pipe de entrada): no Windows, com shell, um pipe de entrada aberto
    // mantém o Node vivo até o filho morrer, mesmo com destroy() e unref().
    // Pasta própria e privada (só o dono): no Windows o %TEMP% já é do usuário; nos outros sistemas a pasta precisa ser do dono e
    // sem acesso para grupo/outros, senão a chamada é recusada antes de escrever o prompt.
    const pastaDosPrompts = pastaPrompts ?? pastaDePromptsPadrao();
    const entrada = path.join(pastaDosPrompts, `prompt-${process.pid}-${crypto.randomBytes(8).toString('hex')}.txt`);
    const liberacao = `${entrada}.liberar`; // barreira do wrapper: só é criado depois de a reserva gravar o PID e o Job
    // No Windows o arquivo pode estar em uso enquanto o processo vive: repete algumas vezes e, se não der, avisa onde ficou.
    const apagarEntrada = (tentativa = 0) => {
      // Cada arquivo no seu próprio try: falhar em um não impede apagar o outro.
      const apagar = (arquivo) => { try { fs.rmSync(arquivo, { force: true }); return true; } catch { return false; } };
      const liberacaoApagada = apagar(liberacao);
      const entradaApagada = apagar(entrada);
      if (liberacaoApagada && entradaApagada) return;
      if (tentativa < 5) setTimeout(() => apagarEntrada(tentativa + 1), 1000); // sem unref: o Node não sai antes de tentar de novo
      else console.error(`não consegui apagar o arquivo temporário (apague à mão): ${[liberacaoApagada ? null : liberacao, entradaApagada ? null : entrada].filter(Boolean).join(', ')}`);
    };
    const jobNome = `Local\\MixAI-${crypto.randomBytes(12).toString('hex')}`;
    const ativo = { pid: undefined, jobNome };
    const esquecerAtivo = () => { if (signal) ativosPorSinal.get(signal)?.delete(ativo); };
    let filho;
    try {
      garantirPastaPrivada(pastaDosPrompts);
      fs.writeFileSync(entrada, String(prompt), { mode: 0o600, flag: 'wx' }); // só o dono lê; nunca segue um arquivo que já exista
      const fdEntrada = fs.openSync(entrada, 'r');
      try {
        // Reserva gravada ANTES de o processo nascer (com o nome do Job): se não der, o agente nem começa.
        if (signal) { if (!ativosPorSinal.has(signal)) ativosPorSinal.set(signal, new Set()); ativosPorSinal.get(signal).add(ativo); }
        avisarJob({ fase: 'antes', signal, jobNome });
        if (lancar) filho = lancar(comando, fdEntrada);
        else filho = spawn('powershell', argsDoWrapper(), { env: { ...process.env, MIXAI_COMANDO: comando, MIXAI_JOB: jobNome, MIXAI_LIBERAR: liberacao }, stdio: [fdEntrada, 'pipe', 'pipe'], windowsHide: true });
      } finally { fs.closeSync(fdEntrada); }
    } catch (e) { esquecerAtivo(); apagarEntrada(); throw e; }
    filho.jobNome = jobNome;
    ativo.pid = filho.pid;
    let erroDeReserva = null;
    try { avisarJob({ fase: 'depois', signal, jobNome, pid: filho.pid }); } catch (e) { erroDeReserva = e; } // grava o PID do wrapper na reserva
    // Só agora o wrapper pode iniciar o comando (barreira): PID e nome do Job já estão na reserva. Sem isto ele sai sem rodar nada.
    if (!erroDeReserva && !lancar) { try { fs.writeFileSync(liberacao, '1', { mode: 0o600, flag: 'wx' }); } catch (e) { erroDeReserva = e; } }
    let terminou = false;
    let relogio = null;
    let estourou = false;
    let saidaGrande = false;
    let abortado = false;
    let erroDoProcesso = null;
    let tirarOuvinteDeAborto = null;
    const fim = (f, valor) => {
      if (terminou) return;
      terminou = true; clearInterval(relogio); clearTimeout(limiteDeTempo);
      if (!valor?.naoConfirmado) esquecerAtivo(); // morte confirmada: nada a reter
      if (tirarOuvinteDeAborto) tirarOuvinteDeAborto(); // só sai depois da conferência: um aborto durante ela ainda conta
      apagarEntrada();
      f(valor);
    };
    // Morte não confirmada: larga o processo (pipes fechados e sem segurar o Node), senão o comando nunca termina.
    const largar = () => {
      for (const f of [filho.stdout, filho.stderr]) {
        if (!f) continue;
        try { f.removeAllListeners('data'); f.on('error', () => {}); f.destroy(); } catch { /* já fechado */ }
        try { f.unref?.(); } catch { /* sem efeito */ }
      }
      try { filho.removeAllListeners('close'); filho.removeAllListeners('error'); filho.on('error', () => {}); } catch { /* sem efeito */ }
      try { filho.unref(); } catch { /* sem efeito */ }
    };
    const naoConfirmado = (texto) => { fim(reject, Object.assign(new Error(texto), { naoConfirmado: true, pid: filho.pid, jobNome: filho.jobNome })); largar(); };
    if (erroDeReserva) { try { matar(filho); } catch { /* o Job é conferido pela retenção */ } return naoConfirmado(`o processo ${filho.pid} nasceu mas a reserva de vagas com o PID dele não foi gravada (${erroDeReserva.message}); pode continuar vivo`); }
    // Uma única rotina de parada (aborto, tempo máximo, saída grande e erro do processo podem pedir juntos): repete o pedido
    // até a chamada terminar, com prazo final explícito.
    let parando = false;
    let aceitoEm = 0;
    let feitas = 0;
    const tentarParar = () => {
      if (terminou) return;
      feitas += 1;
      let aceito = false;
      try { aceito = matar(filho); } catch { aceito = false; }
      if (aceito && !aceitoEm) aceitoEm = Date.now();
      if (aceitoEm) {
        if (Date.now() - aceitoEm >= prazoDeFechamentoMs) naoConfirmado(`o processo ${filho.pid} recebeu o pedido de parada mas a chamada não terminou em ${prazoDeFechamentoMs / 1000} s; pode continuar vivo`);
      } else if (feitas >= tentativasDeMatar) naoConfirmado(`o processo ${filho.pid} não morreu (a parada falhou ${feitas} vezes); pode continuar vivo`);
    };
    const parar = () => {
      if (parando) return;
      parando = true;
      tentarParar();
      if (!terminou) relogio = setInterval(tentarParar, reintentoMs);
    };
    // O tempo máximo também mata a árvore pelo mesmo caminho (o `timeout` do spawn mataria só o shell).
    const limiteDeTempo = setTimeout(() => { estourou = true; parar(); }, tempoMaximoMs);
    if (signal) {
      const abortar = () => { abortado = true; parar(); };
      if (signal.aborted) abortar();
      else signal.addEventListener('abort', abortar, { once: true });
      tirarOuvinteDeAborto = () => signal.removeEventListener('abort', abortar);
    }
    // Um só orçamento de BYTES para stdout e stderr juntos; passou, a árvore é parada em vez de esgotar a memória.
    const saidas = [];
    const erros = [];
    let bytes = 0;
    const guardar = (lista) => (d) => {
      if (saidaGrande) return;
      const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      bytes += b.length;
      if (bytes > maxSaidaBytes) { saidaGrande = true; parar(); return; }
      lista.push(b);
    };
    filho.stdout.on('data', guardar(saidas));
    filho.stderr.on('data', guardar(erros));
    filho.on('error', (e) => {
      // Sem PID o processo nunca nasceu. Com PID, o erro não prova que a árvore acabou: para, espera o 'close' e confere.
      if (filho.pid === undefined) return fim(reject, e);
      erroDoProcesso = e;
      parar();
    });
    filho.on('close', (codigo) => {
      if (terminou) return;
      clearInterval(relogio);
      clearTimeout(limiteDeTempo); // o comando já acabou: a conferência do job não pode transformar um sucesso em "tempo máximo"
      // O shell fechou: se ficou descendente vivo (sem pipe), o 'close' não prova que acabou. Mata e confere, com prazo próprio.
      let prazo;
      const semResposta = new Promise((ok) => { prazo = setTimeout(() => ok(null), prazoDeFechamentoMs); });
      Promise.race([Promise.resolve().then(() => orfaos(filho)), semResposta]).catch(() => null).then((sobrou) => {
        clearTimeout(prazo);
        if (terminou) return;
        if (sobrou === null || sobrou === undefined) return naoConfirmado(`o processo ${filho.pid} fechou e não consegui conferir se sobrou descendente vivo (a conferência falhou)`);
        if (sobrou.length) return naoConfirmado(`o processo ${filho.pid} fechou, mas ${sobrou.length} descendente(s) continuam vivos e não morreram`);
        if (erroDoProcesso) return fim(reject, erroDoProcesso);
        if (abortado) return fim(reject, Object.assign(new Error('chamada abortada'), { abortada: true })); // abortada: nunca vira sucesso, mesmo que o processo já tivesse saído com 0
        const saida = Buffer.concat(saidas).toString('utf8');
        const erro = Buffer.concat(erros).toString('utf8');
        if (codigo === 0 && !estourou && !saidaGrande) fim(resolve, saida);
        else fim(reject, new Error(estourou ? `passou do tempo máximo (${tempoMaximoMs / 1000} s)` : saidaGrande ? `a saída passou de ${maxSaidaBytes} bytes; o comando foi parado` : erro || `saiu com ${codigo}`));
      });
    });
  });
}

const TEMPO_MAXIMO_MS = 10 * 60 * 1000;

const COMANDOS = {
  // Passa pelo rodar-local.js, que confere a memória livre antes de carregar o modelo.
  local: `node "${path.join(__dirname, '..', 'local', 'rodar-local.js')}"`,
  codex: 'codex exec -s read-only -',
  claude: 'claude -p',
};

// O comando de verificação roda como qualquer outro comando: assíncrono, dentro do Job Object no Windows, com tempo
// máximo e abortável pelo `signal` (o lote cancela a verificação em andamento no erro fatal). Verificação que não
// confirma a morte (`naoConfirmado`) NÃO vira "resposta errada": o erro sobe até o lote, que para.
function verificadorPorComando(comando, opcoes = {}) {
  const chamar = chamarComando(comando, opcoes);
  return async (saida, signal) => {
    try { await chamar(saida, signal); return { ok: true, motivo: '' }; } catch (erro) {
      if (erro?.naoConfirmado || erro?.abortada) throw erro;
      return { ok: false, motivo: String(erro?.message || erro).trim().slice(0, 500) };
    }
  };
}

function promptReinstruir(entrada, erradas) {
  const ultimas = erradas.slice(-2).map((e, i) => `Tentativa ${erradas.length - Math.min(2, erradas.length) + i + 1}: saída "${e.saida}" -> erro: ${e.motivo}`);
  return [
    'REINSTRUIR: um modelo pequeno errou esta tarefa. Leia o erro, descubra a causa (pesquise se precisar) e escreva uma instrução curta e exata para ele acertar na próxima. Responda só com a instrução, sem resolver a tarefa por ele.',
    `Tarefa: ${entrada}`,
    ...ultimas,
  ].join('\n');
}

function promptAntagonista(entrada, saida) {
  return [
    'ANTAGONISTA: tente achar defeito nesta resposta (caso de borda, pedido não atendido, algo a mais que ninguém pediu).',
    `Tarefa: ${entrada}`,
    `Resposta: ${saida}`,
    'Responda só "OK" se não achar defeito, ou "PROBLEMA: <o defeito>".',
  ].join('\n');
}

// Loop de tentativas: o Qwen tenta; se falha, o modelo grande lê o erro e reinstrui; repete até o limite.
// Estourou o limite, o grande resolve direto. Cada falha resolvida vira caso de regressão (tests/falhas-escada.test.js).
// Com `antagonico`, a resposta só vale se outro agente (nunca o que produziu) não achar defeito.
async function resolverComLoop({ entrada, verificar, agentes, maxTentativas = 3, antagonico = false, verificarComando = null, arquivos = ARQUIVOS, modelo: modeloBruto, estatico, entradaEstatica, liberacao }) {
  const modelo = normalizarModelo(modeloBruto);
  if (typeof verificar !== 'function') throw new Error('Sem verificador não há como saber se a resposta está certa.');
  if (!Number.isInteger(maxTentativas) || maxTentativas < 1) throw new Error('tentativas precisa ser um número inteiro maior que zero.');
  const usadas = escolherRegras(regrasParaModelo(lerRegras(arquivos.regras), modelo), entrada);
  const base = { entrada, data: new Date().toISOString(), ...(modelo ? { modelo } : {}) };
  const erradas = [];
  const supers = agentes.superiores;

  const julgar = async (saida, produtor) => {
    const v = await verificar(saida);
    if (v.ok !== true) return { ok: false, porVerificador: true, motivo: v.motivo || 'o verificador reprovou' };
    if (!antagonico) return { ok: true, antagonista: null };
    for (const outro of supers.filter((x) => x.nome !== produtor)) {
      const parecer = await tentar(outro.chamar, promptAntagonista(entrada, saida));
      if (parecer === null) continue; // este não respondeu (sem cota): tenta o próximo
      if (/^\s*OK\s*[.!]?\s*$/i.test(parecer)) return { ok: true, antagonista: outro.nome };
      return { ok: false, porVerificador: false, motivo: parecer };
    }
    return { ok: false, porVerificador: false, motivo: 'nenhum outro agente grande disponível para conferir (sem cota?); sem checagem antagônica a resposta não vale' };
  };

  // a regra aprendida passa pela MESMA checagem (verificador + antagonista) da resposta final
  const ok = async (saida) => (await julgar(saida, 'local')).ok === true;
  const concluir = (saida, resolvidoPor, tentativas, antagonista, regra = null, regraSalva = null) => {
    if (erradas.length && verificarComando) {
      registrarCaso(arquivos.falhas, { ...base, saidasErradas: erradas.filter((e) => e.porVerificador).map((e) => e.saida), rejeitadasPeloRevisor: erradas.filter((e) => !e.porVerificador && e.saida).map((e) => e.saida), motivos: erradas.map((e) => e.motivo), saidaCerta: saida, verificar: verificarComando, resolvidoPor });
    }
    registrarCaso(arquivos.casos, { ...base, regra: regra || usadas[0] || null, regrasUsadas: usadas.map((r) => r.id), saida, resolvidoPor });
    return { ok: true, resolvidoPor, saida, tentativas, antagonista, regraSalva };
  };

  const doEstatico = Array.isArray(estatico) && estatico.length ? await tentarEstatico(estatico, entradaEstatica ?? entrada, verificar) : null; // sem estático não ganha nem um turno a mais
  if (doEstatico) {
    registrarCaso(arquivos.casos, { ...base, regra: null, regrasUsadas: [], regraEstatica: doEstatico.regra, saida: doEstatico.saida, resolvidoPor: 'estatico' });
    return { ok: true, resolvidoPor: 'estatico', saida: doEstatico.saida, tentativas: 0, antagonista: null, regraSalva: null };
  }
  const localPode = localLiberado(liberacao, modelo);

  let instrucao = entrada;
  for (let t = 1; t <= maxTentativas && localPode; t += 1) {
    const saida = await tentar(agentes.local, montarPrompt(instrucao, usadas));
    if (saida === null) {
      // Infraestrutura (sem memória, sem placa, processo caiu): o modelo nem respondeu, então não foi erro dele.
      // Não gasta tentativa, não vira falha de regressão e o grande não perde tempo reinstruindo: sai do loop
      // e a tarefa sobe direto (repetir sem memória só repetiria a recusa).
      break;
    } else {
      const j = await julgar(saida, 'local');
      if (j.ok) return concluir(saida, 'local', t, j.antagonista);
      erradas.push({ saida, porVerificador: j.porVerificador, motivo: j.motivo });
    }
    if (t === maxTentativas || supers.length === 0) continue;
    for (let k = 0; k < supers.length; k += 1) {
      const dica = await tentar(supers[(t - 1 + k) % supers.length].chamar, promptReinstruir(entrada, erradas));
      if (dica) { instrucao = `${entrada}

Instrução do revisor: ${dica}`; break; }
    }
  }

  for (const s of supers) {
    const saida = await tentar(s.chamar, montarPrompt(entrada, []));
    if (saida === null) continue;
    const j = await julgar(saida, s.nome);
    if (j.ok) {
      const ultimaDoLocal = erradas.filter((e) => e.saida).pop();
      const aprendida = ultimaDoLocal
        ? await aprenderRegra({ entrada, saidaLocal: ultimaDoLocal.saida, saida, nome: s.nome, chamarSuperior: s.chamar, usadas, ok, agentes, arquivos, data: base.data, modelo })
        : { regra: null, regraSalva: null };
      return concluir(saida, s.nome, maxTentativas, j.antagonista, aprendida.regra, aprendida.regraSalva);
    }
    erradas.push({ saida, porVerificador: j.porVerificador, motivo: j.motivo });
  }
  registrarCaso(arquivos.pendentes, { ...base, saidasErradas: erradas.map((e) => e.saida), motivos: erradas.map((e) => e.motivo), verificar: verificarComando });
  return { ok: false, resolvidoPor: null, saida: null, tentativas: maxTentativas, antagonista: null };
}

const MAX_CONTEXTO = 1500;

function validarPlano(microtarefas) {
  if (!Array.isArray(microtarefas) || microtarefas.length === 0) throw new Error('plano vazio: precisa de ao menos uma microtarefa.');
  const ids = new Set();
  for (const m of microtarefas) {
    const nome = `microtarefa ${m && m.id}`;
    if (!m || !m.id || ids.has(m.id)) throw new Error(`${nome}: id ausente ou repetido.`);
    ids.add(m.id);
    if (!String(m.instrucao || '').trim()) throw new Error(`${nome}: falta a instrução exata.`);
    if (!String(m.verificar || '').trim()) throw new Error(`${nome}: falta o comando que confere o resultado.`);
    if (!Array.isArray(m.escopo) || m.escopo.length === 0) throw new Error(`${nome}: falta o escopo (arquivos que pode tocar).`);
    if (String(m.contexto || '').length > MAX_CONTEXTO) throw new Error(`${nome}: contexto grande demais (máx. ${MAX_CONTEXTO} caracteres); entregue só o que ela precisa.`);
  }
}

const normaliza = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sobrepoe = (a, b) => a.some((x) => b.some((y) => {
  const [p, q] = [normaliza(x), normaliza(y)];
  return p === q || p.startsWith(q + '/') || q.startsWith(p + '/');
}));

function promptMicro(m) {
  return [m.instrucao.trim(), m.contexto ? `Contexto:
${m.contexto}` : null, `Arquivos que você pode tocar: ${m.escopo.join(', ')}`]
    .filter(Boolean).join('\n');
}

// O modelo grande (Claude/Codex) planeja; o Qwen só executa microtarefas delimitadas, até `paralelismo` ao mesmo tempo.
// Microtarefas com escopo que se sobrepõe nunca rodam juntas. Uma que falha não para as outras.
// O controle de paralelismo (se for um) devolve a reserva de vagas ao fim do lote, com sucesso ou erro.
// Se a morte de algum agente NÃO foi confirmada, a reserva dessas vagas fica retida (até os processos morrerem ou expirar):
// nunca é devolvida como se a vaga estivesse livre.
async function lote(opcoes) {
  let retidas = {};
  let erroDoLote = null;
  // Os agentes deste lote (Job e PID) vão para a reserva dele: se o lote morrer deixando agentes vivos, a vaga segue reservada.
  const ponte = {};
  const controle = opcoes?.paralelismo;
  let soltarOuvinte = null;
  if (typeof controle?.fornecerAgentes === 'function' && typeof controle?.atualizarAgentes === 'function') {
    controle.fornecerAgentes(() => ponte.agentes?.() ?? []);
    soltarOuvinte = aoNovoJob((ev) => {
      if (!ponte.possui?.(ev.signal)) return; // comando de outro lote do mesmo processo
      if (controle.atualizarAgentes() !== true) {
        throw Object.assign(new Error('não consegui gravar a reserva de vagas com o agente (mesmo tentando de novo); o agente local não foi mantido'), { naoConfirmado: true, jobNome: ev.jobNome, pid: ev.pid });
      }
    });
  }
  try { return await loteSemLiberar({ ...opcoes, ponte }); } catch (erro) {
    if (erro?.naoConfirmados?.length) retidas = { naoConfirmados: erro.naoConfirmados.length, itens: erro.itensNaoConfirmados ?? [] };
    erroDoLote = erro;
    throw erro;
  } finally {
    soltarOuvinte?.();
    try { opcoes?.paralelismo?.liberar?.(retidas); } catch (e) {
      // Retenção que não pôde ser gravada: falha fechada. O erro é exposto (a reserva segue valendo e o processo tenta gravar de novo).
      if (e?.retencaoNaoGravada) throw Object.assign(new Error(`${e.message}${erroDoLote ? ` (erro do lote: ${erroDoLote.message})` : ''}`), { naoConfirmados: erroDoLote?.naoConfirmados, retencaoNaoGravada: true });
    }
  }
}
async function loteSemLiberar({ ponte = {}, microtarefas, verificadorDe, agentes, paralelismo = 1, reavaliarMs = 15000, tempoParaConfirmarMs = 60000, maxTentativas, antagonico = false, arquivos = ARQUIVOS, estatico, entradaEstatica, liberacao }) {
  validarPlano(microtarefas);
  // `paralelismo` pode ser um número ou uma função (orquestra/paralelismo.js) que diz quantos agentes cabem agora.
  const dinamico = typeof paralelismo === 'function';
  let iniciado = false;
  const limiteBruto = () => {
    const n = dinamico ? paralelismo({ agentesLocais: locais().length + encerrando.length }) : paralelismo;
    // Zero só vale no limite dinâmico (memória ou placa sem espaço agora): o lote espera abrir vaga.
    if (!Number.isInteger(n) || n < (dinamico ? 0 : 1)) throw new Error(dinamico ? 'paralelismo dinâmico precisa devolver um número inteiro maior que zero ou zero.' : 'paralelismo precisa ser um número inteiro maior que zero.');
    return n;
  };
  const resultados = new Map();
  const pendentes = [...microtarefas];
  const rodando = new Map();
  const estados = new Map(); // microtarefa -> { ctl, abandonada, emLocal, fim }
  ponte.agentes = () => [...estados.values()].flatMap((e) => ativosDoSinal(e.ctl.signal));
  ponte.possui = (signal) => !!signal && [...estados.values()].some((e) => e.ctl.signal === signal);
  const naoConfirmados = []; // ids de microtarefas cujo processo não teve a morte confirmada
  const identificadores = new Map(); // id da microtarefa -> [{ pid, jobNome }] dos processos sem morte confirmada (quando se sabe)
  const anotar = (id, item) => { if (!identificadores.has(id)) identificadores.set(id, []); identificadores.get(id).push(item); };
  const marcarFatal = (f) => { f.naoConfirmados = [...new Set(naoConfirmados)]; f.itensNaoConfirmados = f.naoConfirmados.flatMap((id) => {
    const itens = (identificadores.get(id) ?? []).filter((x, i, l) => l.findIndex((y) => y.jobNome === x.jobNome && y.pid === x.pid) === i);
    return itens.length ? itens : [{}]; // sem identificador: a reserva vale pelo prazo
  }); return f; };
  let fatal = null; // processo abortado que não deu para confirmar que morreu: o lote inteiro para com erro claro
  const encerrando = []; // { m, fim }: abortadas cujo processo ainda não confirmou que morreu; a vaga e o escopo seguem ocupados
  // A vaga é de agente LOCAL: quem já subiu para o Codex/Claude (`ocupa` falso: subiu, ou está só conferindo a resposta) não usa o modelo local nem a placa e não conta.
  const locais = () => [...rodando.keys()].filter((m) => estados.get(m).ocupa);
  const limiteAgora = () => {
    try { return limiteBruto(); } catch (er) {
      if (!iniciado) throw er; // limite inválido logo de início: recusa
      fatal = fatal || er; // erro de leitura/configuração com agentes já rodando: o lote para pelo caminho fatal (aborta e espera a morte)
      return 0;
    }
  };
  limiteAgora(); // recusa cedo um limite inválido
  iniciado = true;
  let acordaLoop;
  let mudanca = new Promise((ok) => { acordaLoop = ok; });
  const avisarMudanca = () => { acordaLoop(); mudanca = new Promise((ok) => { acordaLoop = ok; }); };

  while (pendentes.length || rodando.size || encerrando.length) {
    if (fatal) {
      // Interrompe os outros agentes locais e ESPERA a confirmação da morte de cada um antes de lançar o erro.
      const esperas = encerrando.map((x) => ({ id: x.m.id, fim: x.fim, acabou: false }));
      for (const [m, e] of estados) {
        if (e.abandonada || !rodando.has(m)) continue;
        e.abandonada = true;
        e.ctl.abort(); // chega às chamadas ao local e aos superiores (Codex/Claude), que também recebem o sinal
        if (e.emLocal) esperas.push({ id: m.id, fim: e.fim, acabou: false });
        if (e.supFim) esperas.push({ id: m.id, fim: e.supFim, acabou: false });
        if (e.verFim) esperas.push({ id: m.id, fim: e.verFim, acabou: false });
      }
      for (const w of esperas) w.fim.then((confirmada) => { w.acabou = confirmada !== false; }); // `fim` = a chamada terminou; só `true` prova a morte
      let corte;
      await Promise.race([Promise.all(esperas.map((w) => w.fim)), new Promise((ok) => { corte = setTimeout(ok, tempoParaConfirmarMs); })]);
      clearTimeout(corte);
      // Quem ainda não terminou depois do prazo não teve a morte confirmada.
      for (const w of esperas) {
        if (w.acabou) continue;
        naoConfirmados.includes(w.id) || naoConfirmados.push(w.id);
        // chamada ainda pendente: guarda o Job/PID dos processos dela (não só o id da microtarefa)
        const dela = [...estados].find(([m]) => m.id === w.id)?.[1];
        for (const a of ativosDoSinal(dela?.ctl.signal)) anotar(w.id, a);
      }
      const semCitar = [...new Set(naoConfirmados)].filter((id) => !fatal.message.includes(`"${id}"`)); // mesmo com 1 só id, se a mensagem ainda não o cita
      if (semCitar.length) fatal = new Error(`${fatal.message} Também não foi confirmada a morte de: ${semCitar.join(', ')}.`);
      throw marcarFatal(fatal);
    }
    // O dono voltou ao PC: tira agentes locais em andamento (os mais novos primeiro) e devolve a microtarefa à fila.
    // Só tira quem está esperando o modelo local; quem já passou para o Codex/Claude ou para a conferência termina.
    // A vaga só é reaproveitada quando o processo abortado de fato terminou (o `fim` da chamada ao local).
    const limite = limiteAgora();
    while (locais().length > limite) {
      const alvo = locais().reverse().find((m) => estados.get(m).emLocal);
      if (!alvo) break;
      const e = estados.get(alvo);
      e.abandonada = true; // a execução antiga nunca mais responde: não sobe para o Codex nem registra resultado
      const morte = {
        m: alvo,
        fim: e.fim.then((confirmada) => {
          encerrando.splice(encerrando.indexOf(morte), 1);
          if (confirmada === false) { naoConfirmados.includes(alvo.id) || naoConfirmados.push(alvo.id); } // vaga e escopo só se liberam com a morte confirmada: o lote para
          // Não dá para saber se o processo (e os filhos dele) morreu: reaproveitar a vaga ou o escopo seria arriscado, e o
          // estado só existe na memória deste lote. Para o lote inteiro com erro claro.
          avisarMudanca();
          return confirmada; // `fim` = a chamada terminou; o booleano é a prova da morte (nunca undefined)
        }),
      };
      encerrando.push(morte);
      e.ctl.abort();
      rodando.delete(alvo);
      pendentes.unshift(alvo);
    }
    while (locais().length + encerrando.length < limiteAgora()) {
      const ocupados = () => [...rodando.keys(), ...encerrando.map((x) => x.m)];
      const i = pendentes.findIndex((m) => !ocupados().some((r) => sobrepoe(r.escopo, m.escopo)));
      if (i < 0) break;
      const [m] = pendentes.splice(i, 1);
      const entrada = promptMicro(m);
      const e = { ctl: new AbortController(), abandonada: false, emLocal: false, ocupa: true, fim: null };
      estados.set(m, e);
      // A verificação também é um processo: roda com o sinal da microtarefa, e a morte não confirmada dela para o lote (nunca
      // vira "resposta errada"); o erro fatal espera a verificação em andamento terminar.
      const verificadorM = verificadorDe(m);
      const verificar = async (saida) => {
        if (e.abandonada || fatal) throw Object.assign(new Error('verificação cancelada: o lote parou ou a microtarefa foi tirada'), { cancelada: true });
        const p = Promise.resolve().then(() => verificadorM(saida, e.ctl.signal));
        e.verFim = p.then(() => true, (erro) => erro?.naoConfirmado !== true);
        try { return await p; } catch (erro) {
          if (erro?.naoConfirmado) {
            naoConfirmados.push(m.id); anotar(m.id, { pid: erro.pid, jobNome: erro.jobNome });
            fatal = fatal || new Error(`o lote parou: não consegui confirmar que o comando de verificação da microtarefa "${m.id}" morreu (${erro.message}). Veja os processos no Gerenciador de Tarefas, encerre-os à mão e rode o lote de novo.`);
            avisarMudanca();
          }
          throw erro;
        }
      };
      const agentesDaMicro = {
        ...agentes,
        superiores: (agentes.superiores || []).map((sup) => ({
          ...sup,
          chamar: (...a) => {
            if (e.abandonada || fatal) return Promise.reject(Object.assign(new Error('chamada cancelada: o lote parou ou a microtarefa foi tirada'), { cancelada: true }));
            if (e.ocupa) { e.ocupa = false; avisarMudanca(); }
            // O sinal da microtarefa chega também aos superiores: erro fatal ou redução cancelam a chamada em andamento.
            const p = Promise.resolve().then(() => sup.chamar(...a, ...(a.length < 2 ? [e.ctl.signal] : [])));
            e.supFim = p.then(() => true, (erro) => erro?.naoConfirmado !== true); // a chamada terminou; só `true` prova que não ficou processo vivo
            // Morte não confirmada de um superior (Codex/Claude) também é fatal: nunca vira falha comum que segue o lote.
            return p.catch((erro) => {
              if (erro?.naoConfirmado) {
                naoConfirmados.push(m.id); anotar(m.id, { pid: erro.pid, jobNome: erro.jobNome });
                fatal = fatal || new Error(`o lote parou: não consegui confirmar que o processo do superior "${sup.nome}" da microtarefa "${m.id}" morreu (${erro.message}). Veja os processos no Gerenciador de Tarefas, encerre-os à mão e rode o lote de novo.`);
                avisarMudanca();
              }
              throw erro;
            });
          },
        })),
        local: async (prompt) => {
          // Voltando do Codex/Claude (ou começando), só entra no local quando houver vaga dentro do limite.
          const outros = () => locais().filter((m) => estados.get(m) !== e).length;
          while (!e.abandonada && !fatal && outros() + encerrando.length >= limiteAgora()) {
            let t;
            await Promise.race([mudanca, new Promise((ok) => { t = setTimeout(ok, Math.min(reavaliarMs, 200)); })]);
            clearTimeout(t);
          }
          return new Promise((ok, no) => {
          if (e.abandonada || fatal) return no(Object.assign(new Error('chamada cancelada: o lote parou ou a microtarefa foi tirada'), { cancelada: true })); // nunca fica pendente
          e.emLocal = true;
          e.ocupa = true; // (re)entrou no local: ocupa vaga
          // Cada chamada ao local (1ª tentativa, 2ª, correção...) tem o seu próprio fim: abortar a segunda não pode
          // olhar o fim da primeira, que já passou.
          let liberar;
          e.fim = new Promise((fimOk) => { liberar = fimOk; });
          Promise.resolve().then(() => agentes.local(prompt, e.ctl.signal)).then(
            (r) => { e.emLocal = false; e.ocupa = false; avisarMudanca(); liberar(true); if (!e.abandonada) ok(r); },
            (erro) => {
              e.emLocal = false; e.ocupa = false;
              if (erro?.naoConfirmado) {
                // Morte não confirmada (ao abortar, no tempo máximo ou com descendente sobrando): nunca vira erro comum
                // que sobe para o Codex. O lote inteiro para, e esta chamada não responde mais.
                naoConfirmados.push(m.id); anotar(m.id, { pid: erro.pid, jobNome: erro.jobNome });
                fatal = fatal || new Error(`o lote parou: não consegui confirmar que o processo do agente local "${m.id}" morreu (${erro.message}). Veja os processos do modelo local no Gerenciador de Tarefas, encerre-os à mão e rode o lote de novo.`);
                avisarMudanca(); liberar(false); // terminou, mas a morte NÃO foi confirmada
                return;
              }
              avisarMudanca(); liberar(true); if (!e.abandonada) no(erro);
            },
          );
          });
        },
      };
      // `liberacao` (true ou { arquivo }) liga a trava por tipo: o tipo vem do campo `tipo` da microtarefa; sem tipo, nada é liberado.
      const liberacaoDaMicro = liberacao ? { tipo: m.tipo, ...(liberacao.arquivo ? { arquivo: liberacao.arquivo } : {}) } : undefined;
      const execucao = maxTentativas !== undefined || antagonico
        ? resolverComLoop({ entrada, verificar, agentes: agentesDaMicro, maxTentativas: maxTentativas === undefined ? 1 : maxTentativas, antagonico, verificarComando: m.verificar, arquivos, estatico, entradaEstatica: m.instrucao.trim(), liberacao: liberacaoDaMicro })
        : resolver({ entrada, cabeNoLocal: true, verificar, agentes: agentesDaMicro, arquivos, estatico, entradaEstatica: m.instrucao.trim(), liberacao: liberacaoDaMicro });
      const feito = execucao
        .catch((erro) => ({ ok: false, resolvidoPor: null, saida: null, erro: erro.message }))
        .then((r) => {
          if (e.abandonada) return;
          resultados.set(m.id, { id: m.id, ...r });
          rodando.delete(m);
        });
      rodando.set(m, feito);
    }
    // Com limite dinâmico, acorda de tempos em tempos: para abrir vaga quando o PC ficar parado
    // e para tirar agentes quando o dono voltar.
    let relogio;
    const acordar = dinamico && (pendentes.length || locais().length || encerrando.length) ? [new Promise((ok) => { relogio = setTimeout(ok, reavaliarMs); })] : [];
    await Promise.race([...rodando.values(), ...encerrando.map((x) => x.fim), mudanca, ...acordar]);
    clearTimeout(relogio);
  }
  if (fatal) throw marcarFatal(fatal); // o erro fatal surgiu quando já não havia mais nada rodando
  return microtarefas.map((m) => resultados.get(m.id));
}

function exportar(arquivos = ARQUIVOS) {
  const linhas = lerCasos(arquivos.casos).map((c) => JSON.stringify(paraTreino(c)));
  fs.mkdirSync(path.dirname(arquivos.treino), { recursive: true });
  fs.writeFileSync(arquivos.treino, linhas.join('\n') + (linhas.length ? '\n' : ''));
  return linhas.length;
}

// Liga um lote ao grafo (`--grafo`): as microtarefas que são tarefas do grafo vão a em_andamento antes do lote e a
// feita/falha depois. Microtarefa que não existe no grafo é ignorada. Tudo ou nada no início; no fim só mexe no que
// ainda está em_andamento (alguém pode ter concluído por outro caminho).
function ligarAoGrafo(arquivo, microtarefas, { plataforma = process.platform } = {}) {
  const grafoApi = require('./grafo.js');
  const ids = (g) => microtarefas.map((m) => m.id).filter((id) => Object.hasOwn(g.tarefas, id));
  // O escopo que o lote usa é o do plano: precisa caber no escopo da tarefa no grafo, senão a trava de escopo do grafo é contornada.
  // Mesma regra do projeto para o escopo: com `/` no fim é pasta (libera o que está abaixo); sem `/` é arquivo (só ele mesmo, nunca filhos);
  // curinga (`*`, `?`) casa só dentro da mesma pasta. Nada é alargado: na dúvida, recusa. `normaliza()` do grafo não serve aqui
  // porque tira a barra final e reduz curinga à pasta.
  const forma = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(^|\/)(\.\/)+/g, '$1');
  const temPontos = (p) => p.split('/').includes('..'); // `..` pode sair da pasta: recusa em vez de resolver
  const caixa = (p) => (plataforma === 'win32' ? p.toLowerCase() : p); // como o aplicar.js: maiúsculas contam fora do Windows
  const temCuringa = (p) => /[*?]/.test(p);
  // Mesmo glob da trava do CI (.github/scripts/trava_de_escopo.py): `**/` vale zero ou mais pastas, `**` atravessa, `*` e `?` não.
  const casa = (padrao, caminho) => {
    let re = '';
    for (let i = 0; i < padrao.length;) {
      if (padrao.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; } else if (padrao.startsWith('**', i)) { re += '.*'; i += 2; } else {
        const c = padrao[i++];
        re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|\\[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(`^${re}$`).test(caminho);
  };
  const cabe = (p, t) => {
    const [x, y] = [caixa(forma(p)), caixa(forma(t))];
    if (temPontos(x) || temPontos(y)) return false;
    if (x === y) return true;
    if (temCuringa(y)) return !temCuringa(x) && casa(y, x);
    if (!y.endsWith('/')) return false; // arquivo: só ele mesmo
    const fixo = temCuringa(x) ? x.slice(0, x.search(/[*?]/)).replace(/[^/]*$/, '') : x; // parte fixa do padrão do plano
    return fixo.startsWith(y);
  };
  return {
    iniciar() {
      validarPlano(microtarefas); // antes de qualquer gravação: plano inválido não pode deixar tarefa presa em_andamento
      grafoApi.atualizar(arquivo, (g) => {
        for (const m of microtarefas) {
          const t = g.tarefas[m.id];
          const fora = t && m.escopo.find((p) => !t.escopo.some((q) => cabe(p, q)));
          if (fora !== undefined) throw new Error(`microtarefa ${m.id}: o escopo "${fora}" está fora do escopo da tarefa no grafo (${t.escopo.join(', ')}).`);
        }
        return ids(g).reduce((x, id) => grafoApi.iniciar(x, id, 'local'), g);
      });
    },
    terminar(resultados) {
      for (const r of resultados) {
        grafoApi.atualizar(arquivo, (g) => {
          if (g.tarefas[r.id]?.estado !== 'em_andamento') return g;
          return r.ok ? grafoApi.concluir(g, r.id, `lote local verificado (${r.resolvidoPor || 'local'})`) : grafoApi.falhar(g, r.id, 'lote: microtarefa não passou na verificação');
        });
      }
    },
  };
}

async function principal(argumentos) {
  const [comando, alvo, ...resto] = argumentos;
  if (comando === 'exportar') {
    console.log(`${exportar()} exemplos escritos em ${ARQUIVOS.treino}`);
    return 0;
  }
  if (comando === 'lote' && alvo) {
    const ip = resto.indexOf('--paralelo');
    const cfgLote = JSON.parse(fs.readFileSync(path.join(pasta, 'escada.json'), 'utf8'));
    const microtarefas = JSON.parse(fs.readFileSync(path.resolve(alvo), 'utf8'));
    const ig = resto.indexOf('--grafo');
    if (ig >= 0 && !resto[ig + 1]) throw new Error('a opção --grafo precisa do caminho do arquivo do grafo');
    // Pré-voo: tudo que o lote recusaria antes de iniciar qualquer agente é conferido ANTES de marcar o grafo. Erro depois de
    // marcar deixaria a tarefa em_andamento sem processo nenhum (só vale em_andamento quando pode haver processo vivo).
    const paralelo = ip >= 0 && resto[ip + 1] === 'auto' ? 'auto' : ip >= 0 ? Number(resto[ip + 1]) : cfgLote.paralelismoPadrao || 1;
    if (paralelo !== 'auto' && (!Number.isInteger(paralelo) || paralelo < 1)) throw new Error('paralelismo precisa ser um número inteiro maior que zero.');
    const it = resto.indexOf('--tentativas');
    const tentativas = it >= 0 ? Number(resto[it + 1]) : undefined;
    if (it >= 0 && (!Number.isInteger(tentativas) || tentativas < 1)) throw new Error('tentativas precisa ser um número inteiro maior que zero.');
    validarPlano(microtarefas);
    const controle = paralelo === 'auto'
      ? require('./paralelismo.js').criarControle({ refrescarMs: 5000, aoDecidir: (d) => console.error(`paralelo ${d.alvo}: ${d.motivo}`) })
      : paralelo;
    const agentes = {
      local: chamarComando(COMANDOS.local),
      superiores: cfgLote.superiores.map((nome) => ({ nome, chamar: chamarComando(COMANDOS[nome]) })),
    };
    const ligacao = ig >= 0 ? ligarAoGrafo(path.resolve(resto[ig + 1]), microtarefas) : null;
    ligacao?.iniciar();
    const resultados = await lote({
      microtarefas,
      verificadorDe: (m) => verificadorPorComando(m.verificar),
      paralelismo: controle,
      maxTentativas: tentativas,
      antagonico: resto.includes('--antagonico'),
      agentes,
      estatico: resto.includes('--estatico') ? require('./estatico.js').lerRegras() : undefined,
      liberacao: resto.includes('--liberacao') ? true : undefined,
    });
    // Se o lote lançar erro, as tarefas ficam em_andamento (morte de processo não confirmada): nunca voltam à fila sozinhas.
    ligacao?.terminar(resultados);
    for (const r of resultados) console.log(`${r.id}: ${r.ok ? `ok (${r.resolvidoPor})` : 'FALHOU'}`);
    return resultados.every((r) => r.ok) ? 0 : 1;
  }
  if (comando === 'regras') {
    for (const r of lerRegras(ARQUIVOS.regras)) console.log(`${r.id} [${r.status}]: ${r.regra}`);
    return 0;
  }
  if (comando !== 'resolver' || !alvo) {
    console.error('Uso: node orquestra/escada.js resolver <arquivo-da-tarefa> [--cabe-no-local] --verificar "<comando que lê a resposta e sai 0 se estiver certa>" | lote <plano.json> [--paralelo N] [--tentativas N] [--antagonico] [--estatico] [--liberacao] [--grafo <arquivo>] | regras | exportar');
    return 2;
  }
  const iv = resto.indexOf('--verificar');
  if (iv < 0 || !resto[iv + 1]) {
    console.error('Falta --verificar "<comando>": sem conferência automática a escada não sabe se a resposta está certa.');
    return 2;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(pasta, 'escada.json'), 'utf8'));
  const r = await resolver({
    entrada: fs.readFileSync(path.resolve(alvo), 'utf8').trim(),
    cabeNoLocal: resto.includes('--cabe-no-local'),
    verificar: verificadorPorComando(resto[iv + 1]),
    agentes: {
      local: chamarComando(COMANDOS.local),
      superiores: cfg.superiores.map((nome) => ({ nome, chamar: chamarComando(COMANDOS[nome]) })),
    },
  });
  if (!r.ok) {
    console.error('Ninguém acertou. Nada foi registrado.');
    return 1;
  }
  console.log(r.saida);
  console.error(`Resolvido por ${r.resolvidoPor}.${r.regraSalva ? ` Regra nova salva: ${r.regraSalva}.` : ''}`);
  return 0;
}

module.exports = { ligarAoGrafo, lote, chamarComando, ativosDoSinal, aoNovoJob, criarPastaPrivadaWindows, matarArvore, orfaosVivos, confirmarJob, verificadorPorComando, resolverComLoop, escolherRegras, montarPrompt, lerRegraGerada, registrarCaso, lerCasos, paraTreino, resolver, exportar };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (erro) => {
    console.error(`Erro na escada: ${erro.message}`);
    process.exitCode = 1;
  });
}

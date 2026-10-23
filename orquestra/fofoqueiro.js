// Supervisor determinístico: lê o grafo canônico, decide ações puras e só então as executa.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const grafoApi = require('./grafo.js');
const configPadrao = require('./fofoqueiro.json');

const RAIZ = path.resolve(__dirname, '..');
const PASTA_CANAL = process.env.MIXAI_CANAL_DIR || path.join('D:', 'MixAI-coordenacao');
const ARQ_CANAL = path.join(PASTA_CANAL, 'coordenacao.md');
const ARQ_ESTADO = path.join(PASTA_CANAL, 'fofoqueiro-estado.json');
const ARQ_LOG = path.join(PASTA_CANAL, 'fofoqueiro.log');
const ARQ_GRAFO = process.env.MIXAI_GRAFO ? path.resolve(process.env.MIXAI_GRAFO) : path.join(__dirname, 'grafo.json');
const ARQ_SEM_COTA = path.join(__dirname, 'sem-cota.json'); // mesmo arquivo de orquestra/chamar.js
const AGENTES = ['claude', 'codex'];
const LIMITE = /\b(?:rate limit reached|usage limit|session limit|weekly limit|limit will reset|quota exceeded|insufficient_quota)\b/i;
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const normalizarNome = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const textoDaData = (d) => d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const ms = (d) => new Date(d).getTime();
const configuracao = (c = {}) => ({ ...configPadrao, ...c });

// A leitura do estado não transforma JSON corrompido em estado vazio: isso repetiria ações já disparadas.
function lerJson(arquivo, inicial) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return inicial; throw e; }
}
function gravarJson(arquivo, valor) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(valor, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, arquivo);
}
function logPadrao(texto) {
  fs.mkdirSync(PASTA_CANAL, { recursive: true });
  fs.appendFileSync(ARQ_LOG, `${new Date().toISOString()} ${texto}\n`);
}

// Uma mensagem do canal, dirigida de um agente ao outro, também é pendência. Não interpreta o corpo como comando.
function ultimaMensagem(texto) {
  const partes = String(texto).split(/^(?=### )/m).filter((p) => p.startsWith('### '));
  for (const p of partes.reverse()) {
    const titulo = p.split('\n', 1)[0];
    const m = titulo.match(/^###\s+.+?\s[—–-]\s+(\w+)[^→\n]*→\s*([\wÀ-ÿ]+)/);
    if (!m) continue;
    return { de: AGENTES.find((a) => normalizarNome(m[1]) === a), para: AGENTES.find((a) => normalizarNome(m[2]) === a), titulo, corpo: p, chave: `canal:${hash(p)}` };
  }
  return null;
}
function pendenciasDoCanal(texto) {
  const partes = String(texto).split(/^(?=### )/m).filter((p) => p.startsWith('### '));
  const pendentes = [];
  for (const p of partes) {
    const m = ultimaMensagem(p);
    if (!m?.de || !m.para || m.de === m.para) continue;
    for (let i = pendentes.length - 1; i >= 0; i--) {
      if (pendentes[i].de === m.para && pendentes[i].para === m.de) pendentes.splice(i, 1);
    }
    pendentes.push(m);
  }
  return pendentes.map((m) => ({ tipo: 'acordar', agente: m.para, motivo: `Nova mensagem no canal: ${m.titulo}`, ids: [], chave: m.chave }));
}
function pendenciasDosPRs(prs) {
  const acoes = [];
  for (const pr of prs || []) {
    const labels = (pr.labels || []).map((l) => l.name);
    const feito = AGENTES.find((a) => labels.includes(`feito-por:${a}`));
    if (!feito) continue;
    const revisor = feito === 'claude' ? 'codex' : 'claude';
    const falhou = (pr.statusCheckRollup || []).some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(String(c.conclusion || '').toUpperCase()));
    const sha = String(pr.headRefOid || '').slice(0, 8);
    if (falhou) acoes.push({ tipo: 'acordar', agente: feito, ids: [], motivo: `PR #${pr.number} está com teste vermelho`, chave: `ci:${pr.number}:${sha}` });
    else if (!labels.includes(`revisado-por:${revisor}`)) acoes.push({ tipo: 'acordar', agente: revisor, ids: [], motivo: `PR #${pr.number} precisa de revisão cruzada`, chave: `rev:${pr.number}:${sha}` });
  }
  return acoes;
}

const escopoConflita = (a, b) => {
  const x = grafoApi.normaliza(a), y = grafoApi.normaliza(b);
  return x === y || !x || !y || x.startsWith(y + '/') || y.startsWith(x + '/');
};
const conflita = (a, b) => (a.escopo || []).some((x) => (b.escopo || []).some((y) => escopoConflita(x, y)));

// Núcleo puro. 'local' é o identificador canônico do Qwen no grafo atual; não grava 'qwen:*'.
// Cada ação cita somente IDs existentes ou usa id:null para um erro do próprio grafo.
function decidir(g, estado = {}, agora = new Date(), cfg = {}) {
  const c = configuracao(cfg);
  const t = ms(agora);
  const tarefas = g?.tarefas;
  const formatoRuim = !g || g.versao !== 1 || !tarefas || typeof tarefas !== 'object' || Array.isArray(tarefas)
    || Object.entries(tarefas).some(([id, x]) => !x || typeof x !== 'object' || Array.isArray(x) || x.id !== id
      || !Array.isArray(x.depende) || !Array.isArray(x.escopo) || !['pendente', 'em_andamento', 'em_revisao', 'feita', 'falhou'].includes(x.estado));
  const erros = formatoRuim ? ['formato inválido'] : grafoApi.validar(g);
  if (erros.length) return [{ tipo: 'escalar', id: null, motivo: 'grafo inválido; confira o arquivo antes de continuar', chave: `grafo:invalido:${hash(erros.join(';'))}` }];
  const saida = [];
  const usadas = Object.values(tarefas).filter((x) => x.estado === 'em_andamento');
  const visto = estado.visto || {};
  const disparos = estado.disparos || {};
  const semCota = c.semCota || {};
  const espera = Math.max(1, c.esperaMinimaMinutos || 1) * 60000;
  const limite = Math.max(1, c.maxDisparosPorHora || 1);
  const jaVisto = (chave) => Number.isFinite(ms(visto[chave])) && t - ms(visto[chave]) < espera;
  const podeDisparar = (a) => {
    if (semCota[a] && ms(semCota[a]) > t) return 'sem cota';
    const recentes = (disparos[a] || []).filter((x) => t - ms(x) < 3600000 && t >= ms(x));
    if (recentes.length + saida.filter((x) => ['acordar', 'cobrar', 'escada'].includes(x.tipo) && x.agente === a).length >= limite) return 'limite por hora';
    return null;
  };
  const adicionar = (acao) => { if (!jaVisto(acao.chave)) saida.push(acao); };

  for (const x of grafoApi.prontas(g)) {
    if (usadas.some((u) => conflita(x, u))) continue; // o grafo só valida os dois já em andamento; não abrir conflito novo
    if (x.agente === 'local' || /^qwen:/.test(x.agente || '')) {
      if (!x.verificar) adicionar({ tipo: 'escalar', id: x.id, motivo: 'tarefa local sem verificador', chave: `verificar:${x.id}` });
      else {
        const impedimento = podeDisparar('local');
        if (impedimento) adicionar({ tipo: 'registrar', id: x.id, motivo: `local ${impedimento}; tarefa adiada`, chave: `adiar:${x.id}:${impedimento}` });
        else { adicionar({ tipo: 'escada', agente: 'local', ids: [x.id], motivo: `Tarefa ${x.id} pronta para a escada`, chave: `escada:${x.id}` }); usadas.push(x); }
      }
    } else if (AGENTES.includes(x.agente)) {
      const chave = `acordar:${x.id}`;
      const impedimento = podeDisparar(x.agente);
      if (impedimento) adicionar({ tipo: 'registrar', id: x.id, motivo: `${x.agente} ${impedimento}; tarefa adiada`, chave: `adiar:${x.id}:${impedimento}` });
      else if (!jaVisto(chave) && !saida.some((a) => a.tipo === 'acordar' && a.agente === x.agente)) {
        saida.push({ tipo: 'acordar', agente: x.agente, ids: [x.id], motivo: `Tarefa ${x.id} pronta: ${x.titulo}`, chave });
        usadas.push(x);
      }
    } else adicionar({ tipo: 'escalar', id: x.id, motivo: 'tarefa pronta sem agente definido', chave: `sem-agente:${x.id}` });
  }
  for (const x of Object.values(tarefas)) {
    if (x.estado === 'em_andamento' && t - ms(x.atualizado) > (c.prazoParadaMinutos || 30) * 60000) {
      const impedimento = podeDisparar(x.agente);
      if (impedimento) adicionar({ tipo: 'registrar', id: x.id, motivo: `cobrança de ${x.id} adiada: ${impedimento}`, chave: `adiar:cobrar:${x.id}:${impedimento}` });
      else adicionar({ tipo: 'cobrar', id: x.id, agente: x.agente, motivo: `Tarefa ${x.id} parada há mais de ${c.prazoParadaMinutos || 30} min`, chave: `cobrar:${x.id}` });
    }
    if (x.estado === 'falhou') adicionar({ tipo: 'escalar', id: x.id, motivo: `Tarefa ${x.id} falhou ${x.tentativas} vezes`, chave: `falhou:${x.id}` });
  }
  for (const x of grafoApi.travadas(g)) adicionar({ tipo: 'escalar', id: x.id, motivo: `Tarefa ${x.id} travada por dependência falha`, chave: `travada:${x.id}` });
  return saida;
}

function registrar(estado, acao, agora = new Date()) {
  const quando = textoDaData(agora);
  const visto = { ...(estado.visto || {}), [acao.chave]: quando };
  const chaves = Object.keys(visto).sort((a, b) => ms(visto[a]) - ms(visto[b]));
  for (const k of chaves.slice(0, Math.max(0, chaves.length - 200))) delete visto[k];
  const disparos = { ...(estado.disparos || {}) };
  if (['acordar', 'cobrar', 'escada'].includes(acao.tipo) && [...AGENTES, 'local'].includes(acao.agente)) {
    disparos[acao.agente] = [...(disparos[acao.agente] || []).filter((x) => ms(x) > ms(agora) - 3600000), quando];
  }
  return { ...estado, visto, disparos };
}

function filtrarExternas(acoes, estado, agora, cfg) {
  const c = configuracao(cfg), t = ms(agora);
  return acoes.filter((a) => {
    const visto = estado.visto?.[a.chave];
    if (visto && t - ms(visto) < c.esperaMinimaMinutos * 60000) return false;
    if (c.semCota?.[a.agente] && ms(c.semCota[a.agente]) > t) return false;
    const recentes = (estado.disparos?.[a.agente] || []).filter((x) => t - ms(x) < 3600000);
    return recentes.length < c.maxDisparosPorHora;
  });
}

// Um passo; em simulação nenhuma ação tem efeito, inclusive escrita do estado.
function passo(deps, cfg = configPadrao) {
  const agora = deps.agora();
  let estado = deps.lerEstado();
  const c = { ...configuracao(cfg), semCota: deps.lerSemCota() };
  const noPrazo = (chave) => Number.isFinite(ms(estado.visto?.[chave])) && ms(agora) - ms(estado.visto[chave]) < c.esperaMinimaMinutos * 60000;
  const escalarErro = (a, grafoAtual = null) => {
    if (noPrazo(a.chave)) return [];
    if (!deps.simular) {
      estado = registrar(estado, a, agora);
      deps.salvarEstado(estado);
      deps.executar(a, grafoAtual);
    }
    return [a];
  };
  let g;
  try { g = deps.lerGrafo(); }
  catch (e) {
    return escalarErro({ tipo: 'escalar', id: null, motivo: 'não consegui ler o grafo; confira o arquivo', chave: `grafo:leitura:${hash(e.code || e.message)}` });
  }
  let acoes = decidir(g, estado, agora, c);
  if (acoes.length === 1 && acoes[0].tipo === 'escalar' && acoes[0].id === null) {
    return escalarErro(acoes[0], g);
  }
  if (deps.lerCanal) acoes.push(...filtrarExternas(pendenciasDoCanal(deps.lerCanal()), estado, agora, c));
  if (!deps.simular && deps.listarPRs) acoes.push(...filtrarExternas(pendenciasDosPRs(deps.listarPRs()), estado, agora, c));
  const usadas = new Set(), realizadas = [];
  for (const a of acoes) {
    if (noPrazo(a.chave)) continue;
    const disparo = ['acordar', 'cobrar', 'escada'].includes(a.tipo);
    if (disparo) {
      if (usadas.has(a.agente) || (c.semCota[a.agente] && ms(c.semCota[a.agente]) > ms(agora))) continue;
      const recentes = (estado.disparos?.[a.agente] || []).filter((x) => ms(agora) - ms(x) < 3600000 && ms(agora) >= ms(x));
      if (recentes.length >= c.maxDisparosPorHora) continue;
    }
    let atual = g;
    if (!deps.simular && (a.ids?.length || a.id != null)) {
      try { atual = deps.lerGrafo(); } catch { break; }
      if (!decidir(atual, estado, agora, c).some((x) => x.chave === a.chave && x.tipo === a.tipo)) continue;
    }
    estado = registrar(estado, a, agora);
    if (!deps.simular) {
      deps.salvarEstado(estado); // antes do efeito: queda no meio não duplica execução
      if (a.tipo === 'registrar') deps.log?.(a.motivo);
      else deps.executar(a, atual);
    }
    if (disparo) usadas.add(a.agente);
    realizadas.push(a);
  }
  return realizadas;
}

// A data de início distingue um PID reaproveitado de seu dono original.
function inicioDoProcesso(pid) {
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout?.trim() ? r.stdout.trim() : null;
}

// Trava por gerações com PID e início: nunca sobrescreve a trava de um processo vivo.
function pegarTrava(pasta = PASTA_CANAL, deps = {}) {
  fs.mkdirSync(pasta, { recursive: true });
  const prefixo = 'fofoqueiro.trava.';
  const arquivos = () => fs.readdirSync(pasta).filter((x) => /^fofoqueiro\.trava\.\d+$/.test(x)).sort();
  const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const inicioDe = deps.inicioDe || inicioDoProcesso;
  const meuInicio = inicioDe(process.pid) || '?';
  for (let i = 0; i < 5; i++) {
    const todos = arquivos(), ultimo = todos.at(-1);
    if (ultimo) {
      const conteudo = fs.readFileSync(path.join(pasta, ultimo), 'utf8');
      const dono = /^(\d+):([^:]+):/.exec(conteudo);
      if (conteudo !== 'livre') {
        if (!dono) return { ok: false };
        if (vivo(Number(dono[1]))) {
          const inicioAtual = inicioDe(Number(dono[1]));
          if (dono[2] === '?' || !inicioAtual || inicioAtual === dono[2]) return { ok: false };
        }
      }
    }
    const proximo = String((ultimo ? Number(ultimo.slice(prefixo.length)) : 0) + 1).padStart(8, '0');
    const arq = path.join(pasta, prefixo + proximo);
    try { fs.writeFileSync(arq, `${process.pid}:${meuInicio}:${crypto.randomBytes(8).toString('hex')}`, { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    if (arquivos().at(-1) !== path.basename(arq)) { fs.writeFileSync(arq, 'livre'); continue; }
    let solta = false;
    return { ok: true, soltar: () => { if (!solta) { fs.writeFileSync(arq, 'livre'); solta = true; } } };
  }
  return { ok: false };
}

function listarPRs(cfg) {
  const r = spawnSync('gh', ['pr', 'list', '--repo', cfg.repo, '--state', 'open', '--json', 'number,title,headRefOid,labels,statusCheckRollup'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function promptDe(a, g) {
  const ids = a.ids?.length ? a.ids : a.id ? [a.id] : [];
  const tarefas = ids.map((id) => g?.tarefas?.[id]).filter(Boolean)
    .map((t) => `Tarefa ${t.id}: ${t.titulo}\nEscopo: ${t.escopo.join(', ')}\nVerificar: ${t.verificar || 'não definido'}`);
  return [a.motivo, ...tarefas, `Leia AGENTS.md e ${ARQ_CANAL}. Siga somente a tarefa indicada, crie branch/worktree antes de alterar arquivos, registre o progresso no canal e, ao terminar, atualize a tarefa no grafo com revisar ou concluir. Não faça merge do próprio PR.`].join('\n\n');
}
function acordar(a, cfg, g) {
  const prompt = promptDe(a, g);
  const args = a.agente === 'codex' ? ['exec', '-s', 'workspace-write', '-'] : ['-p', prompt, '--output-format', 'json'];
  const r = spawnSync(a.agente, args, { input: a.agente === 'codex' ? prompt : undefined, cwd: RAIZ, encoding: 'utf8', timeout: cfg.tempoMaximoDisparoMinutos * 60000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  const saida = String(r.stdout || '') + String(r.stderr || '');
  return { status: r.status, limite: LIMITE.test(saida) && r.status !== 0 };
}
function executarReal(a, g, cfg, deps = {}) {
  const arquivoGrafo = deps.arquivoGrafo || ARQ_GRAFO;
  const chamarAgente = deps.chamarAgente || ((acao) => acordar(acao, cfg, g));
  const log = deps.log || logPadrao;
  const escreverCanal = deps.escreverCanal || ((texto) => fs.appendFileSync(ARQ_CANAL, texto));
  const executarEscada = deps.chamarEscada || ((microtarefas) => {
    fs.mkdirSync(PASTA_CANAL, { recursive: true });
    const plano = path.join(PASTA_CANAL, `fofoqueiro-plano-${crypto.randomBytes(8).toString('hex')}.json`);
    fs.writeFileSync(plano, JSON.stringify(microtarefas), { flag: 'wx', mode: 0o600 });
    try { return spawnSync(process.execPath, [path.join(__dirname, 'escada.js'), 'lote', plano, '--paralelo', 'auto'], { cwd: RAIZ, encoding: 'utf8', timeout: cfg.tempoMaximoDisparoMinutos * 60000, windowsHide: true }); }
    finally { fs.rmSync(plano, { force: true }); }
  });
  if (a.tipo === 'escalar') {
    const para = /login|aprova|decis[aã]o/.test(a.motivo) ? 'Fernando' : 'Claude';
    escreverCanal(`\n### ${new Date().toISOString()} — Fofoqueiro → ${para} (escalada)\n\n${a.motivo}\n`);
    log(`escalar: ${a.motivo}`);
    return;
  }
  if (a.tipo === 'escada') {
    const microtarefas = a.ids.map((id) => {
      const t = g.tarefas[id];
      return { id, instrucao: t.titulo, verificar: t.verificar, escopo: t.escopo };
    });
    for (const id of a.ids) grafoApi.atualizar(arquivoGrafo, (x) => grafoApi.iniciar(x, id, 'local'));
    let r;
    try { r = executarEscada(microtarefas); }
    catch (e) { r = { status: 1 }; log(`falha ao iniciar escada: ${e.code || 'erro'}`); }
    log(`escada ${a.ids.join(',')}: status=${r.status ?? 1}`);
    if (r.status == null) {
      escreverCanal(`\n### ${new Date().toISOString()} — Fofoqueiro → Claude (lote sem morte confirmada)\n\nLote local ${a.ids.join(', ')} terminou sem confirmação de saída; tarefas mantidas em andamento. Confira os processos antes de retomar.\n`);
      return;
    }
    for (const id of a.ids) grafoApi.atualizar(arquivoGrafo, (x) => {
      if (x.tarefas[id]?.estado !== 'em_andamento') return x;
      return r.status === 0 ? grafoApi.concluir(x, id, 'lote local verificado') : grafoApi.falhar(x, id, `lote saiu com código ${r.status ?? 1}`);
    });
    return;
  }
  if (a.tipo === 'acordar' || a.tipo === 'cobrar') {
    if (a.tipo === 'cobrar' && a.agente === 'local') {
      escreverCanal(`\n### ${new Date().toISOString()} — Fofoqueiro → Claude (cobrança local)\n\n${a.motivo}; confira o lote local.\n`);
      log(`cobrar local: ${a.id}`);
      return;
    }
    if (a.tipo === 'acordar' && a.ids?.length) {
      grafoApi.atualizar(arquivoGrafo, (x) => grafoApi.iniciar(x, a.ids[0], a.agente));
    }
    let r;
    try { r = chamarAgente(a); }
    catch (e) { r = { status: 1, limite: false }; log(`falha ao chamar ${a.agente}: ${e.code || 'erro'}`); }
    log(`${a.tipo} ${a.agente}: status=${r.status}${r.limite ? ' cota' : ''}`);
    if (r.status == null) {
      escreverCanal(`\n### ${new Date().toISOString()} — Fofoqueiro → Claude (agente sem morte confirmada)\n\n${a.agente} terminou sem confirmação de saída; tarefa mantida em andamento. Confira os processos antes de retomar.\n`);
      return;
    }
    if (r.limite) {
      const marcar = deps.marcarSemCota || ((agente) => spawnSync(process.execPath, [path.join(__dirname, 'chamar.js'), 'sem-cota', agente], { encoding: 'utf8', windowsHide: true }));
      const marcado = marcar(a.agente);
      if (marcado.status !== 0) {
        escreverCanal(`\n### ${new Date().toISOString()} — Fofoqueiro → Claude (cota não registrada)\n\nFalha ao registrar falta de cota de ${a.agente}; tarefa mantida em andamento para impedir novo disparo automático.\n`);
        log(`sem-cota de ${a.agente}: falha ao registrar`);
        return;
      }
    }
    if (a.tipo === 'acordar' && a.ids?.length && r.status !== 0) {
      grafoApi.atualizar(arquivoGrafo, (x) => {
        if (x.tarefas[a.ids[0]]?.estado !== 'em_andamento') return x;
        if (r.limite) {
          const y = JSON.parse(JSON.stringify(x));
          y.tarefas[a.ids[0]].estado = 'pendente';
          y.tarefas[a.ids[0]].atualizado = new Date().toISOString();
          y.tarefas[a.ids[0]].resultado = 'agente sem cota';
          return y;
        }
        return grafoApi.falhar(x, a.ids[0], `agente saiu com código ${r.status}`);
      });
    }
    if (a.tipo === 'acordar' && a.ids?.length && r.status === 0) {
      grafoApi.atualizar(arquivoGrafo, (x) => x.tarefas[a.ids[0]]?.estado === 'em_andamento'
        ? grafoApi.revisar(x, a.ids[0], 'CLI terminou; aguarda revisão') : x);
    }
  }
}
function depsReais(simular, cfg) {
  return {
    agora: () => new Date(), simular,
    lerGrafo: () => grafoApi.carregar(ARQ_GRAFO),
    lerEstado: () => lerJson(ARQ_ESTADO, {}),
    salvarEstado: (e) => gravarJson(ARQ_ESTADO, e),
    lerSemCota: () => lerJson(ARQ_SEM_COTA, {}),
    lerCanal: () => { try { return fs.readFileSync(ARQ_CANAL, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } },
    listarPRs: () => listarPRs(cfg),
    executar: (a, g) => executarReal(a, g, cfg),
    log: logPadrao,
  };
}
async function principal(args) {
  if (args.some((a) => !['--simular', '--uma-vez'].includes(a))) throw new Error('uso: fofoqueiro.js [--simular] [--uma-vez]');
  const simular = args.includes('--simular');
  const umaVez = args.includes('--uma-vez');
  if (simular && !umaVez) throw new Error('--simular exige --uma-vez');
  const cfg = configPadrao;
  const deps = depsReais(simular, cfg);
  if (simular) { console.log(JSON.stringify(passo(deps, cfg), null, 2)); return 0; }
  const trava = pegarTrava();
  if (!trava.ok) throw new Error('já existe um fofoqueiro rodando');
  process.once('exit', trava.soltar);
  try {
    if (umaVez) { passo(deps, cfg); return 0; }
    for (;;) {
      try { passo(deps, cfg); } catch (e) { logPadrao(`erro no passo: ${e.code || e.name || 'erro'}`); }
      await new Promise((ok) => setTimeout(ok, cfg.intervaloSegundos * 1000));
    }
  } finally { trava.soltar(); }
}
module.exports = { ultimaMensagem, pendenciasDoCanal, pendenciasDosPRs, decidir, registrar, passo, pegarTrava, promptDe, executarReal, principal };
if (require.main === module) principal(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`Fofoqueiro: ${e.message}`); process.exitCode = 1; });

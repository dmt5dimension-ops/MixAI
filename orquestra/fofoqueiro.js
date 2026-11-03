// Fofoqueiro: vigia leve que percebe mudança no canal, nos PRs e no grafo de tarefas e instiga quem precisa agir.
// Detecção 100% determinística (arquivo + gh), sem modelo. Só a frase de resumo pode usar o modelo local, de noite,
// e só pelo local/rodar-local.js (que confere a memória). Acordar = `codex exec` / `claude -p` pelas assinaturas.
// Uso: node orquestra/fofoqueiro.js [--uma-vez]   (gerenciar escondido: orquestra/fofoqueiro.ps1 iniciar|parar|status)
//
// Grafo de tarefas (D:\MixAI-coordenacao\grafo.json): { "tarefas": [ { id, descricao, dono, depende: [ids],
//   estado: pendente|pronta|em-andamento|feita|bloqueada, atualizadoEm } ] }. Dono "qwen:*" não é acordado aqui
// (a escada cuida); o vigia só registra no log.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const AGENTES = ['claude', 'codex'];
const config = require('./fofoqueiro.json');
const RAIZ = path.resolve(__dirname, '..');
const PASTA_CANAL = process.env.MIXAI_CANAL_DIR || path.join('D:', 'MixAI-coordenacao');
const ARQ_CANAL = path.join(PASTA_CANAL, 'coordenacao.md');
const ARQ_GRAFO = path.join(PASTA_CANAL, 'grafo.json');
const ARQ_ESTADO = path.join(PASTA_CANAL, 'fofoqueiro-estado.json');
const ARQ_LOG = path.join(PASTA_CANAL, 'fofoqueiro.log');
const ARQ_TRAVA = path.join(PASTA_CANAL, 'fofoqueiro.trava');
const ARQ_SEM_COTA = path.join(__dirname, 'sem-cota.json');
const LIMITE = /\b(?:rate limit reached|usage limit|session limit|weekly limit|hit your\s+\w+\s+limit|limit will reset|quota exceeded|insufficient_quota)\b/i;
const PRAZO_PARADA_MIN = 30;

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const outro = (a) => (a === 'claude' ? 'codex' : 'claude');
const hash = (t) => crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 12);

// Última mensagem do canal ("### data — De → Para (...)"). Quem recebe é quem precisa agir.
function ultimaMensagem(texto) {
  const partes = String(texto).split(/^(?=### )/m).filter((p) => p.startsWith('### '));
  for (const p of partes.reverse()) {
    const m = p.split('\n', 1)[0].match(/^###\s+.+?\s[—–-]\s+(\w+)[^→\n]*→\s*([\wÀ-ÿ]+)/);
    if (!m) continue;
    const de = AGENTES.find((a) => norm(m[1]) === a);
    const para = AGENTES.find((a) => norm(m[2]) === a);
    return { de, para, titulo: p.split('\n', 1)[0].trim(), corpo: p, id: `canal:${hash(p)}` };
  }
  return null;
}

// Pendências do canal: só quando uma mensagem de um agente é dirigida ao outro.
function pendenciasDoCanal(texto) {
  const u = ultimaMensagem(texto);
  if (!u || !u.para || !u.de || u.de === u.para) return [];
  return [{ agente: u.para, id: u.id, motivo: `Nova mensagem no canal para você: ${u.titulo}`, trecho: u.corpo }];
}

// Pendências do GitHub: PR feito por um agente sem revisão do outro; PR com check vermelho volta ao autor.
function pendenciasDosPRs(prs) {
  const saida = [];
  for (const pr of prs || []) {
    const nomes = (pr.labels || []).map((l) => l.name);
    const feito = AGENTES.find((a) => nomes.includes(`feito-por:${a}`));
    if (!feito) continue;
    const revisor = outro(feito);
    const sha = String(pr.headRefOid || '').slice(0, 8);
    const falhou = (pr.statusCheckRollup || []).some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(String(c.conclusion || c.state || '').toUpperCase()));
    if (falhou) {
      saida.push({ agente: feito, id: `ci:${pr.number}:${sha}`, motivo: `PR #${pr.number} (${pr.title}) está com check vermelho; corrija.` });
    } else if (!nomes.includes(`revisado-por:${revisor}`)) {
      saida.push({ agente: revisor, id: `rev:${pr.number}:${sha}`, motivo: `PR #${pr.number} (${pr.title}) espera sua revisão adversária (feito por ${feito}).` });
    }
  }
  return saida;
}

// Pendências do grafo: tarefa cujas dependências estão feitas fica liberada; tarefa parada é cobrada do dono.
function pendenciasDoGrafo(grafo, agora, prazoMin = PRAZO_PARADA_MIN) {
  const tarefas = (grafo && Array.isArray(grafo.tarefas)) ? grafo.tarefas : [];
  const feitas = new Set(tarefas.filter((t) => t.estado === 'feita').map((t) => t.id));
  const saida = [];
  for (const t of tarefas) {
    if (!AGENTES.includes(t.dono)) continue;
    const livre = (t.depende || []).every((d) => feitas.has(d));
    if (t.estado === 'pendente' && livre) {
      saida.push({ agente: t.dono, id: `grafo:${t.id}:liberada`, motivo: `Tarefa ${t.id} (${t.descricao}) foi liberada: dependências feitas. Comece.` });
    } else if (['pronta', 'em-andamento'].includes(t.estado) && livre) {
      const parado = agora.getTime() - new Date(t.atualizadoEm || 0).getTime();
      if (parado > prazoMin * 60e3) {
        const faixa = Math.floor(agora.getTime() / (prazoMin * 60e3));
        saida.push({ agente: t.dono, id: `grafo:${t.id}:parada:${faixa}`, motivo: `Tarefa ${t.id} (${t.descricao}) está parada há mais de ${prazoMin} min. Continue ou diga no canal o que bloqueia.` });
      }
    }
  }
  return saida;
}

function lerJson(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}

function pausado(agente, agora) {
  const fim = lerJson(ARQ_SEM_COTA, {})[agente];
  return Boolean(fim) && new Date(fim).getTime() > agora.getTime();
}

// Decide o que disparar: sem repetir fingerprint, com espera mínima e teto por hora para cada agente.
function decidir(pendencias, estado, agora, cfg = config, estaPausado = () => false) {
  const t = agora.getTime();
  const visto = estado.visto || {};
  const disparos = estado.disparos || {};
  const escolhidas = [];
  for (const p of pendencias) {
    if (visto[p.id]) continue;
    const recentes = (disparos[p.agente] || []).filter((x) => t - new Date(x).getTime() < 3600e3);
    const ultimo = recentes.length ? Math.max(...recentes.map((x) => new Date(x).getTime())) : 0;
    if (estaPausado(p.agente)) continue;
    if (escolhidas.some((e) => e.agente === p.agente)) continue;
    if (recentes.length >= cfg.maxDisparosPorHora) continue;
    if (t - ultimo < cfg.esperaMinimaMinutos * 60e3) continue;
    escolhidas.push(p);
  }
  return escolhidas;
}

function registrar(estado, p, agora) {
  const t = agora.toISOString();
  const lim = agora.getTime() - 3600e3;
  const disparos = { ...(estado.disparos || {}) };
  disparos[p.agente] = [...(disparos[p.agente] || []).filter((x) => new Date(x).getTime() > lim), t];
  const visto = { ...(estado.visto || {}), [p.id]: t };
  const chaves = Object.keys(visto).sort((a, b) => visto[a].localeCompare(visto[b]));
  for (const k of chaves.slice(0, Math.max(0, chaves.length - 200))) delete visto[k];
  return { ...estado, visto, disparos };
}

const ehNoite = (agora, n = config.noite) => (n.inicio > n.fim ? agora.getHours() >= n.inicio || agora.getHours() < n.fim : agora.getHours() >= n.inicio && agora.getHours() < n.fim);

function log(msg) {
  try { fs.mkdirSync(PASTA_CANAL, { recursive: true }); fs.appendFileSync(ARQ_LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* log nunca derruba o vigia */ }
}

// Resumo de uma linha: o modelo local só de noite e só pelo rodar-local.js; se falhar, frase determinística.
function resumo(p, agora) {
  if (!config.resumoLocalDeNoite || !ehNoite(agora) || !p.trecho) return p.motivo;
  const r = spawnSync(`node "${path.join(RAIZ, 'local', 'rodar-local.js')}"`, {
    shell: true, encoding: 'utf8', timeout: 120e3, windowsHide: true,
    input: `Resuma em UMA linha em português: o que mudou e quem precisa agir.\n\n${p.trecho.slice(0, 3000)}`,
  });
  const linha = String(r.stdout || '').trim().split(/\r?\n/)[0];
  return r.status === 0 && linha ? `${p.motivo} Resumo: ${linha.slice(0, 300)}` : p.motivo;
}

function montarPrompt(p, agora) {
  return [
    `Você foi acordado pelo fofoqueiro (vigia automático do Fernando). ${resumo(p, agora)}`,
    `Leia AGENTS.md e o canal ${ARQ_CANAL} (inteiro, até o fim) e faça só o que cabe a você, seguindo o AGENTS.md.`,
    'Escreva a resposta ou o progresso no canal (uma seção por mensagem, com data, de quem para quem). Não faça merge de PR. Seja curto, em português.',
  ].join('\n');
}

function acordar(agente, prompt, cfg = config) {
  const r = spawnSync(cfg.comandos[agente], {
    shell: true, input: prompt, encoding: 'utf8', cwd: RAIZ, windowsHide: true,
    timeout: cfg.tempoMaximoDisparoMinutos * 60e3, maxBuffer: 20 * 1024 * 1024,
  });
  const saida = `${r.stdout || ''}${r.stderr || ''}`;
  return { status: r.status === null ? 1 : r.status, limite: LIMITE.test(saida), fim: saida.slice(-300).replace(/\s+/g, ' ') };
}

function listarPRs(cfg = config) {
  const r = spawnSync('gh', ['pr', 'list', '--repo', cfg.repo, '--state', 'open', '--json', 'number,title,headRefOid,labels,statusCheckRollup'],
    { encoding: 'utf8', timeout: 30e3, windowsHide: true });
  if (r.status !== 0) { log(`gh falhou: ${String(r.stderr).slice(0, 200)}`); return null; }
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Um passo do vigia. `deps` existe para os testes trocarem arquivo, gh e agentes por falsos.
function passo(deps) {
  const agora = deps.agora();
  let estado = deps.lerEstado();
  const pend = [...pendenciasDoCanal(deps.lerCanal()), ...pendenciasDoGrafo(deps.lerGrafo(), agora)];
  if (deps.verPRs(estado, agora)) {
    const prs = deps.listarPRs();
    if (prs) { pend.push(...pendenciasDosPRs(prs)); estado = { ...estado, ultimoGh: agora.toISOString() }; }
  }
  const escolhidas = decidir(pend, estado, agora, config, (a) => deps.pausado(a, agora));
  for (const p of escolhidas) {
    estado = registrar(estado, p, agora);
    deps.salvarEstado(estado); // grava antes de acordar: se o vigia cair no meio, não dispara de novo
    log(`acordando ${p.agente}: ${p.id}`);
    const r = deps.acordar(p.agente, montarPrompt(p, agora));
    log(`${p.agente} terminou status=${r.status}${r.limite ? ' (limite de cota)' : ''}: ${r.fim}`);
    if (r.limite) deps.semCota(p.agente);
  }
  const adiadas = pend.filter((p) => !(estado.visto || {})[p.id]).length;
  if (adiadas) log(`${adiadas} pendência(s) adiadas (espera, teto por hora ou agente sem cota)`);
  deps.salvarEstado(estado);
  return escolhidas;
}

function depsReais() {
  return {
    agora: () => new Date(),
    lerEstado: () => lerJson(ARQ_ESTADO, {}),
    salvarEstado: (e) => { fs.mkdirSync(PASTA_CANAL, { recursive: true }); fs.writeFileSync(ARQ_ESTADO, JSON.stringify(e, null, 2)); },
    lerCanal: () => { try { return fs.readFileSync(ARQ_CANAL, 'utf8'); } catch { return ''; } },
    lerGrafo: () => lerJson(ARQ_GRAFO, { tarefas: {} }),
    verPRs: (estado, agora) => !estado.ultimoGh || agora.getTime() - new Date(estado.ultimoGh).getTime() >= config.intervaloGhSegundos * 1000,
    listarPRs: () => listarPRs(),
    acordar: (a, prompt) => acordar(a, prompt),
    pausado: (a, agora) => pausado(a, agora),
    semCota: (a) => spawnSync('node', [path.join(__dirname, 'chamar.js'), 'sem-cota', a], { encoding: 'utf8', windowsHide: true }),
  };
}

// Trava de instância única: um vigia por vez. Trava de processo morto é retomada.
function pegarTrava() {
  fs.mkdirSync(PASTA_CANAL, { recursive: true });
  const velho = Number(lerJson(ARQ_TRAVA, {}).pid);
  if (velho && velho !== process.pid) {
    try { process.kill(velho, 0); return false; } catch (e) { if (e.code === 'EPERM') return false; }
  }
  fs.writeFileSync(ARQ_TRAVA, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
  return true;
}

async function principal(args) {
  if (!pegarTrava()) { console.error('Já existe um fofoqueiro rodando.'); return 1; }
  const deps = depsReais();
  process.on('exit', () => { try { if (lerJson(ARQ_TRAVA, {}).pid === process.pid) fs.unlinkSync(ARQ_TRAVA); } catch { /* ok */ } });
  log('fofoqueiro ligado');
  if (args.includes('--uma-vez')) { passo(deps); return 0; }
  for (;;) {
    try { passo(deps); } catch (e) { log(`erro no passo: ${e.message}`); }
    await new Promise((ok) => setTimeout(ok, config.intervaloSegundos * 1000));
  }
}

module.exports = { ultimaMensagem, pendenciasDoCanal, pendenciasDosPRs, pendenciasDoGrafo, decidir, registrar, ehNoite, passo };
if (require.main === module) principal(process.argv.slice(2)).then((c) => { process.exitCode = c; });

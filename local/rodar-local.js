// Porta de entrada única para o modelo local: a escada e o chamar.js passam por aqui.
// 1. Confere a memória livre do Windows. Com pouca memória a placa de vídeo não consegue reservar espaço,
//    o modelo não carrega e o PC trava; então sai com erro e a tarefa sobe na escada.
// 2. Carrega o mixai-local sem tarefa e confere se ele ficou inteiro na placa. Se parte dele foi para o
//    processador, descarrega na hora e sai com erro, antes de rodar qualquer tarefa
//    (o num_gpu 99 pede a placa, mas sozinho não garante).
// 3. Só então roda a tarefa. Lê a tarefa da entrada padrão e devolve a resposta na saída padrão.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MODELO = 'mixai-local';
const SAIDA_SEM_MEMORIA = 75;
const SAIDA_FORA_DA_PLACA = 76;
const GB = 1024 ** 3;
// Logo depois de o Ollama reiniciar, a primeira carga na placa às vezes falha por falta de espaço
// e a segunda funciona. Por isso tenta carregar mais uma vez, só nesse caso.
const FALTA_DE_ESPACO = /out-of-memory|failed to allocate|out of memory/i;
const ESPERA_ANTES_DE_REPETIR_MS = Number(process.env.MIXAI_ESPERA_MS ?? 5000);
const SERVIDOR = process.env.MIXAI_OLLAMA_URL || 'http://localhost:11434';

function minimoGB() {
  if (process.env.MIXAI_MEMORIA_MINIMA_GB !== undefined) return Number(process.env.MIXAI_MEMORIA_MINIMA_GB);
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'protecao.json'), 'utf8')).memoriaLivreMinimaGB;
}

// RAM do Windows que o processo do modelo (llama-server) usa de verdade agora, em bytes; 0 se não der para medir.
// Não vale o `size` do /api/ps: ele é o tamanho do modelo, que pode estar todo na placa sem gastar RAM.
function ramDoRunner() {
  if (process.env.MIXAI_RAM_RUNNER_GB !== undefined) return Number(process.env.MIXAI_RAM_RUNNER_GB) * GB;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 });
      let kb = 0;
      for (const linha of String(r.stdout || '').split(/\r?\n/)) {
        const campos = linha.match(/"([^"]*)"/g);
        if (campos && campos.length >= 5) kb += Number(campos[4].replace(/[^0-9]/g, '')) || 0;
      }
      return kb * 1024;
    }
    const r = spawnSync('ps', ['-C', 'llama-server', '-o', 'rss='], { encoding: 'utf8', timeout: 5000 });
    return String(r.stdout || '').split(/\s+/).reduce((s, x) => s + (Number(x) || 0), 0) * 1024;
  } catch {
    return 0;
  }
}

// Memória que o próprio mixai-local já ocupa, se o /api/ps o mostra carregado: ela já saiu da memória livre do
// Windows, então sem este crédito o guarda recusaria toda chamada depois da primeira. O crédito é a RAM medida
// do processo do modelo, nunca mais que o `size` dele. Qualquer falha ao consultar ou medir vale 0.
async function memoriaDoModeloCarregado() {
  try {
    const r = await fetch(`${SERVIDOR}/api/ps`);
    if (!r.ok) return 0;
    const lista = await r.json();
    const m = Array.isArray(lista && lista.models) && lista.models.find((x) => x.name === MODELO || x.name === `${MODELO}:latest`);
    if (!m || typeof m.size !== 'number' || m.size <= 0) return 0;
    return Math.max(0, Math.min(m.size, ramDoRunner()));
  } catch {
    return 0;
  }
}

// Com o modelo já carregado não há carga nova, mas a RAM livre sozinha não pode passar de um piso: se outro programa
// esvaziou a máquina, nenhum crédito libera a chamada.
const PISO_LIVRE_GB = 0.25;

async function memoriaSuficiente() {
  const livreGB = process.env.MIXAI_MEMORIA_LIVRE_GB !== undefined ? Number(process.env.MIXAI_MEMORIA_LIVRE_GB) : os.freemem() / GB;
  const minimo = minimoGB();
  const doModeloGB = livreGB >= PISO_LIVRE_GB ? (await memoriaDoModeloCarregado()) / GB : 0;
  if (livreGB + doModeloGB >= minimo) return true;
  console.error(`Modelo local não chamado: memória livre ${livreGB.toFixed(1)} GB (mais ${doModeloGB.toFixed(1)} GB do modelo já carregado), mínimo ${minimo} GB. A tarefa passa para o próximo da escada.`);
  return false;
}
// Carrega o modelo sem rodar tarefa (pedido sem prompt). Devolve null se carregou; senão, o erro.
async function carregar() {
  try {
    const r = await fetch(`${SERVIDOR}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODELO }) });
    return r.ok ? null : await r.text();
  } catch (erro) {
    return `servidor do Ollama não respondeu (${erro.message})`;
  }
}

// Devolve null se o modelo está carregado inteiro na placa; senão, o motivo.
async function foraDaPlaca() {
  let lista;
  try {
    const r = await fetch(`${SERVIDOR}/api/ps`);
    if (!r.ok) return `não deu para conferir onde o modelo carregou (resposta ${r.status})`;
    lista = await r.json();
  } catch (erro) {
    return `não deu para conferir onde o modelo carregou (${erro.message})`;
  }
  const m = Array.isArray(lista && lista.models) && lista.models.find((x) => x.name === MODELO || x.name === `${MODELO}:latest`);
  if (!m || typeof m.size !== 'number' || typeof m.size_vram !== 'number') return 'não deu para confirmar que o modelo carregou na placa';
  if (m.size_vram >= m.size) return null;
  const pct = Math.round((100 * (m.size - m.size_vram)) / m.size);
  return `${pct}% do modelo foi para o processador`;
}

async function descarregar() {
  try {
    await fetch(`${SERVIDOR}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODELO, keep_alive: 0 }) });
  } catch (erro) {
    // se nem o servidor responde, não há o que descarregar
  }
}

function chamarOllama(tarefa) {
  const ollama = process.env.MIXAI_OLLAMA || 'ollama';
  return new Promise((resolve) => {
    const filho = spawn(`${ollama} run ${MODELO}`, { shell: true });
    let stdout = '';
    let stderr = '';
    filho.stdout.on('data', (d) => { stdout += d; });
    filho.stderr.on('data', (d) => { stderr += d; });
    filho.on('error', (erro) => resolve({ status: 1, stdout, stderr: `${stderr}Não foi possível chamar o Ollama: ${erro.message}\n` }));
    filho.on('close', (codigo) => resolve({ status: codigo === null ? 1 : codigo, stdout, stderr }));
    filho.stdin.on('error', () => {});
    filho.stdin.end(tarefa);
  });
}

async function principal() {
  const tarefa = fs.readFileSync(0, 'utf8');
  if (!(await memoriaSuficiente())) return SAIDA_SEM_MEMORIA;

  let erro = await carregar();
  if (erro && FALTA_DE_ESPACO.test(erro)) {
    await new Promise((ok) => setTimeout(ok, ESPERA_ANTES_DE_REPETIR_MS));
    if (!(await memoriaSuficiente())) return SAIDA_SEM_MEMORIA;
    erro = await carregar();
  }
  if (erro) {
    console.error(`Modelo local não carregou: ${erro}`);
    return 1;
  }

  const motivo = await foraDaPlaca();
  if (motivo) {
    await descarregar();
    console.error(`Modelo local descarregado sem rodar a tarefa: ${motivo}. Ele só pode rodar inteiro na placa de vídeo; a tarefa passa para o próximo da escada.`);
    return SAIDA_FORA_DA_PLACA;
  }

  const r = await chamarOllama(tarefa);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) return r.status;
  process.stdout.write(r.stdout);
  return 0;
}

principal().then((codigo) => { process.exitCode = codigo; });

// Porta de entrada única para o modelo local: a escada e o chamar.js passam por aqui.
// Antes de carregar o mixai-local, confere a memória livre do Windows. Com pouca memória a placa de vídeo
// não consegue reservar espaço, o modelo não carrega e o PC trava; então sai com erro e a tarefa sobe na escada.
// Depois da resposta, confere se o modelo ficou inteiro na placa. Se parte dele foi para o processador,
// descarrega na hora e sai com erro (o num_gpu 99 pede a placa, mas sozinho não garante).
// Lê a tarefa da entrada padrão e devolve a resposta do modelo na saída padrão.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODELO = 'mixai-local';
const SAIDA_SEM_MEMORIA = 75;
const SAIDA_FORA_DA_PLACA = 76;
const GB = 1024 ** 3;
// Logo depois de o Ollama reiniciar, a primeira carga na placa às vezes falha por falta de espaço
// e a segunda funciona. Por isso tenta mais uma vez, só nesse caso.
const FALTA_DE_ESPACO = /out-of-memory|failed to allocate|out of memory/i;
const ESPERA_ANTES_DE_REPETIR_MS = Number(process.env.MIXAI_ESPERA_MS ?? 5000);
const SERVIDOR = process.env.MIXAI_OLLAMA_URL || 'http://localhost:11434';

function minimoGB() {
  if (process.env.MIXAI_MEMORIA_MINIMA_GB !== undefined) return Number(process.env.MIXAI_MEMORIA_MINIMA_GB);
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'protecao.json'), 'utf8')).memoriaLivreMinimaGB;
}

function memoriaSuficiente() {
  const livreGB = os.freemem() / GB;
  const minimo = minimoGB();
  if (livreGB >= minimo) return true;
  console.error(`Modelo local não chamado: memória livre ${livreGB.toFixed(1)} GB, mínimo ${minimo} GB. A tarefa passa para o próximo da escada.`);
  return false;
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

// Devolve null se o modelo está inteiro na placa; senão, o motivo.
async function foraDaPlaca() {
  let lista;
  try {
    lista = await (await fetch(`${SERVIDOR}/api/ps`)).json();
  } catch (erro) {
    return `não deu para conferir onde o modelo carregou (${erro.message})`;
  }
  const m = (lista.models || []).find((x) => x.name === MODELO || x.name === `${MODELO}:latest`);
  if (!m) return null; // já descarregou: não está ocupando o processador
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

async function principal() {
  const tarefa = fs.readFileSync(0, 'utf8');
  if (!memoriaSuficiente()) return SAIDA_SEM_MEMORIA;
  let r = await chamarOllama(tarefa);
  if (r.status !== 0 && FALTA_DE_ESPACO.test(r.stderr)) {
    await new Promise((ok) => setTimeout(ok, ESPERA_ANTES_DE_REPETIR_MS));
    if (!memoriaSuficiente()) return SAIDA_SEM_MEMORIA;
    r = await chamarOllama(tarefa);
  }
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) return r.status;
  const motivo = await foraDaPlaca();
  if (motivo) {
    await descarregar();
    console.error(`Modelo local descarregado: ${motivo}. Ele só pode rodar inteiro na placa de vídeo; a tarefa passa para o próximo da escada.`);
    return SAIDA_FORA_DA_PLACA;
  }
  process.stdout.write(r.stdout);
  return 0;
}

principal().then((codigo) => { process.exitCode = codigo; });

// Porta de entrada única para o modelo local: a escada e o chamar.js passam por aqui.
// Antes de carregar o mixai-local, confere a memória livre do Windows. Com pouca memória a placa de vídeo
// não consegue reservar espaço, o modelo não carrega e o PC trava; então sai com erro e a tarefa sobe na escada.
// Lê a tarefa da entrada padrão e devolve a resposta do modelo na saída padrão.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SAIDA_SEM_MEMORIA = 75;
const GB = 1024 ** 3;
// Logo depois de o Ollama reiniciar, a primeira carga na placa às vezes falha por falta de espaço
// e a segunda funciona. Por isso tenta mais uma vez, só nesse caso.
const FALTA_DE_ESPACO = /out-of-memory|failed to allocate|out of memory/i;
const ESPERA_ANTES_DE_REPETIR_MS = Number(process.env.MIXAI_ESPERA_MS ?? 5000);

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
  return spawnSync(`${ollama} run mixai-local`, { shell: true, input: tarefa, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

const tarefa = fs.readFileSync(0, 'utf8');
if (!memoriaSuficiente()) process.exit(SAIDA_SEM_MEMORIA);
let r = chamarOllama(tarefa);
if (r.status !== 0 && FALTA_DE_ESPACO.test(r.stderr || '')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ESPERA_ANTES_DE_REPETIR_MS);
  if (!memoriaSuficiente()) process.exit(SAIDA_SEM_MEMORIA);
  r = chamarOllama(tarefa);
}
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.error) console.error(`Não foi possível chamar o Ollama: ${r.error.message}`);
process.exit(r.status === null ? 1 : r.status);

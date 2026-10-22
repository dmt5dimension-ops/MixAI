const fs = require('node:fs');
const path = require('node:path');

function normalizar(caminho, permitirRaiz = false) {
  if (typeof caminho !== 'string' || !caminho.trim()) return null;
  const barras = caminho.replace(/\\/g, '/');
  if (barras.startsWith('/') || /^[a-zA-Z]:/.test(barras) || barras.includes(':') || barras.includes('\0')) return null;
  for (const segmento of barras.split('/')) {
    const base = segmento.split('.')[0].replace(/[ .]+$/, '');
    if (/^(con|nul|prn|aux|com[1-9]|lpt[1-9])$/i.test(base)) return null;
    if (segmento !== '.' && segmento !== '..' && /[ .]$/.test(segmento)) return null;
  }
  const relativo = path.posix.normalize(barras).replace(/\/+$/, '') || '.';
  if (relativo === '..' || relativo.startsWith('../')) return null;
  if (relativo === '.' && !permitirRaiz) return null;
  return relativo;
}

function entradasDoEscopo(escopo) {
  if (!Array.isArray(escopo)) return [];
  return escopo.flatMap((entrada) => {
    if (typeof entrada !== 'string' || entrada.replace(/\\/g, '/').split('/').includes('..')) return [];
    const nome = normalizar(entrada, true);
    if (nome === null) return [];
    // Pasta exige barra final; nomes sem extensão também podem ser arquivos.
    const pasta = nome === '.' || /[\\/]$/.test(entrada);
    return [{ nome: comparar(nome), pasta }];
  });
}

function comparar(nome) {
  return process.platform === 'win32' ? nome.toLowerCase() : nome;
}

function permitido(entradas, arquivo) {
  const nome = normalizar(arquivo);
  if (nome === null) return false;
  const comparado = comparar(nome);
  return entradas.some((entrada) => comparado === entrada.nome ||
    (entrada.pasta && (entrada.nome === '.' || comparado.startsWith(entrada.nome + '/'))));
}

function conferirAlterados(escopo, alterados) {
  const entradas = entradasDoEscopo(escopo);
  return alterados.filter((arquivo) => !permitido(entradas, arquivo));
}

function dentroDaRaiz(raiz, destino) {
  const relativo = path.relative(raiz, destino);
  return relativo === '' || (relativo !== '..' && !relativo.startsWith('..' + path.sep) && !path.isAbsolute(relativo));
}

function caminhoComCaixaExistente(raiz, segmentos) {
  let atual = raiz;
  for (let i = 0; i < segmentos.length; i++) {
    const segmento = segmentos[i];
    const existentes = fs.readdirSync(atual, { withFileTypes: true });
    const iguais = existentes.filter((item) => comparar(item.name) === comparar(segmento));
    if (iguais.length > 1) throw new Error(`Nome ambíguo: ${segmento}`);
    atual = path.join(atual, iguais.length ? iguais[0].name : segmento);
    const estado = fs.lstatSync(atual, { throwIfNoEntry: false });
    if (estado?.isSymbolicLink()) {
      throw new Error(`Link simbólico fora do limite: ${atual}`);
    }
    if (!estado) {
      // Ainda não há subpasta: os demais segmentos mantêm a caixa recebida.
      return path.join(atual, ...segmentos.slice(i + 1));
    }
  }
  return atual;
}

function aplicarResposta({ raiz, escopo, arquivo, conteudo }) {
  if (typeof raiz !== 'string' || typeof arquivo !== 'string' || typeof conteudo !== 'string') {
    throw new TypeError('raiz, arquivo e conteudo precisam ser texto.');
  }
  const raizReal = fs.realpathSync(raiz);
  if (!fs.statSync(raizReal).isDirectory()) throw new Error('raiz precisa ser uma pasta.');

  let relativo;
  if (path.isAbsolute(arquivo)) {
    const absoluto = path.resolve(arquivo);
    if (!dentroDaRaiz(raizReal, absoluto)) throw new Error('Arquivo fora da raiz.');
    relativo = normalizar(path.relative(raizReal, absoluto));
  } else {
    relativo = normalizar(arquivo);
  }
  if (relativo === null || !permitido(entradasDoEscopo(escopo), relativo)) {
    throw new Error('Arquivo fora do escopo ou da raiz.');
  }

  const segmentos = relativo.split('/');
  const destino = caminhoComCaixaExistente(raizReal, segmentos);
  const pasta = path.dirname(destino);
  fs.mkdirSync(pasta, { recursive: true });
  if (!dentroDaRaiz(raizReal, fs.realpathSync(pasta))) throw new Error('Arquivo fora da raiz.');
  if (fs.existsSync(destino) && fs.lstatSync(destino).isSymbolicLink()) {
    throw new Error('Arquivo aponta para um link simbólico.');
  }
  fs.writeFileSync(destino, conteudo, 'utf8');
  return destino;
}

module.exports = { aplicarResposta, conferirAlterados };

// Prepara o material para treinar o Qwen local (LoRA) a partir dos casos que a escada registrou.
// Só limpa e separa os dados: o treino em si roda no PC do dono, fora daqui.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { lerCasos, paraTreino } = require('./escada.js');
const { MODELO_PADRAO, casosDoModelo, sufixoDeArquivo } = require('./por-modelo.js');

const pasta = __dirname;
const ARQUIVOS = {
  casos: path.join(pasta, 'casos', 'casos.jsonl'),
  treino: path.join(pasta, 'casos', 'treino.jsonl'),
  validacao: path.join(pasta, 'casos', 'validacao.jsonl'),
  relatorio: path.join(pasta, 'casos', 'relatorio-treino.json'),
};

// Padrões de segredo: um caso que contenha qualquer um deles nunca vai para o treino.
const SEGREDOS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/i,
  /\bAuthorization\s*[:=]\s*\S{8,}/i,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:senha|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

const PADRAO = { validacao: 0.1, maxChars: 6000, minimo: 20 };

function hash(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

function temSegredo(texto) {
  return SEGREDOS.some((re) => re.test(texto));
}

function motivoDeDescarte(caso, maxChars) {
  const entrada = typeof caso?.entrada === 'string' ? caso.entrada.trim() : '';
  const saida = typeof caso?.saida === 'string' ? caso.saida.trim() : '';
  if (!entrada || !saida) return 'sem entrada ou sem saída';
  // o registro inteiro (regra, motivos etc.), não só entrada e saída: nada com credencial chega ao treino.jsonl
  if (temSegredo(entrada) || temSegredo(saida) || temSegredo(JSON.stringify(caso))) return 'parece conter segredo';
  if (entrada.length + saida.length > maxChars) return 'grande demais para o contexto do modelo local';
  return null;
}

// Separa treino e validação pelo hash da entrada: o mesmo caso cai sempre do mesmo lado, mesmo com casos novos chegando.
function ladoDe(entrada, fracaoValidacao) {
  const n = parseInt(hash(entrada).slice(0, 8), 16) / 0x100000000;
  return n < fracaoValidacao ? 'validacao' : 'treino';
}

function prepararDataset(casos, opcoes = {}) {
  const { validacao: fracao, maxChars, minimo } = { ...PADRAO, ...opcoes };
  const descartados = [];
  const porEntrada = new Map(); // entrada -> caso; o mais recente vence
  casos.forEach((caso, i) => {
    const motivo = motivoDeDescarte(caso, maxChars);
    if (motivo) { descartados.push({ indice: i, id: caso?.id ?? null, motivo }); return; }
    const chave = hash(caso.entrada.trim());
    const anterior = porEntrada.get(chave);
    if (anterior) {
      const igual = anterior.caso.saida.trim() === caso.saida.trim();
      descartados.push({ indice: anterior.indice, id: anterior.caso.id ?? null, motivo: igual ? 'repetido' : 'substituído por caso mais novo com a mesma entrada' });
    }
    porEntrada.set(chave, { indice: i, caso });
  });
  const treino = [];
  const validacao = [];
  for (const { caso } of porEntrada.values()) {
    const limpo = { ...caso, entrada: caso.entrada.trim(), saida: caso.saida.trim() };
    (ladoDe(limpo.entrada, fracao) === 'validacao' ? validacao : treino).push(paraTreino(limpo));
  }
  const porQuem = {};
  for (const { caso } of porEntrada.values()) porQuem[caso.resolvidoPor || 'desconhecido'] = (porQuem[caso.resolvidoPor || 'desconhecido'] || 0) + 1;
  const motivos = {};
  for (const d of descartados) motivos[d.motivo] = (motivos[d.motivo] || 0) + 1;
  const resumo = {
    lidos: casos.length,
    aproveitados: treino.length + validacao.length,
    treino: treino.length,
    validacao: validacao.length,
    descartados: descartados.length,
    motivos,
    porQuem,
    pronto: treino.length >= minimo,
    minimo,
  };
  return { treino, validacao, descartados, resumo };
}

function gravarJsonl(arquivo, itens) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, itens.map((i) => JSON.stringify(i)).join('\n') + (itens.length ? '\n' : ''));
}

// Com `modelo`, só os casos desse modelo entram e os arquivos ganham o nome dele (treino.<modelo>.jsonl);
// sem ele, vale o Qwen e os nomes de sempre.
function preparar(arquivos = ARQUIVOS, opcoes = {}) {
  const { modelo = MODELO_PADRAO, ...resto } = opcoes;
  const sufixo = sufixoDeArquivo(modelo);
  const comSufixo = (arq) => (sufixo ? arq.replace(/(\.[^.\\/]+)$/, `${sufixo}$1`) : arq);
  const r = prepararDataset(casosDoModelo(lerCasos(arquivos.casos), modelo), resto);
  gravarJsonl(comSufixo(arquivos.treino), r.treino);
  gravarJsonl(comSufixo(arquivos.validacao), r.validacao);
  fs.writeFileSync(comSufixo(arquivos.relatorio), JSON.stringify({ modelo, resumo: r.resumo, descartados: r.descartados }, null, 2) + '\n');
  return r.resumo;
}

function principal(argumentos) {
  const [comando, ...resto] = argumentos;
  if (comando === 'preparar') {
    const iMin = resto.indexOf('--minimo');
    const iMod = resto.indexOf('--modelo');
    const opcoes = { ...(iMin >= 0 ? { minimo: Number(resto[iMin + 1]) } : {}), ...(iMod >= 0 ? { modelo: resto[iMod + 1] } : {}) };
    const r = preparar(ARQUIVOS, opcoes);
    console.log(`${r.aproveitados} de ${r.lidos} casos aproveitados (${r.treino} treino, ${r.validacao} validação); ${r.descartados} descartados.`);
    if (!r.pronto) console.log(`Ainda é pouco para treinar: precisa de pelo menos ${r.minimo} exemplos de treino.`);
    return r.pronto ? 0 : 2;
  }
  console.error('Uso: node orquestra/treino.js preparar [--minimo N] [--modelo <nome>]');
  return 1;
}

if (require.main === module) process.exit(principal(process.argv.slice(2)));

module.exports = { prepararDataset, preparar, temSegredo, ladoDe, ARQUIVOS };

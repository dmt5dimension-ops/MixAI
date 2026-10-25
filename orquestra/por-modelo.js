// Regras e casos por modelo. A mesma escada serve vários alunos (Qwen, outros modelos locais, o aluno estático).
// Regra com `modelos: ["a","b"]` só vale para esses; sem o campo, vale para todos (como as regras de antes).
// Caso com `modelo` conta só para o treino desse modelo; sem o campo é do Qwen (mixai-local), que era o único.
const crypto = require('node:crypto');

const MODELO_PADRAO = 'mixai-local';

function nomeValido(modelo) {
  if (typeof modelo !== 'string' || !modelo.trim()) throw new Error('modelo sem nome');
  return modelo.trim();
}

function regraVale(regra, modelo) {
  const m = nomeValido(modelo);
  if (regra.modelos === undefined) return true;
  return Array.isArray(regra.modelos) && regra.modelos.includes(m); // campo estranho nunca vale (não vaza regra para outro modelo)
}

function regrasDoModelo(regras, modelo) {
  return regras.filter((r) => regraVale(r, modelo));
}

// Só a AUSÊNCIA do campo significa registro antigo (do Qwen); campo presente e inválido ("", 0, null) não é de ninguém.
function casoDoModelo(caso, modelo) {
  const alvo = nomeValido(modelo);
  if (!Object.hasOwn(caso, 'modelo') || caso.modelo === undefined) return alvo === MODELO_PADRAO;
  return typeof caso.modelo === 'string' && caso.modelo.trim() !== '' && caso.modelo.trim() === alvo;
}

function casosDoModelo(casos, modelo) {
  return casos.filter((c) => casoDoModelo(c, modelo));
}

// Nome de modelo vira parte de nome de arquivo: só letras minúsculas, números, ponto, hífen e sublinhado, MAIS um hash do nome
// exato. O hash (curto) faz com que nomes diferentes, na prática, não caiam no mesmo arquivo ("gemma3:1b" x "gemma3/1b", ou "Gemma" x "gemma" em
// sistema de arquivos sem diferença de caixa, como o do Windows).
function sufixoDeArquivo(modelo) {
  const m = nomeValido(modelo);
  if (m === MODELO_PADRAO) return '';
  const legivel = m.replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase().slice(0, 40);
  const hash = crypto.createHash('sha256').update(m).digest('hex').slice(0, 8);
  return `.${legivel}-${hash}`;
}

module.exports = { MODELO_PADRAO, regraVale, regrasDoModelo, casoDoModelo, casosDoModelo, sufixoDeArquivo };

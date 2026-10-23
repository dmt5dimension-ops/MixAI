// Regras e casos por modelo. A mesma escada serve vários alunos (Qwen, outros modelos locais, o aluno estático).
// Regra com `modelos: ["a","b"]` só vale para esses; sem o campo, vale para todos (como as regras de antes).
// Caso com `modelo` conta só para o treino desse modelo; sem o campo é do Qwen (mixai-local), que era o único.
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

function casoDoModelo(caso, modelo) {
  return (caso.modelo || MODELO_PADRAO) === nomeValido(modelo);
}

function casosDoModelo(casos, modelo) {
  return casos.filter((c) => casoDoModelo(c, modelo));
}

// Nome de modelo vira parte de nome de arquivo: só letras, números, ponto, hífen e sublinhado.
function sufixoDeArquivo(modelo) {
  const m = nomeValido(modelo);
  return m === MODELO_PADRAO ? '' : `.${m.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

module.exports = { MODELO_PADRAO, regraVale, regrasDoModelo, casoDoModelo, casosDoModelo, sufixoDeArquivo };

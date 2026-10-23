// Fase 3 do pipeline do Qwen: mede se cada regra de regras-locais.json ajuda de verdade.
// Para cada regra, pega os exemplos em que ela dispararia (mesma escolha da escada) e compara o acerto do agente
// SEM a regra no prompt com o acerto COM ela. Só a medida decide: regra que não ajuda é candidata a sair.
const fs = require('node:fs');
const path = require('node:path');
const { escolherRegras, montarPrompt } = require('./escada.js');
const { avaliar, lerValidacao } = require('./avaliar.js');

const REGRAS = path.join(__dirname, 'regras-locais.json');

function veredito(sem, com) {
  if (com.acertos > sem.acertos) return 'ajuda';
  if (com.acertos < sem.acertos) return 'piora';
  return 'neutra';
}

// `agente(prompt)` é injetado (o modelo local ou um falso). Devolve um item por regra.
async function medirRegras({ regras, exemplos, agente, minimo = 5 }) {
  const itens = [];
  for (const regra of regras.filter((r) => r.status === 'confirmada')) {
    const dela = exemplos.filter((e) => escolherRegras([regra], e.entrada).length > 0);
    if (dela.length < minimo) {
      itens.push({ id: regra.id, veredito: 'sem exemplos suficientes', exemplos: dela.length, minimo });
      continue;
    }
    const sem = await avaliar(dela, (entrada) => agente(montarPrompt(entrada, [])));
    const com = await avaliar(dela, (entrada) => agente(montarPrompt(entrada, [regra])));
    itens.push({ id: regra.id, veredito: veredito(sem, com), exemplos: dela.length, sem: sem.acertos, com: com.acertos });
  }
  return itens;
}

async function principal(argumentos) {
  const [comando, arquivo] = argumentos;
  if (comando !== 'rodar' || !arquivo) {
    console.error('Uso: node orquestra/medir-regras.js rodar <validacao.jsonl>');
    return 1;
  }
  const { chamarComando } = require('./escada.js');
  const chamar = chamarComando(`node "${path.join(__dirname, '..', 'local', 'rodar-local.js')}"`);
  const regras = JSON.parse(fs.readFileSync(REGRAS, 'utf8')).regras;
  const itens = await medirRegras({ regras, exemplos: lerValidacao(path.resolve(arquivo)), agente: (p) => chamar(p) });
  for (const i of itens) console.log(i.sem === undefined ? `${i.id}: ${i.veredito} (${i.exemplos} de ${i.minimo} necessários)` : `${i.id}: ${i.veredito} (sem regra ${i.sem}/${i.exemplos}, com regra ${i.com}/${i.exemplos})`);
  return 0;
}

if (require.main === module) principal(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });

module.exports = { medirRegras, veredito };

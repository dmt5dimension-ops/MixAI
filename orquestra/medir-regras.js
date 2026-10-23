// Fase 3 do pipeline do Qwen: mede se cada regra de regras-locais.json ajuda de verdade.
// Para cada regra, pega os exemplos em que ela dispararia (mesma escolha da escada) e compara o acerto do agente
// SEM a regra no prompt com o acerto COM ela. Só a medida decide: regra que não ajuda é candidata a sair.
const fs = require('node:fs');
const path = require('node:path');
const { escolherRegras, montarPrompt } = require('./escada.js');
const { avaliar, lerValidacao } = require('./avaliar.js');
const { MODELO_PADRAO, regrasDoModelo } = require('./por-modelo.js');

const REGRAS = path.join(__dirname, 'regras-locais.json');

function veredito(sem, com) {
  if (com.acertos > sem.acertos) return 'ajuda';
  if (com.acertos < sem.acertos) return 'piora';
  return 'neutra';
}

// `agente(prompt)` é injetado (o modelo local ou um falso). Devolve um item por regra.
// A medida é a que vale na escada real: para cada exemplo, o prompt SEM a regra alvo leva todas as OUTRAS regras que
// disparariam para ele, e o prompt COM a regra alvo leva essas mesmas mais a alvo. Assim a interação entre regras entra na conta.
// Se o agente falhar (memória, placa) em qualquer chamada, a regra fica "sem medida": falta de recurso não vira "piora" nem "ajuda".
// Só contam as regras que valem para o `modelo` medido.
async function medirRegras({ regras, exemplos, agente, minimo = 5, modelo = MODELO_PADRAO }) {
  const confirmadas = regrasDoModelo(regras, modelo).filter((r) => r.status === 'confirmada');
  const itens = [];
  for (const regra of confirmadas) {
    const dela = exemplos.filter((e) => escolherRegras([regra], e.entrada).length > 0);
    if (dela.length < minimo) {
      itens.push({ id: regra.id, veredito: 'sem exemplos suficientes', exemplos: dela.length, minimo });
      continue;
    }
    let falhas = 0;
    const protegido = async (prompt) => {
      try { return await agente(prompt); } catch (erro) { falhas++; throw erro; }
    };
    const aplicaveis = (entrada, comAlvo) => escolherRegras(confirmadas.filter((r) => r === regra ? comAlvo : true), entrada);
    const sem = await avaliar(dela, (entrada) => protegido(montarPrompt(entrada, aplicaveis(entrada, false))));
    const com = await avaliar(dela, (entrada) => protegido(montarPrompt(entrada, aplicaveis(entrada, true))));
    if (falhas) itens.push({ id: regra.id, veredito: 'sem medida', exemplos: dela.length, falhas });
    else itens.push({ id: regra.id, veredito: veredito(sem, com), exemplos: dela.length, sem: sem.acertos, com: com.acertos });
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
  for (const i of itens) console.log(i.falhas ? `${i.id}: sem medida (o agente falhou ${i.falhas} vez(es); repita quando a máquina estiver livre)` : i.sem === undefined ? `${i.id}: ${i.veredito} (${i.exemplos} de ${i.minimo} necessários)` : `${i.id}: ${i.veredito} (sem regra ${i.sem}/${i.exemplos}, com regra ${i.com}/${i.exemplos})`);
  return 0;
}

if (require.main === module) principal(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });

module.exports = { medirRegras, veredito };

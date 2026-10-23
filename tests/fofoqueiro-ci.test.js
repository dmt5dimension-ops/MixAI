// Etapa 3 do supervisor: tarefa em revisão cujo PR ficou vermelho volta a em_andamento no grafo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grafo = require('../orquestra/grafo.js');
const vigia = require('../orquestra/fofoqueiro.js');

const AGORA = new Date('2026-10-23T14:00:00.000Z');
const CFG = { esperaMinimaMinutos: 10, prazoParadaMinutos: 30, maxDisparosPorHora: 4 };
const pr = (number, falhou, sha = 'aaaaaaaa11111111') => ({ number, headRefOid: sha, labels: [{ name: 'feito-por:codex' }], statusCheckRollup: [{ conclusion: falhou ? 'FAILURE' : 'SUCCESS' }] });

function grafoEmRevisao(resultado) {
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: 'a', titulo: 'A', agente: 'codex', escopo: ['src/a.js'] }, AGORA.toISOString());
  g = grafo.iniciar(g, 'a', 'codex', AGORA.toISOString());
  return grafo.revisar(g, 'a', resultado, AGORA.toISOString());
}

test('devolucoesPorCI: só tarefa em revisão com PR citado em `resultado` e vermelho', () => {
  const g = grafoEmRevisao('PR #30 aberto');
  assert.deepEqual(vigia.devolucoesPorCI(g, [pr(30, true)]).map((x) => [x.tipo, x.tarefa, x.pr]), [['devolver', 'a', 30]]);
  assert.deepEqual(vigia.devolucoesPorCI(g, [pr(30, false)]), [], 'PR verde: nada');
  assert.deepEqual(vigia.devolucoesPorCI(g, [pr(31, true)]), [], 'outro PR: nada');
  assert.deepEqual(vigia.devolucoesPorCI(g, []), [], 'PR fora da lista: nada');
  assert.deepEqual(vigia.devolucoesPorCI(grafoEmRevisao('CLI terminou; aguarda revisão'), [pr(30, true)]), [], 'sem número de PR: nada');
});

test('passo: PR vermelho devolve a tarefa no grafo e ainda chama o autor, uma vez só', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-ci-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, grafoEmRevisao('PR #30'));
  let estado = {};
  const chamadas = [];
  const deps = {
    agora: () => AGORA, simular: false, lerGrafo: () => grafo.carregar(arquivo), lerEstado: () => estado,
    salvarEstado: (x) => { estado = x; }, lerSemCota: () => ({}),
    listarPRs: () => [pr(30, true)],
    executar: (a, g) => { chamadas.push(a.tipo); if (a.tipo === 'devolver') vigia.executarReal(a, g, CFG, { arquivoGrafo: arquivo, log: () => {}, escreverCanal: () => {} }); },
  };
  vigia.passo(deps, CFG);
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'em_andamento');
  assert.match(grafo.carregar(arquivo).tarefas.a.resultado, /CI vermelho.*#30/);
  assert.deepEqual(chamadas.sort(), ['acordar', 'devolver']);
  vigia.passo(deps, CFG); // mesmo head, dentro da espera: nada de novo
  assert.deepEqual(chamadas.sort(), ['acordar', 'devolver']);
});

test('executarReal devolver: tarefa que não está mais em revisão não é tocada; conflito de escopo escala em vez de lançar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-ci2-'));
  const arquivo = path.join(dir, 'grafo.json');
  const canal = [];
  const acao = { tipo: 'devolver', tarefa: 'a', pr: 30, agente: 'codex', motivo: 'm', chave: 'devolver:a:aaaaaaaa' };
  grafo.salvar(arquivo, grafoEmRevisao('PR #30'));
  grafo.atualizar(arquivo, (x) => grafo.concluir(x, 'a', 'feita por outro caminho'));
  vigia.executarReal(acao, grafo.carregar(arquivo), CFG, { arquivoGrafo: arquivo, log: () => {}, escreverCanal: (t) => canal.push(t) });
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'feita');
  // conflito: outra tarefa em andamento com o mesmo escopo
  let g = grafoEmRevisao('PR #30');
  g = grafo.adicionar(g, { id: 'b', titulo: 'B', agente: 'claude', escopo: ['src/a.js'] }, AGORA.toISOString());
  g = grafo.iniciar(g, 'b', 'claude', AGORA.toISOString());
  grafo.salvar(arquivo, g);
  vigia.executarReal(acao, grafo.carregar(arquivo), CFG, { arquivoGrafo: arquivo, log: () => {}, escreverCanal: (t) => canal.push(t) });
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'em_revisao');
  assert.equal(canal.length, 1);
  assert.match(canal[0], /escopo/);
});

test('portão revisao-cruzada vermelho não é teste falhando: tarefa continua em revisão e o revisor é chamado', () => {
  const real = { number: 31, headRefOid: 'bbbbbbbb22222222', labels: [{ name: 'feito-por:claude' }], statusCheckRollup: [
    { name: 'regressao', conclusion: 'SUCCESS' }, { name: 'guarda-de-testes', conclusion: 'SUCCESS' }, { name: 'revisao-cruzada', conclusion: 'FAILURE' }] };
  const g = grafoEmRevisao('PR #31');
  assert.deepEqual(vigia.devolucoesPorCI(g, [real]), []);
  assert.deepEqual(vigia.pendenciasDosPRs([real]).map((x) => [x.agente, x.chave.split(':')[0]]), [['codex', 'rev']]);
  const vermelho = { ...real, statusCheckRollup: [{ name: 'regressao', conclusion: 'FAILURE' }, { name: 'revisao-cruzada', conclusion: 'FAILURE' }] };
  assert.equal(vigia.devolucoesPorCI(g, [vermelho]).length, 1, 'teste real vermelho continua devolvendo');
  assert.equal(vigia.pendenciasDosPRs([vermelho])[0].agente, 'claude');
});

test('devolucoesPorCI: só lê `PR #N` em `resultado`, não número solto de issue', () => {
  assert.deepEqual(vigia.devolucoesPorCI(grafoEmRevisao('corrige issue #30'), [pr(30, true)]), []);
  assert.equal(vigia.devolucoesPorCI(grafoEmRevisao('aberto como pr #30'), [pr(30, true)]).length, 1);
});

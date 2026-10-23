// Etapa 4 do supervisor: PR mesclado conclui a tarefa em revisão; PR fechado sem mesclar escala.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grafo = require('../orquestra/grafo.js');
const vigia = require('../orquestra/fofoqueiro.js');

const AGORA = new Date('2026-10-23T15:00:00.000Z');
const CFG = { esperaMinimaMinutos: 10, prazoParadaMinutos: 30, maxDisparosPorHora: 4 };

function grafoEmRevisao(resultado) {
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: 'a', titulo: 'A', agente: 'codex', escopo: ['src/a.js'] }, AGORA.toISOString());
  g = grafo.iniciar(g, 'a', 'codex', AGORA.toISOString());
  return grafo.revisar(g, 'a', resultado, AGORA.toISOString());
}

test('fechamentosDePR: mesclado conclui, fechado sem mesclar escala, aberto/sem número não faz nada', () => {
  const g = grafoEmRevisao('PR #30');
  assert.deepEqual(vigia.fechamentosDePR(g, [{ number: 30, state: 'MERGED' }]).map((x) => [x.tipo, x.tarefa, x.pr]), [['concluir', 'a', 30]]);
  assert.deepEqual(vigia.fechamentosDePR(g, [{ number: 30, state: 'CLOSED' }]).map((x) => [x.tipo, x.tarefa, x.pr]), [['escalar', 'a', 30]]);
  assert.deepEqual(vigia.fechamentosDePR(g, [{ number: 31, state: 'MERGED' }]), [], 'outro PR');
  assert.deepEqual(vigia.fechamentosDePR(g, []), []);
  assert.deepEqual(vigia.fechamentosDePR(grafoEmRevisao('CLI terminou; aguarda revisão'), [{ number: 30, state: 'MERGED' }]), [], 'sem número de PR');
  const emAndamento = grafo.carregar(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fq-')), 'x.json'));
  assert.deepEqual(vigia.fechamentosDePR(emAndamento, [{ number: 30, state: 'MERGED' }]), [], 'grafo vazio');
});

test('passo: PR mesclado conclui a tarefa no grafo uma vez só e libera a dependente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-merge-'));
  const arquivo = path.join(dir, 'grafo.json');
  let g = grafoEmRevisao('PR #30');
  g = grafo.adicionar(g, { id: 'b', titulo: 'B', agente: 'claude', escopo: ['src/b.js'], depende: ['a'] }, AGORA.toISOString());
  grafo.salvar(arquivo, g);
  let estado = {};
  const chamadas = [];
  const deps = {
    agora: () => AGORA, simular: false, lerGrafo: () => grafo.carregar(arquivo), lerEstado: () => estado,
    salvarEstado: (x) => { estado = x; }, lerSemCota: () => ({}),
    listarPRs: () => [], listarPRsFechados: () => [{ number: 30, state: 'MERGED' }],
    executar: (a, gr) => { chamadas.push(a.tipo); vigia.executarReal(a, gr, CFG, { arquivoGrafo: arquivo, log: () => {}, escreverCanal: () => {} }); },
  };
  vigia.passo(deps, CFG);
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'feita');
  assert.match(grafo.carregar(arquivo).tarefas.a.resultado, /PR #30 mesclado/);
  assert.ok(chamadas.includes('concluir'));
  assert.deepEqual(grafo.prontas(grafo.carregar(arquivo)).map((t) => t.id), ['b']);
});

test('passo: falha ao listar PRs fechados não derruba o passo nem conclui nada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-merge2-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, grafoEmRevisao('PR #30'));
  let estado = {};
  const deps = {
    agora: () => AGORA, simular: false, lerGrafo: () => grafo.carregar(arquivo), lerEstado: () => estado,
    salvarEstado: (x) => { estado = x; }, lerSemCota: () => ({}),
    listarPRs: () => [], listarPRsFechados: () => { throw new Error('rede'); }, log: () => {},
    executar: () => {},
  };
  vigia.passo(deps, CFG);
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'em_revisao');
});

test('listarPRsFechados: usa gh com argumentos fixos e devolve null se o gh falha', () => {
  const chamadas = [];
  const ok = vigia.listarPRsFechados({ repo: 'dmt5dimension-ops/MixAI' }, (cmd, args, o) => { chamadas.push([cmd, args]); return { status: 0, stdout: '[{"number":1,"state":"MERGED"}]' }; }, 'linux');
  assert.deepEqual(ok, [{ number: 1, state: 'MERGED' }]);
  assert.equal(chamadas[0][0], 'gh');
  assert.ok(chamadas[0][1].includes('--state') && chamadas[0][1].includes('closed'));
  assert.equal(vigia.listarPRsFechados({ repo: 'x/y' }, () => ({ status: 1, stdout: '' }), 'linux'), null);
});

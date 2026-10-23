// Etapa 5 do supervisor: PR mesclado que foi revertido reabre a tarefa que o grafo deu como feita.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grafo = require('../orquestra/grafo.js');
const vigia = require('../orquestra/fofoqueiro.js');

const AGORA = new Date('2026-10-23T17:00:00.000Z');
const CFG = { esperaMinimaMinutos: 10, prazoParadaMinutos: 30, maxDisparosPorHora: 4 };
const T = AGORA.toISOString();

function grafoFeita(resultado = 'PR #30 mesclado', extra = (g) => g) {
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: 'a', titulo: 'A', agente: 'codex', escopo: ['src/a.js'] }, T);
  g = grafo.iniciar(g, 'a', 'codex', T);
  g = grafo.concluir(g, 'a', resultado, T);
  return extra(g);
}
const reverte = (n, numero = 44, titulo = null) => ({ number: numero, state: 'MERGED', title: titulo ?? `Revert "Supervisor"`, body: `Reverts dmt5dimension-ops/MixAI#${n}` });

test('grafo.reabrir: feita volta a pendente com motivo; recusa estado errado e dependente ativo', () => {
  const g = grafoFeita();
  const r = grafo.reabrir(g, 'a', 'PR #30 revertido', T);
  assert.equal(r.tarefas.a.estado, 'pendente');
  assert.equal(r.tarefas.a.resultado, 'PR #30 revertido');
  assert.deepEqual(grafo.validar(r), []);
  assert.throws(() => grafo.reabrir(r, 'a', 'x', T), /precisa estar feita/);
  let g2 = grafoFeita();
  g2 = grafo.adicionar(g2, { id: 'b', titulo: 'B', agente: 'claude', escopo: ['src/b.js'], depende: ['a'] }, T);
  g2 = grafo.iniciar(g2, 'b', 'claude', T);
  assert.throws(() => grafo.reabrir(g2, 'a', 'x', T), /dependente.*b/);
});

test('grafo.js reabrir pela linha de comando', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reabrir-'));
  const arq = path.join(dir, 'grafo.json');
  grafo.salvar(arq, grafoFeita());
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'orquestra', 'grafo.js'), 'reabrir', 'a', 'revertido', '--arquivo', arq], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(grafo.carregar(arq).tarefas.a.estado, 'pendente');
});

test('revertidosDePR: só PR mesclado com título Revert que cita o PR da tarefa feita', () => {
  const g = grafoFeita();
  assert.deepEqual(vigia.revertidosDePR(g, [reverte(30)]).map((x) => [x.tipo, x.tarefa, x.pr, x.revert]), [['reabrir', 'a', 30, 44]]);
  assert.deepEqual(vigia.revertidosDePR(g, [reverte(31)]), [], 'reverte outro PR');
  assert.deepEqual(vigia.revertidosDePR(g, [{ ...reverte(30), state: 'CLOSED' }]), [], 'revert não mesclado');
  assert.deepEqual(vigia.revertidosDePR(g, [{ number: 45, state: 'MERGED', title: 'Corrige texto', body: 'Menciona #30 de passagem' }]), [], 'não é revert');
  assert.deepEqual(vigia.revertidosDePR(g, [{ number: 46, state: 'MERGED', title: 'Revert "x" (#30)', body: '' }]).length, 1, 'número no título também vale');
  assert.deepEqual(vigia.revertidosDePR(grafoFeita('feita à mão'), [reverte(30)]), [], 'sem PR no resultado');
  assert.deepEqual(vigia.revertidosDePR(grafoFeita('PR #30 revertido (#44)'), [reverte(30)]), [], 'já reaberta uma vez: resultado não diz mais mesclado');
});

test('passo: revert mesclado reabre a tarefa uma vez; com dependente ativo escala e não mexe no grafo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-rev-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, grafoFeita());
  let estado = {};
  const canal = [];
  const deps = {
    agora: () => AGORA, simular: false, lerGrafo: () => grafo.carregar(arquivo), lerEstado: () => estado,
    salvarEstado: (x) => { estado = x; }, lerSemCota: () => ({}), listarPRs: () => [], log: () => {},
    listarReverts: () => [reverte(30)],
    executar: (a, gr) => vigia.executarReal(a, gr, CFG, { arquivoGrafo: arquivo, log: () => {}, escreverCanal: (t) => canal.push(t) }),
  };
  vigia.passo(deps, CFG);
  const t = grafo.carregar(arquivo).tarefas.a;
  assert.equal(t.estado, 'pendente');
  assert.match(t.resultado, /PR #30 revertido.*#44/);
  vigia.passo({ ...deps, agora: () => new Date(AGORA.getTime() + 20 * 60000) }, CFG);
  assert.equal(canal.length, 0, 'segunda rodada não reabre de novo nem escala');

  let g2 = grafoFeita();
  g2 = grafo.adicionar(g2, { id: 'b', titulo: 'B', agente: 'claude', escopo: ['src/b.js'], depende: ['a'] }, T);
  g2 = grafo.iniciar(g2, 'b', 'claude', T);
  grafo.salvar(arquivo, g2);
  estado = {};
  vigia.passo(deps, CFG);
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'feita');
  assert.deepEqual(grafo.validar(grafo.carregar(arquivo)), []);
  assert.equal(canal.length, 1);
  assert.match(canal[0], /revertido|revert/i);
});

test('listarReverts: busca reverts mesclados por título (sem janela de 30); só consulta com tarefa feita citando PR', () => {
  const chamadas = [];
  const ok = vigia.listarReverts({ repo: 'dmt5dimension-ops/MixAI' }, (cmd, args) => { chamadas.push(args); return { status: 0, stdout: JSON.stringify([reverte(30)]) }; }, 'linux');
  assert.equal(ok.length, 1);
  assert.ok(chamadas[0].includes('--search') && chamadas[0].includes('merged') && !chamadas[0].includes('30'));
  assert.equal(vigia.listarReverts({ repo: 'x/y' }, () => ({ status: 1, stdout: '' }), 'linux'), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-rev2-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, grafoFeita('feita à mão'));
  let consultas = 0;
  const deps = {
    agora: () => AGORA, simular: false, lerGrafo: () => grafo.carregar(arquivo), lerEstado: () => ({}),
    salvarEstado: () => {}, lerSemCota: () => ({}), listarPRs: () => [], log: () => {},
    listarReverts: () => { consultas += 1; return []; }, executar: () => {},
  };
  vigia.passo(deps, CFG);
  assert.equal(consultas, 0, 'tarefa feita sem PR no resultado: não consulta');
});

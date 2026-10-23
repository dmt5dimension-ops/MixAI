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

test('listarPRsFechados: consulta cada PR citado pelo número, mesmo fora dos 30 mais recentes', () => {
  const chamadas = [];
  const gh = (cmd, args) => {
    chamadas.push([cmd, args]);
    const n = Number(args[2]);
    return n === 7 ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify({ number: n, state: n === 3 ? 'MERGED' : 'OPEN' }) };
  };
  const g = grafoEmRevisao('PR #3');
  assert.deepEqual(vigia.prsCitados(g), [3]);
  const ok = vigia.listarPRsFechados({ repo: 'dmt5dimension-ops/MixAI' }, [3, 7, 9], gh, 'linux');
  assert.deepEqual(ok, [{ number: 3, state: 'MERGED' }, { number: 9, state: 'OPEN' }], 'PR 7 falhou: fica de fora, não derruba os outros');
  assert.deepEqual(chamadas.map((c) => [c[0], c[1].slice(0, 3)]), [['gh', ['pr', 'view', '3']], ['gh', ['pr', 'view', '7']], ['gh', ['pr', 'view', '9']]]);
  assert.ok(chamadas.every((c) => !c[1].includes('--limit')), 'sem janela fixa');
  assert.equal(vigia.listarPRsFechados({ repo: 'x/y' }, [3], () => ({ status: 1, stdout: '' }), 'linux'), null);
  assert.deepEqual(vigia.listarPRsFechados({ repo: 'x/y' }, [], () => { throw new Error('não chama'); }, 'linux'), []);
});

test('passo: PR antigo, fora de qualquer janela, ainda conclui a tarefa; sem PR citado não consulta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-janela-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, grafoEmRevisao('PR #12'));
  let estado = {};
  const consultas = [];
  const deps = {
    agora: () => AGORA, simular: false, lerGrafo: () => grafo.carregar(arquivo), lerEstado: () => estado,
    salvarEstado: (x) => { estado = x; }, lerSemCota: () => ({}), listarPRs: () => [], log: () => {},
    listarPRsFechados: (numeros) => { consultas.push(numeros); return numeros.map((number) => ({ number, state: 'MERGED' })); },
    executar: (a, gr) => vigia.executarReal(a, gr, CFG, { arquivoGrafo: arquivo, log: () => {}, escreverCanal: () => {} }),
  };
  vigia.passo(deps, CFG);
  assert.deepEqual(consultas, [[12]]);
  assert.equal(grafo.carregar(arquivo).tarefas.a.estado, 'feita');
  vigia.passo(deps, CFG);
  assert.equal(consultas.length, 1, 'sem tarefa em revisão com PR: não consulta o GitHub');
});

test('fechamentosDePR: só lê `PR #N` em `resultado`, não número solto de issue', () => {
  assert.deepEqual(vigia.fechamentosDePR(grafoEmRevisao('corrige issue #30'), [{ number: 30, state: 'MERGED' }]), []);
});

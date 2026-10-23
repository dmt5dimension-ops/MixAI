const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const grafo = require('../orquestra/grafo.js');
const vigia = require('../orquestra/fofoqueiro.js');

const AGORA = new Date('2026-10-23T12:00:00.000Z');
const CFG = { esperaMinimaMinutos: 10, prazoParadaMinutos: 30, maxDisparosPorHora: 2 };
const tarefa = (id, agente = 'codex', depende = []) => ({ id, titulo: `Tarefa ${id}`, agente, depende, escopo: [`src/${id}.js`], verificar: 'node -e "process.exit(0)"' });
const criar = (...tarefas) => tarefas.reduce((g, t) => grafo.adicionar(g, t, AGORA.toISOString()), grafo.novo());

test('pronta do Codex acorda uma vez e respeita o prazo para repetir', () => {
  const g = criar(tarefa('a'));
  const a = vigia.decidir(g, {}, AGORA, CFG);
  assert.deepEqual(a.map((x) => [x.tipo, x.agente, x.ids]), [['acordar', 'codex', ['a']]]);
  const estado = vigia.registrar({}, a[0], AGORA);
  assert.deepEqual(vigia.decidir(g, estado, new Date(AGORA.getTime() + 9 * 60000), CFG), []);
});

test('tarefa em andamento parada gera cobrança; falha definitiva e dependente travada geram escalada', () => {
  const g = criar(tarefa('a'), tarefa('b', 'claude', ['a']));
  g.tarefas.a.estado = 'em_andamento';
  g.tarefas.a.atualizado = new Date(AGORA.getTime() - 31 * 60000).toISOString();
  assert.deepEqual(vigia.decidir(g, {}, AGORA, CFG).map((x) => [x.tipo, x.id]), [['cobrar', 'a']]);
  g.tarefas.a.estado = 'falhou';
  g.tarefas.a.tentativas = 3;
  const a = vigia.decidir(g, {}, AGORA, CFG);
  assert.deepEqual(a.map((x) => [x.tipo, x.id]), [['escalar', 'a'], ['escalar', 'b']]);
});

test('cobrança local não chama CLI e várias cobranças respeitam limite do ciclo', () => {
  const g = criar(tarefa('a', 'local'), tarefa('b', 'codex'), tarefa('c', 'codex'));
  for (const x of Object.values(g.tarefas)) {
    x.estado = 'em_andamento';
    x.atualizado = new Date(AGORA.getTime() - 31 * 60000).toISOString();
  }
  const a = vigia.decidir(g, {}, AGORA, { ...CFG, maxDisparosPorHora: 1 });
  assert.equal(a.filter((x) => x.tipo === 'cobrar' && x.agente === 'codex').length, 1);
  let chamadas = 0, canal = 0;
  vigia.executarReal(a.find((x) => x.agente === 'local'), g, CFG, { chamarAgente: () => { chamadas++; }, escreverCanal: () => { canal++; }, log: () => {} });
  assert.equal(chamadas, 0);
  assert.equal(canal, 1);
});

test('agente local canônico do grafo segue para escada, sem acordar CLI', () => {
  const a = vigia.decidir(criar(tarefa('q', 'local')), {}, AGORA, CFG);
  assert.deepEqual(a.map((x) => [x.tipo, x.ids]), [['escada', ['q']]]);
});

test('cota e limite por hora impedem novos despertares e registram o adiamento', () => {
  const g = criar(tarefa('a'));
  const semCota = vigia.decidir(g, {}, AGORA, { ...CFG, semCota: { codex: new Date(AGORA.getTime() + 3600000).toISOString() } });
  assert.equal(semCota.some((x) => x.tipo === 'acordar'), false);
  assert.equal(semCota.some((x) => x.tipo === 'registrar' && /cota/.test(x.motivo)), true);
  const cheio = vigia.decidir(g, { disparos: { codex: [AGORA.toISOString(), AGORA.toISOString()] } }, AGORA, CFG);
  assert.equal(cheio.some((x) => x.tipo === 'acordar'), false);
  g.tarefas.a.estado = 'em_andamento';
  g.tarefas.a.atualizado = new Date(AGORA.getTime() - 31 * 60000).toISOString();
  const cobrarCheio = vigia.decidir(g, { disparos: { codex: [AGORA.toISOString(), AGORA.toISOString()] } }, AGORA, CFG);
  assert.equal(cobrarCheio.some((x) => x.tipo === 'cobrar'), false);
});

test('grafo inválido recusa trabalho e escala; nenhuma ação cita tarefa inexistente', () => {
  const g = criar(tarefa('a'));
  g.tarefas.a.depende = ['fantasma'];
  const a = vigia.decidir(g, {}, AGORA, CFG);
  assert.equal(a.length, 1);
  assert.equal(a[0].tipo, 'escalar');
  assert.equal(a[0].id, null);
  const bom = criar(tarefa('b'));
  assert.ok(vigia.decidir(bom, {}, AGORA, CFG).every((x) => (x.ids || (x.id ? [x.id] : [])).every((id) => Object.hasOwn(bom.tarefas, id))));
  const malformado = { versao: 1, tarefas: { a: { id: 'a', depende: null } } };
  assert.deepEqual(vigia.decidir(malformado, {}, AGORA, CFG).map((x) => [x.tipo, x.id]), [['escalar', null]]);
});

test('falha ao carregar grafo é escalada sem acordar agente nem gravar estado', () => {
  let salvou = 0, executou = 0;
  const a = vigia.passo({ agora: () => AGORA, lerGrafo: () => { throw new Error('grafo corrompido'); }, lerEstado: () => ({}), lerSemCota: () => ({}), salvarEstado: () => { salvou++; }, executar: (x) => { executou++; assert.equal(x.tipo, 'escalar'); }, simular: true }, CFG);
  assert.deepEqual(a.map((x) => [x.tipo, x.id]), [['escalar', null]]);
  assert.equal(salvou, 0);
  assert.equal(executou, 0);
});

test('uma mensagem do Claude e PR sem revisão viram pendências deduplicáveis', () => {
  const canal = '### 2026-10-23 — Claude → Codex (rever)\n\nReveja o PR.\n';
  const acao = vigia.pendenciasDoCanal(canal)[0];
  assert.equal(acao.agente, 'codex');
  assert.deepEqual(acao.ids, []);
  const pr = { number: 31, headRefOid: 'abcdef1234', labels: [{ name: 'feito-por:codex' }], statusCheckRollup: [] };
  assert.deepEqual(vigia.pendenciasDosPRs([pr]).map((x) => [x.agente, x.tipo]), [['claude', 'acordar']]);
});

test('despertar leva escopo e verificador da tarefa ao agente', () => {
  const g = criar(tarefa('a'));
  const a = vigia.decidir(g, {}, AGORA, CFG)[0];
  const prompt = vigia.promptDe(a, g);
  assert.match(prompt, /src\/a\.js/);
  assert.match(prompt, /node -e/);
  assert.match(prompt, /Tarefa a/);
});

test('falha do agente devolve tarefa ao grafo e a terceira falha escala', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-falha-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, criar(tarefa('a')));
  const acao = vigia.decidir(grafo.carregar(arquivo), {}, AGORA, CFG)[0];
  const deps = { arquivoGrafo: arquivo, chamarAgente: () => ({ status: 1, limite: false }), log: () => {} };
  for (let i = 1; i <= 3; i++) {
    vigia.executarReal(acao, grafo.carregar(arquivo), CFG, deps);
    const atual = grafo.carregar(arquivo).tarefas.a;
    assert.equal(atual.tentativas, i);
    assert.equal(atual.estado, i === 3 ? 'falhou' : 'pendente');
  }
  assert.equal(vigia.decidir(grafo.carregar(arquivo), {}, AGORA, CFG)[0].tipo, 'escalar');
});

test('trava de instância única recusa a segunda enquanto a primeira vive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-lock-'));
  const a = vigia.pegarTrava(dir);
  try { assert.equal(a.ok, true); assert.equal(vigia.pegarTrava(dir).ok, false); }
  finally { a.soltar(); }
});

test('passo em simulação lista ações sem executar nem salvar estado', () => {
  let executou = 0, salvou = 0;
  const a = vigia.passo({ agora: () => AGORA, lerGrafo: () => criar(tarefa('a')), lerEstado: () => ({}), lerSemCota: () => ({}), executar: () => { executou++; }, salvarEstado: () => { salvou++; }, simular: true, log: () => {} }, CFG);
  assert.equal(a[0].tipo, 'acordar');
  assert.equal(executou, 0);
  assert.equal(salvou, 0);
});

test('CLI --simular --uma-vez lê um grafo real sem executar comandos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fofoqueiro-cli-'));
  const arquivo = path.join(dir, 'grafo.json');
  grafo.salvar(arquivo, criar(tarefa('a')));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'orquestra', 'fofoqueiro.js'), '--simular', '--uma-vez'], { env: { ...process.env, MIXAI_GRAFO: arquivo, MIXAI_CANAL_DIR: dir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acordar/);
  assert.equal(fs.existsSync(path.join(dir, 'fofoqueiro-estado.json')), false);
});

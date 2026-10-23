// Testa o relatório de uso por agente (orquestra/relatorio.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { montar, emTexto, relatorio } = require('../orquestra/relatorio.js');

const AGORA = new Date('2026-10-23T12:00:00Z');
const tarefa = (id, estado, agente) => ({ id, titulo: id, estado, agente, depende: [], escopo: [], tentativas: 0 });

test('conta casos por agente e o percentual que subiu para Codex/Claude', () => {
  const r = montar({ casos: [{ resolvidoPor: 'local' }, { resolvidoPor: 'local' }, { resolvidoPor: 'codex' }, { resolvidoPor: 'claude' }] }, AGORA);
  assert.deepStrictEqual(r.casos.porAgente, { claude: 1, codex: 1, local: 2 });
  assert.strictEqual(r.casos.total, 4);
  assert.strictEqual(r.casos.subiram, 2);
  assert.strictEqual(r.casos.percentualSubiu, 50);
});

test('sem nenhum dado o relatório sai zerado e sem dividir por zero', () => {
  const r = montar({}, AGORA);
  assert.strictEqual(r.casos.total, 0);
  assert.strictEqual(r.casos.percentualSubiu, 0);
  assert.deepStrictEqual(r.pausados, {});
  assert.match(emTexto(r), /Ninguém está sem cota/);
});

test('só tarefas feitas contam para o agente; todas entram por estado', () => {
  const grafo = { tarefas: { a: tarefa('a', 'feita', 'codex'), b: tarefa('b', 'feita', 'codex'), c: tarefa('c', 'em_andamento', 'claude'), d: tarefa('d', 'feita', null) } };
  const r = montar({ grafo }, AGORA);
  assert.deepStrictEqual(r.tarefasFeitas, { claude: 0, codex: 2, local: 0 });
  assert.deepStrictEqual(r.tarefasPorEstado, { feita: 3, em_andamento: 1 });
});

test('só mostra como pausado quem ainda está dentro da pausa', () => {
  const r = montar({ semCota: { codex: '2026-10-23T15:00:00Z', claude: '2026-10-23T10:00:00Z' } }, AGORA);
  assert.deepStrictEqual(r.pausados, { codex: '2026-10-23T15:00:00Z' });
  assert.match(emTexto(r), /codex até 2026-10-23T15:00:00Z/);
});

test('lê os arquivos reais, ignora linha quebrada e arquivo ausente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relatorio-'));
  try {
    const casos = path.join(dir, 'casos.jsonl');
    fs.writeFileSync(casos, '{"resolvidoPor":"local"}\nnão é json\n{"resolvidoPor":"codex"}\n');
    const semCota = path.join(dir, 'sem-cota.json');
    fs.writeFileSync(semCota, '{"claude":"2026-10-24T00:00:00Z"}');
    const r = relatorio({ casos, semCota, falhas: path.join(dir, 'x.jsonl'), grafo: path.join(dir, 'x.json') }, AGORA);
    assert.strictEqual(r.casos.total, 2);
    assert.strictEqual(r.casos.subiram, 1);
    assert.deepStrictEqual(r.pausados, { claude: '2026-10-24T00:00:00Z' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('o relatório do repositório bate com os arquivos de verdade', () => {
  const grafo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'orquestra', 'grafo.json'), 'utf8'));
  const feitas = Object.values(grafo.tarefas).filter((t) => t.estado === 'feita').length;
  const r = relatorio();
  assert.strictEqual(Object.values(r.tarefasFeitas).reduce((a, b) => a + b, 0), feitas);
  assert.strictEqual(Object.values(r.tarefasPorEstado).reduce((a, b) => a + b, 0), Object.keys(grafo.tarefas).length);
  assert.ok(emTexto(r).includes('Casos resolvidos'));
});

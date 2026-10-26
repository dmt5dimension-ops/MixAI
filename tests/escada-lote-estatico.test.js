// Trava o estático e a liberação por tipo dentro do lote (escada.lote): tipo vem da microtarefa, o estático lê só a instrução.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const escada = require('../orquestra/escada.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lote-es-'));
const arquivosTemp = (d) => ({ regras: path.join(d, 'r.json'), casos: path.join(d, 'casos.jsonl'), treino: path.join(d, 't.jsonl'), falhas: path.join(d, 'falhas.jsonl'), pendentes: path.join(d, 'p.jsonl') });
const micro = (id, extra = {}) => ({ id, instrucao: 'inverta abc', escopo: [`src/${id}.js`], verificar: 'true', ...extra });
const inverter = { id: 'inverter', quando: '^inverta (?<t>\\w+)$', saida: '{t|inverter}', exemplo: { entrada: 'inverta ab', saida: 'ba' }, status: 'confirmada' };
const verificadorDe = () => (saida) => ({ ok: saida === 'cba' || saida === 'ok' });

test('lote com estático: a instrução crua casa a regra (sem o texto de escopo/contexto do prompt) e o Qwen nem é chamado', async () => {
  const d = dir();
  let chamadas = 0;
  const r = await escada.lote({ microtarefas: [micro('a', { contexto: 'algum contexto' })], verificadorDe, arquivos: arquivosTemp(d), estatico: [inverter], agentes: { local: async () => { chamadas++; return 'ok'; }, superiores: [] } });
  assert.deepStrictEqual(r.map((x) => [x.id, x.ok, x.resolvidoPor]), [['a', true, 'estatico']]);
  assert.strictEqual(chamadas, 0);
});

test('lote com liberação: tipo da microtarefa decide; sem tipo ou não liberado sobe direto para o grande', async () => {
  const d = dir();
  const tabela = path.join(d, 'liberados.json');
  fs.writeFileSync(tabela, JSON.stringify({ 'mixai-local': { 'data-iso': { liberado: true }, regex: { liberado: false } } }));
  let doLocal = 0;
  const r = await escada.lote({
    microtarefas: [micro('lib', { tipo: 'data-iso' }), micro('nao', { tipo: 'regex' }), micro('semtipo')],
    verificadorDe, arquivos: arquivosTemp(d), liberacao: { arquivo: tabela },
    agentes: { local: async () => { doLocal++; return 'ok'; }, superiores: [{ nome: 'claude', chamar: async () => 'ok' }] },
  });
  const por = Object.fromEntries(r.map((x) => [x.id, x.resolvidoPor]));
  assert.deepStrictEqual(por, { lib: 'local', nao: 'claude', semtipo: 'claude' });
  assert.strictEqual(doLocal, 1, 'só o tipo liberado usa o Qwen');
});

test('lote sem as opções continua igual: o Qwen resolve', async () => {
  const d = dir();
  const r = await escada.lote({ microtarefas: [micro('a')], verificadorDe, arquivos: arquivosTemp(d), agentes: { local: async () => 'ok', superiores: [] } });
  assert.strictEqual(r[0].resolvidoPor, 'local');
});

test('CLI: --estatico com arquivo de regras ilegível para no pré-voo e deixa a tarefa do grafo pendente', () => {
  const { spawnSync } = require('node:child_process');
  const grafo = require('../orquestra/grafo.js');
  const d = dir();
  const arq = path.join(d, 'grafo.json');
  grafo.salvar(arq, grafo.adicionar(grafo.novo(), { id: 'a', titulo: 'A', agente: 'local', escopo: ['t/a'] }, '2026-10-23T12:00:00.000Z'));
  const plano = path.join(d, 'plano.json');
  fs.writeFileSync(plano, JSON.stringify([{ id: 'a', instrucao: 'faça', verificar: 'node -e 0', escopo: ['t/a'] }]));
  const regras = path.join(d, 'regras-estaticas.json');
  fs.writeFileSync(regras, '{ isto não é json');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'orquestra', 'escada.js'), 'lote', plano, '--grafo', arq, '--estatico', '--regras-estaticas', regras], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(grafo.carregar(arq).tarefas.a.estado, 'pendente', 'a tarefa ficou em_andamento sem nenhum agente iniciado');
  const sem = spawnSync(process.execPath, [path.join(__dirname, '..', 'orquestra', 'escada.js'), 'lote', plano, '--grafo', arq, '--estatico', '--regras-estaticas'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notStrictEqual(sem.status, 0);
  assert.match(sem.stderr, /regras-estaticas/);
  assert.strictEqual(grafo.carregar(arq).tarefas.a.estado, 'pendente');
});

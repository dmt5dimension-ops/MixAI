// Trava os dois degraus novos da escada: aluno estático antes do Qwen e liberação por tipo (sombra) antes do Qwen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolver, resolverComLoop, lerCasos } = require('../orquestra/escada.js');

function pasta() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'escada-el-'));
  const arquivos = { regras: path.join(d, 'regras.json'), casos: path.join(d, 'casos.jsonl'), falhas: path.join(d, 'falhas.jsonl'), pendentes: path.join(d, 'pend.jsonl'), treino: path.join(d, 't.jsonl') };
  fs.writeFileSync(arquivos.regras, JSON.stringify({ regras: [] }));
  return { arquivos, dir: d };
}
const inverter = { id: 'inverter', quando: '^inverta (?<t>\\w+)$', saida: '{t|inverter}', exemplo: { entrada: 'inverta ab', saida: 'ba' }, status: 'confirmada' };
const contador = () => { const c = { n: 0 }; c.fn = async () => { c.n++; return 'resposta-do-qwen'; }; return c; };

for (const [nome, rodar] of [
  ['resolver', (o) => resolver({ cabeNoLocal: true, ...o })],
  ['resolverComLoop', (o) => resolverComLoop(o)],
]) {
  test(`${nome}: o aluno estático resolve antes do Qwen, sem chamar nenhum LLM`, async () => {
    const { arquivos } = pasta();
    const local = contador();
    const r = await rodar({ entrada: 'inverta abc', verificar: async (s) => ({ ok: s === 'cba' }), agentes: { local: local.fn, superiores: [] }, arquivos, estatico: [inverter] });
    assert.strictEqual(r.resolvidoPor, 'estatico');
    assert.strictEqual(r.saida, 'cba');
    assert.strictEqual(local.n, 0, 'o Qwen foi chamado mesmo com o estático certo');
    const caso = lerCasos(arquivos.casos).at(-1);
    assert.strictEqual(caso.resolvidoPor, 'estatico');
    assert.strictEqual(caso.regraEstatica, 'inverter');
  });

  test(`${nome}: regra estática que casa mas erra não vale; a tarefa segue para o Qwen`, async () => {
    const { arquivos } = pasta();
    const local = contador();
    const r = await rodar({ entrada: 'inverta abc', verificar: async (s) => ({ ok: s === 'resposta-do-qwen' }), agentes: { local: local.fn, superiores: [] }, arquivos, estatico: [inverter] });
    assert.strictEqual(r.resolvidoPor, 'local');
    assert.strictEqual(local.n, 1);
  });

  test(`${nome}: sem opções a escada é a de sempre (estático e liberação desligados)`, async () => {
    const { arquivos } = pasta();
    const local = contador();
    const r = await rodar({ entrada: 'inverta abc', verificar: async () => ({ ok: true }), agentes: { local: local.fn, superiores: [] }, arquivos });
    assert.strictEqual(r.resolvidoPor, 'local');
  });

  test(`${nome}: tipo não liberado pula o Qwen e sobe para o grande; tipo liberado deixa o Qwen trabalhar`, async () => {
    const { arquivos, dir } = pasta();
    const tabela = path.join(dir, 'liberados.json');
    fs.writeFileSync(tabela, JSON.stringify({ 'mixai-local': { 'data-iso': { liberado: true }, 'regex': { liberado: false } } }));
    const grande = async () => 'resposta-do-grande';
    const verificar = async () => ({ ok: true });
    const local = contador();
    const naoLib = await rodar({ entrada: 'x', verificar, agentes: { local: local.fn, superiores: [{ nome: 'claude', chamar: grande }] }, arquivos, liberacao: { tipo: 'regex', arquivo: tabela } });
    assert.strictEqual(naoLib.resolvidoPor, 'claude');
    assert.strictEqual(local.n, 0, 'o Qwen trabalhou num tipo não liberado');
    const semTabela = await rodar({ entrada: 'x', verificar, agentes: { local: local.fn, superiores: [{ nome: 'claude', chamar: grande }] }, arquivos, liberacao: { tipo: 'data-iso', arquivo: path.join(dir, 'nao-existe.json') } });
    assert.strictEqual(semTabela.resolvidoPor, 'claude', 'sem tabela nada é liberado');
    assert.strictEqual(local.n, 0);
    const lib = await rodar({ entrada: 'x', verificar, agentes: { local: local.fn, superiores: [{ nome: 'claude', chamar: grande }] }, arquivos, liberacao: { tipo: 'data-iso', arquivo: tabela } });
    assert.strictEqual(lib.resolvidoPor, 'local');
    assert.strictEqual(local.n, 1);
  });
}

test('liberação vale por modelo: tipo liberado para um aluno não libera o outro', async () => {
  const { arquivos, dir } = pasta();
  const tabela = path.join(dir, 'liberados.json');
  fs.writeFileSync(tabela, JSON.stringify({ 'mixai-local': { 'data-iso': { liberado: true } } }));
  const local = contador();
  const r = await resolver({ entrada: 'x', cabeNoLocal: true, verificar: async () => ({ ok: true }), agentes: { local: local.fn, superiores: [{ nome: 'claude', chamar: async () => 'g' }] }, arquivos, modelo: 'outro', liberacao: { tipo: 'data-iso', arquivo: tabela } });
  assert.strictEqual(r.resolvidoPor, 'claude');
  assert.strictEqual(local.n, 0);
});

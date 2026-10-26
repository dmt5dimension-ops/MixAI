const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolver, lerCasos } = require('../orquestra/escada.js');

function pasta() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'escada-pm-'));
  const arquivos = { regras: path.join(d, 'regras.json'), casos: path.join(d, 'casos.jsonl'), falhas: path.join(d, 'falhas.jsonl'), treino: path.join(d, 't.jsonl') };
  const regra = (id, modelos) => ({ id, status: 'confirmada', palavras: ['data'], regra: `regra ${id}`, exemplo: { entrada: 'a', saida: 'b' }, ...(modelos ? { modelos } : {}) });
  fs.writeFileSync(arquivos.regras, JSON.stringify({ regras: [regra('geral'), regra('so-qwen', ['mixai-local']), regra('so-outro', ['outro'])] }));
  return arquivos;
}

test('escada com modelo só aplica as regras que valem para ele e grava o modelo no caso', async () => {
  const arquivos = pasta();
  const prompts = [];
  const agentes = { local: async (p) => { prompts.push(p); return 'ok'; }, superiores: [] };
  const r = await resolver({ entrada: 'converta a data', cabeNoLocal: true, verificar: async () => ({ ok: true }), agentes, arquivos, modelo: 'mixai-local' });
  assert.deepStrictEqual(r.regrasUsadas.sort(), ['geral', 'so-qwen']);
  assert.ok(!prompts[0].includes('regra so-outro'));
  assert.strictEqual(lerCasos(arquivos.casos)[0].modelo, 'mixai-local');
});

test('escada sem modelo trata o aluno como o Qwen padrão: não usa regra exclusiva de outro aluno; caso sem campo modelo', async () => {
  const arquivos = pasta();
  const prompts = [];
  const agentes = { local: async (p) => { prompts.push(p); return 'ok'; }, superiores: [] };
  const r = await resolver({ entrada: 'converta a data', cabeNoLocal: true, verificar: async () => ({ ok: true }), agentes, arquivos });
  assert.deepStrictEqual(r.regrasUsadas.sort(), ['geral', 'so-qwen']);
  assert.ok(!prompts[0].includes('regra so-outro'), 'regra de outro aluno vazou para o Qwen padrão');
  assert.strictEqual('modelo' in lerCasos(arquivos.casos)[0], false);
});

test('o lote real (resolverComLoop) sem modelo também não vaza regra de outro aluno', async () => {
  const arquivos = pasta();
  const prompts = [];
  const agentes = { local: async (p) => { prompts.push(p); return 'ok'; }, superiores: [{ nome: 'claude', chamar: async () => 'ok' }] };
  const { resolverComLoop } = require('../orquestra/escada.js');
  const r = await resolverComLoop({ entrada: 'converta a data', verificar: async () => ({ ok: true }), agentes, arquivos });
  assert.ok(r.ok);
  assert.ok(prompts.length > 0 && prompts.every((p) => !p.includes('regra so-outro')));
  assert.ok(prompts.every((p) => p.includes('regra geral')));
});

test('regra aprendida para um modelo nasce limitada a ele', async () => {
  const arquivos = pasta();
  fs.writeFileSync(arquivos.regras, JSON.stringify({ regras: [] }));
  let n = 0;
  const agentes = {
    local: async () => (++n === 1 ? 'errado' : 'certo'),
    superiores: [{ nome: 'claude', chamar: async (p) => (p.includes('regra') || p.includes('Regra') ? JSON.stringify({ id: 'faca-assim', regra: 'faça assim', palavras: ['data'], exemplo: { entrada: 'x', saida: 'y' } }) : 'certo') }],
  };
  const r = await resolver({ entrada: 'converta a data', cabeNoLocal: true, verificar: async (s) => ({ ok: s === 'certo' }), agentes, arquivos, modelo: 'qwen-x' });
  assert.ok(r.regraSalva, 'a regra deveria ter sido salva');
  {
    const salva = JSON.parse(fs.readFileSync(arquivos.regras, 'utf8')).regras.find((x) => x.id === r.regraSalva);
    assert.deepStrictEqual(salva.modelos, ['qwen-x']);
  }
  assert.strictEqual(lerCasos(arquivos.casos).at(-1).modelo, 'qwen-x');
});

test('modelo com espaço nas pontas é normalizado: a regra aprendida é achada na chamada seguinte', async () => {
  const arquivos = pasta();
  fs.writeFileSync(arquivos.regras, JSON.stringify({ regras: [] }));
  let n = 0;
  const agentes = {
    local: async () => (++n === 1 ? 'errado' : 'certo'),
    superiores: [{ nome: 'claude', chamar: async (p) => (p.includes('regra') || p.includes('Regra') ? JSON.stringify({ id: 'faca-assim', regra: 'faça assim', palavras: ['data'], exemplo: { entrada: 'x', saida: 'y' } }) : 'certo') }],
  };
  const verificar = async (s) => ({ ok: s === 'certo' });
  const r = await resolver({ entrada: 'converta a data', cabeNoLocal: true, verificar, agentes, arquivos, modelo: ' qwen-x ' });
  assert.ok(r.regraSalva);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(arquivos.regras, 'utf8')).regras.find((x) => x.id === r.regraSalva).modelos, ['qwen-x']);
  assert.strictEqual(lerCasos(arquivos.casos).at(-1).modelo, 'qwen-x');
  const prompts = [];
  const r2 = await resolver({ entrada: 'converta a data', cabeNoLocal: true, verificar, agentes: { local: async (p) => { prompts.push(p); return 'certo'; }, superiores: [] }, arquivos, modelo: ' qwen-x ' });
  assert.deepStrictEqual(r2.regrasUsadas, ['faca-assim'], 'a regra recém-aprendida não foi reaproveitada');
  assert.ok(prompts[0].includes('faça assim'));
  await assert.rejects(() => resolver({ entrada: 'x', cabeNoLocal: true, verificar, agentes, arquivos, modelo: '  ' }), /modelo sem nome/);
});

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

test('escada sem modelo mantém o comportamento de antes (todas as regras, caso sem campo modelo)', async () => {
  const arquivos = pasta();
  const agentes = { local: async () => 'ok', superiores: [] };
  const r = await resolver({ entrada: 'converta a data', cabeNoLocal: true, verificar: async () => ({ ok: true }), agentes, arquivos });
  assert.strictEqual(r.regrasUsadas.length, 3);
  assert.strictEqual('modelo' in lerCasos(arquivos.casos)[0], false);
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

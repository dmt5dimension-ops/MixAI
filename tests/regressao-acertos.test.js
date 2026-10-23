const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registrar, importarDoPlano, lerAcertos, rodarVerificador } = require('../orquestra/regressao.js');

const tarefa = { id: 't1', tipo: 'data-iso', entrada: 'x', verificar: 'node orquestra/sombra-plano/confere.js igual "abc"' };
const novoArquivo = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acertos-')), 'a.jsonl');

test('regressão de acertos: a resposta certa de cada caso salvo ainda passa e a adulterada reprova', () => {
  const casos = lerAcertos();
  assert.ok(casos.length >= 15, 'a semente tem de ter casos');
  for (const c of casos) {
    assert.ok(rodarVerificador(c.verificar, c.saidaCerta), `${c.id}: a resposta certa deveria passar`);
    assert.ok(!rodarVerificador(c.verificar, c.saidaCerta + '\n#adulterada#'), `${c.id}: a resposta adulterada deveria reprovar`);
  }
});

test('registrar guarda caso válido e recusa duplicado', () => {
  const arq = novoArquivo();
  assert.deepStrictEqual(registrar(tarefa, 'abc', { arquivo: arq, modelo: 'm' }).ok, true);
  assert.strictEqual(lerAcertos(arq)[0].modelo, 'm');
  assert.match(registrar(tarefa, 'abc', { arquivo: arq }).motivo, /já existe/);
});

test('registrar recusa resposta que o verificador reprova, campo faltando e verificador temporário', () => {
  const arq = novoArquivo();
  assert.match(registrar(tarefa, 'errada', { arquivo: arq }).motivo, /não aprova/);
  assert.match(registrar({ ...tarefa, id: '' }, 'abc', { arquivo: arq }).motivo, /sem "id"/);
  assert.match(registrar(tarefa, '', { arquivo: arq }).motivo, /sem resposta/);
  assert.match(registrar({ ...tarefa, verificar: `node ${path.join(os.tmpdir(), 'x.js')}` }, 'abc', { arquivo: arq }).motivo, /temporário/);
  assert.strictEqual(lerAcertos(arq).length, 0);
});

test('registrar recusa verificador que aprova qualquer coisa', () => {
  const arq = novoArquivo();
  assert.match(registrar({ ...tarefa, verificar: 'node -e "process.exit(0)"' }, 'abc', { arquivo: arq }).motivo, /adulterada/);
});

test('importarDoPlano usa a referência como resposta certa', () => {
  const arq = novoArquivo();
  const r = importarDoPlano([{ ...tarefa, referencia: 'abc' }, { ...tarefa, id: 't2', referencia: 'zzz' }], { arquivo: arq });
  assert.strictEqual(r.registrados, 1);
  assert.strictEqual(r.recusados[0].id, 't2');
});

test("planos de sementes diferentes (mesmos ids) viram casos novos; o caso idêntico continua sendo duplicado", () => {
  const { gerarPlano } = require("../orquestra/sombra-plano/gerar-plano.js");
  const arq = novoArquivo();
  const a = importarDoPlano(gerarPlano(24, 1), { arquivo: arq });
  assert.ok(a.registrados >= 20, "quase todo o plano deve entrar");
  assert.ok(a.recusados.every((r) => /já existe/.test(r.motivo)), "só caso idêntico dentro do plano pode ser recusado");
  const b = importarDoPlano(gerarPlano(24, 4), { arquivo: arq });
  assert.ok(b.registrados > 0, "a segunda semente não registrou nada");
  const antes = lerAcertos(arq).length;
  const repetido = importarDoPlano(gerarPlano(24, 4), { arquivo: arq });
  assert.strictEqual(repetido.registrados, 0, "o mesmo plano duas vezes deve ser duplicado");
  assert.strictEqual(lerAcertos(arq).length, antes);
  const ids = lerAcertos(arq).map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, "ids repetidos no arquivo");
  for (const c of lerAcertos(arq)) assert.ok(rodarVerificador(c.verificar, c.saidaCerta), c.id);
});

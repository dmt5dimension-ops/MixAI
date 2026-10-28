const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validar, exigirVerificar, PADRAO } = require('../orquestra/sombra.js');

const plano = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'planos', 'sombra-plano-80.json'), 'utf8'));

test('plano da rodada em sombra é válido e tem tentativas de sobra por tipo para liberar', () => {
  validar(plano);
  exigirVerificar(plano);
  const porTipo = {};
  for (const t of plano) porTipo[t.tipo] = (porTipo[t.tipo] || 0) + 1;
  assert.ok(Object.keys(porTipo).length >= 4);
  for (const n of Object.values(porTipo)) assert.ok(n >= PADRAO.minimo, `tipo com só ${n} tarefas`);
});

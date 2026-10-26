const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const grafo = require('../orquestra/grafo.js');

const arquivo = path.join(__dirname, '..', 'orquestra', 'grafo.json');
const prsMesclados = new Set([16, 18, 19, 24]);

// A lista vem de uma conferência manual no GitHub, fora da suíte. O teste nunca acessa a rede.
function inconsistencias(g, mesclados = prsMesclados, lotesAtivos = new Set()) {
  const erros = [];
  for (const tarefa of Object.values(g.tarefas)) {
    const resultado = String(tarefa.resultado ?? '');
    const numero = Number(resultado.match(/\bPR #(\d+)\b/)?.[1]);
    if (mesclados.has(numero) &&
        (tarefa.estado !== 'feita' || resultado !== `PR #${numero} mesclado`)) {
      erros.push(`${tarefa.id}: PR #${numero} mesclado ainda está ${tarefa.estado} (${resultado})`);
    }
    if (tarefa.estado === 'em_andamento' && !lotesAtivos.has(tarefa.id)) {
      erros.push(`${tarefa.id}: em_andamento sem lote ativo`);
    }
  }
  return erros;
}

test('grafo canônico carrega e não anuncia trabalho antigo como ativo ou em revisão', () => {
  const atual = grafo.carregar(arquivo);
  assert.deepEqual(grafo.validar(atual), []);
  assert.deepEqual(inconsistencias(atual), []);
});

test('detector rejeita PR mesclado ainda em revisão ou aguardando merge e lote fantasma', () => {
  const obsoleto = structuredClone(grafo.carregar(arquivo));
  obsoleto.tarefas.etapa3.estado = 'em_andamento';
  obsoleto.tarefas.etapa4.estado = 'feita';
  obsoleto.tarefas.etapa4.resultado = 'PR #16 aprovado, aguardando merge';
  obsoleto.tarefas.etapa5.estado = 'em_revisao';
  obsoleto.tarefas.etapa5.resultado = 'PR #19 em revisão';
  const erros = inconsistencias(obsoleto);
  assert.ok(erros.some((e) => e.includes('etapa3: em_andamento sem lote ativo')));
  assert.ok(erros.some((e) => e.includes('etapa4: PR #16 mesclado')));
  assert.ok(erros.some((e) => e.includes('etapa5: PR #19 mesclado')));
  assert.deepEqual(inconsistencias(obsoleto, prsMesclados, new Set(['etapa3'])).filter((e) => e.includes('lote ativo')), []);
});

// Trava o notebook do Colab (sem GPU) e a regra "treino só fica pronto com validação".
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepararDataset, ladoDe } = require("../orquestra/treino.js");

const NOTEBOOK = path.join(__dirname, "..", "ferramentas", "treino-colab", "treino-qwen.ipynb");
const celulas = () => JSON.parse(fs.readFileSync(NOTEBOOK, "utf8")).cells.filter((c) => c.cell_type === "code").map((c) => c.source.join(""));

// No Windows "python3" costuma ser só o atalho da Microsoft Store: usa o primeiro que responde "Python x.y".
function acharPython() {
  for (const nome of ["python3", "python", "py"]) {
    const r = spawnSync(nome, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /^Python \d/.test(`${r.stdout}${r.stderr}`.trim())) return nome;
  }
  return null;
}

test("20 casos de treino e nenhum de validação não estão prontos para treinar", () => {
  const casos = [];
  for (let i = 0; casos.length < 20; i++) {
    const entrada = `tarefa numero ${i}`;
    if (ladoDe(entrada, 0.1) === "treino") casos.push({ entrada, saida: "ok" });
  }
  const r = prepararDataset(casos);
  assert.strictEqual(r.resumo.treino, 20);
  assert.strictEqual(r.resumo.validacao, 0);
  assert.strictEqual(r.resumo.pronto, false);
});

test("o notebook fixa a faixa do trl e confere validação não vazia", () => {
  const codigo = celulas();
  assert.ok(codigo.some((c) => /pip install.*"trl>=\d+\.\d+,<\d+"/.test(c)), "trl sem faixa de versão");
  assert.ok(codigo.some((c) => /validacao\.jsonl/.test(c) && /assert v >= 1/.test(c)), "falta conferir validação vazia");
});

test("o montador do trainer usa os nomes certos para a API nova e para a antiga do TRL", () => {
  const py = acharPython();
  if (!py) return; // sem Python nesta máquina não há como provar
  const celula = celulas().find((c) => c.includes("def montar_trainer"));
  assert.ok(celula, "notebook sem montar_trainer");
  const inicio = celula.indexOf("def montar_trainer");
  const fim = celula.indexOf("BASE =");
  const funcao = celula.slice(inicio, fim);
  const script = `
import inspect
${funcao}
class NovaCfg:
    def __init__(self, dataset_text_field=None, per_device_train_batch_size=None, gradient_accumulation_steps=None, num_train_epochs=None, learning_rate=None, eval_strategy=None, output_dir=None, report_to=None, max_length=None): self.k = {'max_length': max_length}
class NovoTrainer:
    def __init__(self, model=None, train_dataset=None, eval_dataset=None, args=None, processing_class=None): self.k = ('processing_class', args.k)
class VelhaCfg:
    def __init__(self, dataset_text_field=None, per_device_train_batch_size=None, gradient_accumulation_steps=None, num_train_epochs=None, learning_rate=None, eval_strategy=None, output_dir=None, report_to=None, max_seq_length=None): self.k = {'max_seq_length': max_seq_length}
class VelhoTrainer:
    def __init__(self, model=None, train_dataset=None, eval_dataset=None, args=None, tokenizer=None): self.k = ('tokenizer', args.k)
assert montar_trainer(NovoTrainer, NovaCfg, 'm', 't', [], []).k == ('processing_class', {'max_length': 2048})
assert montar_trainer(VelhoTrainer, VelhaCfg, 'm', 't', [], []).k == ('tokenizer', {'max_seq_length': 2048})
print('ok')
`;
  const r = spawnSync(py, ["-I", "-c", script], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});

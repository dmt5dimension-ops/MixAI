// Confere o texto de ferramentas/supervisor-tarefa.ps1 (na nuvem não há PowerShell; a validação real é no PC do dono).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(RAIZ, "ferramentas/supervisor-tarefa.ps1"), "utf8");

test("a tarefa roda orquestra/fofoqueiro.js e esse arquivo existe", () => {
  assert.match(script, /orquestra\\fofoqueiro\.js/);
  assert.ok(fs.existsSync(path.join(RAIZ, "orquestra/fofoqueiro.js")));
});

test("inicia no login e reinicia se cair", () => {
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /-RestartCount\s+\d+/);
  assert.match(script, /-RestartInterval/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
});

test("o log fica em D:\\MixAI-coordenacao, separado do canal, sem criar cópia do canal", () => {
  assert.match(script, /D:\\MixAI-coordenacao/);
  assert.match(script, /supervisor-tarefa\.log/);
  assert.doesNotMatch(script, /coordenacao\.md/);
});

test("não usa chave de API e permite remover a tarefa", () => {
  assert.doesNotMatch(script, /API_KEY|ANTHROPIC_|OPENAI_/i);
  assert.match(script, /\[switch\]\$Remover/);
  assert.match(script, /Unregister-ScheduledTask/);
});

test("não roda como administrador", () => {
  assert.match(script, /-RunLevel Limited/);
});

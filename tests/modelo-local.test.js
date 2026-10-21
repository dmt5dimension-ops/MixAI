// Testa a configuração dos modos dia/noite do modelo local (local/modos.json e local/modo.ps1).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PASTA = path.resolve(__dirname, "..", "local");
const modos = JSON.parse(fs.readFileSync(path.join(PASTA, "modos.json"), "utf8"));

test("existem os modos dia e noite, com todos os campos", () => {
  for (const nome of ["dia", "noite"]) {
    const m = modos[nome];
    assert.ok(m, `falta o modo ${nome}`);
    for (const campo of ["modelo", "contexto", "nucleos", "manterNaMemoria", "prioridade"]) {
      assert.ok(m[campo] !== undefined, `modo ${nome} sem ${campo}`);
    }
  }
});

test("modo dia usa menos o PC que o modo noite", () => {
  assert.ok(modos.dia.nucleos < modos.noite.nucleos);
  assert.ok(modos.dia.contexto <= modos.noite.contexto);
  assert.strictEqual(modos.dia.prioridade, "BelowNormal");
  assert.strictEqual(modos.noite.prioridade, "Normal");
});

test("nenhum modo passa do que o PC aguenta", () => {
  for (const m of Object.values(modos)) {
    assert.ok(m.nucleos >= 1 && m.nucleos <= 8, "o processador tem 8 núcleos");
    assert.ok(m.contexto <= 8192, "acima de 8192 o modelo de 7B não cabe na placa de 8 GB");
  }
});

test("o script troca de modo pelo nome fixo que o Claude usa", () => {
  const script = fs.readFileSync(path.join(PASTA, "modo.ps1"), "utf8");
  assert.match(script, /mixai-local/);
  assert.match(script, /modos\.json/);
  assert.match(script, /PriorityClass/);
});

test("o vigia corrige a prioridade do processo do modelo", () => {
  // O Ollama abre o llama-server com prioridade alta; sem o vigia o modo dia não vale para ele.
  const vigia = fs.readFileSync(path.join(PASTA, "vigia-prioridade.ps1"), "utf8");
  assert.match(vigia, /llama-server/);
  assert.match(vigia, /PriorityClass/);
  const script = fs.readFileSync(path.join(PASTA, "modo.ps1"), "utf8");
  assert.match(script, /vigia-prioridade\.ps1/);
});

test("ao reiniciar, o script fecha também o processo do modelo", () => {
  // Bug visto: o llama-server antigo ficava vivo segurando a placa de vídeo e o modelo novo não carregava.
  const script = fs.readFileSync(path.join(PASTA, "modo.ps1"), "utf8");
  const linhaStop = script.split("\n").find((l) => l.startsWith("Stop-Process -Name"));
  assert.ok(linhaStop, "falta a linha que fecha o Ollama");
  assert.match(linhaStop, /'llama-server'/);
});

test("o script sobe o Ollama escondido, sem abrir janela", () => {
  // Bug visto: abrir o "ollama app.exe" mostrava a janela do Ollama na tela do dono.
  const script = fs.readFileSync(path.join(PASTA, "modo.ps1"), "utf8");
  const inicio = script.split("\n").find((l) => l.startsWith("Start-Process") && l.includes("Ollama"));
  assert.ok(inicio, "falta a linha que inicia o Ollama");
  assert.doesNotMatch(inicio, /ollama app\.exe/);
  assert.match(inicio, /'serve'/);
  assert.match(inicio, /-WindowStyle Hidden/);
});

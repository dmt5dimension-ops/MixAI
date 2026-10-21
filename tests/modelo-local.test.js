// Testa a configuração dos modos dia/noite do modelo local (local/modos.json e local/modo.ps1).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PASTA = path.resolve(__dirname, "..", "local");
const modos = JSON.parse(fs.readFileSync(path.join(PASTA, "modos.json"), "utf8"));
const POWERSHELL = process.platform === "win32" ? "powershell" : "pwsh";

// Roda o criar-apelido.ps1 com um "ollama" falso que termina com o código pedido.
function criarApelidoComOllamaFalso(codigoDeSaida) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-falso-"));
  const falso = path.join(dir, "ollama-falso.ps1");
  const registro = path.join(dir, "chamadas.txt");
  fs.writeFileSync(falso, `Add-Content '${registro}' ($args -join ' ')\nexit ${codigoDeSaida}\n`);
  const r = spawnSync(POWERSHELL, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(PASTA, "criar-apelido.ps1"),
    "-Modelo", "qwen2.5-coder:7b", "-Contexto", "4096", "-Nucleos", "4", "-Ollama", falso,
  ], { encoding: "utf8" });
  const chamadas = fs.existsSync(registro) ? fs.readFileSync(registro, "utf8") : "";
  return { status: r.status, saida: `${r.stdout}${r.stderr}`, chamadas };
}

test("se o Ollama falhar ao criar o mixai-local, o script para com erro", () => {
  // Bug achado na revisão do Codex: o modo era anunciado como ligado mesmo com a falha.
  const r = criarApelidoComOllamaFalso(1);
  assert.match(r.chamadas, /create mixai-local -f/);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.saida, /NAO foi ligado/);
});

test("se o Ollama criar o mixai-local, o script termina sem erro", () => {
  const r = criarApelidoComOllamaFalso(0);
  assert.match(r.chamadas, /create mixai-local -f/);
  assert.strictEqual(r.status, 0, r.saida);
});

test("o modo.ps1 só anuncia o modo depois de criar o mixai-local", () => {
  const script = fs.readFileSync(path.join(PASTA, "modo.ps1"), "utf8");
  assert.doesNotMatch(script, /ollama create/, "a criação fica só no criar-apelido.ps1, que confere a falha");
  const criar = script.indexOf("criar-apelido.ps1");
  const anuncio = script.indexOf("ligado:");
  assert.ok(criar > 0 && anuncio > criar);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
});

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

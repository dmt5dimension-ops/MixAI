// Trava a regra do canal de coordenação entre Claude e Codex: os dois arquivos de regras precisam apontar para o mesmo canal.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CANAL = ["D:", "MixAI-coordenacao", "coordenacao.md"].join(String.fromCharCode(92));
const ler = (nome) => fs.readFileSync(path.resolve(__dirname, "..", nome), "utf8");

test("AGENTS.md e CODEX.md mandam usar o mesmo canal fora do git, antes e depois de cada etapa", () => {
  for (const nome of ["AGENTS.md", "CODEX.md"]) {
    const texto = ler(nome);
    assert.ok(texto.includes(CANAL), `${nome} não cita o canal ${CANAL}`);
    assert.ok(/fora do git/i.test(texto), `${nome} não diz que o canal fica fora do git`);
  }
  assert.ok(/antes e depois/i.test(ler("AGENTS.md")));
});

test("CLAUDE.md obriga o Claude a ler e escrever no canal antes e depois de cada passo, e antes de terminar o turno", () => {
  const texto = ler("CLAUDE.md");
  assert.ok(texto.includes(CANAL), "CLAUDE.md não cita o canal");
  assert.ok(/antes e depois de cada passo/i.test(texto), "falta 'antes e depois de cada passo'");
  assert.ok(/nunca (termine|terminar) (um|o) turno/i.test(texto), "falta a regra de nunca terminar o turno sem checar o canal");
});

test("só existe UM ponto de comunicação: o arquivo do repositório é apenas um ponteiro para o canal fixo", () => {
  const texto = ler(path.join("docs", "memoria", "coordenacao.md"));
  assert.ok(texto.includes(CANAL), "o ponteiro não cita o caminho fixo do canal");
  assert.ok(texto.split(/\r?\n/).filter((l) => l.trim()).length <= 6, "o arquivo do repositório deve ser só um ponteiro (máx. 6 linhas), não uma segunda cópia da conversa");
  assert.ok(!/^###\s/m.test(texto), "não pode haver mensagens (### ...) no arquivo do repositório");
});

test("CLAUDE.md não manda mais olhar a cópia antiga: o ponto de comunicação é um só", () => {
  const texto = ler("CLAUDE.md");
  assert.ok(!/cópia antiga/i.test(texto), "CLAUDE.md ainda fala em cópia antiga");
  assert.ok(/s[óo]mente|somente|só nele|apenas/i.test(texto), "CLAUDE.md deve dizer que se lê e escreve SÓ no canal");
});

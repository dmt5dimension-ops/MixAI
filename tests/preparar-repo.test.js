// Testa o kit que leva as regras do MixAI para o repositório de outro app (ferramentas/preparar-repo.ps1).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");
const kit = JSON.parse(ler("ferramentas/kit-arquivos.json"));
const script = ler("ferramentas/preparar-repo.ps1");

test("tudo que o kit copia existe neste repositório", () => {
  // Bug visto: o script copiava de ferramentas/modelos/, pasta que nunca existiu, e quebrava no primeiro passo.
  for (const item of kit.copiar) {
    assert.ok(fs.existsSync(path.join(RAIZ, item)), `o kit manda copiar ${item}, que não existe`);
  }
  assert.ok(fs.existsSync(path.join(RAIZ, kit.memoriaVazia.de)), "falta o modelo da memória vazia");
});

test("o kit leva as regras, os portões do CI e os comandos dos agentes", () => {
  // Lista do passo 1 do /integrar-app.
  const cobre = (alvo) =>
    kit.copiar.some((item) => item === alvo || (item.endsWith("/") && alvo.startsWith(item)));
  for (const alvo of [
    "AGENTS.md",
    "CLAUDE.md",
    "CODEX.md",
    ".claude/skills/integrar-app/SKILL.md",
    ".claude/agents/revisor.md",
    ".github/workflows/regressao.yml",
    ".github/workflows/portoes-do-pr.yml",
    ".github/scripts/trava_de_escopo.py",
    ".github/scripts/guarda_testes.py",
    ".github/scripts/revisao_cruzada.py",
    ".github/pull_request_template.md",
  ]) {
    assert.ok(cobre(alvo), `o kit não leva ${alvo}`);
  }
  assert.strictEqual(kit.memoriaVazia.para, "docs/memoria/estado.md");
});

test("o app novo começa com a memória vazia, sem o estado do MixAI", () => {
  const vazia = ler(kit.memoriaVazia.de);
  const titulos = (t) => t.split("\n").filter((l) => l.startsWith("## "));
  assert.deepStrictEqual(titulos(vazia), titulos(ler("docs/memoria/estado.md")));
  assert.doesNotMatch(vazia, /Papéis trocáveis|mixai-local|qwen/);
});

test("o script usa a lista do kit, não a pasta antiga", () => {
  assert.match(script, /kit-arquivos\.json/);
  assert.doesNotMatch(script, /'modelos'/);
});

test("o script acha onde gravar o comando de teste no AGENTS.md", () => {
  const ancora = new RegExp(kit.ancoraComandoTeste);
  const achado = ler("AGENTS.md").match(ancora);
  assert.ok(achado, "a âncora do comando de teste não acha nada no AGENTS.md");
  assert.strictEqual(achado[2], "npm test");
  assert.match(script, /ancoraComandoTeste/);
});

test("o script cria todas as labels que o AGENTS.md usa", () => {
  const usadas = new Set(ler("AGENTS.md").match(/(feito-por|revisado-por):(claude|codex)|permitir-[a-z-]+/g));
  for (const label of usadas) {
    assert.match(script, new RegExp(`'${label}'`), `o script não cria a label ${label}`);
  }
});

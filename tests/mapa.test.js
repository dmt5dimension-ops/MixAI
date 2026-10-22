// Testa o mapa do código e da memória (orquestra/mapa.js): índice de onde fica cada função e do que já foi feito.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const mapa = require(path.join(RAIZ, "orquestra", "mapa.js"));

function repoFalso() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "mapa-"));
  const grava = (rel, texto) => {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), texto);
  };
  grava("src/soma.js", "// Soma dois números.\nfunction somar(a, b) {\n  return a + b;\n}\nasync function lerTudo() {}\nconst dobrar = (x) => x * 2;\nmodule.exports = { somar, dobrar };\n");
  grava("scripts/x.ps1", "# Liga o modo noite.\nfunction Ligar-Noite {\n}\n");
  grava("node_modules/lixo/a.js", "function naoEntra() {}\n");
  grava("docs/memoria/estado.md", "# Estado\n\n## Já funciona (e o teste que trava)\n\n| O quê | Teste que trava |\n| --- | --- |\n| Soma dois números | `tests/soma.test.js` |\n| Outra coisa | tests/outra.test.js |\n\n## Em andamento\n\n- (nada)\n");
  return raiz;
}

test("o mapa lista funções com arquivo, linha e descrição, e ignora node_modules", () => {
  const raiz = repoFalso();
  const m = mapa.construir(raiz);
  const soma = m.arquivos.find((a) => a.arquivo === "src/soma.js");
  assert.ok(soma, "src/soma.js ausente");
  assert.strictEqual(soma.descricao, "Soma dois números.");
  assert.deepStrictEqual(soma.funcoes.map((f) => [f.nome, f.linha]), [["somar", 2], ["lerTudo", 5], ["dobrar", 6]]);
  assert.deepStrictEqual(soma.exporta, ["somar", "dobrar"]);
  assert.ok(m.arquivos.some((a) => a.arquivo === "scripts/x.ps1" && a.funcoes[0].nome === "Ligar-Noite"));
  assert.ok(!m.arquivos.some((a) => a.arquivo.includes("node_modules")));
});

test("o mapa acha funções com recuo, métodos, arrows aninhadas, e não confunde string com module.exports", () => {
  const raiz = repoFalso();
  fs.writeFileSync(path.join(raiz, "src/fundo.js"), [
    "async function externa() {",
    "  const julgar = async (saida, produtor) => {",
    "    if (saida) { return 1; }",
    "    for (const x of saida) {}",
    "  };",
    "  function interna(a) {}",
    "  const simples = x => x;",
    "}",
    "class Caixa {",
    "  constructor(a) {}",
    "  static criar() {}",
    "  async ler(x) {}",
    "}",
    "const obj = {",
    "  gancho: (e) => e,",
    "  outro(a) { return a; },",
    "};",
    "const texto = \"module.exports = { falso };\";",
    "module.exports = { externa };",
    "",
  ].join("\n"));
  const f = mapa.construir(raiz).arquivos.find((a) => a.arquivo === "src/fundo.js");
  const nomes = f.funcoes.map((x) => x.nome);
  for (const n of ["externa", "julgar", "interna", "simples", "constructor", "criar", "ler", "gancho", "outro"]) assert.ok(nomes.includes(n), `faltou ${n}: ${nomes}`);
  for (const n of ["if", "for", "obj", "texto"]) assert.ok(!nomes.includes(n), `sobrou ${n}`);
  assert.strictEqual(f.funcoes.find((x) => x.nome === "julgar").linha, 2);
  assert.deepStrictEqual(f.exporta, ["externa"]);
});

test("chamada ou comentário cujo texto menciona function não vira declaração", () => {
  const raiz = repoFalso();
  fs.writeFileSync(path.join(raiz, "src/texto.js"), [
    "function real() {}",
    "grava(\"a.js\", \"function falsa1(a) {\\n}\");",
    "grava('b.js', 'function falsa2() {}');",
    "grava(`function falsa3() {}`);",
    "// function falsa4() {}",
    "const x = 1; // function falsa5() {",
    "",
  ].join("\n"));
  const f = mapa.construir(raiz).arquivos.find((a) => a.arquivo === "src/texto.js");
  assert.deepStrictEqual(f.funcoes.map((x) => x.nome), ["real"]);
});

test("comentário de bloco, template de várias linhas e regex não viram função nem exports", () => {
  const raiz = repoFalso();
  fs.writeFileSync(path.join(raiz, "src/blocos.js"), [
    "function real() {}",
    "/* function falsa1() {}",
    "   function falsa2() {} */",
    "const t = `",
    "function falsa3() {}",
    "module.exports = { falso };",
    "`;",
    "const r = /\"function falsa4() {/;",
    "const depois = /[/]\\//.test(t);",
    "function outraReal() {}",
    "/*",
    "module.exports = { falso2 };",
    "*/",
    "module.exports = { real, outraReal };",
    "grava(\"a.js\", \"function falsa5(a) {\\n}\");",
    "",
  ].join("\n"));
  const f = mapa.construir(raiz).arquivos.find((a) => a.arquivo === "src/blocos.js");
  assert.deepStrictEqual(f.funcoes.map((x) => [x.nome, x.linha]), [["real", 1], ["outraReal", 10]]);
  assert.deepStrictEqual(f.exporta, ["real", "outraReal"]);
});

test("o mapa guarda o que já foi feito e qual teste trava cada coisa", () => {
  const m = mapa.construir(repoFalso());
  assert.deepStrictEqual(m.feitos, [
    { o_que: "Soma dois números", testes: ["tests/soma.test.js"] },
    { o_que: "Outra coisa", testes: ["tests/outra.test.js"] },
  ]);
});

test("o mapa é estável: gerar duas vezes dá o mesmo texto, e conferir acusa mapa velho", () => {
  const raiz = repoFalso();
  mapa.gerar(raiz);
  assert.strictEqual(mapa.conferir(raiz).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(raiz, "docs/memoria/mapa.json"), "utf8"), JSON.stringify(mapa.construir(raiz), null, 2) + "\n");
  fs.appendFileSync(path.join(raiz, "src/soma.js"), "function nova() {}\n");
  assert.strictEqual(mapa.conferir(raiz).ok, false);
});

test("buscar acha função, arquivo ou item feito por trecho do nome, sem reler o projeto", () => {
  const m = mapa.construir(repoFalso());
  const r = mapa.buscar(m, "som");
  assert.ok(r.some((x) => x.tipo === "funcao" && x.nome === "somar" && x.arquivo === "src/soma.js" && x.linha === 2));
  assert.ok(r.some((x) => x.tipo === "feito" && x.o_que === "Soma dois números"));
  assert.deepStrictEqual(mapa.buscar(m, "zzz-nao-existe"), []);
});

test("o mapa real é gerado de forma determinística e conhece a escada", () => {
  const m = mapa.gerar(RAIZ);
  const primeiraSaida = ["mapa.json", "mapa.md"].map((nome) => fs.readFileSync(path.join(RAIZ, "docs/memoria", nome), "utf8"));
  mapa.gerar(RAIZ);
  const segundaSaida = ["mapa.json", "mapa.md"].map((nome) => fs.readFileSync(path.join(RAIZ, "docs/memoria", nome), "utf8"));
  assert.deepStrictEqual(segundaSaida, primeiraSaida);
  assert.deepStrictEqual(JSON.parse(primeiraSaida[0]), m);
  const escada = m.arquivos.find((a) => a.arquivo === "orquestra/escada.js");
  assert.ok(escada.funcoes.some((f) => f.nome === "resolverComLoop"));
  assert.ok(m.feitos.length >= 5);
});

test("os mapas gerados são ignorados pelo git e não estão versionados", () => {
  for (const nome of ["mapa.json", "mapa.md"]) {
    const rel = `docs/memoria/${nome}`;
    const ignorado = spawnSync("git", ["check-ignore", "--no-index", "--quiet", rel], { cwd: RAIZ });
    assert.strictEqual(ignorado.status, 0, `${rel} não está no .gitignore`);
    const versionado = spawnSync("git", ["ls-files", "--error-unmatch", rel], { cwd: RAIZ });
    assert.strictEqual(versionado.status, 1, `${rel} ainda está versionado`);
  }
});

test("a linha de comando busca e confere (sai com 1 quando o mapa está velho)", () => {
  const ok = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "mapa.js"), "buscar", "resolverComLoop"], { encoding: "utf8" });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /orquestra\/escada\.js:\d+/);
  const raiz = repoFalso();
  const semMapa = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "mapa.js"), "buscar", "somar", "--raiz", raiz], { encoding: "utf8" });
  assert.strictEqual(semMapa.status, 0, semMapa.stderr);
  assert.match(semMapa.stdout, /src\/soma\.js:2/);
  const velho = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "mapa.js"), "conferir", "--raiz", raiz], { encoding: "utf8" });
  assert.strictEqual(velho.status, 1);
});

test("buscar usa o código atual mesmo se o mapa gerado estiver velho", () => {
  const raiz = repoFalso();
  mapa.gerar(raiz);
  fs.appendFileSync(path.join(raiz, "src/soma.js"), "function novidade() {}\n");
  const resultado = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "mapa.js"), "buscar", "novidade", "--raiz", raiz], { encoding: "utf8" });
  assert.strictEqual(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /src\/soma\.js:8\s+novidade/);
});

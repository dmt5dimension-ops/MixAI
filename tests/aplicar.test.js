const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { aplicarResposta, conferirAlterados } = require('../orquestra/aplicar.js');

function emRaizTemporaria(fn) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mixai-aplicar-'));
  try { fn(raiz); } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
}

test('grava o conteúdo exato em arquivo permitido', () => emRaizTemporaria((raiz) => {
  aplicarResposta({ raiz, escopo: ['src/a.js'], arquivo: 'src/a.js', conteudo: 'olá\n' });
  assert.equal(fs.readFileSync(path.join(raiz, 'src/a.js'), 'utf8'), 'olá\n');
}));

test('recusa arquivo fora do escopo antes de criar pastas ou sobrescrever', () => emRaizTemporaria((raiz) => {
  fs.mkdirSync(path.join(raiz, 'src'));
  fs.writeFileSync(path.join(raiz, 'src/a.js'), 'original');
  assert.throws(() => aplicarResposta({ raiz, escopo: ['src/a.js'], arquivo: 'src/b.js', conteudo: 'x' }));
  assert.equal(fs.readFileSync(path.join(raiz, 'src/a.js'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(raiz, 'src/b.js')), false);
}));

test('recusa fuga por .. mesmo se o escopo também tentar sair da raiz', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'mixai-limite-'));
  const raiz = path.join(pasta, 'raiz');
  const fora = path.join(pasta, 'fora.js');
  try {
    fs.mkdirSync(raiz);
    assert.throws(() => aplicarResposta({ raiz, escopo: ['../fora.js'], arquivo: '../fora.js', conteudo: 'x' }));
    assert.equal(fs.existsSync(fora), false);
  } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
});

test('escopo de arquivo não libera nomes parecidos nem um filho', () => emRaizTemporaria((raiz) => {
  for (const arquivo of ['src/a.js.bak', 'src/ab.js', 'src/a.js/filho']) {
    assert.throws(() => aplicarResposta({ raiz, escopo: ['src/a.js'], arquivo, conteudo: 'x' }));
    assert.equal(fs.existsSync(path.join(raiz, arquivo)), false);
  }
}));

test('escopo de pasta permite descendentes, mas não uma pasta irmã', () => emRaizTemporaria((raiz) => {
  aplicarResposta({ raiz, escopo: ['src/'], arquivo: 'src/x/y.js', conteudo: 'ok' });
  assert.equal(fs.readFileSync(path.join(raiz, 'src/x/y.js'), 'utf8'), 'ok');
  assert.throws(() => aplicarResposta({ raiz, escopo: ['src/'], arquivo: 'srcx/y.js', conteudo: 'x' }));
  assert.equal(fs.existsSync(path.join(raiz, 'srcx')), false);
  assert.deepEqual(conferirAlterados(['src/'], ['src/x/y.js', 'srcx/y.js']), ['srcx/y.js']);
}));

test('pasta sem barra final não libera filhos', () => emRaizTemporaria((raiz) => {
  assert.throws(() => aplicarResposta({ raiz, escopo: ['src'], arquivo: 'src/x.js', conteudo: 'x' }));
  assert.equal(fs.existsSync(path.join(raiz, 'src')), false);
  assert.deepEqual(conferirAlterados(['src'], ['src', 'src/x.js']), ['src/x.js']);
}));

test('recusa caminho absoluto fora da raiz', () => emRaizTemporaria((raiz) => {
  const fora = path.join(os.tmpdir(), `fora-${path.basename(raiz)}.js`);
  assert.throws(() => aplicarResposta({ raiz, escopo: ['.'], arquivo: fora, conteudo: 'x' }));
  assert.equal(fs.existsSync(fora), false);
}));

test('normaliza ./ e compara maiúsculas conforme o sistema de arquivos', () => emRaizTemporaria((raiz) => {
  fs.mkdirSync(path.join(raiz, 'src'));
  fs.writeFileSync(path.join(raiz, 'src/a.js'), 'antes');
  if (process.platform === 'win32') {
    aplicarResposta({ raiz, escopo: ['./SRC/a.js'], arquivo: './src/A.js', conteudo: 'depois' });
    assert.equal(fs.readFileSync(path.join(raiz, 'src/a.js'), 'utf8'), 'depois');
    assert.deepEqual(conferirAlterados(['src/a.js'], ['./src/A.js']), []);
  } else {
    assert.throws(() => aplicarResposta({ raiz, escopo: ['./src/a.js'], arquivo: './src/A.js', conteudo: 'indevido' }));
    assert.equal(fs.readFileSync(path.join(raiz, 'src/a.js'), 'utf8'), 'antes');
    assert.deepEqual(conferirAlterados(['src/a.js'], ['./src/A.js']), ['./src/A.js']);
  }
  assert.deepEqual(fs.readdirSync(path.join(raiz, 'src')), ['a.js']);
}));

test('conferirAlterados retorna exatamente os caminhos fora do escopo, na mesma ordem', () => {
  const alterados = ['src/a.js', 'docs/x.md', './SRC/b.js', 'srcx/y.js', 'src/a.js.bak', '../fora.js'];
  const caixaDiferente = process.platform === 'win32' ? [] : ['./SRC/b.js'];
  assert.deepEqual(conferirAlterados(['src/a.js', 'src/b.js'], alterados),
    ['docs/x.md', ...caixaDiferente, 'srcx/y.js', 'src/a.js.bak', '../fora.js']);
  assert.deepEqual(conferirAlterados(['src/'], alterados),
    ['docs/x.md', ...caixaDiferente, 'srcx/y.js', '../fora.js']);
  assert.deepEqual(conferirAlterados([], alterados), alterados);
});

test('escopo vazio recusa tudo sem criar arquivo', () => emRaizTemporaria((raiz) => {
  assert.throws(() => aplicarResposta({ raiz, escopo: [], arquivo: 'a.js', conteudo: 'x' }));
  assert.equal(fs.existsSync(path.join(raiz, 'a.js')), false);
}));

test('escopo que sobe pastas não vira permissão para a raiz inteira', () => emRaizTemporaria((raiz) => {
  assert.throws(() => aplicarResposta({ raiz, escopo: ['src/..'], arquivo: 'docs/x.md', conteudo: 'x' }));
  assert.equal(fs.existsSync(path.join(raiz, 'docs')), false);
  assert.deepEqual(conferirAlterados(['src/..'], ['docs/x.md']), ['docs/x.md']);
}));

test('recusa gravação por um link simbólico que aponta para fora', () => emRaizTemporaria((raiz) => {
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'mixai-fora-'));
  try {
    fs.symlinkSync(fora, path.join(raiz, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => aplicarResposta({ raiz, escopo: ['src/'], arquivo: 'src/a.js', conteudo: 'x' }));
    assert.equal(fs.existsSync(path.join(fora, 'a.js')), false);
  } finally { fs.rmSync(fora, { recursive: true, force: true }); }
}));

test('nomes de arquivo sem extensão não liberam filhos', () => emRaizTemporaria((raiz) => {
  for (const nome of ['Makefile', '.gitignore', 'LICENSE', 'Dockerfile']) {
    assert.throws(() => aplicarResposta({ raiz, escopo: [nome], arquivo: `${nome}/x`, conteudo: 'x' }));
    assert.equal(fs.existsSync(path.join(raiz, nome)), false);
    assert.deepEqual(conferirAlterados([nome], [nome, `${nome}/x`]), [`${nome}/x`]);
    aplicarResposta({ raiz, escopo: [nome], arquivo: nome, conteudo: nome });
    assert.equal(fs.readFileSync(path.join(raiz, nome), 'utf8'), nome);
  }
}));

test('recusa dois-pontos em qualquer parte do nome sem gravar', () => emRaizTemporaria((raiz) => {
  for (const arquivo of ['src/a.js:ads', 'src:ads/a.js']) {
    assert.throws(() => aplicarResposta({ raiz, escopo: ['src/'], arquivo, conteudo: 'x' }));
    assert.equal(fs.existsSync(path.join(raiz, arquivo)), false);
    assert.deepEqual(conferirAlterados(['.'], [arquivo]), [arquivo]);
  }
  assert.deepEqual(fs.readdirSync(raiz), []);
}));

test('recusa nomes reservados do Windows mesmo dentro de pasta autorizada', () => emRaizTemporaria((raiz) => {
  const arquivos = ['src/con', 'src/CON.txt', 'src/nul', 'src/prn.log', 'src/aux',
    'src/com1', 'src/COM9.txt', 'src/lpt1', 'src/LPT9.bin'];
  for (const arquivo of arquivos) {
    assert.throws(() => aplicarResposta({ raiz, escopo: ['src/'], arquivo, conteudo: 'x' }));
    assert.equal(fs.existsSync(path.join(raiz, arquivo)), false);
  }
  assert.deepEqual(conferirAlterados(['src/'], arquivos), arquivos);
  assert.deepEqual(fs.readdirSync(raiz), []);
}));

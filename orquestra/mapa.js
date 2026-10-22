// Mapa do código e da memória: onde fica cada função e o que já foi feito.
// Os modelos grandes consultam o mapa (`buscar`) em vez de reler o projeto.
const fs = require('node:fs');
const path = require('node:path');

const ignorar = new Set(['node_modules', '.git', 'casos', 'falhas']);
const saida = path.join('docs', 'memoria', 'mapa.json');
const saidaTexto = path.join('docs', 'memoria', 'mapa.md');

function listar(raiz, dir = '') {
  const achados = [];
  for (const e of fs.readdirSync(path.join(raiz, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir.split(path.sep).join('/'), e.name);
    if (e.isDirectory()) {
      if (!ignorar.has(e.name)) achados.push(...listar(raiz, rel));
    } else if (/\.(js|ps1)$/.test(e.name)) {
      achados.push(rel);
    }
  }
  return achados.sort();
}

function descricao(linhas, marca) {
  const primeira = linhas.findIndex((l) => l.trim() && !l.startsWith('#!'));
  const l = linhas[primeira] || '';
  return l.startsWith(marca) ? l.slice(marca.length).trim() : '';
}

// Esvazia comentários, strings, templates (inclusive de várias linhas) e regex do arquivo inteiro,
// mantendo as quebras de linha, para que texto dentro deles nunca pareça código.
function semTextos(texto, js) {
  if (!js) return texto.replace(/<#[\s\S]*?#>/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/#.*$/gm, '');
  let saida = '';
  let ultimo = '';
  const n = texto.length;
  for (let i = 0; i < n;) {
    const c = texto[i];
    const prox = texto[i + 1];
    if (c === '/' && prox === '/') {
      while (i < n && texto[i] !== '\n') i++;
    } else if (c === '/' && prox === '*') {
      const fim = texto.indexOf('*/', i + 2);
      const bloco = texto.slice(i, fim < 0 ? n : fim + 2);
      saida += bloco.replace(/[^\n]/g, ' ');
      i += bloco.length;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && texto[j] !== c && (c === '`' || texto[j] !== '\n')) j += texto[j] === '\\' ? 2 : 1;
      const lit = texto.slice(i, j + 1);
      saida += c + lit.slice(1, -1).replace(/[^\n]/g, ' ') + c;
      i = j + 1;
      ultimo = c;
    } else if (c === '/' && (ultimo === '' || '(,=:[!&|?{};+-*%<>~^'.includes(ultimo))) {
      let j = i + 1;
      let classe = false;
      while (j < n && texto[j] !== '\n' && (classe || texto[j] !== '/')) {
        if (texto[j] === '\\') j++;
        else if (texto[j] === '[') classe = true;
        else if (texto[j] === ']') classe = false;
        j++;
      }
      saida += '/ /';
      i = j + 1;
      ultimo = '/';
    } else {
      saida += c;
      if (!/\s/.test(c)) ultimo = c;
      i++;
    }
  }
  return saida;
}

function lerArquivo(raiz, rel) {
  const texto = fs.readFileSync(path.join(raiz, rel), 'utf8');
  const linhas = texto.split(/\r?\n/);
  const js = rel.endsWith('.js');
  const limpas = semTextos(texto, js).split(/\r?\n/);
  const palavras = 'if|for|while|switch|catch|function|return|else|do|try|with';
  const regras = js
    ? [
        /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
        /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s*)?(?:function\b[^(]*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?:=>|\{)/,
        new RegExp(`^\\s+(?:static\\s+)?(?:async\\s+)?(?!(?:${palavras})\\b)([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*\\{`),
      ]
    : [/^\s*function\s+([\w-]+)/i];
  const funcoes = [];
  linhas.forEach((l, i) => {
    for (const r of regras) {
      const m = r.exec(limpas[i]);
      if (m) { funcoes.push({ nome: m[1], linha: i + 1 }); break; }
    }
  });
  const item = { arquivo: rel, descricao: descricao(linhas, js ? '//' : '#'), funcoes };
  if (js) {
    const m = /^module\.exports\s*=\s*\{([^}]*)\}/m.exec(limpas.join('\n'));
    item.exporta = m ? m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean) : [];
  }
  return item;
}

function lerFeitos(raiz) {
  const arq = path.join(raiz, 'docs', 'memoria', 'estado.md');
  if (!fs.existsSync(arq)) return [];
  const feitos = [];
  let dentro = false;
  for (const l of fs.readFileSync(arq, 'utf8').split(/\r?\n/)) {
    if (/^##\s/.test(l)) dentro = /^##\s+Já funciona/i.test(l);
    else if (dentro && l.startsWith('|') && !/^\|\s*(O quê|-)/.test(l)) {
      const [, oque, testes] = l.split('|').map((s) => s.trim());
      if (oque) feitos.push({ o_que: oque, testes: [...(testes || '').matchAll(/tests\/[\w./-]+\.js/g)].map((m) => m[0]) });
    }
  }
  return feitos;
}

function construir(raiz) {
  return { arquivos: listar(raiz).map((r) => lerArquivo(raiz, r)), feitos: lerFeitos(raiz) };
}

function emTexto(m) {
  const linhas = ['# Mapa do código e da memória', '', 'Gerado por `node orquestra/mapa.js gerar`. Não edite à mão.', '', '## Arquivos', ''];
  for (const a of m.arquivos) {
    linhas.push(`- \`${a.arquivo}\`${a.descricao ? ` — ${a.descricao}` : ''}`);
    for (const f of a.funcoes) linhas.push(`  - \`${f.nome}\` (linha ${f.linha})`);
  }
  linhas.push('', '## Já feito e o teste que trava', '');
  for (const f of m.feitos) linhas.push(`- ${f.o_que}${f.testes.length ? ` — ${f.testes.map((t) => `\`${t}\``).join(', ')}` : ''}`);
  return linhas.join('\n') + '\n';
}

function gerar(raiz) {
  const m = construir(raiz);
  fs.mkdirSync(path.join(raiz, 'docs', 'memoria'), { recursive: true });
  fs.writeFileSync(path.join(raiz, saida), JSON.stringify(m, null, 2) + '\n');
  fs.writeFileSync(path.join(raiz, saidaTexto), emTexto(m));
  return m;
}

function conferir(raiz) {
  const m = construir(raiz);
  const esperado = { [saida]: JSON.stringify(m, null, 2) + '\n', [saidaTexto]: emTexto(m) };
  const velhos = Object.keys(esperado).filter((f) => {
    const arq = path.join(raiz, f);
    return !fs.existsSync(arq) || fs.readFileSync(arq, 'utf8') !== esperado[f];
  });
  return { ok: velhos.length === 0, velhos };
}

function buscar(m, termo) {
  const t = String(termo).toLowerCase();
  const achados = [];
  for (const a of m.arquivos) {
    if (a.arquivo.toLowerCase().includes(t) || a.descricao.toLowerCase().includes(t)) achados.push({ tipo: 'arquivo', arquivo: a.arquivo, descricao: a.descricao });
    for (const f of a.funcoes) if (f.nome.toLowerCase().includes(t)) achados.push({ tipo: 'funcao', nome: f.nome, arquivo: a.arquivo, linha: f.linha });
  }
  for (const f of m.feitos) if (f.o_que.toLowerCase().includes(t)) achados.push({ tipo: 'feito', ...f });
  return achados;
}

function principal(args) {
  const i = args.indexOf('--raiz');
  const raiz = i >= 0 ? path.resolve(args.splice(i, 2)[1]) : path.resolve(__dirname, '..');
  const [cmd, ...resto] = args;
  if (cmd === 'gerar') {
    const m = gerar(raiz);
    console.log(`Mapa gerado: ${m.arquivos.length} arquivos, ${m.feitos.length} itens feitos.`);
    return 0;
  }
  if (cmd === 'conferir') {
    const r = conferir(raiz);
    if (!r.ok) console.error(`Mapa velho (${r.velhos.join(', ')}). Rode: node orquestra/mapa.js gerar`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'buscar' && resto.length) {
    const m = construir(raiz);
    const r = buscar(m, resto.join(' '));
    for (const x of r) {
      if (x.tipo === 'funcao') console.log(`${x.arquivo}:${x.linha}  ${x.nome}`);
      else if (x.tipo === 'arquivo') console.log(`${x.arquivo}  ${x.descricao}`);
      else console.log(`feito: ${x.o_que}  ${x.testes.join(', ')}`);
    }
    return r.length ? 0 : 2;
  }
  console.error('Uso: node orquestra/mapa.js gerar | conferir | buscar <termo> [--raiz <pasta>]');
  return 1;
}

module.exports = { construir, gerar, conferir, buscar, emTexto };

if (require.main === module) process.exitCode = principal(process.argv.slice(2));

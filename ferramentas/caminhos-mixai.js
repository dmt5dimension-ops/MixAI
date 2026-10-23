// Faz o AGENTS.md/CODEX.md copiados para o repo de outro app apontarem para os scripts da pasta do MixAI
// (orquestra/ e local/ existem só lá). Uso: node ferramentas/caminhos-mixai.js <arquivo.md> <pasta do MixAI>
const fs = require('node:fs');

const base = (pasta) => String(pasta).replace(/\\/g, '/').replace(/\/+$/, '');
const INICIO = '(?<![\\w/\\\\.:"-])'; // só início de caminho: não pega docs/orquestra/x nem "D:/MixAI/orquestra/x"

function reescrever(texto, pasta) {
  const raiz = base(pasta);
  return String(texto)
    // Comandos: caminho completo entre aspas (a pasta pode ter espaço).
    .replace(new RegExp(`\\bnode ${INICIO}(orquestra/[\\w./-]+)`, 'g'), (_, rel) => `node "${raiz}/${rel}"`)
    .replace(new RegExp(`-File ${INICIO}(orquestra[/\\\\][\\w./\\\\-]+)`, 'g'), (_, rel) => `-File "${raiz}/${rel.replace(/\\/g, '/')}"`)
    // Menções soltas.
    .replace(new RegExp(`${INICIO}((?:orquestra|local)/)`, 'g'), (_, rel) => `${raiz}/${rel}`);
}

module.exports = { reescrever };

if (require.main === module) {
  const [arquivo, pasta] = process.argv.slice(2);
  if (!arquivo || !pasta) { console.error('uso: node caminhos-mixai.js <arquivo.md> <pasta do MixAI>'); process.exit(2); }
  const antes = fs.readFileSync(arquivo, 'utf8');
  const depois = reescrever(antes, pasta);
  if (depois !== antes) fs.writeFileSync(arquivo, depois);
}

// Verificadores mecânicos do plano da sombra. Leem a resposta do Qwen na entrada padrão e saem com 0 se estiver certa.
//   node confere.js igual "<esperado>"          resposta (sem espaço nas pontas e sem crases/aspas) igual ao esperado
//   node confere.js regex <arquivo.json>         { "bons": [...], "ruins": [...] }: re.fullmatch em JS, ancorada
const fs = require('node:fs');

function limpar(texto) {
  const bloco = /```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/.exec(texto);
  return (bloco ? bloco[1] : texto).trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
}

function conferir(modo, argumento, resposta) {
  const r = limpar(resposta);
  if (modo === 'igual') return r === argumento;
  if (modo === 'regex') {
    const { bons, ruins } = JSON.parse(fs.readFileSync(argumento, 'utf8'));
    let re;
    try { re = new RegExp(`^(?:${r})$`); } catch { return false; }
    return r !== '' && bons.every((s) => re.test(s)) && !ruins.some((s) => re.test(s));
  }
  throw new Error(`modo desconhecido: ${modo}`);
}

if (require.main === module) {
  let entrada = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { entrada += d; });
  process.stdin.on('end', () => {
    try { process.exit(conferir(process.argv[2], process.argv[3], entrada) ? 0 : 1); } catch (e) { console.error(e.message); process.exit(2); }
  });
}

module.exports = { conferir, limpar };

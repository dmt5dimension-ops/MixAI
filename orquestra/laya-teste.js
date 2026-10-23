// Mede se o Laya (modelo de decisão, não gera texto) acerta a pergunta "essa tarefa cabe no modelo local?"
// em cima dos casos antigos do MixAI (orquestra/casos/casos.jsonl). Quem roda o modelo de verdade é o PC do dono:
//   node orquestra/laya-teste.js medir orquestra/casos/casos.jsonl --modelo "python orquestra/laya-ponte.py"
// O modelo é um comando externo que lê uma linha JSON por caso ({id, entrada}) e responde uma linha JSON
// ({id, probabilidade}), onde probabilidade é a chance de "cabe no local". Assim os testes usam um modelo simulado.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MINIMO_CASOS = 30;
const ACERTO_MINIMO = 0.8;
const FOLGA_SOBRE_BASE = 0.1;
const LIMIAR_PADRAO = 0.5;
const LIMITE_PADRAO = 50;
const CASOS_PADRAO = path.join(__dirname, 'casos', 'casos.jsonl');

function rotular(caso) {
  return caso.resolvidoPor === 'local' ? 'local' : 'grande';
}

function carregarCasos(arquivo, limite) {
  const casos = [];
  if (limite === 0) return casos;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    if (!linha.trim()) continue;
    let c;
    try { c = JSON.parse(linha); } catch { continue; }
    if (!c || typeof c.entrada !== 'string' || !c.entrada.trim()) continue;
    casos.push({ entrada: c.entrada, esperado: rotular(c) });
    if (limite !== undefined && casos.length >= limite) break;
  }
  return casos;
}

function medir(casos, probabilidades, limiar = LIMIAR_PADRAO) {
  if (!Array.isArray(probabilidades) || probabilidades.length < casos.length) {
    throw new Error(`o modelo devolveu ${probabilidades ? probabilidades.length : 0} respostas para ${casos.length} casos`);
  }
  const matriz = { localComoLocal: 0, localComoGrande: 0, grandeComoLocal: 0, grandeComoGrande: 0 };
  casos.forEach((c, i) => {
    const previsto = probabilidades[i] >= limiar ? 'local' : 'grande';
    const chave = `${c.esperado}Como${previsto === 'local' ? 'Local' : 'Grande'}`;
    matriz[chave]++;
  });
  const total = casos.length;
  const acertos = matriz.localComoLocal + matriz.grandeComoGrande;
  const locais = matriz.localComoLocal + matriz.localComoGrande;
  const linhaBase = total ? Math.max(locais, total - locais) / total : 0;
  const acerto = total ? acertos / total : 0;
  const r = { total, limiar, acertos, acerto, matriz, falsoLocal: matriz.grandeComoLocal, linhaBase };
  r.veredito = veredito(r);
  return r;
}

// Falso-local (tarefa difícil mandada ao 7B) é o erro caro, por isso aparece no relatório.
function veredito(r) {
  if (r.total < MINIMO_CASOS) return { vale: false, motivo: `poucos casos (${r.total}); precisa de pelo menos ${MINIMO_CASOS} para concluir algo.` };
  if (r.acerto < ACERTO_MINIMO) return { vale: false, motivo: `acertou ${pct(r.acerto)}, abaixo do mínimo de ${pct(ACERTO_MINIMO)}.` };
  if (r.acerto < r.linhaBase + FOLGA_SOBRE_BASE) return { vale: false, motivo: `acertou ${pct(r.acerto)}, mas sempre chutar a maioria já dá ${pct(r.linhaBase)}.` };
  return { vale: true, motivo: `acertou ${pct(r.acerto)} contra ${pct(r.linhaBase)} do chute na maioria.` };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function chamarModelo(comando, casos) {
  return new Promise((resolve, reject) => {
    const filho = spawn(comando, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    filho.stdout.setEncoding('utf8');
    filho.stderr.setEncoding('utf8');
    filho.stdout.on('data', (d) => { out += d; });
    filho.stderr.on('data', (d) => { err += d; });
    filho.on('error', reject);
    filho.stdin.on('error', () => {});
    filho.on('close', (codigo) => {
      if (codigo !== 0) return reject(new Error(`o modelo saiu com código ${codigo}: ${err.trim().slice(-300)}`));
      const porId = new Map();
      for (const linha of out.split(/\r?\n/)) {
        if (!linha.trim()) continue;
        let r;
        try { r = JSON.parse(linha); } catch { return reject(new Error(`resposta inválida do modelo: ${linha.slice(0, 120)}`)); }
        if (typeof r.probabilidade !== 'number' || r.probabilidade < 0 || r.probabilidade > 1) {
          return reject(new Error(`resposta inválida do modelo: ${linha.slice(0, 120)}`));
        }
        porId.set(r.id, r.probabilidade);
      }
      const probs = casos.map((_, i) => porId.get(i));
      if (probs.some((p) => p === undefined)) return reject(new Error(`sem resposta para ${probs.filter((p) => p === undefined).length} dos ${casos.length} casos`));
      resolve(probs);
    });
    for (let i = 0; i < casos.length; i++) filho.stdin.write(JSON.stringify({ id: i, entrada: casos[i].entrada }) + '\n');
    filho.stdin.end();
  });
}

function textoRelatorio(r) {
  const m = r.matriz;
  return [
    `Casos: ${r.total} (limiar ${r.limiar})`,
    `Acerto: ${pct(r.acerto)} (${r.acertos}/${r.total}); chutar a maioria daria ${pct(r.linhaBase)}`,
    `Local certo: ${m.localComoLocal}   Local mandado ao grande: ${m.localComoGrande}`,
    `Grande certo: ${m.grandeComoGrande}   Grande mandado ao local (erro caro): ${m.grandeComoLocal}`,
    `Veredito: ${r.veredito.vale ? 'vale integrar' : 'ainda não vale'}: ${r.veredito.motivo}`,
  ].join('\n');
}

function opcao(args, nome) {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

// Número explícito vale como está (zero inclusive); ausente usa o padrão; lixo é erro, nunca o padrão.
function numeroDaOpcao(args, nome, padrao, valido, descricao) {
  if (!args.includes(nome)) return padrao;
  const texto = opcao(args, nome);
  const n = typeof texto === 'string' && texto.trim() !== '' && !texto.startsWith('--') ? Number(texto) : NaN;
  if (!Number.isFinite(n) || !valido(n)) throw new Error(`${nome} precisa ser ${descricao} (recebi ${texto === undefined ? 'nada' : `"${texto}"`}).`);
  return n;
}

async function principal(args) {
  if (args[0] !== 'medir') {
    console.error('Uso: node orquestra/laya-teste.js medir [casos.jsonl] --modelo "<comando>" [--limite 50] [--limiar 0.5] [--saida relatorio.json]');
    return 2;
  }
  const arquivo = args[1] && !args[1].startsWith('--') ? args[1] : CASOS_PADRAO;
  const modelo = opcao(args, '--modelo');
  if (!modelo) { console.error('Falta --modelo "<comando>", por exemplo "python orquestra/laya-ponte.py".'); return 2; }
  if (!fs.existsSync(arquivo)) { console.error(`Não encontrei o arquivo de casos: ${arquivo}`); return 2; }
  let limite, limiar;
  try {
    limite = numeroDaOpcao(args, '--limite', LIMITE_PADRAO, Number.isInteger, 'um número inteiro de 0 para cima');
    if (limite < 0) throw new Error(`--limite precisa ser um número inteiro de 0 para cima (recebi "${opcao(args, '--limite')}").`);
    limiar = numeroDaOpcao(args, '--limiar', LIMIAR_PADRAO, (n) => n >= 0 && n <= 1, 'um número de 0 a 1');
  } catch (e) { console.error(e.message); return 2; }
  if (limite === 0) { console.error('Com --limite 0 não sobra nenhum caso para medir; use 1 ou mais.'); return 2; }
  const casos = carregarCasos(arquivo, limite);
  if (!casos.length) { console.error('O arquivo não tem nenhum caso com "entrada".'); return 2; }
  const probs = await chamarModelo(modelo, casos);
  const r = medir(casos, probs, limiar);
  console.log(textoRelatorio(r));
  const saida = opcao(args, '--saida');
  if (saida) fs.writeFileSync(saida, JSON.stringify(r, null, 2) + '\n');
  return 0;
}

module.exports = { rotular, carregarCasos, medir, chamarModelo, textoRelatorio, MINIMO_CASOS };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`Erro: ${e.message}`); process.exit(1); });
}

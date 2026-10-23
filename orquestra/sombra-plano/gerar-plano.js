// Gera o plano da fase 0/1 do Qwen: tarefas que uma máquina confere, com a resposta de referência.
//   node orquestra/sombra-plano/gerar-plano.js 30 [semente] > plano.json    (rodar da raiz do repositório)
//   node orquestra/sombra.js rodar plano.json

function aleatorio(semente) {
  let s = semente >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const inteiro = (r, a, b) => a + Math.floor(r() * (b - a));

const TIPOS = {
  'data-iso': (r, i) => {
    const d = new Date(Date.UTC(1990, 0, 1) + inteiro(r, 0, 14000) * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const [a, m, dia] = iso.split('-');
    return { entrada: `Converta a data ${dia}/${m}/${a} (dia, mês, ano) para o formato ISO AAAA-MM-DD. Responda só com a data.`, modo: 'igual', esperado: iso };
  },
  'contar-vogais': (r) => {
    const texto = Array.from({ length: inteiro(r, 4, 12) }, () => 'abcdeiouxyz'[inteiro(r, 0, 11)]).join('');
    return { entrada: `Quantas vogais (a, e, i, o, u) tem o texto "${texto}"? Responda só com o número.`, modo: 'igual', esperado: String([...texto].filter((c) => 'aeiou'.includes(c)).length) };
  },
  'inverter-texto': (r) => {
    const texto = Array.from({ length: inteiro(r, 4, 10) }, () => 'abcdefghij'[inteiro(r, 0, 10)]).join('');
    return { entrada: `Escreva o texto "${texto}" de trás para frente. Responda só com o resultado.`, modo: 'igual', esperado: [...texto].reverse().join('') };
  },
  'regex-digitos': (r) => {
    const n = inteiro(r, 3, 9);
    return { entrada: `Escreva uma expressão regular que aceite apenas strings com exatamente ${n} dígitos (usada com correspondência completa). Responda só com a regex.`, modo: 'regex', esperado: `\\d{${n}}`,
      dados: { bons: ['1'.repeat(n), '7'.repeat(n - 1) + '0'], ruins: ['1'.repeat(n + 1), '1'.repeat(n - 1), 'a'.repeat(n), ''] } };
  },
};

// Os dados da regex vão dentro do próprio comando `verificar` (base64): cada plano é autossuficiente, planos de sementes
// diferentes não se atropelam e nada some quando a pasta temporária é limpa. O 3º parâmetro só existe por compatibilidade.
function gerarPlano(n, semente = 1) {
  const r = aleatorio(semente);
  const nomes = Object.keys(TIPOS);
  const tarefas = [];
  for (let i = 0; i < n; i++) {
    const tipo = nomes[i % nomes.length];
    const t = TIPOS[tipo](r, i);
    const id = `${tipo}-${String(i + 1).padStart(3, '0')}`;
    let verificar;
    if (t.modo === 'regex') {
      verificar = `node orquestra/sombra-plano/confere.js regex64 ${Buffer.from(JSON.stringify(t.dados)).toString('base64')}`;
    } else {
      verificar = `node orquestra/sombra-plano/confere.js igual "${t.esperado}"`;
    }
    tarefas.push({ id, tipo, entrada: t.entrada, verificar, referencia: t.esperado });
  }
  return tarefas;
}

if (require.main === module) {
  const n = Number(process.argv[2] || 30);
  if (!Number.isInteger(n) || n < 1) { console.error('Uso: node orquestra/sombra-plano/gerar-plano.js <quantidade> [semente]'); process.exit(1); }
  console.log(JSON.stringify(gerarPlano(n, Number(process.argv[3] || 1)), null, 2));
}

module.exports = { gerarPlano, TIPOS };

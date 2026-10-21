// Verificador do caso de regressão "data em ISO": lê a resposta no stdin e sai 0 só se for exatamente 2026-10-21.
let texto = '';
process.stdin.on('data', (d) => { texto += d; });
process.stdin.on('end', () => process.exit(texto.trim() === '2026-10-21' ? 0 : 1));

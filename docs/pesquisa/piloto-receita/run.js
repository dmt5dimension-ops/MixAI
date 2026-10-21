// Piloto: Qwen (mixai-local) sem receita x com receita, extração de campos de chamado.
// Uso: node run.js   (Ollama em 127.0.0.1:11434). Nenhuma API paga.
const fs = require('node:fs');
const path = require('node:path');
const arq = process.argv[2] || 'casos.json';
const casos = JSON.parse(fs.readFileSync(path.join(__dirname, arq), 'utf8'));
const receita = fs.readFileSync(path.join(__dirname, 'receita.md'), 'utf8').trim();
const MODELO = 'mixai-local';
const base = 'Retorne só JSON com as chaves cliente, data_iso, erro.';

async function chamar(prompt) {
  // a primeira chamada pode dar HTTP 500 enquanto o modelo carrega; repete até 3 vezes
  for (let t = 1; ; t += 1) {
    const r = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model: MODELO, prompt, stream: false, options: { temperature: 0, num_ctx: 4096, num_predict: 160, num_gpu: 0, use_mmap: true } }),
    });
    if (r.ok) return (await r.json()).response;
    if (t >= 3) throw new Error('HTTP ' + r.status);
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}
const norm = (s) => String(s).toLowerCase();
function avaliar(resp, caso) {
  const r = { estrito: false, conteudo: false, detalhe: [] };
  let obj; const bruto = resp.trim();
  try { obj = JSON.parse(bruto); r.estrito = true; } catch {
    try { obj = JSON.parse(bruto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch { r.detalhe.push('JSON inválido'); return r; }
    r.detalhe.push('cercado em markdown');
  }
  const chaves = Object.keys(obj).sort().join(',');
  if (chaves !== 'cliente,data_iso,erro') r.detalhe.push('chaves: ' + chaves);
  const okCliente = caso.cliente === null ? obj.cliente === null : (typeof obj.cliente === 'string' && caso.cliente.some((c) => norm(obj.cliente).includes(norm(c))));
  const okData = obj.data_iso === caso.data_iso;
  const okErro = caso.erro === null ? obj.erro === null : (typeof obj.erro === 'string' && caso.erro.every((k) => norm(obj.erro).includes(norm(k))));
  if (!okCliente) r.detalhe.push('cliente=' + JSON.stringify(obj.cliente));
  if (!okData) r.detalhe.push('data_iso=' + JSON.stringify(obj.data_iso));
  if (!okErro) r.detalhe.push('erro=' + JSON.stringify(obj.erro));
  r.conteudo = okCliente && okData && okErro && chaves === 'cliente,data_iso,erro';
  return r;
}
(async () => {
  const placar = { sem: { estrito: 0, conteudo: 0 }, formato: { estrito: 0, conteudo: 0 }, com: { estrito: 0, conteudo: 0 } };
  const linhas = [];
  for (const caso of casos) {
    const sem = base + '\n\nTexto: ' + caso.texto;
    const com = receita + '\n\n' + base + '\n\nTexto: ' + caso.texto + '\nSaída:';
    const formato = base + ' Responda só com o JSON puro, sem ``` e sem explicação. Use null quando o dado não aparecer.\n\nTexto: ' + caso.texto;
    const res = {};
    for (const [k, p] of [['sem', sem], ['formato', formato], ['com', com]]) {
      const resp = await chamar(p);
      const a = avaliar(resp, caso);
      // "estrito" = JSON puro (sem cerca) E conteúdo certo
      const estritoOk = a.estrito && a.conteudo;
      if (estritoOk) placar[k].estrito += 1;
      if (a.conteudo) placar[k].conteudo += 1;
      res[k] = { estritoOk, conteudoOk: a.conteudo, detalhe: a.detalhe, resposta: resp.trim() };
    }
    linhas.push({ id: caso.id, ...res });
    console.log(`#${caso.id} formato:${res.formato.estritoOk ? 'OK' : res.formato.conteudoOk ? 'ok-cerca' : 'X'} sem:${res.sem.estritoOk ? 'OK' : res.sem.conteudoOk ? 'ok-cerca' : 'X'} com:${res.com.estritoOk ? 'OK' : res.com.conteudoOk ? 'ok-cerca' : 'X'}`);
  }
  const out = { modelo: MODELO, data: new Date().toISOString(), casos: casos.length, receita_chars: receita.length, placar, linhas };
  fs.writeFileSync(path.join(__dirname, arq === 'casos.json' ? 'resultado.json' : 'resultado-' + arq), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ placar, receita_chars: receita.length }));
})();

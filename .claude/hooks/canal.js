// Trava do canal Claude↔Codex (regra obrigatória do dono). Dois modos, ligados em .claude/settings.json:
//   inicio: SessionStart, mostra o fim do canal para o Claude ler antes de começar.
//   parar:  Stop, impede encerrar o turno se a última mensagem do canal é do Codex e o Claude ainda não respondeu.
// O canal fixo é D:\MixAI-coordenacao\coordenacao.md (fora do git). Sem o arquivo (ex.: sessão na nuvem) sai em silêncio.
const fs = require('node:fs');

const CANAL = process.env.MIXAI_CANAL || ['D:', 'MixAI-coordenacao', 'coordenacao.md'].join(String.fromCharCode(92));
const LINHAS_NO_INICIO = 60;

// Autor de cada seção "### data — Autor → Destino". Transcrições do Codex "rodadas pelo Claude" são do Claude.
function ultimoAutor(texto) {
  const cabecalhos = String(texto).split(/\r?\n/).filter((l) => /^###\s/.test(l));
  for (let i = cabecalhos.length - 1; i >= 0; i--) {
    const m = /^###\s+(?:\S+\s+)?[—-]\s*([^→\n]+?)\s*(?:→|$)/.exec(cabecalhos[i]);
    if (!m) continue;
    const autor = m[1].trim();
    if (/rodad[oa] pel[oa] Claude|MIGRADO/i.test(cabecalhos[i])) return 'claude';
    return /^codex/i.test(autor) ? 'codex' : 'claude';
  }
  return null;
}

function decidirParar(texto, _entrada) {
  // Mesmo com stop_hook_active (o Claude tenta encerrar de novo), só libera depois de responder no canal: a leitura é refeita a cada tentativa.
  if (ultimoAutor(texto) !== 'codex') return null;
  return {
    decision: 'block',
    reason: `O Codex deixou uma mensagem sem resposta no canal ${CANAL}. Leia o fim do arquivo, faça o que ele pediu ou responda ali mesmo (uma seção "### data — Claude → Codex"), e só então encerre o turno.`,
  };
}

function fimDoCanal(texto) {
  return String(texto).split(/\r?\n/).slice(-LINHAS_NO_INICIO).join('\n');
}

function lerEntrada() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function principal(modo) {
  let texto;
  try { texto = fs.readFileSync(CANAL, 'utf8'); } catch { return; } // sem canal: silêncio
  if (modo === 'inicio') {
    console.log(`[Canal com o Codex: ${CANAL}] Regra do dono: leia o canal antes e depois de cada passo e nunca termine o turno sem checar. Últimas linhas:\n${fimDoCanal(texto)}`);
  } else if (modo === 'parar') {
    const r = decidirParar(texto, lerEntrada());
    if (r) console.log(JSON.stringify(r));
  }
}

module.exports = { ultimoAutor, decidirParar, fimDoCanal };

if (require.main === module) principal(process.argv[2]);

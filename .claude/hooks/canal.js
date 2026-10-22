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
    // data (com ou sem hora), travessão (— ou -) e depois o autor até a seta
    const m = /^###\s+(?:\S+(?:\s+\d{1,2}:\d{2})?\s+)?[—–-]\s*([^→\n]+?)\s*(?:→|$)/.exec(cabecalhos[i]);
    if (!m) continue;
    const autor = m[1].trim();
    // Transcrição do Codex rodada pelo Claude (autor "Codex (rodado pelo Claude...)") conta como do Claude.
    if (/^codex\s*\([^)]*rodad[oa] pel[oa] Claude/i.test(autor)) return 'claude';
    if (/^codex/i.test(autor)) return 'codex';
    if (/^claude/i.test(autor)) return 'claude';
    // Autor de outra pessoa (dono, nuvem) ou cabeçalho sem autor: não decide quem respondeu; olha a seção anterior.
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
  try { texto = fs.readFileSync(CANAL, 'utf8'); } catch (erro) {
    if (erro && erro.code === 'ENOENT') return; // sem canal (ex.: sessão na nuvem): silêncio
    // Qualquer outra falha (acesso negado, é uma pasta...) NÃO pode desligar a trava em silêncio.
    const motivo = `Não consegui ler o canal ${CANAL} (${erro && erro.code ? erro.code : 'erro'}). Corrija o acesso ao arquivo antes de encerrar o turno.`;
    if (modo === 'parar') console.log(JSON.stringify({ decision: 'block', reason: motivo }));
    else console.log(`[Canal com o Codex] ${motivo}`);
    return;
  }
  if (modo === 'inicio') {
    console.log(`[Canal com o Codex: ${CANAL}] Regra do dono: leia o canal antes e depois de cada passo e nunca termine o turno sem checar. Últimas linhas:\n${fimDoCanal(texto)}`);
  } else if (modo === 'parar') {
    const r = decidirParar(texto, lerEntrada());
    if (r) console.log(JSON.stringify(r));
  }
}

module.exports = { ultimoAutor, decidirParar, fimDoCanal };

if (require.main === module) principal(process.argv[2]);

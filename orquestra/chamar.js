const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pasta = __dirname;
const arquivoEstado = path.join(pasta, 'sem-cota.json');
const papeis = require('./papeis.json');
const agentes = ['claude', 'codex', 'local'];

function detectarLimite(texto) {
  return /\b(?:rate limit reached|usage limit|session limit|weekly limit|hit your\s+\w+\s+limit|limit will reset|quota exceeded|insufficient_quota)\b/i.test(String(texto));
}

function limiteNaSaida(agente, saida, tarefa) {
  if (agente === 'claude') {
    for (const linha of String(saida).split(/\r?\n/).reverse()) {
      try {
        const resultado = JSON.parse(linha);
        return resultado?.is_error === true && detectarLimite(resultado.result);
      } catch (erro) {
        if (!(erro instanceof SyntaxError)) throw erro;
      }
    }
  }

  let texto = String(saida);
  const trechos = [String(tarefa), ...String(tarefa).split(/\r?\n/)]
    .filter((trecho) => trecho.trim())
    .sort((a, b) => b.length - a.length);
  for (const trecho of trechos) texto = texto.split(trecho).join('');
  return detectarLimite(texto);
}

function ultimoJson(saida) {
  for (const linha of String(saida).split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(linha);
    } catch (erro) {
      if (!(erro instanceof SyntaxError)) throw erro;
    }
  }
  return null;
}

function falhouSemCota(agente, saida, codigo) {
  return codigo !== 0 || (agente === 'claude' && ultimoJson(saida)?.is_error === true);
}

function marcarSemCota(estado, agente, horas, agora) {
  return {
    ...estado,
    [agente]: new Date(new Date(agora).getTime() + horas * 60 * 60 * 1000).toISOString(),
  };
}

function escolher(papel, configuracao, estado, agora, implementador) {
  const momento = new Date(agora).getTime();
  return (configuracao.ordem[papel] || []).find((agente) => {
    if (agente === implementador) return false;
    const fim = estado[agente];
    return !fim || new Date(fim).getTime() <= momento;
  }) || null;
}

function lerEstado() {
  if (!fs.existsSync(arquivoEstado)) {
    fs.writeFileSync(arquivoEstado, '{}\n');
    return {};
  }
  try {
    const estado = JSON.parse(fs.readFileSync(arquivoEstado, 'utf8'));
    return estado && typeof estado === 'object' && !Array.isArray(estado) ? estado : {};
  } catch (erro) {
    if (erro instanceof SyntaxError) return {};
    throw erro;
  }
}

function salvarEstado(estado) {
  fs.writeFileSync(arquivoEstado, JSON.stringify(estado, null, 2) + '\n');
}

function uso() {
  console.error('Uso: node orquestra/chamar.js quem | sem-cota <claude|codex|local> | normal | <papel> <arquivo> [--implementador <agente>]');
  return 2;
}

function principal(argumentos) {
  const [comando, alvo, opcao, implementador] = argumentos;
  let estado = lerEstado();

  if (comando === 'quem' && argumentos.length === 1) {
    const agora = new Date();
    for (const papel of Object.keys(papeis.ordem)) {
      console.log(`${papel}: ${escolher(papel, papeis, estado, agora) || 'ninguém disponível'}`);
    }
    const pausados = agentes.filter((agente) => estado[agente] && new Date(estado[agente]).getTime() > agora.getTime());
    if (pausados.length === 0) console.log('Ninguém está pausado.');
    for (const agente of pausados) console.log(`${agente} pausado até ${estado[agente]}`);
    return 0;
  }

  if (comando === 'sem-cota' && argumentos.length === 2 && agentes.includes(alvo)) {
    estado = marcarSemCota(estado, alvo, papeis.pausaHoras, new Date());
    salvarEstado(estado);
    console.log(`${alvo} sem cota; pausado até ${estado[alvo]}.`);
    return 0;
  }

  if (comando === 'normal' && argumentos.length === 1) {
    salvarEstado({});
    console.log('Todas as pausas foram removidas.');
    return 0;
  }

  if (!Object.hasOwn(papeis.ordem, comando) || !alvo ||
      (argumentos.length !== 2 && (argumentos.length !== 4 || opcao !== '--implementador' || !agentes.includes(implementador)))) {
    return uso();
  }

  const tarefa = fs.readFileSync(path.resolve(alvo), 'utf8');
  const comandos = {
    claude: 'claude -p --output-format json --permission-mode acceptEdits --allowedTools "Bash(npm test:*)" "Bash(git status:*)" "Bash(git diff:*)"',
    codex: 'codex exec -s workspace-write -',
    local: 'ollama run mixai-local',
  };

  while (true) {
    const agente = escolher(comando, papeis, estado, new Date(), implementador);
    if (!agente) {
      console.error(`Ninguém disponível para o papel ${comando}.`);
      return 3;
    }
    if (agente === 'local') console.log('O modelo local só devolve texto; ele não edita arquivos.');
    const resultado = spawnSync(comandos[agente], {
      shell: true,
      input: tarefa,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (resultado.stdout) process.stdout.write(resultado.stdout);
    if (resultado.stderr) process.stderr.write(resultado.stderr);
    const saida = (resultado.stdout || '') + '\n' + (resultado.stderr || '');
    if (limiteNaSaida(agente, saida, tarefa)) {
      estado = marcarSemCota(estado, agente, papeis.pausaHoras, new Date());
      salvarEstado(estado);
      console.error(`${agente} ficou sem cota até ${estado[agente]}. Tentando o próximo agente.`);
      continue;
    }
    if (falhouSemCota(agente, saida, resultado.status)) {
      const mensagem = agente === 'claude' ? ultimoJson(saida)?.result : null;
      console.error(`${agente} falhou: ${mensagem || 'veja a saída acima'}`);
      return 1;
    }
    if (resultado.error) {
      console.error(`Não foi possível chamar ${agente}: ${resultado.error.message}`);
      return 1;
    }
    return resultado.status === null ? 1 : resultado.status;
  }
}

module.exports = { detectarLimite, limiteNaSaida, falhouSemCota, marcarSemCota, escolher };

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (erro) {
    console.error(`Erro na orquestração: ${erro.message}`);
    process.exitCode = 1;
  }
}

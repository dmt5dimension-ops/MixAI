"""Gera tarefas que uma máquina consegue conferir sozinha (sem Claude, Codex ou API) e confere as respostas.

Cada caso tem: tipo, prompt, referencia (resposta certa conhecida) e dados para o verificador.
Os casos são determinísticos pela semente, então a validação é sempre a mesma.
"""
import ast
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from datetime import date, timedelta

TEMPO_MAX_S = 5

DICAS = {
    "data_iso": "Responda somente com a data no formato AAAA-MM-DD, com zeros à esquerda, sem texto extra.",
    "regex": "Responda somente com a expressão regular, sem delimitadores, sem aspas e sem explicação. Ela será usada com re.fullmatch.",
    "codigo": "Responda somente com a função Python pedida, com o nome exato e sem exemplos de uso nem print.",
}


def extrair(resposta):
    """Pega o conteúdo do primeiro bloco de código; sem bloco, usa a resposta inteira."""
    r = str(resposta or "")
    m = re.search(r"```[A-Za-z0-9_+-]*\n(.*?)```", r, re.S)
    return (m.group(1) if m else r).strip()


# Código vindo do modelo nunca roda solto: (1) a árvore do código é conferida antes (sem import fora da lista, sem open/exec/eval,
# sem nome ou atributo com "__"), (2) ele roda com uma lista fechada de funções embutidas (não existe open nem __import__ livre),
# (3) em outro processo, pasta vazia, sem variáveis do ambiente, com limite de tempo, memória e processos.
# Sem `operator` e `string`: attrgetter/methodcaller/Formatter alcançam atributo por texto e furam a conferência da árvore.
# Cada módulo permitido entra no código do modelo como uma FACHADA: só as funções e classes públicas dele, nunca outro módulo
# (statistics.sys, re.enum, functools.sys... não existem), então não há caminho de volta para os módulos do sistema.
IMPORTS_OK = {"math", "re", "itertools", "functools", "collections", "statistics"}
# atributos que dão acesso ao quadro de execução do interpretador (frame/código) e de lá aos globais reais
ATRIBUTOS_DE_QUADRO = ("gi_", "cr_", "ag_", "f_", "tb_", "co_", "func_")
NOMES_PROIBIDOS = {"open", "exec", "eval", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars",
                   "getattr", "setattr", "delattr", "exit", "quit", "memoryview", "help", "dir", "type", "super", "object"}
EMBUTIDAS_OK = ["abs", "all", "any", "bin", "bool", "chr", "dict", "divmod", "enumerate", "filter", "float", "frozenset", "hex",
                "int", "isinstance", "iter", "len", "list", "map", "max", "min", "next", "oct", "ord", "pow", "range", "repr",
                "reversed", "round", "set", "slice", "sorted", "str", "sum", "tuple", "zip", "ValueError", "TypeError",
                "KeyError", "IndexError", "ZeroDivisionError", "Exception", "True", "False", "None"]


def codigo_seguro(codigo):
    """True se a árvore do código não usa nada fora do permitido."""
    try:
        arvore = ast.parse(codigo)
    except SyntaxError:
        return False
    for no in ast.walk(arvore):
        if isinstance(no, ast.Import):
            if any(a.name.split(".")[0] not in IMPORTS_OK for a in no.names):
                return False
        elif isinstance(no, ast.ImportFrom):
            if no.level or (no.module or "").split(".")[0] not in IMPORTS_OK:
                return False
        elif isinstance(no, ast.Name):
            if no.id in NOMES_PROIBIDOS or no.id.startswith("__"):
                return False
        elif isinstance(no, ast.Attribute):
            if no.attr.startswith("__") or no.attr in NOMES_PROIBIDOS or no.attr.startswith(ATRIBUTOS_DE_QUADRO):
                return False
        elif isinstance(no, (ast.Global, ast.Nonlocal)):
            return False
    return True


_LIMITES = '''
import resource
resource.setrlimit(resource.RLIMIT_AS, (1 << 30, 1 << 30))
resource.setrlimit(resource.RLIMIT_CPU, (%d, %d))
resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
'''


# sem variáveis do ambiente (chaves, tokens); o Windows só precisa do SystemRoot para o Python subir
_AMBIENTE = {} if os.name == "posix" else {"SystemRoot": os.environ.get("SystemRoot", "")}


def _rodar(codigo):
    """Roda o código em outro processo isolado, com tempo máximo. Devolve True se saiu com 0."""
    prefixo = (_LIMITES % (TEMPO_MAX_S, TEMPO_MAX_S)) if os.name == "posix" else ""
    with tempfile.TemporaryDirectory() as pasta:
        try:
            p = subprocess.run([sys.executable, "-I", "-c", prefixo + codigo], cwd=pasta, capture_output=True,
                               timeout=TEMPO_MAX_S + 2, env=_AMBIENTE)
            return p.returncode == 0
        except subprocess.TimeoutExpired:
            return False


# ---------- data_iso ----------
def _data_iso(rng):
    d = date(1990, 1, 1) + timedelta(days=rng.randrange(0, 14000))
    formato = rng.choice(["{:02d}/{:02d}/{}", "{:02d}-{:02d}-{}", "{:02d}.{:02d}.{}"])
    texto = formato.format(d.day, d.month, d.year)
    return {"tipo": "data_iso", "prompt": f"Converta a data {texto} (dia, mês, ano) para o formato ISO AAAA-MM-DD.",
            "referencia": d.isoformat(), "dados": {"esperado": d.isoformat()}}


def _ver_data_iso(caso, resposta):
    return extrair(resposta).strip().strip("`'\" ") == caso["dados"]["esperado"]


# ---------- regex ----------
def _regex(rng):
    n = rng.randrange(3, 9)
    k = rng.randrange(2, 5)
    modelos = [
        (f"aceite apenas strings com exatamente {n} dígitos", rf"\d{{{n}}}",
         ["1" * n, "7" * (n - 1) + "0"], ["1" * (n + 1), "1" * (n - 1), "a" * n, ""]),
        (f"aceite apenas strings com {k} letras minúsculas seguidas de um hífen e {n} dígitos", rf"[a-z]{{{k}}}-\d{{{n}}}",
         ["a" * k + "-" + "5" * n], ["A" * k + "-" + "5" * n, "a" * k + "5" * n, "a" * (k + 1) + "-" + "5" * n]),
        ("aceite apenas horas no formato HH:MM de 00:00 a 23:59", r"([01]\d|2[0-3]):[0-5]\d",
         ["00:00", "23:59", "07:30"], ["24:00", "12:60", "7:30", "12-30"]),
        (f"aceite apenas strings formadas por {n} ou mais letras 'x' ou 'y' (nenhum outro caractere)", rf"[xy]{{{n},}}",
         ["x" * n, "xy" * n], ["x" * (n - 1), "xz" * n, ""]),
    ]
    desc, ref, bons, ruins = rng.choice(modelos)
    return {"tipo": "regex", "prompt": f"Escreva uma expressão regular Python que, usada com re.fullmatch, {desc}.",
            "referencia": ref, "dados": {"bons": bons, "ruins": ruins}}


def _ver_regex(caso, resposta):
    padrao = extrair(resposta).strip().strip("`")
    if not padrao:
        return False
    d = caso["dados"]
    codigo = ("import re,json\nd=json.loads(%r)\np=re.compile(d['p'])\n"
              "assert all(p.fullmatch(s) for s in d['bons'])\nassert not any(p.fullmatch(s) for s in d['ruins'])\n"
              % json.dumps({"p": padrao, "bons": d["bons"], "ruins": d["ruins"]}))
    return _rodar(codigo)


# ---------- codigo ----------
def _modelos_codigo(rng):
    k = rng.randrange(2, 6)
    lim = rng.randrange(3, 12)
    return [
        ("soma_multiplos", f"recebe uma lista de inteiros e devolve a soma dos que são múltiplos de {k}",
         f"def soma_multiplos(l):\n    return sum(x for x in l if x % {k} == 0)\n",
         lambda r: [([r.randrange(-20, 40) for _ in range(r.randrange(0, 8))],) for _ in range(6)]),
        ("conta_vogais", "recebe um texto e devolve quantas vogais (a, e, i, o, u, sem acento, maiúsculas ou minúsculas) ele tem",
         "def conta_vogais(t):\n    return sum(1 for c in t.lower() if c in 'aeiou')\n",
         lambda r: [("".join(r.choice("abcdeIOUxyz ") for _ in range(r.randrange(0, 12))),) for _ in range(6)]),
        ("eh_palindromo", "recebe um texto e devolve True se ele é palíndromo ignorando maiúsculas e espaços, senão False",
         "def eh_palindromo(t):\n    s = t.replace(' ', '').lower()\n    return s == s[::-1]\n",
         lambda r: [(r.choice(["Ana", "arara", "casa", "A sub no bus", "ab ba", "abc", ""]),) for _ in range(6)]),
        ("limita", f"recebe uma lista de números e devolve uma nova lista em que todo valor maior que {lim} vira {lim}",
         f"def limita(l):\n    return [min(x, {lim}) for x in l]\n",
         lambda r: [([r.randrange(-5, 25) for _ in range(r.randrange(0, 8))],) for _ in range(6)]),
        ("maior_diferenca", "recebe uma lista de inteiros com pelo menos 2 elementos e devolve a maior diferença absoluta entre dois elementos consecutivos",
         "def maior_diferenca(l):\n    return max(abs(a - b) for a, b in zip(l, l[1:]))\n",
         lambda r: [([r.randrange(-30, 30) for _ in range(r.randrange(2, 8))],) for _ in range(6)]),
        ("palavras_unicas", "recebe um texto e devolve a lista, em ordem alfabética, das palavras distintas em minúsculas (separadas por espaço)",
         "def palavras_unicas(t):\n    return sorted(set(t.lower().split()))\n",
         lambda r: [(" ".join(r.choice(["Sol", "lua", "SOL", "mar", "Mar", "céu"]) for _ in range(r.randrange(0, 7))),) for _ in range(6)]),
    ]


def _codigo(rng):
    nome, desc, ref, argsfn = rng.choice(_modelos_codigo(rng))
    escopo = {}
    exec(ref, escopo)  # referência escrita por nós, confiável
    casos = []
    for args in argsfn(rng):
        casos.append({"args": list(args), "esperado": escopo[nome](*args)})
    return {"tipo": "codigo", "prompt": f"Escreva em Python a função {nome} que {desc}.",
            "referencia": ref, "dados": {"nome": nome, "testes": casos}}


def _ver_codigo(caso, resposta):
    codigo = extrair(resposta)
    if not codigo or not codigo_seguro(codigo):
        return False
    d = caso["dados"]
    runner = ("import json, builtins, sys, types\nd=json.loads(%r)\n"
              "_ok=%r\n_imp=%r\n_real=builtins.__import__\n"
              "def _fachada(nome):\n    mod = _real(nome)\n    ns = types.SimpleNamespace()\n"
              "    for k in dir(mod):\n        v = getattr(mod, k)\n        if k.startswith('_') or isinstance(v, types.ModuleType): continue\n        setattr(ns, k, v)\n    return ns\n"
              "_fach = {n: _fachada(n) for n in _imp}\n"
              "def _imp_seguro(nome, globals=None, locals=None, fromlist=(), level=0):\n    if level or nome not in _fach: raise ImportError(nome)\n    return _fach[nome]\n"
              "for _m in ('os', 'posix', 'nt', 'subprocess', 'socket', 'shutil', 'ctypes', '_ctypes', 'pathlib'):\n    sys.modules.pop(_m, None)\n"
              "_b={n: getattr(builtins, n) for n in _ok}\n_b['__import__']=_imp_seguro\n_b['__build_class__']=builtins.__build_class__\n"
              "ns={'__builtins__': _b, '__name__': 'resposta'}\n"
              "exec(compile(%r,'resposta','exec'),ns)\nf=ns[d['nome']]\n"
              "for t in d['testes']:\n    assert f(*t['args'])==t['esperado'], t\n"
              % (json.dumps({"nome": d["nome"], "testes": d["testes"]}), EMBUTIDAS_OK, sorted(IMPORTS_OK), codigo))
    return _rodar(runner)


GERADORES = {"data_iso": _data_iso, "regex": _regex, "codigo": _codigo}
VERIFICADORES = {"data_iso": _ver_data_iso, "regex": _ver_regex, "codigo": _ver_codigo}
TIPOS = list(GERADORES)


def verificar(caso, resposta):
    try:
        return bool(VERIFICADORES[caso["tipo"]](caso, resposta))
    except Exception:
        return False


def gerar(semente, n=1, tipos=None, conferir=True):
    """n casos determinísticos pela semente, alternando os tipos. A própria referência tem que passar no verificador."""
    rng = random.Random(semente)
    tipos = tipos or TIPOS
    casos = []
    while len(casos) < n:
        caso = GERADORES[tipos[len(casos) % len(tipos)]](rng)
        assert not conferir or verificar(caso, caso["referencia"]), f"referência reprovada: {caso}"
        casos.append(caso)
    return casos

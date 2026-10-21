"""Bloqueia PR que mexe em arquivo fora do escopo declarado.

O PR precisa ter na descrição uma seção:

    ## Escopo
    - src/tela/menu.css
    - src/tela/

Cada item é um arquivo, uma pasta (terminada em /) ou um padrão com * (ex.: src/*.css).
* não entra em subpastas; use ** para isso (ex.: src/**/*.css).
Arquivos de teste e a memória do projeto (docs/memoria/) sempre podem mudar.
A label permitir-fora-do-escopo, colocada pelo humano, libera.

Uso: python trava_de_escopo.py <sha-base> <sha-head>
"""
import json
import os
import re
import subprocess
import sys

LABEL_LIBERA = "permitir-fora-do-escopo"

SEMPRE_PERMITIDO = re.compile(
    r"(^|/)(tests?|__tests__|specs?)/"
    r"|(^|/)test_[^/]+\.py$"
    r"|_test\.(py|go|rb)$"
    r"|\.(test|spec)\.[jt]sx?$"
    r"|Tests?\.(cs|java|kt)$"
    r"|^docs/memoria/"
)

# Mudar o manifesto de dependências implica mudar o lockfile junto.
PARES = {
    "package.json": ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
    "pyproject.toml": ["poetry.lock", "uv.lock"],
    "requirements.txt": [],
}


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def ler_evento():
    caminho = os.environ.get("GITHUB_EVENT_PATH")
    if not caminho or not os.path.exists(caminho):
        return {}
    with open(caminho, encoding="utf-8") as f:
        return json.load(f).get("pull_request", {})


def escopo_declarado(corpo):
    itens = []
    dentro = False
    for linha in (corpo or "").splitlines():
        if re.match(r"^\s*##\s+Escopo\b", linha, re.IGNORECASE):
            dentro = True
            continue
        if dentro and re.match(r"^\s*##\s", linha):
            break
        if dentro:
            m = re.match(r"^\s*[-*]\s+`?([^`\s]+)`?", linha)
            if m and not m.group(1).startswith("<"):
                item = m.group(1)
                itens.append(item[2:] if item.startswith("./") else item)
    return itens


def casa_padrao(arquivo, padrao):
    """Glob em que * e ? nao atravessam pasta; ** atravessa."""
    regex = ""
    i = 0
    while i < len(padrao):
        c = padrao[i]
        if padrao[i:i + 3] == "**/":
            regex += "(?:.*/)?"
            i += 3
            continue
        if padrao[i:i + 2] == "**":
            regex += ".*"
            i += 2
            continue
        regex += "[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c)
        i += 1
    return re.fullmatch(regex, arquivo) is not None


def permitido(arquivo, escopo):
    if SEMPRE_PERMITIDO.search(arquivo):
        return True
    for item in escopo:
        if item.endswith("/") and arquivo.startswith(item):
            return True
        if casa_padrao(arquivo, item):
            return True
        if arquivo in PARES.get(os.path.basename(item), []) and os.path.dirname(arquivo) == os.path.dirname(item):
            return True
    return False


def main(base, head):
    pr = ler_evento()
    escopo = escopo_declarado(pr.get("body"))
    labels = {l["name"] for l in pr.get("labels", [])}
    mudados = [l for l in git("diff", "--name-only", f"{base}...{head}").splitlines() if l]

    if not escopo:
        print("A descricao do PR nao tem a secao '## Escopo' com a lista do que pode mudar.")
        print("Exemplo:\n  ## Escopo\n  - src/tela/menu.css")
        return 0 if LABEL_LIBERA in labels else 1

    fora = [a for a in mudados if not permitido(a, escopo)]
    print("Escopo declarado: " + ", ".join(escopo))
    if not fora:
        print(f"Todos os {len(mudados)} arquivos alterados estao dentro do escopo.")
        return 0

    print("Arquivos alterados FORA do escopo pedido:")
    for a in fora:
        print(f"  - {a}")
    if LABEL_LIBERA in labels:
        print(f"Label '{LABEL_LIBERA}' presente: liberado pelo humano.")
        return 0
    print("Desfaca essas mudancas ou, se forem mesmo necessarias, explique no PR e peca ao humano a label "
          f"'{LABEL_LIBERA}'.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))

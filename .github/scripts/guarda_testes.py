"""Bloqueia PR que apaga teste ou adiciona skip/only/xfail.

Uso: python guarda_testes.py <sha-base> <sha-head>
Lê as labels do PR em GITHUB_EVENT_PATH; a label permitir-remocao-de-teste libera.
"""
import json
import os
import re
import subprocess
import sys

LABEL_LIBERA = "permitir-remocao-de-teste"

ARQUIVO_DE_TESTE = re.compile(
    r"(^|/)(tests?|__tests__|specs?)/"
    r"|(^|/)test_[^/]+\.py$"
    r"|_test\.(py|go|rb)$"
    r"|\.(test|spec)\.[jt]sx?$"
    r"|Tests?\.(cs|java|kt)$"
)

PULO_DE_TESTE = [
    (re.compile(r"\b(it|test|describe)\.(skip|only)\s*\("), "skip/only em teste JS"),
    (re.compile(r"\bx(it|describe|test)\s*\("), "xit/xdescribe em teste JS"),
    (re.compile(r"@pytest\.mark\.(skip|skipif|xfail)\b"), "pytest skip/xfail"),
    (re.compile(r"\bpytest\.(skip|xfail)\s*\("), "pytest.skip/xfail"),
    (re.compile(r"@unittest\.(skip|expectedFailure)"), "unittest skip"),
    (re.compile(r"\bt\.Skip(f|Now)?\s*\("), "t.Skip em Go"),
    (re.compile(r"@(Disabled|Ignore)\b"), "@Disabled/@Ignore"),
]


def git(*args):
    return subprocess.run(["git", "-c", "core.quotepath=false", *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout


def labels_do_pr():
    caminho = os.environ.get("GITHUB_EVENT_PATH")
    if not caminho or not os.path.exists(caminho):
        return set()
    with open(caminho, encoding="utf-8") as f:
        evento = json.load(f)
    return {l["name"] for l in evento.get("pull_request", {}).get("labels", [])}


def main(base, head):
    problemas = []

    for linha in git("diff", "--name-status", "-M", f"{base}...{head}").splitlines():
        partes = linha.split("\t")
        status = partes[0]
        if status.startswith("D") and ARQUIVO_DE_TESTE.search(partes[1]):
            problemas.append(f"arquivo de teste apagado: {partes[1]}")
        elif status.startswith("R") and ARQUIVO_DE_TESTE.search(partes[1]) and not ARQUIVO_DE_TESTE.search(partes[2]):
            problemas.append(f"arquivo de teste renomeado para fora dos testes: {partes[1]} -> {partes[2]}")

    arquivo_atual = None
    for linha in git("diff", "-U0", f"{base}...{head}").splitlines():
        if linha.startswith("+++ "):
            arquivo_atual = linha[6:] if linha.startswith("+++ b/") else None
            continue
        if not linha.startswith("+") or arquivo_atual is None:
            continue
        for padrao, descricao in PULO_DE_TESTE:
            if padrao.search(linha[1:]):
                problemas.append(f"{descricao} adicionado em {arquivo_atual}: {linha[1:].strip()}")

    if not problemas:
        print("Nenhum teste apagado ou pulado.")
        return 0

    print("Mudancas que enfraquecem a suite de testes:")
    for p in problemas:
        print(f"  - {p}")
    if LABEL_LIBERA in labels_do_pr():
        print(f"Label '{LABEL_LIBERA}' presente: liberado pelo humano.")
        return 0
    print(f"Bloqueado. Se for intencional, um humano coloca a label '{LABEL_LIBERA}'.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))

"""Exige que o PR tenha sido revisado por um agente diferente de quem implementou.

Lê o evento em GITHUB_EVENT_PATH. Labels esperadas:
  feito-por:claude | feito-por:codex
  revisado-por:claude | revisado-por:codex
Em novos commits (synchronize) a revisão anterior perde validade; o workflow
remove a label revisado-por:* antes de chamar este script.
"""
import json
import os
import sys

AGENTES = ("claude", "codex")


def main():
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
        evento = json.load(f)
    labels = {l["name"] for l in evento.get("pull_request", {}).get("labels", [])}
    if os.environ.get("REVISAO_INVALIDADA") == "1":
        labels = {l for l in labels if not l.startswith("revisado-por:")}

    feito = {a for a in AGENTES if f"feito-por:{a}" in labels}
    revisado = {a for a in AGENTES if f"revisado-por:{a}" in labels}

    if len(feito) != 1:
        print("Falta dizer quem implementou: coloque exatamente uma label feito-por:claude ou feito-por:codex.")
        return 1
    autor = feito.pop()
    outro = next(a for a in AGENTES if a != autor)
    if outro not in revisado:
        if autor in revisado:
            print(f"O {autor} nao pode revisar o proprio trabalho. Falta a revisao do {outro} (label revisado-por:{outro}).")
        else:
            print(f"Falta a revisao adversaria do {outro} (label revisado-por:{outro}).")
        return 1
    print(f"Feito por {autor}, revisado por {outro}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

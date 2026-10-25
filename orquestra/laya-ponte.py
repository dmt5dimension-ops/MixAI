# Ponte entre o medidor (orquestra/laya-teste.js) e o Laya. Lê uma linha JSON por caso no stdin
# ({"id": 0, "entrada": "..."}) e escreve uma linha JSON por caso no stdout ({"id": 0, "probabilidade": 0.87}).
# Instalação (uma vez): pip install laya. Se travar ao carregar: set USE_TF=0.
# O checkpoint multilíngue lê português; o inglês falha fora de alfabeto latino e das tarefas em português.
# Não foi executado no ambiente de desenvolvimento (sem o modelo): a primeira rodada real é no PC do dono.
import json
import os
import sys

os.environ.setdefault("USE_TF", "0")

import laya  # noqa: E402

PERGUNTA = {
    "cabe_no_local": {
        "type": "noul",
        "instructions": "Esta tarefa é pequena e mecânica, com resposta curta que um comando consegue conferir sozinho?",
    }
}


def main():
    agente = laya.load("convaiinnovations/laya", subfolder="multilingual")
    for linha in sys.stdin:
        if not linha.strip():
            continue
        caso = json.loads(linha)
        texto = str(caso["entrada"])[:1500]  # contexto do modelo é curto
        resposta = agente.predict(texto, PERGUNTA)
        probabilidade = float(resposta["answers"]["cabe_no_local"]["noul"])
        print(json.dumps({"id": caso["id"], "probabilidade": probabilidade}), flush=True)


if __name__ == "__main__":
    main()

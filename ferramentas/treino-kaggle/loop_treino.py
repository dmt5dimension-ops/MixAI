"""Ponto de entrada do treino sem supervisão (Kaggle ou Colab).

python loop_treino.py --pasta /kaggle/working/estado [--anterior /kaggle/input/<saida-da-sessao-anterior>/estado] [--horas 11]
"""
import argparse
import json
import os
import shutil

import ciclo

MODELFILE = """FROM ./{gguf}
PARAMETER num_gpu 99
PARAMETER num_ctx 4096
"""


def principal(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--pasta", default="/kaggle/working/estado" if os.path.isdir("/kaggle/working") else "estado")
    p.add_argument("--anterior", help="estado salvo pela sessão anterior (continua de onde parou)")
    p.add_argument("--horas", type=float, default=ciclo.PADRAO["horas"])
    p.add_argument("--lote", type=int, default=ciclo.PADRAO["lote"])
    p.add_argument("--rodadas", type=int, default=ciclo.PADRAO["max_rodadas"])
    a = p.parse_args(argv)

    if a.anterior and os.path.isdir(a.anterior) and not os.path.exists(os.path.join(a.pasta, "estado.json")):
        shutil.copytree(a.anterior, a.pasta, dirs_exist_ok=True)
        arq = os.path.join(a.pasta, "estado.json")
        with open(arq, encoding="utf-8") as f:
            est = json.load(f)
        if est.get("melhor_dir"):  # caminho guardado na sessão antiga: aponta para a cópia de agora
            est["melhor_dir"] = os.path.join(a.pasta, "melhor")
            with open(arq, "w", encoding="utf-8") as f:
                json.dump(est, f, ensure_ascii=False, indent=1)

    from modelo_unsloth import ModeloUnsloth
    modelo = ModeloUnsloth()
    est = ciclo.executar(modelo, a.pasta, {"horas": a.horas, "lote": a.lote, "max_rodadas": a.rodadas})

    h = est["historico"]
    print(f"Rodadas: {est['rodada']} | nota base: {h[0]['nota']}/{h[0]['total']} | melhor: {est['melhor']}/{h[0]['total']} | parou por: {est.get('parou_por')}")
    if est["melhor_dir"]:
        modelo.carregar(est["melhor_dir"])
        saida = os.path.join(a.pasta, "ollama")
        modelo.exportar_gguf(saida)
        gguf = next((f for f in os.listdir(saida) if f.endswith(".gguf")), None)
        if gguf:
            with open(os.path.join(saida, "Modelfile"), "w") as f:
                f.write(MODELFILE.format(gguf=gguf))
            print("Para o Ollama: baixe a pasta 'ollama' e rode: ollama create mixai-local-v2 -f Modelfile")
    else:
        print("Nenhuma rodada superou a nota da base: nada para exportar (resultado honesto).")
    return est


if __name__ == "__main__":
    principal()

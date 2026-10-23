"""O laço de rodadas: Qwen tenta, verificador mecânico confere, treina nos acertos e nos corrigidos, mede, promove ou volta.

Nada aqui usa API nem outro modelo. O modelo entra por um objeto com: responder(prompt), treinar(exemplos),
salvar(pasta), carregar(pasta), reiniciar(). Assim o laço é testável sem placa de vídeo.
"""
import json
import os
import time

import geradores

SEMENTE_VALIDACAO = 10_000
SEMENTE_TREINO = 1_000_000
PADRAO = {"lote": 40, "validacao": 60, "max_rodadas": 200, "paciencia": 6, "horas": 11.0, "replay": 200,
          "limite_dica": 0.6}


def montar_prompt(caso, regras):
    dica = regras.get(caso["tipo"])
    return caso["prompt"] + (("\n\nRegra: " + dica) if dica else "")


def nota(modelo, casos, regras=None):
    regras = regras or {}
    por_tipo = {}
    acertos = 0
    for c in casos:
        ok = geradores.verificar(c, modelo.responder(montar_prompt(c, regras)))
        acertos += ok
        a, t = por_tipo.get(c["tipo"], (0, 0))
        por_tipo[c["tipo"]] = (a + ok, t + 1)
    return acertos, por_tipo


def _gravar(arquivo, dados):
    tmp = arquivo + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=1)
    os.replace(tmp, arquivo)


def carregar_estado(pasta):
    arq = os.path.join(pasta, "estado.json")
    if os.path.exists(arq):
        with open(arq, encoding="utf-8") as f:
            return json.load(f)
    return {"rodada": 0, "melhor": None, "melhor_dir": None, "regras": {}, "historico": [], "sem_melhora": 0}


def _ler_exemplos(pasta):
    arq = os.path.join(pasta, "exemplos.jsonl")
    if not os.path.exists(arq):
        return []
    with open(arq, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def _anexar_exemplos(pasta, novos):
    with open(os.path.join(pasta, "exemplos.jsonl"), "a", encoding="utf-8") as f:
        for e in novos:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def _voltar_ao_melhor(modelo, est):
    if est["melhor_dir"]:
        modelo.carregar(est["melhor_dir"])
    else:
        modelo.reiniciar()


def _testar_regras(modelo, validacao, por_tipo_treino, est, cfg):
    """Regra só vale se, com ela no prompt, o tipo melhora de verdade na validação."""
    for tipo, (a, t) in por_tipo_treino.items():
        if t == 0 or a / t >= cfg["limite_dica"] or tipo in est["regras"] or tipo not in geradores.DICAS:
            continue
        do_tipo = [c for c in validacao if c["tipo"] == tipo]
        sem, _ = nota(modelo, do_tipo)
        com, _ = nota(modelo, do_tipo, {tipo: geradores.DICAS[tipo]})
        if com > sem:
            est["regras"][tipo] = geradores.DICAS[tipo]


def executar(modelo, pasta, cfg=None, relogio=time.time):
    cfg = {**PADRAO, **(cfg or {})}
    os.makedirs(pasta, exist_ok=True)
    inicio = relogio()
    limite = cfg["horas"] * 3600
    est = carregar_estado(pasta)
    validacao = geradores.gerar(SEMENTE_VALIDACAO, cfg["validacao"])
    prompts_validacao = {c["prompt"] for c in validacao}

    if est["melhor_dir"]:
        modelo.carregar(est["melhor_dir"])
    if est["melhor"] is None:
        est["melhor"], _ = nota(modelo, validacao, est["regras"])
        est["historico"].append({"rodada": 0, "nota": est["melhor"], "total": len(validacao), "promovido": True, "base": True})
        _gravar(os.path.join(pasta, "estado.json"), est)

    est["sem_melhora"] = 0  # cada sessão tenta de novo; a paciência vale dentro da sessão
    duracao = 0.0
    while est["rodada"] < cfg["max_rodadas"] and est["sem_melhora"] < cfg["paciencia"]:
        if relogio() - inicio + duracao * 1.2 > limite:
            est["parou_por"] = "tempo"
            break
        t0 = relogio()
        r = est["rodada"] + 1
        casos = [c for c in geradores.gerar(SEMENTE_TREINO + r * 10_000, cfg["lote"] * 2) if c["prompt"] not in prompts_validacao][: cfg["lote"]]
        exemplos, por_tipo, acertos = [], {}, 0
        for c in casos:
            resp = modelo.responder(montar_prompt(c, est["regras"]))
            ok = geradores.verificar(c, resp)
            acertos += ok
            a, t = por_tipo.get(c["tipo"], (0, 0))
            por_tipo[c["tipo"]] = (a + ok, t + 1)
            # prompt sem a regra: o treino ensina a regra, não a depender dela
            exemplos.append({"messages": [{"role": "user", "content": c["prompt"]},
                                          {"role": "assistant", "content": geradores.extrair(resp) if ok else c["referencia"]}],
                             "origem": "acerto" if ok else "corrigido"})
        antigos = _ler_exemplos(pasta)[-cfg["replay"]:]
        modelo.treinar([{"messages": e["messages"]} for e in exemplos + antigos])
        nova, _ = nota(modelo, validacao, est["regras"])
        promovido = nova > est["melhor"]
        if promovido:
            destino = os.path.join(pasta, "melhor")
            modelo.salvar(destino)
            est["melhor"], est["melhor_dir"], est["sem_melhora"] = nova, destino, 0
            _testar_regras(modelo, validacao, por_tipo, est, cfg)
        else:
            est["sem_melhora"] += 1
            _voltar_ao_melhor(modelo, est)
        _anexar_exemplos(pasta, exemplos)
        est["rodada"] = r
        est["historico"].append({"rodada": r, "tentativas_certas": acertos, "tentativas": len(casos), "nota": nova,
                                 "total": len(validacao), "promovido": promovido,
                                 "por_tipo": {k: list(v) for k, v in por_tipo.items()}})
        _gravar(os.path.join(pasta, "estado.json"), est)
        duracao = max(duracao, relogio() - t0)
    else:
        est["parou_por"] = "rodadas" if est["rodada"] >= cfg["max_rodadas"] else "sem melhora"
    _gravar(os.path.join(pasta, "estado.json"), est)
    return est

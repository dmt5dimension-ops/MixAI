"""Testes do que dá para provar sem placa de vídeo: geradores, verificadores e o laço (com um modelo de mentira)."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ciclo  # noqa: E402
import geradores  # noqa: E402


class ModeloFalso:
    """Acerta os tipos que 'aprendeu'. Cada treino ensina o próximo tipo da lista; piora_em faz uma rodada piorar."""

    def __init__(self, ordem=("data_iso", "regex", "codigo"), piora_em=()):
        self.ordem, self.piora_em = list(ordem), set(piora_em)
        self.sabe, self.treinos, self.salvos, self.snap = set(), 0, {}, None
        self.tipo_atual = None
        self.chamadas_treino = []

    MAPA = None

    def responder(self, prompt):
        tipo = "data_iso" if "ISO" in prompt else "regex" if "expressão regular" in prompt else "codigo"
        if tipo not in self.sabe:
            return "não sei"
        caso = self._achar(prompt)
        return caso["referencia"] if caso else "?"

    @classmethod
    def _achar(cls, prompt):
        if cls.MAPA is None:
            cls.MAPA = {}
            sementes = [ciclo.SEMENTE_VALIDACAO] + [ciclo.SEMENTE_TREINO + r * 10_000 for r in range(1, 12)]
            for s in sementes:
                for c in geradores.gerar(s, 120, conferir=False):
                    cls.MAPA[c["prompt"]] = c
        return cls.MAPA.get(prompt.split("\n\nRegra:")[0])

    def treinar(self, exemplos):
        self.chamadas_treino.append(len(exemplos))
        self.treinos += 1
        if self.treinos in self.piora_em:
            self.sabe = set()
        elif len(self.sabe) < len(self.ordem):
            self.sabe.add(self.ordem[len(self.sabe)])

    def salvar(self, pasta):
        os.makedirs(pasta, exist_ok=True)
        self.salvos[pasta] = set(self.sabe)
        with open(os.path.join(pasta, "ok"), "w") as f:
            f.write("1")

    def carregar(self, pasta):
        self.sabe = set(self.salvos.get(pasta, set(self.sabe)))

    def reiniciar(self):
        self.sabe = set()


class TestGeradores(unittest.TestCase):
    def test_referencia_passa_e_geracao_e_deterministica(self):
        a = geradores.gerar(1, 30)
        b = geradores.gerar(1, 30)
        self.assertEqual([c["prompt"] for c in a], [c["prompt"] for c in b])
        self.assertEqual({c["tipo"] for c in a}, set(geradores.TIPOS))
        for s in range(2, 40):
            geradores.gerar(s, 6)  # tem assert interno: a referência tem que passar

    def test_resposta_errada_reprova(self):
        d, r, c = geradores.gerar(5, 3)
        self.assertFalse(geradores.verificar(d, "1999-01-01"))
        self.assertFalse(geradores.verificar(r, "a*"))
        self.assertFalse(geradores.verificar(c, "def nada(x):\n    return None\n"))

    def test_aceita_bloco_de_codigo_e_texto_em_volta_da_data(self):
        d = geradores.gerar(9, 1, ["data_iso"])[0]
        self.assertTrue(geradores.verificar(d, "```\n" + d["referencia"] + "\n```"))
        c = geradores.gerar(9, 1, ["codigo"])[0]
        self.assertTrue(geradores.verificar(c, "```python\n" + c["referencia"] + "```"))

    def test_codigo_com_laco_infinito_ou_erro_reprova(self):
        c = geradores.gerar(9, 1, ["codigo"])[0]
        nome = c["dados"]["nome"]
        self.assertFalse(geradores.verificar(c, f"def {nome}(*a):\n    while True: pass\n"))
        self.assertFalse(geradores.verificar(c, f"def {nome}(*a):\n    raise ValueError()\n"))
        self.assertFalse(geradores.verificar(c, ""))

    def test_regex_que_aceita_tudo_reprova(self):
        r = geradores.gerar(3, 1, ["regex"])[0]
        self.assertFalse(geradores.verificar(r, ".*"))
        self.assertFalse(geradores.verificar(r, "(["))  # regex inválida


class TestCiclo(unittest.TestCase):
    CFG = {"lote": 6, "validacao": 12, "max_rodadas": 10, "paciencia": 3}

    def test_promove_so_quando_melhora_e_volta_quando_piora(self):
        with tempfile.TemporaryDirectory() as pasta:
            m = ModeloFalso(piora_em=(2,))
            est = ciclo.executar(m, pasta, {**self.CFG, "max_rodadas": 3})
            h = {x["rodada"]: x for x in est["historico"]}
            self.assertEqual(h[0]["nota"], 0)
            self.assertTrue(h[1]["promovido"])
            self.assertFalse(h[2]["promovido"])  # piorou: não promove
            # a rodada 3 parte do melhor salvo (rodada 1), não do estado piorado da rodada 2
            self.assertTrue(h[3]["promovido"])
            self.assertGreater(h[3]["nota"], h[1]["nota"])
            self.assertEqual(est["melhor"], h[3]["nota"])

    def test_empate_nao_promove(self):
        with tempfile.TemporaryDirectory() as pasta:
            m = ModeloFalso(ordem=("data_iso",))
            est = ciclo.executar(m, pasta, {**self.CFG, "max_rodadas": 4, "paciencia": 10})
            promovidos = [x["rodada"] for x in est["historico"] if x["promovido"]]
            self.assertEqual(promovidos, [0, 1])  # base + única melhora; as seguintes empatam

    def test_para_por_paciencia(self):
        with tempfile.TemporaryDirectory() as pasta:
            est = ciclo.executar(ModeloFalso(ordem=()), pasta, {**self.CFG, "paciencia": 2})
            self.assertEqual(est["rodada"], 2)
            self.assertEqual(est["parou_por"], "sem melhora")
            self.assertIsNone(est["melhor_dir"])  # nada superou a base: nada a exportar

    def test_continua_de_onde_parou(self):
        with tempfile.TemporaryDirectory() as pasta:
            m = ModeloFalso()
            ciclo.executar(m, pasta, {**self.CFG, "max_rodadas": 2})
            m2 = ModeloFalso()
            m2.salvos = dict(m.salvos)
            est = ciclo.executar(m2, pasta, {**self.CFG, "max_rodadas": 4})
            self.assertEqual(est["rodada"], 4)
            self.assertEqual([x["rodada"] for x in est["historico"]], [0, 1, 2, 3, 4])
            self.assertEqual(sum(1 for x in est["historico"] if x.get("base")), 1)  # base medida uma vez só

    def test_para_por_tempo_antes_de_estourar(self):
        with tempfile.TemporaryDirectory() as pasta:
            t = [0.0]

            def relogio():
                t[0] += 1000
                return t[0]
            est = ciclo.executar(ModeloFalso(), pasta, {**self.CFG, "horas": 1.0, "max_rodadas": 50, "paciencia": 50}, relogio)
            self.assertEqual(est["parou_por"], "tempo")
            self.assertLess(est["rodada"], 50)

    def test_treino_sem_regra_no_prompt_e_com_replay(self):
        with tempfile.TemporaryDirectory() as pasta:
            m = ModeloFalso()
            ciclo.executar(m, pasta, {**self.CFG, "max_rodadas": 2, "paciencia": 10})
            self.assertEqual(m.chamadas_treino[0], 6)
            self.assertEqual(m.chamadas_treino[1], 12)  # lote novo + replay da rodada anterior
            with open(os.path.join(pasta, "exemplos.jsonl"), encoding="utf-8") as f:
                texto = f.read()
            self.assertNotIn("Regra:", texto)

    def test_regra_so_confirma_se_ajuda(self):
        class Fraco(ModeloFalso):
            def responder(self, prompt):
                if "Regra:" in prompt and "ISO" in prompt:
                    return self._achar(prompt)["referencia"]
                return "não sei"

            def treinar(self, exemplos):
                self.treinos += 1
                self.sabe = {"x"}  # só para a nota mudar

        with tempfile.TemporaryDirectory() as pasta:
            est = ciclo.executar(Fraco(), pasta, {**self.CFG, "max_rodadas": 3, "paciencia": 5})
            self.assertIn(est["regras"].get("data_iso", ""), ["", geradores.DICAS["data_iso"]])
            self.assertNotIn("regex", est["regras"])  # a dica de regex não ajudou: não vira regra


if __name__ == "__main__":
    unittest.main()

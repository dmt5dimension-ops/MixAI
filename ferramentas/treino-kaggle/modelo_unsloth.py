"""Modelo real (Qwen2.5-Coder 7B em 4 bits + LoRA) para o laço de ciclo.py. Só roda em GPU NVIDIA (Kaggle/Colab).
ATENÇÃO: este arquivo ainda não foi executado numa GPU; na primeira rodada, use --rodadas 1 --lote 4 para conferir.
"""
import inspect
import os

BASE = "unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit"
ALVOS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
SISTEMA = "Você é um assistente de programação. Responda de forma curta e exata."


def montar_trainer(SFTTrainer, SFTConfig, modelo, tok, dados, max_seq, epocas, lr):
    """Monta o treinador com os nomes certos da versão instalada do TRL (processing_class/max_length ou tokenizer/max_seq_length).
    Separado da classe para poder ser conferido sem GPU."""
    cfg = inspect.signature(SFTConfig).parameters
    pars = inspect.signature(SFTTrainer.__init__).parameters
    config = SFTConfig(dataset_text_field="text", per_device_train_batch_size=2, gradient_accumulation_steps=4,
                       num_train_epochs=epocas, learning_rate=lr, output_dir="/tmp/saida-treino", report_to="none",
                       save_strategy="no", **{("max_length" if "max_length" in cfg else "max_seq_length"): max_seq})
    return SFTTrainer(model=modelo, train_dataset=dados, args=config,
                      **{("processing_class" if "processing_class" in pars else "tokenizer"): tok})


class ModeloUnsloth:
    def __init__(self, max_seq=2048, lr=1e-4, epocas=1):
        self.max_seq, self.lr, self.epocas = max_seq, lr, epocas
        self.reiniciar()

    def _novo(self, origem, com_lora):
        from unsloth import FastLanguageModel
        self.FLM = FastLanguageModel
        self.modelo, self.tok = FastLanguageModel.from_pretrained(origem, max_seq_length=self.max_seq, load_in_4bit=True)
        if com_lora:
            self.modelo = FastLanguageModel.get_peft_model(self.modelo, r=16, lora_alpha=16, target_modules=ALVOS)

    def reiniciar(self):
        self._liberar()
        self._novo(BASE, True)

    def carregar(self, pasta):
        self._liberar()
        self._novo(pasta, False)  # pasta de adaptador: o Unsloth junta a base e o adaptador

    def _liberar(self):
        import gc
        for nome in ("modelo", "tok"):
            if hasattr(self, nome):
                delattr(self, nome)
        gc.collect()
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass

    def responder(self, prompt):
        self.FLM.for_inference(self.modelo)
        msgs = [{"role": "system", "content": SISTEMA}, {"role": "user", "content": prompt}]
        ids = self.tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to("cuda")
        saida = self.modelo.generate(input_ids=ids, max_new_tokens=300, do_sample=False)
        return self.tok.decode(saida[0][ids.shape[1]:], skip_special_tokens=True)

    def treinar(self, exemplos):
        from datasets import Dataset
        from trl import SFTConfig, SFTTrainer
        self.FLM.for_training(self.modelo)
        dados = Dataset.from_list([{"text": self.tok.apply_chat_template(
            [{"role": "system", "content": SISTEMA}] + e["messages"], tokenize=False)} for e in exemplos])
        montar_trainer(SFTTrainer, SFTConfig, self.modelo, self.tok, dados, self.max_seq, self.epocas, self.lr).train()

    def salvar(self, pasta):
        os.makedirs(pasta, exist_ok=True)
        self.modelo.save_pretrained(pasta)
        self.tok.save_pretrained(pasta)

    def exportar_gguf(self, pasta):
        os.makedirs(pasta, exist_ok=True)
        self.modelo.save_pretrained_gguf(pasta, self.tok, quantization_method="q4_k_m")

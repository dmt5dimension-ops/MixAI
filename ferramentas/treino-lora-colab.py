# Treino QLoRA do Qwen2.5-Coder 7B em GPU de terceiros (Colab/Kaggle, T4 16 GB). NÃO roda na nuvem do Claude nem no PC AMD.
# Passos no Colab: enviar treino.jsonl e validacao.jsonl (gerados por `node orquestra/treino.js preparar`) para /content,
# rodar esta célula, baixar mixai-local-v2.gguf e, no PC, criar o modelo com um Modelfile (FROM ./mixai-local-v2.gguf, PARAMETER num_gpu 99).
# Ainda não foi executado: conferir os números de versão e a memória na primeira rodada, com poucos passos.
# !pip install unsloth trl datasets
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

BASE = "unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit"
modelo, tok = FastLanguageModel.from_pretrained(BASE, max_seq_length=2048, load_in_4bit=True)
modelo = FastLanguageModel.get_peft_model(modelo, r=16, lora_alpha=16, target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])

dados = load_dataset("json", data_files={"train": "/content/treino.jsonl", "validation": "/content/validacao.jsonl"})
dados = dados.map(lambda ex: {"text": tok.apply_chat_template(ex["messages"], tokenize=False)})

SFTTrainer(
    model=modelo, tokenizer=tok, train_dataset=dados["train"], eval_dataset=dados["validation"],
    args=SFTConfig(dataset_text_field="text", max_seq_length=2048, per_device_train_batch_size=2, gradient_accumulation_steps=4,
                   num_train_epochs=2, learning_rate=2e-4, eval_strategy="epoch", output_dir="/content/saida", report_to="none"),
).train()

modelo.save_pretrained_gguf("/content/mixai-local-v2", tok, quantization_method="q4_k_m")

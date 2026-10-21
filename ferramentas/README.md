# Ferramentas de instalação

Scripts para montar o ambiente do orquestrador no Windows 11.

1. `instalar.ps1`: instala Git, Node.js, GitHub CLI, Claude Code, Codex CLI, os plugins do Claude (Superpowers e revisão do Codex) e baixa o Agent Orchestrator.
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\ferramentas\instalar.ps1
   ```
2. `preparar-repo.ps1`: aplica as regras e o CI em outro repositório. Este repositório já está preparado.
3. `primeiro-pedido.md`: texto para colar no coordenador do Agent Orchestrator.

## Só assinatura, sem API

Tudo roda pelas CLIs no seu PC, logadas na assinatura Claude Pro/Max e na conta do ChatGPT. Nada aqui usa chave de API da Anthropic ou da OpenAI, e o CI não chama nenhum modelo. O `instalar.ps1` avisa se houver `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` ou `CODEX_API_KEY` configuradas, porque elas fazem as CLIs cobrarem por API. No Agent Orchestrator, prefira workers do Claude em modo interativo: o modo headless (`claude -p`) sai de um crédito separado, cobrado a preço de API.

# Ferramentas de instalação

Scripts para montar o ambiente do orquestrador no Windows 11.

1. `instalar.ps1`: instala Git, Node.js, GitHub CLI, Claude Code, Codex CLI, os plugins do Claude (Superpowers e revisão do Codex) e baixa o Agent Orchestrator.
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\ferramentas\instalar.ps1
   ```
2. `preparar-repo.ps1`: aplica as regras e o CI em outro repositório. Este repositório já está preparado.
3. `primeiro-pedido.md`: texto para colar no coordenador do Agent Orchestrator.

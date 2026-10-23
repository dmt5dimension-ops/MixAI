# SÓ LEITURA: pergunta ao Job Object de uma chamada (criado por job-windows.ps1, nome em $Nome) se ainda há processo dentro.
# NUNCA encerra nada (quem encerra é o job-confirmar-windows.ps1, só para o job do próprio chamador ou de dono morto).
# Saída (última linha): FECHADO (o job não existe), VAZIO (existe, sem processo) ou VIVOS <n>. Erro/outra coisa = inconclusivo.
param([Parameter(Mandatory = $true)][string]$Nome)
$ErrorActionPreference = 'Stop'

$codigo = @'
using System;
using System.Runtime.InteropServices;
public static class MixJobConsultar {
  [StructLayout(LayoutKind.Sequential)] struct CONTAGEM {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint acesso, bool herdar, string nome);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int classe, IntPtr info, uint tamanho, IntPtr retorno);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Consultar(string nome) {
    IntPtr job = OpenJobObject(0x0004, false, nome); // só JOB_OBJECT_QUERY: sem permissão de encerrar
    if (job == IntPtr.Zero) {
      int erro = Marshal.GetLastWin32Error();
      if (erro == 2) return "FECHADO"; // ERROR_FILE_NOT_FOUND
      throw new Exception("OpenJobObject falhou: " + erro);
    }
    try {
      int tamanho = Marshal.SizeOf(typeof(CONTAGEM));
      IntPtr p = Marshal.AllocHGlobal(tamanho);
      try {
        if (!QueryInformationJobObject(job, 1, p, (uint)tamanho, IntPtr.Zero)) throw new Exception("QueryInformationJobObject falhou: " + Marshal.GetLastWin32Error());
        int ativos = (int)((CONTAGEM)Marshal.PtrToStructure(p, typeof(CONTAGEM))).ActiveProcesses;
        return ativos == 0 ? "VAZIO" : "VIVOS " + ativos;
      } finally { Marshal.FreeHGlobal(p); }
    } finally { CloseHandle(job); }
  }
}
'@

try {
  Add-Type -TypeDefinition $codigo
  [Console]::Out.WriteLine([MixJobConsultar]::Consultar($Nome))
} catch {
  [Console]::Error.WriteLine("não consegui consultar o Job Object: $($_.Exception.Message)")
  exit 2
}

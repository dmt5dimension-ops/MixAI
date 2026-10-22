# Confere o Job Object de uma chamada (criado por job-windows.ps1 com o nome em $Nome): encerra o job e só diz que está
# limpo quando ele não existe mais ou está sem nenhum processo. Usado por orquestra/escada.js depois que o comando fechou.
# Saída (última linha): FECHADO (o job não existe mais: o Windows já fechou e matou tudo), VAZIO (existia, sem processo),
# VIVOS <n> (sobraram n processos mesmo depois de encerrar o job). Qualquer outra coisa/erro = inconclusivo.
param([Parameter(Mandatory = $true)][string]$Nome)
$ErrorActionPreference = 'Stop'

$codigo = @'
using System;
using System.Runtime.InteropServices;
public static class MixJobConfirmar {
  [StructLayout(LayoutKind.Sequential)] struct CONTAGEM {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint acesso, bool herdar, string nome);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int classe, IntPtr info, uint tamanho, IntPtr retorno);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint codigo);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static int Ativos(IntPtr job) {
    int tamanho = Marshal.SizeOf(typeof(CONTAGEM));
    IntPtr p = Marshal.AllocHGlobal(tamanho);
    try {
      if (!QueryInformationJobObject(job, 1, p, (uint)tamanho, IntPtr.Zero)) throw new Exception("QueryInformationJobObject falhou: " + Marshal.GetLastWin32Error());
      return (int)((CONTAGEM)Marshal.PtrToStructure(p, typeof(CONTAGEM))).ActiveProcesses;
    } finally { Marshal.FreeHGlobal(p); }
  }
  public static string Conferir(string nome) {
    IntPtr job = OpenJobObject(0x0004 | 0x0008, false, nome); // QUERY | TERMINATE
    if (job == IntPtr.Zero) {
      int erro = Marshal.GetLastWin32Error();
      if (erro == 2) return "FECHADO"; // ERROR_FILE_NOT_FOUND: ninguém mais segura o job, o Windows já o fechou
      throw new Exception("OpenJobObject falhou: " + erro);
    }
    try {
      int ativos = Ativos(job);
      for (int i = 0; i < 20 && ativos > 0; i++) {
        TerminateJobObject(job, 1);
        System.Threading.Thread.Sleep(100);
        ativos = Ativos(job);
      }
      return ativos == 0 ? "VAZIO" : "VIVOS " + ativos;
    } finally { CloseHandle(job); }
  }
}
'@

try {
  Add-Type -TypeDefinition $codigo
  [Console]::Out.WriteLine([MixJobConfirmar]::Conferir($Nome))
} catch {
  [Console]::Error.WriteLine("não consegui conferir o Job Object: $($_.Exception.Message)")
  exit 2
}

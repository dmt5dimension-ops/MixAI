# Roda o comando de $env:MIXAI_COMANDO dentro de um Job Object do Windows, para que matar este processo mate tudo o
# que o comando criou (filhos, netos, órfãos), sem ler PID de ninguém. Usado por orquestra/escada.js (chamarComando).
#
# 1. Cria o job com KILL_ON_JOB_CLOSE (quando o último dono do job fecha, o Windows mata todos os processos dentro).
#    Sem BREAKAWAY: ninguém dentro do job consegue sair dele.
# 2. Coloca ESTE processo no job antes de iniciar o comando. Tudo que nascer daqui em diante nasce dentro do job.
# 3. Inicia o comando por cmd.exe, herdando stdin/stdout/stderr (o Node ligou os três a este processo), espera e
#    sai com o mesmo código.
# Se o job não puder ser criado, sai com 125 SEM rodar o comando (nunca roda um comando que não dá para matar direito).
$ErrorActionPreference = 'Stop'

$codigo = @'
using System;
using System.Runtime.InteropServices;
public static class MixJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct EXT {
    public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr atributos, string nome);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int classe, IntPtr info, uint tamanho);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr processo);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr job; // a alça fica viva até este processo morrer; ao morrer, o Windows fecha e mata o job
  public static void Entrar() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject falhou: " + Marshal.GetLastWin32Error());
    EXT info = new EXT();
    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    int tamanho = Marshal.SizeOf(typeof(EXT));
    IntPtr p = Marshal.AllocHGlobal(tamanho);
    try {
      Marshal.StructureToPtr(info, p, false);
      if (!SetInformationJobObject(job, 9, p, (uint)tamanho)) throw new Exception("SetInformationJobObject falhou: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject falhou: " + Marshal.GetLastWin32Error());
  }
}
'@

try {
  Add-Type -TypeDefinition $codigo
  [MixJob]::Entrar()
} catch {
  [Console]::Error.WriteLine("não consegui criar o Job Object: $($_.Exception.Message)")
  exit 125
}

$comando = $env:MIXAI_COMANDO
if ([string]::IsNullOrEmpty($comando)) { [Console]::Error.WriteLine('MIXAI_COMANDO vazio'); exit 125 }

$inicio = New-Object System.Diagnostics.ProcessStartInfo
$inicio.FileName = $env:ComSpec
$inicio.Arguments = '/d /s /c "' + $comando + '"'
$inicio.UseShellExecute = $false # sem redirecionar: o comando herda stdin/stdout/stderr deste processo
$processo = [System.Diagnostics.Process]::Start($inicio)
$processo.WaitForExit()
exit $processo.ExitCode

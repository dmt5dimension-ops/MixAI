# Roda o comando de $env:MIXAI_COMANDO dentro de um Job Object do Windows, para que matar este processo mate tudo o
# que o comando criou (filhos, netos, órfãos), sem ler PID de ninguém. Usado por orquestra/escada.js (chamarComando).
#
# 1. Cria o job (com o nome de $env:MIXAI_JOB, para o escada.js poder consultá-lo) com KILL_ON_JOB_CLOSE (quando o último dono do job fecha, o Windows mata todos os processos dentro).
#    Sem BREAKAWAY: ninguém dentro do job consegue sair dele.
# 2. Coloca ESTE processo no job antes de iniciar o comando. Tudo que nascer daqui em diante nasce dentro do job.
# 3. Inicia o comando por cmd.exe, herdando stdin/stdout/stderr (o Node ligou os três a este processo), espera e
#    sai com o mesmo código.
# 3b. BARREIRA: depois de entrar no job e ANTES de iniciar o comando, espera o arquivo de $env:MIXAI_LIBERAR, que o Node só cria depois de
#    gravar o PID deste processo e o nome do job na reserva de vagas. Se o arquivo não aparecer em 60 s (ou MIXAI_LIBERAR_ESPERA_S; o Node morreu ou desistiu),
#    sai com 124 SEM rodar o comando; sem MIXAI_LIBERAR sai com 125. Assim nenhum comando roda sem estar registrado na reserva.
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
  public static void Entrar(string nome) {
    job = CreateJobObject(IntPtr.Zero, nome); // sem atributos: a alça não é herdável. O nome deixa orquestra/job-confirmar-windows.ps1 consultar o job.
    int erro = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject falhou: " + erro);
    if (erro == 183) throw new Exception("já existe um job com este nome (ERROR_ALREADY_EXISTS): recusado"); // nunca entrar num job que não é nosso
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

if ([string]::IsNullOrEmpty($env:MIXAI_JOB)) { [Console]::Error.WriteLine('MIXAI_JOB vazio'); exit 125 }
try {
  Add-Type -TypeDefinition $codigo
  [MixJob]::Entrar($env:MIXAI_JOB)
} catch {
  [Console]::Error.WriteLine("não consegui criar o Job Object: $($_.Exception.Message)")
  exit 125
}

$libera = $env:MIXAI_LIBERAR
if ([string]::IsNullOrEmpty($libera)) { [Console]::Error.WriteLine('MIXAI_LIBERAR vazio'); exit 125 }
$espera = 60
$esperaConfigurada = 0
if ([int]::TryParse($env:MIXAI_LIBERAR_ESPERA_S, [ref]$esperaConfigurada) -and $esperaConfigurada -gt 0) { $espera = $esperaConfigurada } # configurável (os testes usam poucos segundos)
$limite = [DateTime]::UtcNow.AddSeconds($espera)
while (-not (Test-Path -LiteralPath $libera)) {
  if ([DateTime]::UtcNow -gt $limite) { [Console]::Error.WriteLine("sem liberação do Node em $espera s: o comando não foi executado"); exit 124 }
  Start-Sleep -Milliseconds 50
}
Remove-Item -LiteralPath $libera -Force -ErrorAction SilentlyContinue

$comando = $env:MIXAI_COMANDO
if ([string]::IsNullOrEmpty($comando)) { [Console]::Error.WriteLine('MIXAI_COMANDO vazio'); exit 125 }

$inicio = New-Object System.Diagnostics.ProcessStartInfo
$inicio.FileName = $env:ComSpec
$inicio.Arguments = '/d /s /c "' + $comando + '"'
$inicio.UseShellExecute = $false # sem redirecionar: o comando herda stdin/stdout/stderr deste processo
$processo = [System.Diagnostics.Process]::Start($inicio)
$processo.WaitForExit()
exit $processo.ExitCode

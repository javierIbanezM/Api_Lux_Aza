<#
  Registra una tarea programada de Windows que restaura los procesos de PM2 (pm2 resurrect) cada
  vez que arranca el servidor, SIN necesidad de que nadie inicie sesion.

  Uso (UNA sola vez, en el servidor, PowerShell como ADMINISTRADOR y con la MISMA cuenta que
  ejecuta PM2 -- la que hizo "pm2 start"):

      cd C:\API_WHALES_WATCHER
      pm2 list                      # deja ONLINE solo lo que quieres que arranque solo
      .\deploy\instalar-arranque-pm2.ps1

  Pide la contrasena de esa cuenta: hace falta para que la tarea se ejecute aunque no haya sesion
  iniciada y para que conserve el acceso a los recursos de red (\\192.168.2.140\c$\...).
  Al terminar ejecuta "pm2 save", que es lo que "pm2 resurrect" restaura despues.

  Para quitarlo:  Unregister-ScheduledTask -TaskName 'PM2 resurrect (API WHALES)' -Confirm:$false
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$nombreTarea = 'PM2 resurrect (API WHALES)'
$pm2 = (Get-Command pm2.cmd -ErrorAction Stop).Source
$nodeDir = Split-Path (Get-Command node.exe -ErrorAction Stop).Source
$cuenta = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "Cuenta:  $cuenta"
Write-Host "pm2:     $pm2"
Write-Host "node:    $nodeDir"

$cred = Get-Credential -UserName $cuenta -Message 'Contrasena de esta cuenta (la tarea se ejecutara aunque nadie haya iniciado sesion)'

# La tarea se ejecuta con un PATH limpio: se anade la carpeta de node (puede ser una instalacion
# portable) para que pm2.cmd lo encuentre.
$comando = "set `"PATH=$nodeDir;%PATH%`" && `"$pm2`" resurrect"
$accion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $comando"

# 1 minuto despues del arranque, para que la red (UNC hacia el 140) este lista.
$disparador = New-ScheduledTaskTrigger -AtStartup
$disparador.Delay = 'PT1M'

$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $nombreTarea -Action $accion -Trigger $disparador -Settings $ajustes `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null

Write-Host ''
Write-Host "Tarea '$nombreTarea' registrada:"
Get-ScheduledTask -TaskName $nombreTarea | Select-Object TaskName, State | Format-Table -AutoSize

# Guarda la lista actual de PM2: es lo que restaurara "pm2 resurrect" tras cada reinicio.
Write-Host 'Guardando la lista de PM2 (pm2 save)...'
& $pm2 save
& $pm2 list

Write-Host ''
Write-Host 'LISTO. Comprobacion definitiva: reiniciar el servidor y, pasado ~2 minutos, ejecutar "pm2 list".'

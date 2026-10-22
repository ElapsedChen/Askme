Option Explicit

Dim shell, command, exitCode
Set shell = CreateObject("WScript.Shell")

command = """C:\Users\Chen\AppData\Local\Microsoft\WindowsApps\pwsh.exe"" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File ""D:\Askme\start-askme.ps1"""
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode

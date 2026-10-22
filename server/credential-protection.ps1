param([ValidateSet('initialize','protect','unprotect','lock')][string]$Operation, [string]$Directory)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if ($Operation -eq 'lock') {
        $hash = [System.Security.Cryptography.SHA256]::Create()
        $key = [BitConverter]::ToString($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($Directory).ToUpperInvariant()))).Replace('-', '')
        $mutex = [System.Threading.Mutex]::new($false, ('Local\AskmeChatGPT-' + $key))
        $owned = $false
        try {
            try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
            if (-not $owned) { exit 23 }
            [Console]::Out.WriteLine('LOCKED')
            [Console]::Out.Flush()
            # Node 退出会关闭管道；即使崩溃也由 Windows 释放互斥锁。
            [Console]::In.ReadToEnd() | Out-Null
        } finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
        exit 0
    }
    if ($Operation -eq 'initialize') {
        [System.IO.Directory]::CreateDirectory($Directory) | Out-Null
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $existing = Get-Acl -LiteralPath $Directory
        $rules = $existing.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        $restricted = $existing.AreAccessRulesProtected -and $existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18')) { $restricted = $false }
        }
        if ($restricted) { [Console]::Out.Write('OK'); exit 0 }
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow'))
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', $inheritance, 'None', 'Allow'))
        Set-Acl -LiteralPath $Directory -AclObject $acl
        [Console]::Out.Write('OK')
        exit 0
    }
    Add-Type -AssemblyName System.Security
    $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('Askme.ChatGPT.credentials.v1')
    if ($Operation -eq 'protect') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
    # 不把输入、凭据或系统异常详情输出到日志。
    [Console]::Error.Write('CREDENTIAL_PROTECTION_FAILED')
    exit 1
}

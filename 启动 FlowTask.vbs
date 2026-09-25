' FlowTask one-click launcher (Portable)
' -----------------------------------------------------------------------------
' Source is intentionally ASCII-only: this file is read by wscript using the
' system ANSI codepage, so non-ASCII literals would break on other machines.
'
' Double-click "FlowTask.lnk" (or this file):
'   1) probe the local storage service with GET /api/ping (no auth needed)
'   2) if it is not up, start it hidden - PowerShell first, Node.js fallback
'   3) wait until ready, then open http://127.0.0.1:5178 in the default browser
'   4) (re)create the logo shortcut in this folder and on the Desktop
'
' Data lives next to this script as plain JSON:
'   flowtask_auth.json | flowtask_data_<uid>.json | flowtask_shared.json
' We never open the .html with file:// because that mode has no per-account files.

Option Explicit

Dim sh, fso, appDir, selfPath, i
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir   = fso.GetParentFolderName(WScript.ScriptFullName)
selfPath = WScript.ScriptFullName

Const APP_URL = "http://127.0.0.1:5178"

' ---------- helpers ----------
Function ServiceReady()
  Dim http
  ServiceReady = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.ServerXMLHTTP")
  End If
  If Err.Number = 0 Then
    http.setTimeouts 300, 300, 300, 900
    http.open "GET", APP_URL & "/api/ping", False
    http.send
    ServiceReady = (Err.Number = 0)
  End If
  On Error GoTo 0
End Function

' Look up powershell.exe on disk only - never shell out, because "cmd /c where"
' would allocate a console window that flashes on screen.
Function FindPowerShell()
  Dim sys, p
  FindPowerShell = ""
  sys = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
  If fso.FileExists(sys) Then
    FindPowerShell = sys
    Exit Function
  End If
  p = sh.ExpandEnvironmentStrings("%WINDIR%") & "\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  If fso.FileExists(p) Then FindPowerShell = p
End Function

' Newest node.exe: PATH first, then the local runtime versions folder (highest version wins)
' Newest node.exe found by scanning PATH folders and the local runtime versions dir.
' File-system probing only: no "cmd /c where", no console window flashing.
Function FindNode()
  Dim pathEnv, items, i, p, root, f, best, bestVer
  FindNode = ""
  On Error Resume Next
  pathEnv = sh.Environment("PROCESS")("PATH")
  On Error GoTo 0
  If Len(pathEnv) > 0 Then
    items = Split(pathEnv, ";")
    For i = 0 To UBound(items)
      If Len(items(i)) > 0 Then
        p = items(i) & "\node.exe"
        If fso.FileExists(p) Then
          FindNode = p
          Exit Function
        End If
      End If
    Next
  End If
  best = "" : bestVer = ""
  On Error Resume Next
  root = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions"
  If fso.FolderExists(root) Then
    For Each f In fso.GetFolder(root).SubFolders
      If fso.FileExists(root & "\" & f.Name & "\node.exe") Then
        If CompareVersion(f.Name, bestVer) > 0 Then
          bestVer = f.Name
          best = root & "\" & f.Name & "\node.exe"
        End If
      End If
    Next
  End If
  On Error GoTo 0
  FindNode = best
End Function

' crude "22.22.2-2" vs "24.14.0" comparison so the newest runtime wins
Function CompareVersion(a, b)
  Dim pa, pb, i, na, nb, lim
  pa = Split(a, ".") : pb = Split(b, ".")
  lim = UBound(pa)
  If UBound(pb) > lim Then lim = UBound(pb)
  CompareVersion = 0
  For i = 0 To lim
    na = 0 : nb = 0
    If i <= UBound(pa) Then na = Val(Replace(pa(i), "-", ""))
    If i <= UBound(pb) Then nb = Val(Replace(pb(i), "-", ""))
    If na > nb Then
      CompareVersion = 1 : Exit Function
    ElseIf na < nb Then
      CompareVersion = -1 : Exit Function
    End If
  Next
End Function

Sub MakeShortcut(lnkPath, desc)
  Dim lnk, ico
  ico = appDir & "\flowtask.ico"
  If Not fso.FileExists(ico) Then ico = "%SystemRoot%\System32\SHELL32.dll,137"
  Set lnk = sh.CreateShortcut(lnkPath)
  lnk.TargetPath = "wscript.exe"
  lnk.Arguments = """" & selfPath & """"
  lnk.IconLocation = ico
  lnk.WorkingDirectory = appDir
  lnk.Description = desc
  lnk.Save
End Sub

' ---------- 1) logo shortcuts (self-referencing, so no locale-dependent names) ----------
On Error Resume Next
MakeShortcut appDir & "\FlowTask.lnk", "FlowTask"
Dim desk : desk = sh.SpecialFolders("Desktop")
If Len(desk) > 0 Then MakeShortcut desk & "\FlowTask.lnk", "FlowTask"
Err.Clear
On Error GoTo 0

' ---------- 2) start the storage service when needed ----------
If Not ServiceReady() Then
  Dim ps : ps = FindPowerShell()
  If ps <> "" Then
    sh.CurrentDirectory = appDir
    sh.Run """" & ps & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & appDir & "\flowtask_server.ps1""", 0, False
    For i = 1 To 30
      WScript.Sleep 250
      If ServiceReady() Then Exit For
    Next
  End If

  If Not ServiceReady() Then
    Dim nd : nd = FindNode()
    If nd <> "" Then
      sh.CurrentDirectory = appDir
      sh.Run """" & nd & """ """ & appDir & "\flowtask_server.js""", 0, False
      For i = 1 To 30
        WScript.Sleep 250
        If ServiceReady() Then Exit For
      Next
    End If
  End If
End If

' ---------- 3) open the app ----------
If ServiceReady() Then
  sh.Run APP_URL, 1, False
Else
  MsgBox "FlowTask storage service did not start." & vbCrLf & vbCrLf & _
         "Run flowtask_server.ps1 (or .js) manually and try again." & vbCrLf & _
         "All data files are plain JSON next to this folder.", 48, "FlowTask"
End If

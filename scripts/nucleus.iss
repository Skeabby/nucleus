; Nucleus - Inno Setup 6 installer script.
;
; Build it with the wrapper (recommended):
;
;   powershell -ExecutionPolicy Bypass -File scripts\make-setup.ps1
;
; or compile it directly with the Inno Setup compiler:
;
;   ISCC.exe /DAppVersion=0.4.0-alpha scripts\nucleus.iss
;
; make-setup.ps1 reads the version from launcher-rs\Cargo.toml and passes it in
; as /DAppVersion=<version>; a plain ISCC run still works thanks to the
; #ifndef fallback below.
;
; The install is per-user (PrivilegesRequired=lowest), so double-clicking the
; setup needs no UAC prompt and lands in %LOCALAPPDATA%\Programs\Nucleus.

#define AppName "Nucleus"
#define AppExeName "nucleus-launcher.exe"
#define AppPublisher "Nucleus contributors"
#define AppURL "https://github.com/Skeabby/nucleus"

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

; Absolute paths derived from this script's own directory - never hardcoded.
#define ScriptDir AddBackslash(SourcePath)
#define SrcExe ScriptDir + "..\launcher-rs\target\release\nucleus-launcher.exe"
#define SrcIcon ScriptDir + "..\assets\nucleus.ico"

[Setup]
; The AppId must never change, or Windows will treat every release as a new app.
AppId={{8F3B2C1A-6D4E-4A9B-9C3F-7E2A1D5B4C60}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\Nucleus
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
OutputDir=..\dist
OutputBaseFilename=NucleusSetup-{#AppVersion}-win64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}
#if FileExists(SrcIcon)
SetupIconFile={#SrcIcon}
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; Checked by default on purpose: the desktop shortcut is part of a normal
; install (interactive box pre-ticked and /VERYSILENT runs create it too,
; since silent installs only process *selected* tasks). Users who do not
; want it can untick the box or pass /TASKS with the task name omitted.
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SrcExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autoprograms}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
var
  RemoveNucleusData: Boolean;

{ True when `node --version` runs and prints a version (Node.js is on PATH). }
function NodeIsAvailable(): Boolean;
var
  ResultCode: Integer;
  TempFile: String;
  Lines: TArrayOfString;
begin
  Result := False;
  TempFile := ExpandConstant('{tmp}\nucleus-node-version.txt');
  DeleteFile(TempFile);
  if Exec(ExpandConstant('{cmd}'), '/C node --version > "' + TempFile + '" 2>NUL',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if (ResultCode = 0) and LoadStringsFromFile(TempFile, Lines) then
      Result := (GetArrayLength(Lines) > 0) and (Pos('v', Lines[0]) = 1);
  end;
  DeleteFile(TempFile);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { Never block the install on Node.js - only warn, because only the apps need it.
    Stay silent during an unattended install, or a modal box would hang it. }
  if (CurStep = ssPostInstall) and (not WizardSilent()) and (not NodeIsAvailable()) then
    MsgBox('Nucleus is installed.' + #13#10 + #13#10 +
           'Node.js is required to run the apps (the launcher itself does not need it). ' +
           'Install it from https://nodejs.org and make sure it is on your PATH, then open Nucleus.',
           mbInformation, MB_OK);
end;

function InitializeUninstall(): Boolean;
begin
  RemoveNucleusData := False;
  { Ask before touching user data; stay silent during an unattended uninstall. }
  if not UninstallSilent() then
  begin
    if MsgBox('Also delete your installed Nucleus apps and settings?' + #13#10 + #13#10 +
              'Yes: remove ' + ExpandConstant('{userappdata}') + '\Nucleus' + #13#10 +
              'No:  keep your apps and settings',
              mbConfirmation, MB_YESNO) = IDYES then
    begin
      RemoveNucleusData := True;
    end;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if (CurUninstallStep = usPostUninstall) and RemoveNucleusData then
  begin
    DataDir := ExpandConstant('{userappdata}\Nucleus');
    if DirExists(DataDir) then
      DelTree(DataDir, True, True, True);
  end;
end;

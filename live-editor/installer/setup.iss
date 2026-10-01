; Build through scripts/build-installer.ps1. StageDir must be a validated, data-free release.
#if Ver < EncodeVer(6, 7, 3)
  #error Inno Setup 6.7.3 or newer is required
#endif
#ifndef StageDir
  #error StageDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef SetupAppId
  #define SetupAppId "Caibo.LiveRecorder"
#endif
#ifndef SetupBaseName
  #define SetupBaseName "BiliLiveEditor-" + AppVersion + "-win-x64-setup"
#endif

[Setup]
AppId={#SetupAppId}
AppName=菜播·录包机
AppVersion={#AppVersion}
AppPublisher=糊涂小菜包
AppPublisherURL=https://github.com/kk12091209/Caibaoliverecorder
AppSupportURL=https://space.bilibili.com/5162836
AppUpdatesURL=https://github.com/kk12091209/Caibaoliverecorder/releases
DefaultDirName={localappdata}\Programs\菜播·录包机
DefaultGroupName=菜播·录包机
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern dynamic windows11
WizardSizePercent=115
DisableWelcomePage=no
DisableDirPage=no
DisableProgramGroupPage=yes
SetupIconFile=..\desktop\app.ico
UninstallDisplayIcon={app}\录播机.exe
UninstallDisplayName=菜播·录包机
UninstallFilesDir={app}\程序组件\卸载
OutputDir={#SetupOutputDir}
OutputBaseFilename={#SetupBaseName}
#ifdef QaFastCompile
Compression=none
SolidCompression=no
#else
Compression=lzma2/ultra64
LZMAUseSeparateProcess=yes
LZMADictionarySize=131072
SolidCompression=yes
#endif
CloseApplications=no
RestartApplications=no
LicenseFile={#StageDir}\程序组件\LICENSE
VersionInfoDescription=菜播·录包机安装程序
VersionInfoProductName=菜播·录包机
VersionInfoVersion={#AppVersion}

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Messages]
WelcomeLabel1=欢迎使用菜播·录包机
WelcomeLabel2=B 站与抖音直播录制、回看和弹幕剪辑。%n%n安装后即可使用，无需另装 Node.js 或 FFmpeg。%n%n建议安装到空间充足的磁盘。
SelectDirLabel3=选择程序与默认录像数据的保存位置。长时间录制会占用较多空间，建议选择空间充足的磁盘。
FinishedHeadingLabel=菜播·录包机已准备就绪
FinishedLabel=添加直播间，即可开始监控与录制。录制结束后自动预处理，需要视频时再手动导出。%n%n卸载会删除安装目录内的全部文件，包括录像和导出视频；需要保留的文件请先移出安装目录。
ConfirmUninstall=确定卸载 %1 吗？%n%n安装目录内的全部文件将永久删除，包括录像、导出视频、缓存和设置。需要保留的文件请先移出安装目录。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Dirs]
Name: "{app}\导出视频默认路径\完整素材"
Name: "{app}\导出视频默认路径\导出片段"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\录播机.exe"; DestName: "maintenance.exe"; Flags: dontcopy
Source: "translation-LICENSE.txt"; DestDir: "{app}\程序组件\licenses"; DestName: "installer-translation-LICENSE.txt"; Flags: ignoreversion
Source: "{#InnoLicense}"; DestDir: "{app}\程序组件\licenses"; DestName: "Inno-Setup-LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\菜播·录包机"; Filename: "{app}\录播机.exe"; WorkingDir: "{app}"
Name: "{group}\卸载菜播·录包机"; Filename: "{uninstallexe}"
Name: "{app}\卸载菜播·录包机"; Filename: "{uninstallexe}"
Name: "{autodesktop}\菜播·录包机"; Filename: "{app}\录播机.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\录播机.exe"; Description: "打开菜播·录包机"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; InitializeUninstall validates the dedicated installation before any deletion.
Type: filesandordirs; Name: "{app}"

[Code]
function NormalizedPath(const Value: String): String;
begin
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Value));
end;

function SafeInstallationPath(const Value: String): Boolean;
var
  Folder, WindowsFolder: String;
  ProtectedFolders: TArrayOfString;
  I: Integer;
begin
  Folder := NormalizedPath(Value);
  Result := False;
  if Length(Folder) <= Length(ExtractFileDrive(Folder)) + 1 then Exit;
  WindowsFolder := AddBackslash(NormalizedPath(ExpandConstant('{win}')));
  if (CompareText(Folder, RemoveBackslashUnlessRoot(WindowsFolder)) = 0) or
     (CompareText(Copy(AddBackslash(Folder), 1, Length(WindowsFolder)), WindowsFolder) = 0) then Exit;
  if (GetEnv('USERPROFILE') <> '') and
     (CompareText(Folder, NormalizedPath(GetEnv('USERPROFILE'))) = 0) then Exit;
  ProtectedFolders := ['{userdesktop}', '{commondesktop}', '{userdocs}',
    '{commondocs}', '{localappdata}', '{userappdata}', '{commonappdata}',
    '{commonpf}', '{commonpf32}', '{commonpf64}'];
  for I := 0 to GetArrayLength(ProtectedFolders) - 1 do
    if CompareText(Folder, NormalizedPath(ExpandConstant(ProtectedFolders[I]))) = 0 then Exit;
  Result := True;
end;

function InstallationMarker: String;
begin
  Result := ExpandConstant('{app}\程序组件\installation-owner.txt');
end;

function InstallationOwned: Boolean;
var
  Lines: TArrayOfString;
begin
  Result := False;
  if not LoadStringsFromFile(InstallationMarker, Lines) then Exit;
  if GetArrayLength(Lines) <> 2 then Exit;
  Result := (Lines[0] = '{#SetupAppId}') and
    (CompareText(Lines[1], NormalizedPath(ExpandConstant('{app}'))) = 0);
end;

function DirectoryHasContents(const Folder: String): Boolean;
var
  Entry: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Folder) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
          Result := True;
          Break;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Lines: TArrayOfString;
begin
  if CurStep = ssPostInstall then begin
    Lines := ['{#SetupAppId}', NormalizedPath(ExpandConstant('{app}'))];
    if not SaveStringsToUTF8File(InstallationMarker, Lines, False) then
      RaiseException('无法保存安装信息，请重新安装。');
  end;
end;

procedure InitializeWizard;
var
  Brand: TPanel;
  Heading, Features: TNewStaticText;
begin
  WizardForm.WizardBitmapImage.Visible := False;
  Brand := TPanel.Create(WizardForm);
  Brand.Parent := WizardForm.WelcomePage;
  Brand.SetBounds(0, 0, WizardForm.WizardBitmapImage.Width, WizardForm.WelcomePage.Height);
  Brand.BevelOuter := bvNone;
  Brand.Color := $00282118;
  Heading := TNewStaticText.Create(WizardForm);
  Heading.Parent := Brand;
  Heading.AutoSize := False;
  Heading.SetBounds(ScaleX(18), ScaleY(42), Brand.Width - ScaleX(32), ScaleY(90));
  Heading.Font.Name := 'Microsoft YaHei UI';
  Heading.Font.Size := 20;
  Heading.Font.Style := [fsBold];
  Heading.Font.Color := $00CFEF79;
  Heading.Caption := '菜播' + #13#10 + '录包机';
  Features := TNewStaticText.Create(WizardForm);
  Features.Parent := Brand;
  Features.AutoSize := False;
  Features.SetBounds(ScaleX(18), ScaleY(165), Brand.Width - ScaleX(32), ScaleY(140));
  Features.Font.Name := 'Microsoft YaHei UI';
  Features.Font.Size := 10;
  Features.Font.Color := clWhite;
  Features.Caption := '直播录制' + #13#10#13#10 + '连续回看 · 精确选段' + #13#10#13#10 + '弹幕视频 · 本地保存';
end;

function SafeMaintenance: String;
var
  Exe: String;
  ResultCode: Integer;
begin
  Result := '';
  Exe := ExpandConstant('{app}\录播机.exe');
  if not FileExists(Exe) then Exit;
  { The embedded current helper also handles older installed launchers safely. }
  if IsUninstaller then
    Exe := ExpandConstant('{app}\录播机.exe')
  else begin
    ExtractTemporaryFile('maintenance.exe');
    Exe := ExpandConstant('{tmp}\maintenance.exe');
  end;
  if not Exec(Exe, '--prepare-maintenance ' + AddQuotes(ExpandConstant('{app}')), ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := '无法确认软件已安全退出，请先从系统托盘退出菜播·录包机，然后重试。'
  else if ResultCode = 2 then
    Result := '软件正在录制、导出、整理或预处理。请等待任务完成，或在软件内主动停止任务，然后重试。不会强制结束您的任务。'
  else if ResultCode <> 0 then
    Result := '后台尚未安全退出，请先从系统托盘退出菜播·录包机，然后重试。';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '请选择专用的安装文件夹。';
  if not SafeInstallationPath(ExpandConstant('{app}')) then Exit;
  if DirectoryHasContents(ExpandConstant('{app}')) and not InstallationOwned and
    not (FileExists(ExpandConstant('{app}\程序组件\release-manifest.json')) and
         FileExists(ExpandConstant('{app}\录播机.exe'))) then Exit;
  Result := SafeMaintenance;
end;

function InitializeUninstall: Boolean;
var
  Error: String;
begin
  Result := False;
  if not SafeInstallationPath(ExpandConstant('{app}')) or not InstallationOwned then begin
    SuppressibleMsgBox('安装目录无法确认，请重新安装后再卸载。', mbError, MB_OK, IDOK);
    Exit;
  end;
  Error := SafeMaintenance;
  Result := Error = '';
  if not Result then SuppressibleMsgBox(Error, mbError, MB_OK, IDOK);
end;

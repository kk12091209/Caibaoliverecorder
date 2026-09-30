# Windows installer

`setup.iss` is compiled with pinned Inno Setup 6.7.3 by `scripts/build-installer.ps1`.
Only the fresh, data-free portable release stage is included. The installer uses
per-user installation, a Chinese modern wizard, optional desktop shortcuts and
Windows uninstall registration. Uninstaller files live under `程序组件/卸载`; a
root shortcut makes them discoverable. Uninstall removes only installed program
files and shortcuts, never generated recordings, databases or exported videos.

Before replacing/removing program files, maintenance mode checks the private
local service and its data lock. Busy recording/processing refuses maintenance
without requesting an exit. Idle services and current desktop windows shut down
gracefully. Older launchers are checked for running processes and must be exited
by the user; they are never launched with an unknown command-line option.

`scripts/test-installer.ps1` compiles a separate QA identity and performs actual
install, upgrade and uninstall tests entirely under `.tools/release-qa`. It uses
synthetic data and never installs over a user's copy. Its test registration is
separate from the public installer registration.

The Chinese language file and MIT license come from
https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation
at commit `1ff90acc4ed4aee82b1cda43253243deee3daed4`.
ChineseSimplified.isl SHA-256:
`bf0751fa176569c6faa2f6e17ed2734617bef325d5cc06eae030fdd0258ee778`.
The installer includes both its translation license and Inno Setup's license.

# Source snapshot

This archive contains the modified editor, explicitly listed recorder additions,
and tracked source at commit
a27640a33bcc35e09c76111c14e1d3627805e483, including required tracked icons and other build
assets. It intentionally contains no Git database, local recordings, credentials,
development dependencies or runtime executables.

The upstream recorder build uses GitVersion and can require Git history. This ZIP
alone is not claimed to build the entire upstream solution. Prepare the exact
baseline checkout, then overlay the contents of this source archive into it:

git clone https://github.com/BililiveRecorder/BililiveRecorder.git source-build
git -C source-build checkout a27640a33bcc35e09c76111c14e1d3627805e483
git -C source-build submodule update --init --recursive

After overlaying, follow live-editor/README.md and the build/release scripts under
live-editor/scripts. Keep the cloned .git directory; the archive does not replace
it. Do not substitute a newer upstream checkout for the recorded baseline.

SOURCE-MANIFEST.json records every included file hash and every excluded tracked
file. Public upstream FLV test fixtures and the legacy WPF miniffmpeg executable
are omitted. The current CLI and editor builds do not use that legacy executable.
To restore omitted upstream fixtures, clone the recorded submodule source URL and
check out its exact commit below; these are upstream public fixtures, not recordings
from this installation. In a full Git checkout, git submodule update --init --recursive
restores the matching submodules. In this source-only ZIP, use the explicit clones:
- test/data: https://github.com/BililiveRecorder/test-data.git at 28aa6c68ae6abf3242e42db703ef1676ecbb22fd
  git clone --no-checkout https://github.com/BililiveRecorder/test-data.git restored-test-data
  git -C restored-test-data checkout 28aa6c68ae6abf3242e42db703ef1676ecbb22fd

- webui/source: https://github.com/BililiveRecorder/BililiveRecorder-WebUI.git at 08fd0be31c7d4a496f9202199ff3b4a9e05e8d56
  git clone --no-checkout https://github.com/BililiveRecorder/BililiveRecorder-WebUI.git restored-webui-source
  git -C restored-webui-source checkout 08fd0be31c7d4a496f9202199ff3b4a9e05e8d56

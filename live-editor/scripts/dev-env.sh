#!/usr/bin/env bash
# Source this file from a shell before building/testing on macOS.
if [ -n "${ZSH_VERSION:-}" ]; then
  CAIBO_ENV_FILE="${(%):-%x}"
else
  CAIBO_ENV_FILE="${BASH_SOURCE[0]}"
fi
CAIBO_SOURCE_ROOT="$(cd "$(dirname "$CAIBO_ENV_FILE")/../.." && pwd -P)"
mkdir -p "$CAIBO_SOURCE_ROOT/.tools/tmp" "$CAIBO_SOURCE_ROOT/.tools/dotnet-home" "$CAIBO_SOURCE_ROOT/.tools/nuget"
export TMPDIR="$CAIBO_SOURCE_ROOT/.tools/tmp" TMP="$CAIBO_SOURCE_ROOT/.tools/tmp" TEMP="$CAIBO_SOURCE_ROOT/.tools/tmp"
export DOTNET_CLI_HOME="$CAIBO_SOURCE_ROOT/.tools/dotnet-home" NUGET_PACKAGES="$CAIBO_SOURCE_ROOT/.tools/nuget"
export DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_ROLL_FORWARD=Major
export PATH="$CAIBO_SOURCE_ROOT/.tools/runtime/node-v24.12.0-darwin-arm64/bin:$CAIBO_SOURCE_ROOT/.tools/dotnet:$PATH"
export FFMPEG_PATH="$CAIBO_SOURCE_ROOT/.tools/runtime/ffmpeg/ffmpeg" FFPROBE_PATH="$CAIBO_SOURCE_ROOT/.tools/runtime/ffmpeg/ffprobe"
export RECORDER_PATH="$CAIBO_SOURCE_ROOT/.tools/runtime/recorder/BililiveRecorder.Cli"

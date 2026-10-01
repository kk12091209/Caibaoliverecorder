#!/usr/bin/env bash
set -euo pipefail
work=$(cygpath -u "$CAIBO_FFMPEG_WORK")
cd "$work"
# GCC's own temporary assembler files also need an ASCII native path.
mkdir -p compiler-temp
export TMPDIR="$(cygpath -m "$CAIBO_FFMPEG_WORK")/compiler-temp"
export TMP="$TMPDIR" TEMP="$TMPDIR"
native="$(cygpath -m "$CAIBO_FFMPEG_WORK")"
compiler="$native/msys64/ucrt64/bin/gcc.exe"
export GCC_EXEC_PREFIX="$native/msys64/ucrt64/lib/gcc/"
export LIBRARY_PATH="$native/msys64/ucrt64/lib;$native/msys64/ucrt64/x86_64-w64-mingw32/lib"
export MSYS2_ENV_CONV_EXCL='GCC_EXEC_PREFIX;LIBRARY_PATH;TMPDIR;TMP;TEMP'
if [[ ${CAIBO_FFMPEG_SKIP_INSTALL:-0} != 1 ]]; then
  pacman -Sy --noconfirm --needed make tar diffutils nasm \
    mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-pkgconf \
    mingw-w64-ucrt-x86_64-libass mingw-w64-ucrt-x86_64-x264 \
    mingw-w64-ucrt-x86_64-libvpl mingw-w64-ucrt-x86_64-amf-headers \
    mingw-w64-ucrt-x86_64-ffnvcodec-headers
fi
pacman -Q > packages.lock.txt
if [[ ! -d ffmpeg-8.1.2 ]]; then tar -xf ffmpeg-8.1.2.tar.xz; fi
mkdir -p ffmpeg-build
cd ffmpeg-build
if [[ ${CAIBO_FFMPEG_REUSE_CONFIG:-0} != 1 ]]; then
../ffmpeg-8.1.2/configure --prefix="$work/ffmpeg-install" \
  --target-os=mingw32 --arch=x86_64 --cc="$compiler" --cxx="$native/msys64/ucrt64/bin/g++.exe" \
  --enable-shared --disable-static --disable-debug --disable-doc --disable-ffplay \
  --disable-autodetect --enable-gpl --enable-version3 \
  --enable-libx264 --enable-libass --enable-libvpl --enable-amf \
  --enable-ffnvcodec --enable-nvenc --enable-nvdec --enable-cuvid \
  --enable-d3d11va --enable-dxva2 --enable-schannel --enable-zlib \
  --enable-w32threads --extra-cflags=-O2
fi
make -j"${CAIBO_FFMPEG_JOBS:-4}" CC="$compiler" HOSTCC="$compiler" LD="$compiler" HOSTLD="$compiler"
make install

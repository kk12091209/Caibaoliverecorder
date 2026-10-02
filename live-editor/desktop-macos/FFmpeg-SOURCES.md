# FFmpeg supplier sources and licenses

The shipped FFmpeg / FFprobe binaries are Martin Riedl macOS arm64 release
1789931890_9.0.2. Binary download hashes are pinned in prepare-macos.sh.
Original configuration and reported versions are preserved in ffmpeg-versions.txt.

Source inventory collected on 2026-10-02 from the upstream locations below.
The release also provides Caibo-0.1.4-FFmpeg-upstream-sources.tar.gz, containing
these downloaded archives, hashes and the supplier build script snapshot at
f63b8aab8f5ce1a067da86ba69e34a36a7e217e5. Licenses from those sources are kept
under ffmpeg-dependencies/. libogg and libiconv are build dependency entries from
the supplier scripts, not version numbers reported by the binary.

The supplier uses a moving x264 master archive and publishes no exact x264 commit
in its version inventory. Its build-script snapshot also predates this binary.
The archived upstream sources and scripts document provenance; they do not assert
bit-for-bit reproduction of the supplier binary or exact x264 snapshot identity.

Supplier: https://ffmpeg.martin-riedl.de/
Build scripts: https://git.martin-riedl.de/ffmpeg/build-script

| Component | Version | Upstream source archive |
| --- | --- | --- |
| aom | 3.15.0 | https://storage.googleapis.com/aom-releases/libaom-3.15.0.tar.gz |
| libass | 0.17.5 | https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.gz |
| libbluray | 1.5.0 | https://download.videolan.org/pub/videolan/libbluray/1.5.0/libbluray-1.5.0.tar.xz |
| dav1d | 1.5.4 | https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.gz |
| fontconfig | 2.17.1 | https://gitlab.freedesktop.org/api/v4/projects/890/packages/generic/fontconfig/2.17.1/fontconfig-2.17.1.tar.xz |
| freetype | 2.13.0 | https://download.savannah.gnu.org/releases/freetype/freetype-2.13.0.tar.gz |
| fribidi | 1.0.16 | https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz |
| harfbuzz | 14.4.0 | https://github.com/harfbuzz/harfbuzz/releases/download/14.4.0/harfbuzz-14.4.0.tar.xz |
| libklvanc | 1.6.0 | https://github.com/stoth68000/libklvanc/archive/refs/tags/vid.obe.1.6.0.tar.gz |
| lame | 4.0 | https://unlimited.dl.sourceforge.net/project/lame/lame/4.0/lame-4.0.tar.gz |
| openh264 | 2.6.0 | https://github.com/cisco/openh264/archive/v2.6.0.tar.gz |
| openjpeg | 2.5.4 | https://github.com/uclouvain/openjpeg/archive/refs/tags/v2.5.4.tar.gz |
| openssl | 3.6.4 | https://github.com/openssl/openssl/releases/download/openssl-3.6.4/openssl-3.6.4.tar.gz |
| opus | 1.6.1 | https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz |
| rav1e | 0.8.1 | https://github.com/xiph/rav1e/archive/refs/tags/v0.8.1.tar.gz |
| sdl | 2.32.10 | https://www.libsdl.org/release/SDL2-2.32.10.tar.gz |
| snappy | 1.2.2 | https://github.com/google/snappy/archive/refs/tags/1.2.2.tar.gz |
| srt | 1.5.7 | https://github.com/Haivision/srt/archive/refs/tags/v1.5.7.tar.gz |
| svt-av1 | 4.2.0 | https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/v4.2.0/SVT-AV1-v4.2.0.tar.gz |
| libtheora | 1.2.0 | https://downloads.xiph.org/releases/theora/libtheora-1.2.0.tar.gz |
| libvmaf | 3.2.0 | https://github.com/Netflix/vmaf/archive/refs/tags/v3.2.0.tar.gz |
| libvorbis | 1.3.7 | https://ftp.osuosl.org/pub/xiph/releases/vorbis/libvorbis-1.3.7.tar.gz |
| vpx | 1.16.0 | https://github.com/webmproject/libvpx/archive/v1.16.0.tar.gz |
| vvenc | 1.14.0 | https://github.com/fraunhoferhhi/vvenc/archive/refs/tags/v1.14.0.tar.gz |
| libwebp | 1.6.0 | https://github.com/webmproject/libwebp/archive/refs/tags/v1.6.0.tar.gz |
| x264 | 0.165.x | https://code.videolan.org/videolan/x264/-/archive/master/x264-master.tar.gz |
| x265 | 4.2 | https://bitbucket.org/multicoreware/x265_git/get/4.2.tar.gz |
| libxml2 | 2.15.3 | https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.3.tar.xz |
| zimg | 3.0.6 | https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz |
| zlib | 1.3.2 | https://www.zlib.net/fossils/zlib-1.3.2.tar.gz |
| zvbi | 0.2.35 | https://sourceforge.net/projects/zapping/files/zvbi/0.2.35/zvbi-0.2.35.tar.bz2/download |
| ffmpeg | 9.0.2 | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.bz2 |
| libogg | 1.3.6 | https://ftp.osuosl.org/pub/xiph/releases/ogg/libogg-1.3.6.tar.gz |
| libiconv | 1.17 | https://ftp.gnu.org/pub/gnu/libiconv/libiconv-1.17.tar.gz |

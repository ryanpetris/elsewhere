# Native dependencies

Elsewhere uses the distribution's shared libraries. Install the artifact built for your distribution;
FFmpeg library ABIs differ between releases. The package manager supplies the native libraries,
their copyright notices and their corresponding source packages.

Media processing uses [FFmpeg](https://ffmpeg.org/legal.html), including libavcodec, libavutil,
libavfilter, libswscale, libswresample, libavformat and libavdevice. Distribution builds commonly
include libvpx, x264, x265, libaom, SVT-AV1 and libopus. FFmpeg's license depends on its build options;
consult the installed FFmpeg package's license and copyright files for that build.

Device access uses [PipeWire](https://gitlab.freedesktop.org/pipewire/pipewire),
[libva](https://github.com/intel/libva), [Mesa](https://docs.mesa3d.org/license.html) and
[libxkbcommon](https://github.com/xkbcommon/libxkbcommon). Their upstream source and distribution
packages contain the applicable notices. Viewer dependency notices are in `THIRD_PARTY.txt`.

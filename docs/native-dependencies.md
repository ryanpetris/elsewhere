# Native dependencies

Elsewhere uses the distribution's shared libraries. Install the artifact built for your distribution;
FFmpeg library ABIs differ between releases. The package manager supplies the native libraries,
their copyright notices and their corresponding source packages.

Verified RTMPS broadcasts require the system trust store from `ca-certificates`. Native packages
depend on it. Install it separately when using a tarball; a missing trust store prevents TLS
connections to otherwise trusted destinations.

Media processing uses [FFmpeg](https://ffmpeg.org/legal.html), including libavcodec, libavutil,
libavfilter, libswscale, libswresample, libavformat and libavdevice. Distribution builds commonly
include libvpx, x264, x265, libaom and libopus. FFmpeg's license depends on its build options;
consult the installed FFmpeg package's license and copyright files for that build.

Device access uses [PipeWire](https://gitlab.freedesktop.org/pipewire/pipewire),
[libva](https://github.com/intel/libva), [Mesa](https://docs.mesa3d.org/license.html) and
[libxkbcommon](https://github.com/xkbcommon/libxkbcommon). Their upstream source and distribution
packages contain the applicable notices. Rust and viewer dependency credits are in
[ACKNOWLEDGEMENTS.md](https://github.com/ryanpetris/elsewhere/blob/master/ACKNOWLEDGEMENTS.md).

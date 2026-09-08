// Native/Pulse playback signals for browser checks. The player supplies the device clock.
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const tonePattern = '^ffmpeg .* -metadata comment=elsewhere-browser-audio-fixture( |$)';

export function toneCommand({ frequency = 440, volume = .1, seconds, pulse = false, name, application } = {}) {
  const source = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `sine=frequency=${frequency}:sample_rate=48000`, '-af', `volume=${volume * 8},pan=stereo|c0=c0|c1=c0`, '-ac', '2',
    ...(seconds ? ['-t', seconds] : []), '-metadata', 'comment=elsewhere-browser-audio-fixture', '-f', 'f32le', 'pipe:1'];
  const player = pulse
    ? ['pacat', '--playback', '--raw', '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=20',
      ...(name ? [`--stream-name=${name}`] : []), ...(application ? [`--client-name=${application}`] : [])]
    : ['pw-cat', '--playback', '--raw', '--format=f32', '--rate=48000', '--channels=2', '--latency=20ms',
      ...(name || application ? ['--properties', JSON.stringify({ ...(name ? { 'node.name': name, 'node.description': name, 'media.name': name } : {}),
        ...(application ? { 'application.name': application } : {}) })] : []), '-'];
  return source.map(quote).join(' ') + ' | ' + player.map(quote).join(' ');
}

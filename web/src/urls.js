// The server supplies the public base path, whether or not the proxy strips it upstream.
const prefix = new URL(document.baseURI).pathname.replace(/\/$/, '');
export const url = path => prefix + path;
export const storageKey = key => `elsewhere${prefix ? ':' + prefix : ''}.${key}`;
export const websocketUrl = path => {
  const target = new URL(url(path), location.origin);
  target.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return target.href;
};

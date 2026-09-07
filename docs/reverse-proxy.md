# Hosting Elsewhere behind a reverse proxy

Elsewhere can share one HTTPS hostname with other applications or other Elsewhere instances.
Each instance gets a public path, such as `/elsewhere/alice/` or `/elsewhere/bob/`. The proxy
terminates HTTPS and WebSocket TLS; Elsewhere can use `--no-tls` on a private backend connection.
The browser still uses HTTPS, as required by WebCodecs and browser capture features.

## Choose how the proxy forwards paths

`--url-prefix /elsewhere/alice` sets the public path for the viewer, assets, HTTP API, MCP and all
WebSockets. Prefixes can have multiple levels. A trailing slash is optional in the flag; the viewer's
base URL ends in `/`. Prefix segments accept ASCII letters, digits, `-`, `.`, `_` and `~`.
Empty internal segments, `.` and `..` segments, URL escapes, query strings and fragments are rejected.
Omitting the flag, or using `/`, serves at the root.

| Backend flags | Public request | Request forwarded by proxy |
| --- | --- | --- |
| `--url-prefix /elsewhere/alice` | `/elsewhere/alice/ws` | `/elsewhere/alice/ws` |
| `--url-prefix /elsewhere/alice --proxy-strips-prefix` | `/elsewhere/alice/ws` | `/ws` |

The default mode accepts the prefixed routes and redirects the bare prefix to its trailing-slash
form, preserving the query string. With `--proxy-strips-prefix`, Elsewhere accepts root routes;
the proxy should redirect the bare public prefix. Browser URLs use the configured prefix in both
modes. Configure the prefix explicitly; Elsewhere does not infer it from forwarded headers.

## nginx with two instances

This example uses a private Docker network shared by nginx and two Elsewhere containers. Give the
containers the network aliases `alice` and `bob`. Each instance needs its own persistent data volume
for tokens and its own desktop environment. Forwarding to an instance must be consistent across HTTP
requests, MCP sessions and every WebSocket; independent desktops are not interchangeable replicas.

These commands create the `elsewhere-proxy` Docker network and start the instances. Build the image
with `make docker` first. Rendering and encoding use the CPU here; see the README for GPU options.

```sh
docker network create elsewhere-proxy
docker run -d --name alice --network elsewhere-proxy --shm-size 1g \
  -v alice-data:/home/elsewhere/.config/elsewhere \
  elsewhere --render-node none --no-tls --no-rtc --listen 0.0.0.0:8080 \
  --url-prefix /elsewhere/alice
docker run -d --name bob --network elsewhere-proxy --shm-size 1g \
  -v bob-data:/home/elsewhere/.config/elsewhere \
  elsewhere --render-node none --no-tls --no-rtc --listen 0.0.0.0:8080 \
  --url-prefix /elsewhere/bob --proxy-strips-prefix
```

Run nginx on that network, publish its TCP port 443, and mount this configuration and your HTTPS
certificate and key. Replace `desktop.example.com` and the certificate paths for your deployment.
Only nginx needs the public HTTPS certificate. The backend HTTP ports need no host port publication.

```nginx
events {}
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen 443 ssl;
        server_name desktop.example.com;
        ssl_certificate /etc/nginx/tls/fullchain.pem;
        ssl_certificate_key /etc/nginx/tls/privkey.pem;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 1g;

        location = /elsewhere/alice {
            return 308 /elsewhere/alice/$is_args$args;
        }
        location /elsewhere/alice/ {
            proxy_pass http://alice:8080;
        }

        location = /elsewhere/bob {
            return 308 /elsewhere/bob/$is_args$args;
        }
        location /elsewhere/bob/ {
            proxy_pass http://bob:8080/;
        }
    }
}
```

The absence of a trailing `/` on Alice's `proxy_pass` preserves the request path. Bob's trailing `/`
replaces the matched location prefix with `/`, matching `--proxy-strips-prefix`.
Use the corresponding pair of settings for either instance.

The upgrade headers cover desktop, window and terminal WebSockets. Long read timeouts allow idle
terminals; desktop and window connections send keepalive pings. Disabling response buffering lets MCP
stream responses promptly. The upload limit is an example; set it to the largest transfer you allow.
Preserve the `Authorization` header, which nginx forwards by default. A gateway login is additional
authentication and does not replace Elsewhere's tokens.

Open `https://desktop.example.com/elsewhere/alice/` or `/elsewhere/bob/`. Retrieve the matching token
with `docker exec alice elsewhere token` or `docker exec bob elsewhere token`, and paste it into the
viewer. Token storage, preferences and named window popups are scoped by prefix. Different instances
can remain open in separate tabs. Paths on the same origin are not a browser security boundary;
use separate hostnames if the applications must not share an origin.

In preserved-prefix mode, the startup log uses the backend's scheme and port with the public path;
through a proxy, use its HTTPS hostname and port instead. In stripped-prefix mode, the log gives
the public path to open through the proxy, since the backend does not directly serve the viewer
at that path.

## Optional WebRTC on separate UDP ports

The default WebSocket transport carries the desktop through nginx alone. To offer WebRTC video,
replace `--no-rtc` in each container command with:

```text
Alice: --rtc-addr <reachable-ip> --rtc-port 50001
Bob:   --rtc-addr <reachable-ip> --rtc-port 50002
```

Also add `-p 50001:50001/udp` to Alice's Docker options and `-p 50002:50002/udp` to Bob's, before the
image name. Open or forward those UDP ports on the firewall or router. Both instances can advertise
the same public IP. With `--rtc-addr`, the advertised port and local port are the same, so keep the
port number unchanged when forwarding.

Specify both flags when UDP uses a different endpoint from HTTPS. `--rtc-port` alone changes the
local bind port; without `--rtc-addr`, Elsewhere advertises the page's hostname and port instead.
URL prefixes do not route UDP traffic. nginx's HTTP proxy is not in this video path.

WebRTC uses its own generated DTLS certificate, whose fingerprint is exchanged through WebSocket
signalling. It needs no copy of nginx's certificate or a publicly trusted certificate in Elsewhere.
`--no-tls` leaves WebRTC encryption enabled. Input, audio and signalling stay on WebSocket even when
WebRTC carries video. If the WebRTC path fails, video falls back to WebSocket. STUN/TURN options and
transport recovery are described in the README's Transport section.

## API and MCP clients

Include the public prefix before every documented route. For Alice, the API is at
`https://desktop.example.com/elsewhere/alice/api/windows`, MCP is at
`https://desktop.example.com/elsewhere/alice/mcp`, and the skill is at
`https://desktop.example.com/elsewhere/alice/skill/SKILL.md`.
Send Alice's bearer token. This is the same in both proxy modes; only the proxy-to-backend path differs.

See nginx's [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html) and
[proxy_pass documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)
for the upgrade and path-replacement rules.

## Verification

`cd web && npm run check:url-prefix` runs the integration check inside the Docker rig with nginx,
OpenSSL, Chromium and foot installed, and a current binary at `/src/target/release/elsewhere` or
`ELSEWHERE_BINARY`. It starts isolated temporary instances and an HTTPS proxy, then exercises nested
prefixes in both forwarding modes and an unprefixed instance.

# qbittorrent-windscribe-ephemeral-port

Automatically keeps qBittorrent's listening ports in sync with a Windscribe ephemeral port forward.

This fork lives at:

https://github.com/spjoes/qbittorrent-windscribe-ephemeral-port

## What It Does

Windscribe ephemeral port forwards expire on a weekly cycle. This app:

- logs into Windscribe through the same API flow used by the desktop client
- creates a temporary Windscribe web session
- reads the current ephemeral port forward
- creates a new ephemeral port forward when needed
- updates qBittorrent's listen and announce ports
- optionally writes a Gluetun iptables rule file
- optionally restarts Gluetun and/or qBittorrent containers after a port change

This app does not route qBittorrent through a VPN. Use something like Gluetun for VPN routing.

## Windscribe Login

This fork does not require FlareSolverr or Byparr.

It uses Windscribe's API login flow directly:

- `WINDSCRIBE_AUTH_HASH` can be supplied to skip username/password login.
- If no auth hash is supplied, `WINDSCRIBE_USERNAME` and `WINDSCRIBE_PASSWORD` are used.
- The app caches the Windscribe API auth hash after a successful login.
- Web sessions are short lived and are recreated from the cached auth hash when needed.

Keep `CACHE_DIR` persistent. Without persistent cache, the container may need to login again after every recreate.

## Important Notes

- Windscribe may still require captcha during a fresh password login.
- The app includes a local image-based solver for Windscribe's slider captcha, but avoiding fresh logins is still the more reliable path.
- If your Windscribe account uses 2FA, set `WINDSCRIBE_TOTP_SECRET`.
- qBittorrent can authenticate with either an API key or username/password.
- qBittorrent API keys require qBittorrent 5.2 or newer.

## Configuration

Configuration is done with environment variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WINDSCRIBE_AUTH_HASH` | No | | Existing Windscribe API `session_auth_hash`. If set, username/password login is skipped. |
| `WINDSCRIBE_USERNAME` | No | | Windscribe username. Required when `WINDSCRIBE_AUTH_HASH` is not set. |
| `WINDSCRIBE_PASSWORD` | No | | Windscribe password. Required when `WINDSCRIBE_AUTH_HASH` is not set. |
| `WINDSCRIBE_TOTP_SECRET` | No | | Base32 TOTP secret for Windscribe 2FA. |
| `WINDSCRIBE_EPHEMERAL_INTERNAL_PORT` | No | `0` | Specific internal ephemeral port to request. Use `0` or leave unset to request a matching port. |
| `WINDSCRIBE_RETRY_DELAY` | No | `3600000` | Retry delay after a Windscribe error, in milliseconds. |
| `WINDSCRIBE_EXTRA_DELAY` | No | `60000` | Delay after Windscribe port expiry before requesting a new one, in milliseconds. |
| `CLIENT_URL` | Yes | | qBittorrent Web UI URL, for example `http://qbittorrent:8080`. |
| `CLIENT_API_KEY` | No | | qBittorrent Web UI API key. Either this or `CLIENT_USERNAME` and `CLIENT_PASSWORD` is required. |
| `CLIENT_USERNAME` | No | | qBittorrent Web UI username. |
| `CLIENT_PASSWORD` | No | | qBittorrent Web UI password. |
| `CLIENT_RETRY_DELAY` | No | `300000` | Retry delay after a qBittorrent error, in milliseconds. |
| `CRON_SCHEDULE` | No | | Optional cron schedule for extra periodic checks. |
| `CACHE_DIR` | No | Docker: `/cache`, local: `./cache` | Directory used to persist Windscribe auth/session cache and cached port state. |
| `GLUETUN_DIR` | No | Docker: `/post-rules.txt`, local: `./post-rules.txt` | File path where Gluetun iptables rules are written. |
| `GLUETUN_IFACE` | No | `tun0` | Gluetun VPN interface name. |
| `GLUETUN_CONTAINER_NAME` | No | | Docker container name for Gluetun. If set, Gluetun is restarted after a port change. |
| `QBITTORRENT_CONTAINER_NAME` | No | | Docker container name for qBittorrent. If set, qBittorrent is restarted after a port change and the listening port is re-applied after restart. |

Either `WINDSCRIBE_AUTH_HASH` or both `WINDSCRIBE_USERNAME` and `WINDSCRIBE_PASSWORD` must be set.

Either `CLIENT_API_KEY` or both `CLIENT_USERNAME` and `CLIENT_PASSWORD` must be set.

## Docker Compose

Build this fork locally:

```yaml
services:
  qbittorrent-windscribe-ephemeral-port:
    build: .
    restart: unless-stopped
    environment:
      WINDSCRIBE_USERNAME: your_windscribe_username
      WINDSCRIBE_PASSWORD: your_windscribe_password
      CLIENT_URL: http://qbittorrent:8080
      CLIENT_API_KEY: your_qbittorrent_api_key
      CACHE_DIR: /cache
      GLUETUN_DIR: /post-rules.txt
      GLUETUN_IFACE: tun0
      # Optional:
      # WINDSCRIBE_TOTP_SECRET: your_base32_totp_secret
      # WINDSCRIBE_EPHEMERAL_INTERNAL_PORT: 0
      # GLUETUN_CONTAINER_NAME: gluetun
      # QBITTORRENT_CONTAINER_NAME: qbittorrent
    volumes:
      - ./cache:/cache
      - ./post-rules.txt:/post-rules.txt
      # Required only if using automatic container restarts:
      # - /var/run/docker.sock:/var/run/docker.sock
```

Mounting `/var/run/docker.sock` gives this container control over Docker on the host. Only mount it if you want automatic container restarts and trust the code.

## Unraid

Recommended persistent cache mapping:

```text
Container Path: /cache
Host Path: /mnt/user/appdata/qbittorrent-windscribe-ephemeral-port/cache
Access Mode: Read/Write
```

Set:

```text
CACHE_DIR=/cache
```

Optional Gluetun rule output:

```text
Container Path: /post-rules.txt
Host Path: /mnt/user/appdata/qbittorrent-windscribe-ephemeral-port/post-rules.txt
Access Mode: Read/Write
```

Set:

```text
GLUETUN_DIR=/post-rules.txt
```

If you want this app to restart Gluetun and/or qBittorrent after a port change, also mount the Docker socket:

```text
Container Path: /var/run/docker.sock
Host Path: /var/run/docker.sock
Access Mode: Read/Write
```

Then set one or both container names:

```text
GLUETUN_CONTAINER_NAME=gluetun
QBITTORRENT_CONTAINER_NAME=qbittorrent
```

## Local Development

Install dependencies:

```bash
yarn install
```

Create `.env`:

```env
WINDSCRIBE_USERNAME=your_windscribe_username
WINDSCRIBE_PASSWORD=your_windscribe_password
# Or:
# WINDSCRIBE_AUTH_HASH=your_windscribe_session_auth_hash

CLIENT_URL=http://localhost:8080
CLIENT_API_KEY=your_qbittorrent_api_key
# Or:
# CLIENT_USERNAME=admin
# CLIENT_PASSWORD=adminadmin

CACHE_DIR=./cache
GLUETUN_DIR=./post-rules.txt
```

Run the app:

```bash
yarn start
```

Build:

```bash
yarn build
```

Lint:

```bash
yarn lint
```

## Windscribe Debug Check

Use this to test only the Windscribe login/session/port-read path:

```bash
yarn windscribe:debug
```

This does not update qBittorrent and does not create or delete Windscribe ports. It only checks:

- API auth hash login/cache
- temporary web session creation
- CSRF token parsing
- current ephemeral port status

## 2FA

If Windscribe 2FA is enabled, set `WINDSCRIBE_TOTP_SECRET`.

The secret is the Base32 value inside the authenticator QR URI:

```text
otpauth://totp/Windscribe:username?secret=ABCDEFGHIJKLMNOP&issuer=Windscribe
```

Use only the `secret` value:

```env
WINDSCRIBE_TOTP_SECRET=ABCDEFGHIJKLMNOP
```

## Cache Behavior

The cache stores:

- Windscribe API auth hash
- temporary Windscribe web session cookie
- last known Windscribe port

The web session is short lived, commonly around 60 minutes. The app recreates it from the cached auth hash when needed.

The auth hash is the important long-lived value. Persist `CACHE_DIR` so restarts do not force fresh password login.

## Troubleshooting

Run:

```bash
yarn windscribe:debug
```

Common issues:

| Error | Meaning |
| --- | --- |
| `Invalid CAPTCHA solution` | Fresh password login required captcha and the local solver missed. Retry later or use a cached/provided `WINDSCRIBE_AUTH_HASH`. |
| `Missing environment variable CLIENT_URL` | Set `CLIENT_URL` to qBittorrent's Web UI URL. |
| `Either CLIENT_API_KEY or both CLIENT_USERNAME and CLIENT_PASSWORD must be provided` | Configure qBittorrent authentication. |
| `Either WINDSCRIBE_AUTH_HASH or both WINDSCRIBE_USERNAME and WINDSCRIBE_PASSWORD must be provided` | Configure Windscribe authentication. |
| `Failed to get csrf token` | Windscribe web session creation or account page parsing failed. Run `yarn windscribe:debug` for a narrower error. |

## Credits

This project is based on earlier qBittorrent and Deluge Windscribe ephemeral port forwarder projects, with this fork adding the direct Windscribe API login/session flow and removing the FlareSolverr/Byparr requirement.

Use at your own risk.

# POCUT production: stop and start

Run these commands as root on the Bluehost production server (129.121.151.159).
The public site is https://pocut.vxu.me and the systemd service is `pocut-web`.

Temporarily stop production and prevent it starting again after a server reboot:

```sh
systemctl disable --now pocut-web.service
```

Start the existing deployed release and enable automatic startup at boot:

```sh
systemctl enable --now pocut-web.service
```

No rebuild or redeployment is required. The service runs the already-built
release at `/srv/pocut/live/apps/web`; project and account data remain under
`/var/lib/pocut/accounts`. Stopping the service leaves Caddy and DNS running;
application requests return HTTP 502 while its backend is stopped. Cached pages
may remain visible in a visitor's browser, but cannot use the backend.

Check service and automatic startup status and the public health endpoint:

```sh
systemctl is-active pocut-web.service
systemctl is-enabled pocut-web.service
curl -fsS https://pocut.vxu.me/api/health
```

A healthy running service reports `active`, `enabled`, and `OK`. Its systemd
unit also has `Restart=on-failure` for automatic recovery after a process failure.
Enabling the service confirms boot configuration; it does not itself test an
actual server reboot. These commands do not switch releases or change stored data.

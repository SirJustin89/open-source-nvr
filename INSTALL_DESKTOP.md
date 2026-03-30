# Install the desktop launcher

To install the desktop launcher for this build, copy the .desktop file into your applications directory:

```bash
mkdir -p ~/.local/share/applications
cp build/open-source-nvr.desktop ~/.local/share/applications/
chmod +x ~/.local/share/applications/open-source-nvr.desktop
# Optionally update the icon cache or log out/in for the menu to refresh
```

Notes:
- The `Exec` entry runs the server from the project directory and prefixes the PATH so the virtual environment's `python` is used when the server spawns `python3`.
- If you prefer the server to run in the background without a terminal window, edit `Terminal=false` in `build/open-source-nvr.desktop` and consider using systemd instead (recommended for production).

## Install systemd user service (recommended)

To install and enable the systemd user service provided in `build/open-source-nvr.service`:

```bash
mkdir -p ~/.config/systemd/user
cp build/open-source-nvr.service ~/.config/systemd/user/open-source-nvr.service
systemctl --user daemon-reload
systemctl --user enable --now open-source-nvr
```

Check logs with:

```bash
journalctl --user-unit=open-source-nvr -f
```

Adjust the `WorkingDirectory` and `Environment=PATH=` in `build/open-source-nvr.service` if your checkout lives elsewhere.

## Uninstall

To remove the desktop launcher and systemd user service, run the provided uninstall script:

```bash
bash build/uninstall.sh
```

Notes:
- The installer prompts before enabling the systemd user service by default. Use `bash build/install.sh --yes` to enable non-interactively.
- The uninstall script will stop and disable the service if running, remove the service unit and desktop file, and reload the systemd user daemon.

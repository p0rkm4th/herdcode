# HERDCODE

A phone cockpit for [Codex](https://github.com/openai/codex) and a local
Ollama herd. Codex can't live on a phone — it needs a repo checkout and a
shell on a real host, and the models are 15–19 GB on GPU boxes — so
HERDCODE is a client, in two lanes:

- **Herd Chat** — the app talks directly to Ollama nodes (`:11434`) and/or
  a LiteLLM gateway (`:4000/v1`) over Tailscale, streaming. No
  intermediary.
- **Codex** — the app talks to `herd_bridge.py` on the host machine,
  which runs `codex exec --oss --json` against that host's Ollama and
  streams the events back as SSE.

Fold-aware layout (built for a Galaxy Fold 6): single column with bottom
tabs on the cover screen; sessions sidebar plus a herd inspector when
unfolded. `configChanges` covers folding and rotation, so a streaming
reply or a Codex run survives the fold.

## Status

**v1.0.0 (versionCode 1)** — built, and verified against fake servers and
a stand-in Codex binary, but **not yet configured and not yet
device-tested**. The seeded endpoints are placeholders (`http://hades:…`);
a first real run needs your Tailscale addresses in Settings, the bridge
stood up on the host, and a smoke test on the device.

Package `com.hckrslsh.herdcode`. Permissions: INTERNET +
ACCESS_NETWORK_STATE. It is a network client by design and uses cleartext
HTTP *inside* the tailnet, where WireGuard is the encryption layer.
**Never port-forward anything this app talks to.**

## Pieces

| Path | What |
|---|---|
| `herdcode.html` | The whole client — one file, also embedded in the APK |
| `bridge/herd_bridge.py` | Stdlib-only Python bridge for the Codex host |
| `bridge/herd-bridge.service` | systemd user unit, restricted to tailnet + loopback sources |
| `bridge/codex-herd-config.toml` | Example `~/.codex/config.toml` making the herd Codex's default backend |
| `android/` | Gradle-free APK build (WebView shell) |
| `tests/` | JS logic tests — the shipping client code against fake Ollama / LiteLLM servers |

## Run the bridge

On the host you need: Codex CLI installed, Ollama ≥ 0.13.4 running with
`OLLAMA_CONTEXT_LENGTH=65536` (Codex needs a ≥64k window, or tool calls
silently truncate), and Tailscale.

```bash
mkdir -p ~/.local/share/herdcode ~/.config/systemd/user
cp bridge/herd_bridge.py ~/.local/share/herdcode/
cp bridge/herd-bridge.service ~/.config/systemd/user/
cat > ~/.config/herdcode.env <<EOF
HERD_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(24))")
HERD_BIND=<this-host-tailscale-ip>
HERD_REPOS_ROOT=$HOME/workspace
HERD_UPSTREAMS=http://127.0.0.1:11434
EOF
chmod 600 ~/.config/herdcode.env
systemctl --user daemon-reload && systemctl --user enable --now herd-bridge
```

Then in the app's Settings: replace the placeholder endpoints with your
nodes' Tailscale IPs or MagicDNS names, set the bridge URL
(`http://<host>:8765`) and the token, and tap **Test bridge**.

Node-side gotchas: Ollama must listen beyond localhost
(`OLLAMA_HOST=0.0.0.0` or the tailnet interface), and direct chat from the
app needs `OLLAMA_ORIGINS=*` on the node (the tailnet is the perimeter).
Routing through the LiteLLM gateway sidesteps the CORS requirement.

## Security model

- The bridge requires `HERD_TOKEN` on every route and refuses to start
  without one. Repos are confined to `HERD_REPOS_ROOT` — path escapes get
  a 400. One run at a time. Codex is exec'd as an argv list, never
  through a shell.
- Sandbox is `read-only` by default. `workspace-write` is an explicit
  per-run choice; `danger-full-access` is refused unless
  `HERD_ALLOW_FULL=1` is set on the bridge.
- The systemd unit additionally allows only tailnet (100.64.0.0/10) and
  loopback source addresses.

## Build the APK (no Gradle)

Same hand-rolled pipeline: `android/build.sh`
(aapt2 → javac → d8 → zipalign → uber-apk-signer). You need the Android
SDK (platform android-34, build-tools 34.0.0), JDK 17, the
uber-apk-signer jar, and a keystore: the script generates a dedicated one
on first run, with its password taken from the environment
(`export HERDCODE_KS_PASS=...`). As shipped, the script's paths assume
the author's workspace layout (toolchain under
`~/workspace/styxworks-app/`); adjust the variables at the top.

## Tests

```bash
node tests/js_logic_test.js   # stream parsers against fake Ollama (NDJSON) and fake LiteLLM (SSE) servers
node --check tests/combined.js
```

## License

**TODO — owner to decide before publishing.** No LICENSE file is included
yet; until one is added, this code is all-rights-reserved by default.

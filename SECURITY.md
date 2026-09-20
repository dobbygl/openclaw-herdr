# Security

This plugin sends text to coding agents that may run with relaxed permission modes. Treat it as privileged local automation:

- `/herdr` requires an authorized OpenClaw sender (the default). Do not relax it.
- The plugin talks only to the local Herdr Unix socket; it opens no network ports.
- Watch state lives in the plugin's OpenClaw state directory and contains pane ids, session keys and prompt previews. Keep that directory private.

Report vulnerabilities privately through GitHub Security Advisories on this repository. Please do not include terminal output or credentials in public issues.

# bridge/spike

Tools used in the M0 spike (see `docs/spike-m0.md`).

- `keyecho.mjs`: prints the bytes each stdin read delivers, in hex. Open it in
  an Orca terminal and send keys with `POST /spike/call` →
  `terminal.sendText` to see exactly what arrives.

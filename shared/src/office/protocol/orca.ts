// The bridge's link to Orca (orca-office, not agent-office): whether the Orca plugin is connected.

export type OrcaServerMsg =
  /** Sent after `welcome` and whenever it changes: false while Orca (its plugin) isn't connected to the bridge. */
  { t: 'orca'; online: boolean };

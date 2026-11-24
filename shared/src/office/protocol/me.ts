// Who you are in the office. agent-office had accounts, invites, team SSH keys and per-person Claude
// and GitHub sign-ins; orca-office is one person's office without a login (design.md #1, #16), so
// you're always its admin.

export interface Me {
  admin: boolean;
}

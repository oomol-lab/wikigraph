export const CLI_HELP_ROUTES = {
  command: "wikigraph --help",
  config: "wikigraph help config",
  format: "wikigraph help format",
  readiness: "wikigraph help readiness",
  root: "wikigraph --help",
  runtime: "wikigraph help runtime",
  uri: "wikigraph help uri",
} as const;

export function archiveMaintenanceHelpRoute(subcommand: string): string {
  return `wikigraph ${subcommand} --help`;
}

export function withHelpRoute(message: string, route: string): string {
  return `${message}\nSee: ${route}`;
}
